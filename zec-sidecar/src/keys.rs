//! Viewing keys for auditors.
//!
//! A ZIP 316 unified full viewing key (UFVK, `uview1…` on mainnet, `uviewtest1…` on testnet) lets
//! its holder see every note this wallet received and every payment it sent, with amounts and
//! memos, and link all of the wallet's diversified addresses to each other. It can never spend.
//! Silicr exports the Orchard component only, to match its Orchard-receiver-only addresses: a
//! Sapling or transparent component would describe pools this wallet never uses.
//!
//! Nothing in here logs or prints a key; callers decide where it goes (stdout, once, on request).

use std::path::Path;

use anyhow::{Context, anyhow, bail};
use secrecy::ExposeSecret;
use zcash_address::unified::{Encoding, Fvk, Ufvk};
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_protocol::consensus::{Network, Parameters};
use zip32::AccountId;

use crate::remote::chain_name;

/// The Orchard-only UFVK encoding of `ufvk` for `params`' network.
pub fn orchard_only_ufvk(params: &Network, ufvk: &UnifiedFullViewingKey) -> anyhow::Result<String> {
    let fvk = ufvk.orchard().ok_or_else(|| anyhow!("wallet has no Orchard viewing key"))?;
    let container = Ufvk::try_from_items(vec![Fvk::Orchard(fvk.to_bytes())])
        .map_err(|e| anyhow!("encoding the viewing key failed: {e}"))?;
    Ok(container.encode(&params.network_type()))
}

/// Parses a UFVK for `params`' network (the HRP is checked, so a mainnet key is refused on a
/// testnet wallet and the other way round) and requires an Orchard component.
pub fn decode_ufvk(params: &Network, s: &str) -> anyhow::Result<UnifiedFullViewingKey> {
    let s = s.trim();
    let hrp = s.split('1').next().unwrap_or("");
    if !hrp.eq_ignore_ascii_case("uview") && !hrp.eq_ignore_ascii_case("uviewtest") {
        bail!("not a unified full viewing key (expected uview1… or uviewtest1…); a seed phrase or spending key is never accepted here");
    }
    let ufvk = UnifiedFullViewingKey::decode(params, s).map_err(|e| {
        anyhow!("invalid unified full viewing key for {}net: {e}", chain_name(*params))
    })?;
    if ufvk.orchard().is_none() {
        bail!("the viewing key has no Orchard component; Silicr wallets are Orchard-only, so there would be nothing to watch");
    }
    Ok(ufvk)
}

/// `export-ufvk`: the wallet's Orchard-only UFVK without starting a server connection or taking
/// the wallet lock, so it works while a daemon has the wallet open. Reads the stored key from the
/// wallet database (read-only), and falls back to deriving it from the seed if the database is
/// not readable.
pub fn export_offline(dir: &Path, params: &Network) -> anyhow::Result<String> {
    let meta: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.join("wallet.json")).with_context(|| format!("no wallet in {}", dir.display()))?,
    )
    .context("parsing wallet.json")?;
    let net = meta.get("network").and_then(|v| v.as_str()).unwrap_or("");
    if net != chain_name(*params) {
        bail!(
            "wallet {} was created for network {net:?} but --network {} was given; refusing",
            dir.display(),
            chain_name(*params)
        );
    }
    let db_path = dir.join("data.sqlite");
    if db_path.exists() {
        let ro = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        ro.busy_timeout(std::time::Duration::from_secs(10))?;
        let stored: Option<String> = ro
            .query_row("SELECT ufvk FROM accounts ORDER BY id LIMIT 1", [], |r| r.get(0))
            .context("reading the account's viewing key")?;
        if let Some(s) = stored {
            let ufvk = UnifiedFullViewingKey::decode(params, &s).map_err(|e| anyhow!("stored viewing key is corrupt: {e}"))?;
            return orchard_only_ufvk(params, &ufvk);
        }
    }
    let seed_path = dir.join("wallet.seed");
    if !seed_path.exists() {
        bail!("wallet {} holds neither a viewing key nor a seed", dir.display());
    }
    let seed = crate::wallet::read_seed(dir)?;
    let usk = UnifiedSpendingKey::from_seed(params, seed.expose_secret(), AccountId::ZERO)
        .map_err(|e| anyhow!("key derivation failed: {e:?}"))?;
    orchard_only_ufvk(params, &usk.to_unified_full_viewing_key())
}

/// What kind of memo a 512-byte ZIP 302 memo field carries, for ledgers:
/// - a Silicr frame (binary `0xFF|"SLC1"|v1|type` or text `slc1:<base64url>`): the message type
///   (`RFQ`, `BID`, `ACCEPT`, `PAY`, `CLOSE`), or `silicr:unknown` for a type this build doesn't know;
/// - `none` for the empty memo (`0xF6`), `text` for UTF-8 text, `binary` for other arbitrary data.
pub fn memo_kind(memo: &[u8]) -> &'static str {
    const MAGIC: &[u8] = b"SLC1";
    const VERSION: u8 = 1;
    let silicr = |frame: &[u8]| -> Option<&'static str> {
        if frame.len() < 6 || &frame[..4] != MAGIC || frame[4] != VERSION {
            return None;
        }
        Some(match frame[5] {
            1 => "RFQ",
            2 => "BID",
            3 => "ACCEPT",
            4 => "PAY",
            5 => "CLOSE",
            _ => "silicr:unknown",
        })
    };
    match memo.first() {
        None | Some(0xf6) => "none",
        Some(0xff) => silicr(&memo[1..]).unwrap_or("binary"),
        Some(b) if *b <= 0xf4 => {
            let end = memo.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
            if end == 0 {
                return "none"; // all zeros: an empty text memo
            }
            let text = &memo[..end];
            if let Some(b64) = text.strip_prefix(b"slc1:") {
                // Only the 6-byte header matters: 8 base64url characters decode to the first 6 bytes.
                if let Some(head) = b64.get(..8).and_then(b64url_decode_8) {
                    return silicr(&head).unwrap_or("text");
                }
            }
            "text"
        }
        Some(_) => "binary",
    }
}

/// Decodes exactly 8 base64url characters into 6 bytes (no padding).
fn b64url_decode_8(s: &[u8]) -> Option<[u8; 6]> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a') as u32 + 26,
            b'0'..=b'9' => (c - b'0') as u32 + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        })
    };
    let mut out = [0u8; 6];
    for (chunk, o) in s.chunks(4).zip(out.chunks_mut(3)) {
        let n = (val(chunk[0])? << 18) | (val(chunk[1])? << 12) | (val(chunk[2])? << 6) | val(chunk[3])?;
        o[0] = (n >> 16) as u8;
        o[1] = (n >> 8) as u8;
        o[2] = n as u8;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_keys::keys::UnifiedAddressRequest;
    use zip32::DiversifierIndex;

    fn usk(params: &Network) -> UnifiedSpendingKey {
        UnifiedSpendingKey::from_seed(params, &[7u8; 32], AccountId::ZERO).unwrap()
    }

    #[test]
    fn export_is_orchard_only_and_round_trips() {
        for (params, hrp) in [(Network::TestNetwork, "uviewtest1"), (Network::MainNetwork, "uview1")] {
            let full = usk(&params).to_unified_full_viewing_key();
            assert!(full.sapling().is_some(), "a seed-derived UFVK has a Sapling part we must strip");
            let s = orchard_only_ufvk(&params, &full).unwrap();
            assert!(s.starts_with(hrp), "{s}");
            let back = decode_ufvk(&params, &s).unwrap();
            assert!(back.sapling().is_none());
            assert_eq!(back.orchard().unwrap().to_bytes(), full.orchard().unwrap().to_bytes());
            // The watch-only key derives the same Orchard-only addresses as the spending wallet.
            let a = full.address(DiversifierIndex::new(), UnifiedAddressRequest::ORCHARD).unwrap().encode(&params);
            let b = back.address(DiversifierIndex::new(), UnifiedAddressRequest::ORCHARD).unwrap().encode(&params);
            assert_eq!(a, b);
            // Re-exporting the stripped key is idempotent.
            assert_eq!(orchard_only_ufvk(&params, &back).unwrap(), s);
        }
    }

    #[test]
    fn decode_refuses_wrong_network_seeds_and_garbage() {
        let s = orchard_only_ufvk(&Network::TestNetwork, &usk(&Network::TestNetwork).to_unified_full_viewing_key()).unwrap();
        let err = decode_ufvk(&Network::MainNetwork, &s).unwrap_err().to_string();
        assert!(err.contains("mainnet"), "{err}");
        assert!(decode_ufvk(&Network::TestNetwork, "abandon abandon abandon ability").is_err());
        assert!(decode_ufvk(&Network::TestNetwork, "utest1th74wdjrhclrr3klkgwzv63jhd224vvk0ta5h9urlwndm5pv2v29e2x8jgk5ekkk5e9w9me2k7yc7r8up8k2y866kwh03llcuctp0pdt").is_err());
        assert!(decode_ufvk(&Network::TestNetwork, "").is_err());
    }

    #[test]
    fn memo_kinds() {
        let mut m = vec![0u8; 512];
        assert_eq!(memo_kind(&m), "none"); // all zeros: an empty text memo
        m[0] = 0xf6;
        assert_eq!(memo_kind(&m), "none");
        assert_eq!(memo_kind(&[]), "none");
        let mut t = vec![0u8; 512];
        t[..5].copy_from_slice(b"hello");
        assert_eq!(memo_kind(&t), "text");
        let mut b = vec![0u8; 512];
        b[0] = 0xff;
        b[1..7].copy_from_slice(b"SLC1\x01\x04");
        assert_eq!(memo_kind(&b), "PAY");
        b[6] = 1;
        assert_eq!(memo_kind(&b), "RFQ");
        b[6] = 9;
        assert_eq!(memo_kind(&b), "silicr:unknown");
        b[5] = 2; // another protocol version: not ours
        assert_eq!(memo_kind(&b), "binary");
        let mut other = vec![0u8; 512];
        other[0] = 0xff;
        other[1] = 0xaa;
        assert_eq!(memo_kind(&other), "binary");
        // Text transport: "slc1:" + base64url("SLC1\x01\x02" ...) → BID.
        let mut txt = vec![0u8; 512];
        let frame = b"SLC1\x01\x02\x80\x01";
        let enc = b64url(frame);
        txt[..5].copy_from_slice(b"slc1:");
        txt[5..5 + enc.len()].copy_from_slice(enc.as_bytes());
        assert_eq!(memo_kind(&txt), "BID");
        let mut nottxt = vec![0u8; 512];
        nottxt[..9].copy_from_slice(b"slc1:????");
        assert_eq!(memo_kind(&nottxt), "text");
    }

    fn b64url(data: &[u8]) -> String {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for c in data.chunks(3) {
            let n = (c[0] as u32) << 16 | (c.get(1).copied().unwrap_or(0) as u32) << 8 | c.get(2).copied().unwrap_or(0) as u32;
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            if c.len() > 1 {
                out.push(T[(n >> 6) as usize & 63] as char);
            }
            if c.len() > 2 {
                out.push(T[n as usize & 63] as char);
            }
        }
        out
    }
}

/// Opt-in live test (`ZEC_SIDECAR_LIVE=1 cargo test --release live_`): two throwaway testnet
/// wallets in a temp dir, never funded. Checks the export → watch-only round trip end to end:
/// the watch wallet derives the same Orchard-only address, syncs, answers `ledger`, exports the
/// same key, and refuses to send. Nothing is spent (there is nothing to spend).
#[cfg(test)]
mod live {
    use super::*;
    use crate::{
        remote::{DEFAULT_SERVER, Server},
        wallet::{Opts, OutputReq, Wallet, WalletError},
    };

    fn opts(dir: std::path::PathBuf, view_only: bool, ufvk: Option<String>) -> Opts {
        let params = Network::TestNetwork;
        Opts {
            network: params,
            data_dir: dir,
            server: Server::parse(DEFAULT_SERVER, params).unwrap().with_proxy(None).unwrap(),
            create: true,
            birthday: None,
            trusted_confirmations: 3,
            untrusted_confirmations: 10,
            target_note_count: 1,
            min_split_zats: 1_000_000,
            view_only,
            ufvk,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn live_viewing_key_round_trip() {
        if std::env::var("ZEC_SIDECAR_LIVE").is_err() {
            eprintln!("skipped: set ZEC_SIDECAR_LIVE=1 to run against testnet");
            return;
        }
        let tmp = std::env::temp_dir().join(format!("silicr-ufvk-live-{}", std::process::id()));
        let spend_dir = tmp.join("spend");
        let watch_dir = tmp.join("watch");

        let spend = Wallet::open(opts(spend_dir.clone(), false, None)).await.unwrap();
        let key = spend.export_viewing_key().unwrap();
        assert!(key.starts_with("uviewtest1"), "{key}");
        assert_eq!(export_offline(&spend_dir, &Network::TestNetwork).unwrap(), key, "offline export matches the live one");
        assert!(export_offline(&spend_dir, &Network::MainNetwork).is_err(), "wrong network is refused");
        let addr = spend.address().unwrap();
        drop(spend);

        // A watch-only wallet needs --view-only; the key alone is refused only by clap, so the
        // wallet layer must still refuse a seed-less dir without a key.
        assert!(Wallet::open(opts(watch_dir.clone(), true, None)).await.is_err());
        let mut watch = Wallet::open(opts(watch_dir.clone(), true, Some(key.clone()))).await.unwrap();
        assert!(watch.view_only());
        assert!(!watch_dir.join("wallet.seed").exists(), "a watch-only wallet has no seed");
        assert_eq!(watch.address().unwrap(), addr, "same Orchard-only address from the viewing key");
        assert_eq!(watch.export_viewing_key().unwrap(), key);
        watch.sync().await.unwrap();
        assert!(watch.ledger().unwrap().is_empty());
        let memo = vec![0xf6u8; 512];
        match watch.send(vec![OutputReq { to: addr.clone(), zats: 1, memo }]).await {
            Err(WalletError::ReadOnly(m)) => assert!(m.contains("watch-only"), "{m}"),
            other => panic!("expected ReadOnly, got {:?}", other.map(|_| ()).map_err(|e| e.to_string())),
        }
        drop(watch);

        // Re-opening the watch dir without --view-only is refused; with another key too.
        assert!(Wallet::open(opts(watch_dir.clone(), false, None)).await.is_err());
        let other = orchard_only_ufvk(
            &Network::TestNetwork,
            &UnifiedSpendingKey::from_seed(&Network::TestNetwork, &[9u8; 32], AccountId::ZERO).unwrap().to_unified_full_viewing_key(),
        )
        .unwrap();
        assert!(Wallet::open(opts(watch_dir.clone(), true, Some(other))).await.is_err());
        assert!(Wallet::open(opts(watch_dir.clone(), true, Some(key))).await.is_ok());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
