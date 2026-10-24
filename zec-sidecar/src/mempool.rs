//! Mempool watcher: streams every mempool transaction from lightwalletd (no per-tx requests,
//! so the server learns nothing about which transactions are ours), trial-decrypts each one
//! with the account's viewing keys, and caches incoming Orchard-protocol notes until they are
//! mined. The stream closes whenever a block is mined; that is used as a "new block" signal.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use tokio::sync::Notify;
use tracing::{debug, info, warn};
use zcash_client_backend::{TransferType, decrypt_transaction, proto::service};
use zcash_client_sqlite::AccountUuid;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::TxId;
use zcash_protocol::consensus::{BlockHeight, Network};

use crate::{addr::encode_orchard, remote::Server};

/// Forget cached notes we haven't seen in the mempool for this long (expired or dropped).
const STALE_AFTER: Duration = Duration::from_secs(45 * 60);

#[derive(Clone, Debug)]
pub struct MempoolNote {
    pub txid: TxId,
    pub index: usize,
    pub to_address: String,
    pub zats: u64,
    pub memo: Vec<u8>,
    /// "ironwood" or "orchard"
    pub value_pool: &'static str,
    pub last_seen: Instant,
}

#[derive(Default)]
pub struct MempoolState {
    pub notes: HashMap<(TxId, usize), MempoolNote>,
    /// Raw bytes of mempool transactions that involve this wallet, so that enhancement can use
    /// them instead of asking the server for that specific txid.
    pub raw: HashMap<TxId, (Vec<u8>, Instant)>,
    pub stream_sessions: u64,
    pub connected: bool,
}

impl MempoolState {
    pub fn prune(&mut self) {
        let now = Instant::now();
        self.notes.retain(|_, n| now.duration_since(n.last_seen) < STALE_AFTER);
        self.raw.retain(|_, (_, t)| now.duration_since(*t) < STALE_AFTER);
    }
}

pub type Shared = Arc<Mutex<MempoolState>>;

pub fn spawn(
    server: Server,
    params: Network,
    ufvks: HashMap<AccountUuid, UnifiedFullViewingKey>,
    state: Shared,
    new_block: Arc<Notify>,
) {
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(2);
        loop {
            match server.connect_streaming().await {
                Ok(mut client) => {
                    backoff = Duration::from_secs(2);
                    if let Ok(mut s) = state.lock() {
                        s.connected = true;
                    }
                    loop {
                        let tip = match client.get_latest_block(service::ChainSpec::default()).await {
                            Ok(b) => BlockHeight::from_u32(b.into_inner().height as u32),
                            Err(e) => {
                                warn!("mempool watcher: GetLatestBlock failed: {e}");
                                break;
                            }
                        };
                        let mut stream = match client.get_mempool_stream(service::Empty {}).await {
                            Ok(r) => r.into_inner(),
                            Err(e) => {
                                warn!("mempool watcher: GetMempoolStream failed: {e}");
                                break;
                            }
                        };
                        if let Ok(mut s) = state.lock() {
                            s.stream_sessions += 1;
                        }
                        let mut seen = 0usize;
                        let mut ended_cleanly = true;
                        while let Some(item) = stream.next().await {
                            match item {
                                Ok(raw) => {
                                    seen += 1;
                                    handle(&params, tip, &ufvks, &state, raw);
                                }
                                Err(e) => {
                                    debug!("mempool stream error: {e}");
                                    ended_cleanly = false;
                                    break;
                                }
                            }
                        }
                        debug!("mempool stream closed after {seen} txs (tip was {tip})");
                        // The server closes the stream when a block is mined.
                        new_block.notify_one();
                        if let Ok(mut s) = state.lock() {
                            s.prune();
                        }
                        if !ended_cleanly {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }
                Err(e) => warn!("mempool watcher: connect failed: {e:#}"),
            }
            if let Ok(mut s) = state.lock() {
                s.connected = false;
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    });
}

fn handle(
    params: &Network,
    tip: BlockHeight,
    ufvks: &HashMap<AccountUuid, UnifiedFullViewingKey>,
    state: &Shared,
    raw: service::RawTransaction,
) {
    // Mempool entries come with the *latest block height*, not a mined height.
    let tx = match zcash_primitives::transaction::Transaction::read(
        &raw.data[..],
        zcash_protocol::consensus::BranchId::for_height(params, tip + 1),
    ) {
        Ok(tx) => tx,
        Err(e) => {
            debug!("mempool: unparseable tx: {e}");
            return;
        }
    };
    let txid = tx.txid();
    let decrypted = decrypt_transaction(params, None, Some(tip), &tx, ufvks);
    if !decrypted.has_decrypted_outputs() {
        return;
    }
    let now = Instant::now();
    let mut s = match state.lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    s.raw.insert(txid, (raw.data.clone(), now));
    let pools = [
        ("orchard", decrypted.orchard_outputs()),
        ("ironwood", decrypted.ironwood_outputs()),
    ];
    for (pool_name, outputs) in pools {
        for out in outputs {
            if out.transfer_type() != TransferType::Incoming {
                continue;
            }
            let (note, _pool) = out.note();
            let key = (txid, out.index());
            let entry = s.notes.entry(key).or_insert_with(|| {
                info!("mempool: incoming {pool_name} note in {txid} (action {})", out.index());
                MempoolNote {
                    txid,
                    index: out.index(),
                    to_address: encode_orchard(params, note.recipient()),
                    zats: note.value().inner(),
                    memo: out.memo().as_slice().to_vec(),
                    value_pool: pool_name,
                    last_seen: now,
                }
            });
            entry.last_seen = now;
        }
    }
}
