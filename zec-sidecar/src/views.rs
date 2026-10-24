//! Local material for public transaction views, so `inspectTx` never has to ask the light-wallet
//! server about a transaction (a GetTransaction(txid) request tells the operator that this IP is
//! interested in that txid).
//!
//! Two kinds of record, in `<dataDir>/txviews.sqlite` (owned by the sidecar, separate from the
//! zcash_client_sqlite wallet database):
//! - `sent_raw`: the exact bytes of every transaction this wallet built, saved before broadcast;
//! - `compact_txs`: a summary of each wallet-relevant transaction taken from the compact blocks
//!   the wallet downloads anyway during sync (counts, the 52-byte ciphertext prefixes, block
//!   height and time).

use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use zcash_client_backend::proto::compact_formats::{CompactBlock, CompactTx};
use zcash_primitives::transaction::TxId;

const FILE: &str = "txviews.sqlite";

/// Summary of one transaction as it appears in a compact block. Everything here is public.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompactSummary {
    /// Display (big-endian) hex txid.
    pub txid: String,
    pub height: u32,
    pub time: u32,
    /// Position in the block; 0 is the coinbase.
    pub tx_index: u64,
    pub sapling_spends: usize,
    pub sapling_outputs: usize,
    pub orchard_actions: usize,
    pub ironwood_actions: usize,
    /// Hex of the first 32 bytes of each action's encrypted note ciphertext.
    pub orchard_samples: Vec<String>,
    pub ironwood_samples: Vec<String>,
    /// Present only when the server returned transparent data in the compact block.
    pub transparent_inputs: Option<usize>,
    pub transparent_output_script_lens: Option<Vec<usize>>,
}

fn sample(ciphertext: &[u8]) -> String {
    hex::encode(&ciphertext[..ciphertext.len().min(32)])
}

pub fn summarize(block: &CompactBlock, tx: &CompactTx, transparent_known: bool) -> CompactSummary {
    let mut id = tx.txid.clone();
    id.reverse();
    CompactSummary {
        txid: hex::encode(id),
        height: block.height as u32,
        time: block.time,
        tx_index: tx.index,
        sapling_spends: tx.spends.len(),
        sapling_outputs: tx.outputs.len(),
        orchard_actions: tx.actions.len(),
        ironwood_actions: tx.ironwood_actions.len(),
        orchard_samples: tx.actions.iter().map(|a| sample(&a.ciphertext)).collect(),
        ironwood_samples: tx.ironwood_actions.iter().map(|a| sample(&a.ciphertext)).collect(),
        transparent_inputs: transparent_known.then_some(tx.vin.len()),
        transparent_output_script_lens: transparent_known.then(|| tx.vout.iter().map(|o| o.script_pub_key.len()).collect()),
    }
}

/// Summaries of the transactions in `blocks` (heights `start..end`) that the wallet database
/// recorded: those that pay or spend this wallet's notes. Others are not kept.
pub fn relevant_summaries(
    wallet_db: &rusqlite::Connection,
    blocks: &[CompactBlock],
    start: u32,
    end: u32,
    transparent_known: bool,
) -> anyhow::Result<Vec<(TxId, CompactSummary)>> {
    let mut stmt = wallet_db.prepare_cached("SELECT txid FROM transactions WHERE mined_height >= ?1 AND mined_height < ?2")?;
    let relevant: std::collections::BTreeSet<Vec<u8>> = stmt
        .query_map([start as i64, end as i64], |r| r.get::<_, Vec<u8>>(0))?
        .collect::<Result<_, _>>()?;
    let mut out = vec![];
    if relevant.is_empty() {
        return Ok(out);
    }
    for b in blocks {
        for tx in &b.vtx {
            if relevant.contains(&tx.txid)
                && let Ok(bytes) = <[u8; 32]>::try_from(tx.txid.as_slice()) {
                    out.push((TxId::from_bytes(bytes), summarize(b, tx, transparent_known)));
                }
        }
    }
    Ok(out)
}

/// Bitcoin-style CompactSize length.
fn cs(n: usize) -> usize {
    match n {
        0..=252 => 1,
        253..=0xFFFF => 3,
        0x1_0000..=0xFFFF_FFFF => 5,
        _ => 9,
    }
}

/// Serialized size of an Orchard-protocol bundle (Orchard and Ironwood share the layout):
/// actions (cv, nf, rk, cmx, epk, enc 580, out 80 = 820 B each), flags, value balance, anchor,
/// the Halo 2 proof (2720 + 2272 per action), a spend-auth signature per action, binding sig.
fn orchard_bundle_size(n: usize) -> usize {
    if n == 0 {
        return 1;
    }
    let proof = 2720 + 2272 * n;
    cs(n) + 820 * n + 1 + 8 + 32 + cs(proof) + proof + 64 * n + 64
}

/// Serialized size of the v5/v6 Sapling component.
fn sapling_size(spends: usize, outputs: usize) -> usize {
    let mut s = cs(spends) + 96 * spends + cs(outputs) + 756 * outputs;
    if spends + outputs > 0 {
        s += 8; // valueBalanceSapling
    }
    if spends > 0 {
        s += 32; // anchorSapling
    }
    s + spends * (192 + 64) + outputs * 192 + if spends + outputs > 0 { 64 } else { 0 }
}

/// Best estimate of the transaction size from compact data. Exact for shielded-only v5/v6
/// transactions (checked against mined testnet transactions); transparent inputs are estimated
/// as P2PKH (unlocking scripts are not in compact blocks).
pub fn estimate_size(c: &CompactSummary) -> usize {
    // header: version, version group, branch id, lock time, expiry height
    let mut s = 20;
    let t_in = c.transparent_inputs.unwrap_or(0);
    s += cs(t_in) + t_in * (32 + 4 + 1 + 107 + 4);
    match &c.transparent_output_script_lens {
        Some(lens) => {
            s += cs(lens.len()) + lens.iter().map(|l| 8 + cs(*l) + l).sum::<usize>();
        }
        None => s += 1,
    }
    s += sapling_size(c.sapling_spends, c.sapling_outputs);
    s += orchard_bundle_size(c.orchard_actions);
    if c.ironwood_actions > 0 {
        s += orchard_bundle_size(c.ironwood_actions);
    }
    s
}

pub struct ViewStore {
    conn: rusqlite::Connection,
}

impl ViewStore {
    pub fn open(dir: &Path) -> anyhow::Result<Self> {
        let path = dir.join(FILE);
        let conn = rusqlite::Connection::open(&path).with_context(|| format!("opening {}", path.display()))?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sent_raw (
                 txid BLOB PRIMARY KEY,
                 raw BLOB NOT NULL,
                 created_unix INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS compact_txs (
                 txid BLOB PRIMARY KEY,
                 height INTEGER NOT NULL,
                 summary_json TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS compact_txs_height ON compact_txs (height);",
        )?;
        Ok(ViewStore { conn })
    }

    pub fn put_sent_raw(&self, txid: &TxId, raw: &[u8], created_unix: u64) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO sent_raw (txid, raw, created_unix) VALUES (?1, ?2, ?3)
             ON CONFLICT (txid) DO UPDATE SET raw = excluded.raw",
            rusqlite::params![txid.as_ref().to_vec(), raw, created_unix as i64],
        )?;
        Ok(())
    }

    pub fn sent_raw(&self, txid: &TxId) -> anyhow::Result<Option<Vec<u8>>> {
        let mut stmt = self.conn.prepare_cached("SELECT raw FROM sent_raw WHERE txid = ?1")?;
        let mut rows = stmt.query([txid.as_ref().to_vec()])?;
        Ok(match rows.next()? {
            Some(r) => Some(r.get(0)?),
            None => None,
        })
    }

    pub fn put_compact(&self, txid: &TxId, c: &CompactSummary) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO compact_txs (txid, height, summary_json) VALUES (?1, ?2, ?3)
             ON CONFLICT (txid) DO UPDATE SET height = excluded.height, summary_json = excluded.summary_json",
            rusqlite::params![txid.as_ref().to_vec(), c.height as i64, serde_json::to_string(c)?],
        )?;
        Ok(())
    }

    pub fn compact(&self, txid: &TxId) -> anyhow::Result<Option<CompactSummary>> {
        let mut stmt = self.conn.prepare_cached("SELECT summary_json FROM compact_txs WHERE txid = ?1")?;
        let mut rows = stmt.query([txid.as_ref().to_vec()])?;
        Ok(match rows.next()? {
            Some(r) => Some(serde_json::from_str(&r.get::<_, String>(0)?)?),
            None => None,
        })
    }

    /// Drops compact summaries above a reorg rewind height (they may describe orphaned blocks).
    pub fn truncate_above(&self, height: u32) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM compact_txs WHERE height > ?1", [height as i64])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(ironwood: usize) -> CompactSummary {
        CompactSummary {
            txid: "00".repeat(32),
            height: 1,
            time: 0,
            tx_index: 1,
            sapling_spends: 0,
            sapling_outputs: 0,
            orchard_actions: 0,
            ironwood_actions: ironwood,
            orchard_samples: vec![],
            ironwood_samples: vec![],
            transparent_inputs: Some(0),
            transparent_output_script_lens: Some(vec![]),
        }
    }

    #[test]
    fn size_estimate_matches_mined_testnet_transactions() {
        // 3229fe47…: 3 Ironwood actions, 12,322 bytes. acff7b85…: 41 actions, 132,252 bytes.
        assert_eq!(estimate_size(&summary(3)), 12_322);
        assert_eq!(estimate_size(&summary(41)), 132_252);
    }

    #[test]
    fn keeps_only_wallet_relevant_transactions() {
        use zcash_client_backend::proto::compact_formats::{CompactOrchardAction, CompactTx, TxOut};
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE transactions (txid BLOB, mined_height INTEGER);").unwrap();
        let ours = [1u8; 32];
        db.execute("INSERT INTO transactions VALUES (?1, 100)", [ours.to_vec()]).unwrap();
        // Same txid but outside the scanned range: must not match a block from this batch.
        let action = |b: u8| CompactOrchardAction { ciphertext: vec![b; 52], ..Default::default() };
        let block = CompactBlock {
            height: 100,
            time: 1_790_000_000,
            vtx: vec![
                CompactTx { index: 0, txid: vec![9u8; 32], vout: vec![TxOut { value: 1, script_pub_key: vec![0; 25] }], ..Default::default() },
                CompactTx { index: 1, txid: ours.to_vec(), ironwood_actions: vec![action(0xab), action(0xcd)], ..Default::default() },
            ],
            ..Default::default()
        };
        let got = relevant_summaries(&db, std::slice::from_ref(&block), 100, 101, true).unwrap();
        assert_eq!(got.len(), 1);
        let (txid, c) = &got[0];
        assert_eq!(txid.as_ref(), &ours);
        assert_eq!(c.txid, hex::encode([1u8; 32]));
        assert_eq!((c.height, c.time, c.tx_index, c.ironwood_actions), (100, 1_790_000_000, 1, 2));
        assert_eq!(c.ironwood_samples, vec!["ab".repeat(32), "cd".repeat(32)]);
        assert_eq!(c.transparent_inputs, Some(0));
        assert_eq!(c.transparent_output_script_lens, Some(vec![]));
        assert!(relevant_summaries(&db, &[block], 101, 200, true).unwrap().is_empty());
    }

    #[test]
    fn store_round_trips_and_truncates() {
        let dir = std::env::temp_dir().join(format!("zec-sidecar-views-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = ViewStore::open(&dir).unwrap();
        let txid = TxId::from_bytes([7u8; 32]);
        assert!(store.sent_raw(&txid).unwrap().is_none());
        store.put_sent_raw(&txid, b"raw", 1).unwrap();
        assert_eq!(store.sent_raw(&txid).unwrap().as_deref(), Some(&b"raw"[..]));
        let mut c = summary(2);
        c.height = 100;
        store.put_compact(&txid, &c).unwrap();
        assert_eq!(store.compact(&txid).unwrap(), Some(c));
        store.truncate_above(99).unwrap();
        assert!(store.compact(&txid).unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
