//! zec-sidecar: the Zcash light-wallet backend for Silicr (mainnet or testnet, chosen with --network).
//!
//! `serve` runs one wallet and speaks JSON lines: one request per line on stdin
//! (`{"id":1,"method":"poll","params":{"sinceHeight":0}}`), one response per line on stdout
//! (`{"id":1,"ok":true,"result":...}` or `{"id":1,"ok":false,"error":{"code","message"}}`),
//! plus `{"event":"ready",...}` once the wallet is open and synced. Logs go to stderr and never
//! contain seeds, keys or memo contents. Closing stdin shuts the sidecar down.

mod addr;
mod inspect;
mod keys;
mod mempool;
mod remote;
mod socks;
mod views;
mod wallet;

use std::{path::PathBuf, sync::Arc, time::Duration};

use anyhow::Context;
use clap::{Args, Parser, Subcommand};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Notify, mpsc},
};
use tracing::{error, info, warn};

use crate::{
    remote::{Server, chain_name, default_server, parse_network},
    wallet::{BOUNDED_BATCH_BLOCKS, OutputReq, Wallet, WalletError},
};

/// Budgets for the syncs that run inside the request loop. Requests queue behind a sync, so the
/// loop is never held for longer than this; after a failure the wallet backs off and answers
/// from local state at once (see Wallet::sync_bounded).
const INLINE_SYNC_BUDGET: Duration = Duration::from_secs(8);
/// A send needs a fresh anchor; it may wait a little longer, but not forever.
const SEND_SYNC_BUDGET: Duration = Duration::from_secs(20);
/// The explicit `sync` request (silicr sync) is allowed a real catch-up.
const EXPLICIT_SYNC_BUDGET: Duration = Duration::from_secs(290);

#[derive(Parser)]
#[command(name = "zec-sidecar", version, about = "Silicr's Zcash light wallet, mainnet or testnet (Orchard receivers, Ironwood spends only)")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run one wallet as a JSON-lines service on stdin/stdout.
    Serve(ServeArgs),
    /// Print the wallet's unified full viewing key (Orchard component only) and exit. Needs no
    /// server and works while a daemon has the wallet open. The key reveals every payment this
    /// wallet ever sent or received, with amounts and memos, and links all of its addresses; it
    /// can never spend. Nothing is printed without --confirm.
    ExportUfvk {
        /// Wallet directory.
        #[arg(long)]
        data_dir: PathBuf,
        /// main or test; must be the network the wallet was created on.
        #[arg(long, default_value = "test")]
        network: String,
        /// Required: acknowledge that the key exposes the whole wallet's history to its holder.
        #[arg(long)]
        confirm: bool,
    },
    /// Print the server's info as JSON (verifies it serves --network) and exit.
    Info {
        /// main or test. Nothing defaults to mainnet.
        #[arg(long, default_value = "test")]
        network: String,
        /// lightwalletd/Zaino endpoint, host:port (default by network: testnet.zec.rocks:443 / zec.rocks:443).
        #[arg(long)]
        server: Option<String>,
        /// SOCKS5 proxy for every connection to the server, e.g. socks5h://127.0.0.1:9050 (Tor).
        #[arg(long, env = "SILICR_PROXY")]
        proxy: Option<String>,
    },
    /// DEBUG: fetch a transaction from the server and print its public view as JSON. This asks the
    /// server for that txid, which tells its operator this IP is interested in it; the wallet's
    /// own inspectTx never does that.
    InspectTx {
        #[arg(long, default_value = "test")]
        network: String,
        #[arg(long)]
        server: Option<String>,
        #[arg(long, env = "SILICR_PROXY")]
        proxy: Option<String>,
        txid: String,
        /// Also print the raw transaction bytes (hex).
        #[arg(long)]
        raw_hex: bool,
    },
    /// List transactions with shielded parts in a block range (public data only; debug helper).
    FindTxs {
        #[arg(long, default_value = "test")]
        network: String,
        #[arg(long)]
        server: Option<String>,
        #[arg(long, env = "SILICR_PROXY")]
        proxy: Option<String>,
        #[arg(long)]
        from: u32,
        #[arg(long)]
        to: u32,
        /// Also request transparent data (vin/vout) in the compact blocks.
        #[arg(long)]
        with_transparent: bool,
    },
}

#[derive(Args, Clone)]
struct ServeArgs {
    /// Wallet directory (e.g. .silicr/wallets/buyer). Holds the seed, so never commit it.
    #[arg(long)]
    data_dir: PathBuf,
    /// lightwalletd/Zaino endpoint, host:port (default by network: testnet.zec.rocks:443 / zec.rocks:443).
    /// Its reported chain must match --network.
    #[arg(long)]
    server: Option<String>,
    /// SOCKS5 proxy (e.g. Tor, socks5h://127.0.0.1:9050) for every connection to the server. Names
    /// are resolved by the proxy; there is no direct fallback. Also read from $SILICR_PROXY.
    #[arg(long, env = "SILICR_PROXY")]
    proxy: Option<String>,
    /// main or test. Nothing defaults to mainnet; a wallet directory is locked to the network it was created on.
    #[arg(long, default_value = "test")]
    network: String,
    /// Create the wallet if the directory has none.
    #[arg(long)]
    create: bool,
    /// Birthday height for a new wallet (default: chain tip - 100).
    #[arg(long)]
    birthday: Option<u32>,
    /// Background sync interval.
    #[arg(long, default_value_t = 15_000)]
    sync_interval_ms: u64,
    /// Confirmations before the wallet's own change is spendable (ZIP 315 default 3).
    #[arg(long, default_value_t = 3)]
    trusted_confirmations: u32,
    /// Confirmations before received funds are spendable (ZIP 315 default 10).
    #[arg(long, default_value_t = 10)]
    untrusted_confirmations: u32,
    /// Split change into up to this many notes so consecutive sends need not wait for change.
    #[arg(long, default_value_t = 4)]
    target_note_count: usize,
    /// Smallest change note created when splitting (zatoshis).
    #[arg(long, default_value_t = 1_000_000)]
    min_split_zats: u64,
    /// Watch-only: refuse every send. Required to open a wallet created from a viewing key.
    #[arg(long)]
    view_only: bool,
    /// Create the wallet (if the directory has none) from this unified full viewing key
    /// (uview1… / uviewtest1…, Orchard component required). Implies --view-only. The key is
    /// visible to local users in the process list; keep the machine yours.
    #[arg(long, requires = "view_only")]
    ufvk: Option<String>,
}

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("ZEC_SIDECAR_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,zcash_client_backend=warn,zcash_client_sqlite=warn,schemerz=warn,schemerz_rusqlite=warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_target(false)
        .init();
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    init_tracing();
    let cli = Cli::parse();
    let code = match cli.command {
        Command::Info { network, server, proxy } => one_shot(async move {
            let server = server_for(&network, server.as_deref(), proxy.as_deref())?;
            let (_, info) = server.connect_checked().await?;
            Ok(json!({
                "network": chain_name(server.network),
                "server": server.uri(),
                "proxy": server.proxy_label(),
                "chainName": info.chain_name,
                "blockHeight": info.block_height,
                "estimatedHeight": info.estimated_height,
                "consensusBranchId": info.consensus_branch_id,
                "vendor": info.vendor,
                "version": info.version,
                "nodeBuild": info.zcashd_build,
                "nodeSubversion": info.zcashd_subversion,
                "saplingActivationHeight": info.sapling_activation_height,
            }))
        })
        .await,
        Command::InspectTx { network, server, proxy, txid, raw_hex } => one_shot(async move {
            eprintln!("note: debug command; this asks the server for txid {txid}, which reveals interest in it");
            let server = server_for(&network, server.as_deref(), proxy.as_deref())?;
            let (mut client, _) = server.connect_checked().await?;
            let (view, raw) = inspect::inspect_remote(&mut client, &server.network, &txid).await?;
            let mut v = serde_json::to_value(view)?;
            if raw_hex {
                v["rawHex"] = json!(hex::encode(raw));
            }
            Ok(v)
        })
        .await,
        Command::FindTxs { network, server, proxy, from, to, with_transparent } => one_shot(async move {
            use futures_util::TryStreamExt;
            use zcash_client_backend::proto::service;
            let server = server_for(&network, server.as_deref(), proxy.as_deref())?;
            let (mut client, _) = server.connect_checked().await?;
            let range = service::BlockRange {
                start: Some(service::BlockId { height: u64::from(from), hash: vec![] }),
                end: Some(service::BlockId { height: u64::from(to), hash: vec![] }),
                pool_types: if with_transparent {
                    vec![
                        service::PoolType::Transparent as i32,
                        service::PoolType::Sapling as i32,
                        service::PoolType::Orchard as i32,
                        service::PoolType::Ironwood as i32,
                    ]
                } else {
                    vec![]
                },
            };
            let blocks: Vec<_> = client.get_block_range(range).await?.into_inner().try_collect().await?;
            let mut txs = vec![];
            for b in blocks {
                for tx in b.vtx {
                    let mut id = tx.txid.clone();
                    id.reverse();
                    txs.push(json!({
                        "height": b.height,
                        "time": b.time,
                        "txid": hex::encode(id),
                        "saplingSpends": tx.spends.len(),
                        "saplingOutputs": tx.outputs.len(),
                        "orchardActions": tx.actions.len(),
                        "ironwoodActions": tx.ironwood_actions.len(),
                        "fee": tx.fee,
                        "vin": tx.vin.len(),
                        "vout": tx.vout.len(),
                        "ciphertextLen": tx.ironwood_actions.first().map(|a| a.ciphertext.len()),
                    }));
                }
            }
            Ok(Value::Array(txs))
        })
        .await,
        Command::ExportUfvk { data_dir, network, confirm } => {
            if !confirm {
                eprintln!(
                    "error: export-ufvk prints a key that reveals every payment this wallet ever sent or received, with amounts and memos, and links all of its addresses. It cannot spend. Re-run with --confirm to print it."
                );
                2
            } else {
                match parse_network(&network).and_then(|n| keys::export_offline(&data_dir, &n)) {
                    Ok(k) => {
                        println!("{k}");
                        0
                    }
                    Err(e) => {
                        eprintln!("error: {e:#}");
                        1
                    }
                }
            }
        }
        Command::Serve(args) => match serve(args).await {
            Ok(()) => 0,
            Err(e) => {
                error!("fatal: {e:#}");
                let line = json!({"event": "fatal", "error": format!("{e:#}")}).to_string();
                println!("{line}");
                1
            }
        },
    };
    std::process::exit(code);
}

/// `--network`, `--server` (default by network) and `--proxy` → the server to talk to.
fn server_for(network: &str, server: Option<&str>, proxy: Option<&str>) -> anyhow::Result<Server> {
    let network = parse_network(network)?;
    Server::parse(server.unwrap_or(default_server(network)), network)?.with_proxy(proxy)
}

async fn one_shot<F: std::future::Future<Output = anyhow::Result<Value>>>(f: F) -> i32 {
    match f.await {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap());
            0
        }
        Err(e) => {
            eprintln!("error: {e:#}");
            1
        }
    }
}

fn error_code(e: &WalletError) -> &'static str {
    match e {
        WalletError::Privacy(_) => "PrivacyError",
        WalletError::InsufficientFunds { .. } => "InsufficientFunds",
        WalletError::BadRequest(_) => "BadRequest",
        WalletError::TxNotKnown(_) => "TxNotKnown",
        WalletError::ReadOnly(_) => "ReadOnly",
        WalletError::Other(_) => "Internal",
    }
}

fn param_u64(p: &Value, key: &str) -> Result<u64, WalletError> {
    match p.get(key) {
        Some(Value::String(s)) => s.parse().map_err(|_| WalletError::BadRequest(format!("{key} must be a decimal integer"))),
        Some(Value::Number(n)) => n.as_u64().ok_or_else(|| WalletError::BadRequest(format!("{key} must be a non-negative integer"))),
        _ => Err(WalletError::BadRequest(format!("missing {key}"))),
    }
}

async fn serve(args: ServeArgs) -> anyhow::Result<()> {
    let server = server_for(&args.network, args.server.as_deref(), args.proxy.as_deref())?;
    let network = server.network;
    if network == zcash_protocol::consensus::Network::MainNetwork {
        info!("MAINNET: real ZEC. Spends are Ironwood-only and capped by the daemon; see docs/MAINNET.md");
    }
    match server.proxy_label() {
        Some(p) => info!("every connection to {} goes through SOCKS5 proxy {p} (names resolved by the proxy; no direct fallback)", server.uri()),
        None if server.proxy.is_some() => info!("{} is on this machine: connecting directly, the proxy is not needed", server.uri()),
        None => {}
    }
    let opts = wallet::Opts {
        network,
        data_dir: args.data_dir.clone(),
        server: server.clone(),
        create: args.create,
        birthday: args.birthday,
        trusted_confirmations: args.trusted_confirmations,
        untrusted_confirmations: args.untrusted_confirmations,
        target_note_count: args.target_note_count,
        min_split_zats: args.min_split_zats,
        view_only: args.view_only || args.ufvk.is_some(),
        ufvk: args.ufvk.clone(),
    };
    let mut w = Wallet::open(opts).await?;
    if w.view_only() {
        info!("wallet open ({}), WATCH-ONLY: no spending key, every send is refused; syncing", args.data_dir.display());
    } else {
        info!("wallet open ({}), syncing", args.data_dir.display());
    }

    let new_block = Arc::new(Notify::new());
    mempool::spawn(server.clone(), w.params, w.ufvks(), w.mempool.clone(), new_block.clone());

    // Warm the Orchard/Ironwood proving key in the background so the first send is fast.
    tokio::task::spawn_blocking(|| {
        let t = std::time::Instant::now();
        let _ = zcash_primitives::transaction::builder::cached_orchard_proving_key(
            orchard::circuit::OrchardCircuitVersion::PostNu6_3,
        );
        info!("proving key ready in {} ms", t.elapsed().as_millis());
    });

    let first = w.sync().await.context("initial sync")?;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = out_rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });
    let emit = |v: Value| {
        let _ = out_tx.send(v.to_string());
    };

    emit(json!({
        "event": "ready",
        "network": chain_name(network),
        "server": server.uri(),
        "proxy": server.proxy_label(),
        "address": w.address()?,
        "viewOnly": w.view_only(),
        "birthday": w.birthday(),
        "tip": first.tip,
        "syncMs": first.ms,
        "scannedBlocks": first.scanned_blocks,
        "version": env!("CARGO_PKG_VERSION"),
    }));

    let (req_tx, mut req_rx) = mpsc::channel::<Option<String>>(256);
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(l)) => {
                    if req_tx.send(Some(l)).await.is_err() {
                        break;
                    }
                }
                _ => {
                    let _ = req_tx.send(None).await;
                    break;
                }
            }
        }
    });

    let mut tick = tokio::time::interval(Duration::from_millis(args.sync_interval_ms.max(1000)));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    #[cfg(unix)]
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;

    loop {
        tokio::select! {
            msg = req_rx.recv() => {
                let Some(Some(line)) = msg else { info!("stdin closed; shutting down"); break };
                let line = line.trim();
                if line.is_empty() { continue; }
                let req: Request = match serde_json::from_str(line) {
                    Ok(r) => r,
                    Err(e) => {
                        emit(json!({"id": null, "ok": false, "error": {"code": "BadRequest", "message": format!("invalid JSON request: {e}")}}));
                        continue;
                    }
                };
                let shutdown = req.method == "shutdown";
                let resp = match handle(&mut w, &req).await {
                    Ok(result) => json!({"id": req.id, "ok": true, "result": result}),
                    Err(e) => {
                        let mut err = json!({"code": error_code(&e), "message": e.to_string()});
                        if let WalletError::InsufficientFunds { available, required, .. } = &e {
                            err["available"] = json!(available.map(|v| v.to_string()));
                            err["required"] = json!(required.map(|v| v.to_string()));
                        }
                        if let WalletError::Other(inner) = &e { warn!("{} failed: {inner:#}", req.method); }
                        json!({"id": req.id, "ok": false, "error": err})
                    }
                };
                emit(resp);
                if shutdown { break; }
            }
            _ = tick.tick() => {
                if w.sync_age().is_none_or(|a| a >= Duration::from_millis(args.sync_interval_ms))
                    && w.sync_backoff_left().is_none()
                    && let Err(e) = w.sync_bounded(INLINE_SYNC_BUDGET, BOUNDED_BATCH_BLOCKS).await { warn!("background sync failed: {e:#}"); }
            }
            _ = new_block.notified() => {
                // The mempool stream closed on a new block: the server is reachable, so skip any backoff.
                w.clear_sync_backoff();
                if let Err(e) = w.sync_bounded(INLINE_SYNC_BUDGET, BOUNDED_BATCH_BLOCKS).await { warn!("sync after new block failed: {e:#}"); }
            }
            _ = sigterm_recv(&mut sigterm) => { info!("SIGTERM; shutting down"); break; }
        }
    }
    let _ = emit;
    drop(out_tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    Ok(())
}

#[cfg(unix)]
async fn sigterm_recv(s: &mut tokio::signal::unix::Signal) {
    s.recv().await;
}

/// Syncs first unless the last sync is fresher than `max_age`, within a budget. Read-only calls
/// never fail on a sync error: they answer from local state, and while the wallet is backing off
/// after a failure they don't even try. A send (`strict`) must have a fresh anchor and tells the
/// caller when it can't get one; the engine retries the send with its own backoff.
async fn ensure_fresh(w: &mut Wallet, max_age: Duration, strict: bool) -> Result<(), WalletError> {
    if w.sync_age().is_some_and(|a| a < max_age) {
        return Ok(());
    }
    if !strict && w.sync_backoff_left().is_some() {
        return Ok(()); // answered from local state; the background loop retries when the backoff ends
    }
    let budget = if strict { SEND_SYNC_BUDGET } else { INLINE_SYNC_BUDGET };
    if let Err(e) = w.sync_bounded(budget, BOUNDED_BATCH_BLOCKS).await
        && strict
    {
        return Err(WalletError::Other(e.context("sync before send failed")));
    }
    Ok(())
}

/// What a read-only answer says about its freshness: `stale` when the wallet could not reach the
/// server and answered from local state, with the last error.
fn freshness(w: &Wallet, stale: bool) -> Value {
    json!({
        "stale": stale,
        "syncAgeMs": w.sync_age().map(|d| d.as_millis() as u64),
        "syncError": if stale { w.sync_error() } else { None },
    })
}

async fn handle(w: &mut Wallet, req: &Request) -> Result<Value, WalletError> {
    let p = &req.params;
    match req.method.as_str() {
        "ping" => Ok(json!("pong")),
        "info" => {
            let fully = w.last_known_tip();
            let mp = w.mempool.lock().map(|m| (m.connected, m.stream_sessions, m.notes.len())).unwrap_or_default();
            Ok(json!({
                "network": chain_name(w.params),
                "server": w.opts.server.uri(),
                "proxy": w.opts.server.proxy_label(),
                "serverVendor": w.server_info.vendor,
                "serverVersion": w.server_info.version,
                "nodeSubversion": w.server_info.zcashd_subversion,
                "consensusBranchId": w.server_info.consensus_branch_id,
                "birthday": w.birthday(),
                "viewOnly": w.view_only(),
                "tip": fully,
                "lastSyncMsAgo": w.sync_age().map(|d| d.as_millis() as u64),
                "syncError": w.sync_error(),
                "syncBackoffMs": w.sync_backoff_left().map(|d| d.as_millis() as u64),
                "mempool": {"connected": mp.0, "sessions": mp.1, "cachedNotes": mp.2},
            }))
        }
        "address" => Ok(json!({ "address": w.address()? })),
        "newAddress" => {
            let (address, index) = w.new_address()?;
            Ok(json!({ "address": address, "diversifierIndex": index }))
        }
        "height" => {
            let (height, stale) = w.tip_or_stale(INLINE_SYNC_BUDGET).await?;
            let mut v = freshness(w, stale);
            v["height"] = json!(height);
            Ok(v)
        }
        "sync" => Ok(serde_json::to_value(w.sync_bounded(EXPLICIT_SYNC_BUDGET, 1000).await?).map_err(anyhow::Error::from)?),
        "balance" => {
            ensure_fresh(w, Duration::from_secs(10), false).await?;
            Ok(serde_json::to_value(w.balance()?).map_err(anyhow::Error::from)?)
        }
        "poll" => {
            let since = p.get("sinceHeight").and_then(Value::as_u64).unwrap_or(0) as u32;
            ensure_fresh(w, Duration::from_secs(2), false).await?;
            let notes = w.poll(since)?;
            let mut v = freshness(w, w.sync_error().is_some());
            v["notes"] = serde_json::to_value(notes).map_err(anyhow::Error::from)?;
            v["tip"] = json!(w.last_known_tip());
            Ok(v)
        }
        "send" => {
            let outs = p
                .get("outputs")
                .and_then(Value::as_array)
                .ok_or_else(|| WalletError::BadRequest("missing outputs".into()))?;
            let mut outputs = Vec::with_capacity(outs.len());
            for o in outs {
                let to = o.get("to").and_then(Value::as_str).ok_or_else(|| WalletError::BadRequest("output.to missing".into()))?;
                let zats = param_u64(o, "zats")?;
                let memo = hex::decode(o.get("memoHex").and_then(Value::as_str).unwrap_or(""))
                    .map_err(|_| WalletError::BadRequest("output.memoHex must be hex".into()))?;
                outputs.push(OutputReq { to: to.to_string(), zats, memo });
            }
            ensure_fresh(w, Duration::from_secs(2), true).await?;
            Ok(serde_json::to_value(w.send(outputs).await?).map_err(anyhow::Error::from)?)
        }
        "inspectTx" => {
            let txid = p.get("txid").and_then(Value::as_str).ok_or_else(|| WalletError::BadRequest("missing txid".into()))?;
            Ok(serde_json::to_value(w.inspect_local(txid)?).map_err(anyhow::Error::from)?)
        }
        // The key goes to the caller only: never to the log.
        "exportViewingKey" => Ok(json!({ "ufvk": w.export_viewing_key()?, "network": chain_name(w.params), "orchardOnly": true })),
        "ledger" => {
            ensure_fresh(w, Duration::from_secs(2), false).await?;
            let entries = w.ledger()?;
            Ok(json!({ "entries": entries, "tip": w.last_known_tip(), "birthday": w.birthday(), "viewOnly": w.view_only() }))
        }
        "shutdown" => Ok(json!({ "bye": true })),
        other => Err(WalletError::BadRequest(format!("unknown method {other:?}"))),
    }
}
