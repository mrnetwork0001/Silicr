//! What a public chain observer can learn about one transaction. Feeds Silicr's Leak Inspector.
//!
//! Views are built from data the wallet already holds; the wallet's `inspectTx` never asks the
//! light-wallet server about a txid (see `Wallet::inspect_local`):
//! - from raw bytes (our own broadcasts, transactions the wallet stored, mempool-stream copies):
//!   every field is exact (`complete: true`);
//! - from a compact-block summary: counts and ciphertext prefixes are exact, the size is a formula
//!   estimate (exact for shielded-only transactions), the version is inferred, and the fee and
//!   value balances are unknown (`feeZats: null`, value balances reported as "0" and listed in
//!   `estimated`).
//!
//! `inspect_remote` (debug CLI only) does fetch from the server, and says so.

use std::collections::HashMap;

use anyhow::{Context, anyhow};
use serde::Serialize;
use tonic::Code;
use zcash_client_backend::proto::service;
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, Network},
    value::{ZatBalance, Zatoshis},
};

use crate::{
    remote::Client,
    views::{CompactSummary, estimate_size},
};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub inputs: usize,
    pub outputs: usize,
    /// True for a coinbase transaction (its single "input" is the null prevout).
    pub coinbase: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaplingView {
    pub spends: usize,
    pub outputs: usize,
    pub value_balance_zats: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionsView {
    pub actions: usize,
    pub value_balance_zats: String,
    /// Hex of the first 32 bytes of each action's encrypted note ciphertext.
    pub ciphertext_samples: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PublicTxView {
    pub txid: String,
    pub height: Option<u32>,
    pub time: Option<u32>,
    pub version: u32,
    pub size_bytes: usize,
    pub fee_zats: Option<String>,
    pub transparent: Counts,
    pub sapling: SaplingView,
    /// The legacy Orchard pool bundle (NU5..NU6.2 value; withdraw-only since NU6.3).
    pub orchard: ActionsView,
    /// The Ironwood pool bundle (NU6.3+). Orchard-shaped actions paying Orchard receivers.
    pub ironwood: ActionsView,
    pub expiry_height: Option<u32>,
    pub consensus_branch_id: Option<String>,
    /// No transparent and no Sapling parts, and at least one Orchard-protocol action.
    pub fully_shielded_orchard_protocol: bool,
    /// Where the view came from: "broadcast" (bytes this wallet built), "wallet" (bytes the wallet
    /// stored while syncing), "mempool" (bytes from the mempool stream), "compact-block" (summary
    /// kept from a compact block the wallet scanned) or "server" (debug CLI only).
    pub source: &'static str,
    /// True when built from the full transaction, so every field is exact.
    pub complete: bool,
    /// Fields that are estimated or unknown in this view (empty when `complete`).
    pub estimated: Vec<&'static str>,
}

pub fn parse_txid(s: &str) -> anyhow::Result<TxId> {
    let mut bytes: [u8; 32] = hex::decode(s.trim())
        .context("txid must be hex")?
        .try_into()
        .map_err(|_| anyhow!("txid must be 32 bytes"))?;
    bytes.reverse();
    Ok(TxId::from_bytes(bytes))
}

/// `RawTransaction.height`: 0 = mempool, u64::MAX = mined off the main chain, else the height.
pub fn mined_height(raw: &service::RawTransaction) -> Option<BlockHeight> {
    (raw.height > 0 && raw.height <= u64::from(u32::MAX)).then(|| BlockHeight::from_u32(raw.height as u32))
}

pub fn parse_raw(params: &Network, tip: BlockHeight, raw: &service::RawTransaction) -> anyhow::Result<Transaction> {
    let branch = BranchId::for_height(params, mined_height(raw).unwrap_or(tip + 1));
    Transaction::read(&raw.data[..], branch).context("parsing raw transaction")
}

/// Fetches a transaction by txid. `Ok(None)` if the server doesn't know it. This is a targeted
/// request: the wallet uses it only for memo enhancement and status checks of its own
/// transactions, never for `inspectTx`.
pub async fn fetch_raw(client: &mut Client, txid: &TxId) -> anyhow::Result<Option<service::RawTransaction>> {
    let req = service::TxFilter { hash: txid.as_ref().to_vec(), ..Default::default() };
    match client.get_transaction(req).await {
        Ok(r) => Ok(Some(r.into_inner())),
        Err(status) if status.code() == Code::NotFound => Ok(None),
        // Some servers report unknown txids as a generic error mentioning "not found".
        Err(status) if status.message().to_ascii_lowercase().contains("not found")
            || status.message().contains("No such mempool or blockchain transaction") =>
        {
            Ok(None)
        }
        Err(status) => Err(anyhow!("GetTransaction failed: {status}")),
    }
}

fn zat_balance_str(v: ZatBalance) -> String {
    i64::from(v).to_string()
}

fn actions_view(
    bundle: Option<&orchard::Bundle<orchard::bundle::Authorized, ZatBalance>>,
) -> ActionsView {
    match bundle {
        None => ActionsView { actions: 0, value_balance_zats: "0".into(), ciphertext_samples: vec![] },
        Some(b) => ActionsView {
            actions: b.actions().len(),
            value_balance_zats: zat_balance_str(*b.value_balance()),
            ciphertext_samples: b
                .actions()
                .iter()
                .map(|a| hex::encode(&a.encrypted_note().enc_ciphertext.as_ref()[..32]))
                .collect(),
        },
    }
}

/// Exact view from the full transaction. `prevouts` must contain the value of every transparent
/// input's previous output for the fee to be known (not needed for shielded-only transactions);
/// the wallet passes none, so a transaction with transparent inputs gets `feeZats: null`.
pub fn view(
    tx: &Transaction,
    size_bytes: usize,
    height: Option<BlockHeight>,
    time: Option<u32>,
    prevouts: &HashMap<(TxId, u32), Zatoshis>,
    source: &'static str,
) -> PublicTxView {
    let (t_in, t_out) = tx
        .transparent_bundle()
        .map_or((0, 0), |b| (b.vin.len(), b.vout.len()));
    let coinbase = tx.transparent_bundle().is_some_and(|b| b.is_coinbase());
    let sapling = tx.sapling_bundle().map_or(
        SaplingView { spends: 0, outputs: 0, value_balance_zats: "0".into() },
        |b| SaplingView {
            spends: b.shielded_spends().len(),
            outputs: b.shielded_outputs().len(),
            value_balance_zats: zat_balance_str(*b.value_balance()),
        },
    );
    let orchard = actions_view(tx.orchard_bundle());
    let ironwood = actions_view(tx.ironwood_bundle());
    let fee = if coinbase {
        None
    } else {
        tx.fee_paid(|outpoint| -> Result<Option<Zatoshis>, zcash_protocol::value::BalanceError> {
            Ok(prevouts.get(&(TxId::from_bytes(*outpoint.hash()), outpoint.n())).copied())
        })
        .ok()
        .flatten()
        .map(|z| z.into_u64().to_string())
    };
    let fully = t_in == 0
        && t_out == 0
        && sapling.spends == 0
        && sapling.outputs == 0
        && (orchard.actions + ironwood.actions) > 0;
    PublicTxView {
        txid: tx.txid().to_string(),
        height: height.map(u32::from),
        time,
        version: tx.version().header() & 0x7FFF_FFFF,
        size_bytes,
        fee_zats: fee,
        transparent: Counts { inputs: t_in, outputs: t_out, coinbase },
        sapling,
        orchard,
        ironwood,
        expiry_height: Some(u32::from(tx.expiry_height())),
        consensus_branch_id: Some(format!("{:08x}", u32::from(tx.consensus_branch_id()))),
        fully_shielded_orchard_protocol: fully,
        source,
        complete: true,
        estimated: vec![],
    }
}

/// View from a compact-block summary (no server request). See the module docs for what is exact.
pub fn compact_view(c: &CompactSummary) -> PublicTxView {
    let mut estimated = vec!["sizeBytes", "version", "feeZats", "valueBalances", "expiryHeight", "consensusBranchId"];
    let transparent_known = c.transparent_inputs.is_some() && c.transparent_output_script_lens.is_some();
    if !transparent_known {
        estimated.push("transparent");
    }
    let t_in = c.transparent_inputs.unwrap_or(0);
    let t_out = c.transparent_output_script_lens.as_ref().map_or(0, Vec::len);
    let fully = t_in == 0
        && t_out == 0
        && transparent_known
        && c.sapling_spends == 0
        && c.sapling_outputs == 0
        && (c.orchard_actions + c.ironwood_actions) > 0;
    PublicTxView {
        txid: c.txid.clone(),
        height: Some(c.height),
        time: Some(c.time),
        // Only v6 transactions carry an Ironwood bundle; otherwise assume v5.
        version: if c.ironwood_actions > 0 { 6 } else { 5 },
        size_bytes: estimate_size(c),
        fee_zats: None,
        transparent: Counts { inputs: t_in, outputs: t_out, coinbase: c.tx_index == 0 },
        sapling: SaplingView { spends: c.sapling_spends, outputs: c.sapling_outputs, value_balance_zats: "0".into() },
        orchard: ActionsView {
            actions: c.orchard_actions,
            value_balance_zats: "0".into(),
            ciphertext_samples: c.orchard_samples.clone(),
        },
        ironwood: ActionsView {
            actions: c.ironwood_actions,
            value_balance_zats: "0".into(),
            ciphertext_samples: c.ironwood_samples.clone(),
        },
        expiry_height: None,
        consensus_branch_id: None,
        fully_shielded_orchard_protocol: fully,
        source: "compact-block",
        complete: false,
        estimated,
    }
}

/// DEBUG CLI ONLY: fetches `txid` (and transparent prevouts) from the server. This tells the
/// server operator that this IP is interested in that transaction; the wallet never does this.
pub async fn inspect_remote(
    client: &mut Client,
    params: &Network,
    txid_hex: &str,
) -> anyhow::Result<(PublicTxView, Vec<u8>)> {
    let txid = parse_txid(txid_hex)?;
    let tip = client
        .get_latest_block(service::ChainSpec::default())
        .await
        .context("GetLatestBlock")?
        .into_inner()
        .height;
    let tip = BlockHeight::from_u32(u32::try_from(tip).context("tip height")?);
    let raw = fetch_raw(client, &txid)
        .await?
        .ok_or_else(|| anyhow!("transaction {txid_hex} not found on the server (wrong network, expired or never broadcast)"))?;
    let tx = parse_raw(params, tip, &raw)?;
    let height = mined_height(&raw);

    let time = match height {
        Some(h) => client
            .get_block(service::BlockId { height: u64::from(h), hash: vec![] })
            .await
            .ok()
            .map(|b| b.into_inner().time),
        None => None,
    };

    let mut prevouts = HashMap::new();
    if let Some(b) = tx.transparent_bundle().filter(|b| !b.is_coinbase()) {
        for vin in &b.vin {
            let prev_txid = TxId::from_bytes(*vin.prevout().hash());
            if let Ok(Some(prev_raw)) = fetch_raw(client, &prev_txid).await
                && let Ok(prev) = parse_raw(params, tip, &prev_raw)
                && let Some(out) = prev
                    .transparent_bundle()
                    .and_then(|pb| pb.vout.get(vin.prevout().n() as usize))
            {
                prevouts.insert((prev_txid, vin.prevout().n()), out.value());
            }
        }
    }

    Ok((view(&tx, raw.data.len(), height, time, &prevouts, "server"), raw.data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_client_backend::proto::compact_formats::{CompactBlock, CompactOrchardAction, CompactTx};

    /// Raw bytes of public testnet tx 3229fe47… (block 4,427,819): v6, 3 Ironwood actions.
    const TX_3229: &str = include_str!("../testdata/tx-3229fe47.hex");
    const TXID_3229: &str = "3229fe47ebc9b381914dc964bc9603ec998bd86680e9097aaa4c0a847a01ccab";

    fn tx() -> (Transaction, Vec<u8>) {
        let raw = hex::decode(TX_3229.trim()).unwrap();
        let tx = Transaction::read(&raw[..], BranchId::Nu6_3).unwrap();
        (tx, raw)
    }

    /// What a lightwalletd compact block carries for this transaction.
    fn compact_of(tx: &Transaction, height: u64, time: u32, index: u64) -> (CompactBlock, CompactTx) {
        let iw = tx.ironwood_bundle().unwrap();
        let ctx = CompactTx {
            index,
            txid: tx.txid().as_ref().to_vec(),
            ironwood_actions: iw
                .actions()
                .iter()
                .map(|a| CompactOrchardAction {
                    nullifier: a.nullifier().to_bytes().to_vec(),
                    cmx: a.cmx().to_bytes().to_vec(),
                    ephemeral_key: a.encrypted_note().epk_bytes.to_vec(),
                    ciphertext: a.encrypted_note().enc_ciphertext.as_ref()[..52].to_vec(),
                })
                .collect(),
            ..Default::default()
        };
        let block = CompactBlock { height, time, vtx: vec![ctx.clone()], ..Default::default() };
        (block, ctx)
    }

    /// Raw transactions are parsed under the branch for their height; NU7 (ZIP 259) must be known
    /// on testnet (from 4,465,026) and mainnet (from 3,543,405), with Ironwood (NU6.3) before it.
    #[test]
    fn branch_ids_cover_nu7() {
        let (test, main) = (Network::TestNetwork, Network::MainNetwork);
        assert_eq!(BranchId::for_height(&test, BlockHeight::from(4_465_025)), BranchId::Nu6_3);
        assert_eq!(BranchId::for_height(&test, BlockHeight::from(4_465_026)), BranchId::Nu7);
        assert_eq!(BranchId::for_height(&main, BlockHeight::from(3_428_143)), BranchId::Nu6_3);
        assert_eq!(BranchId::for_height(&main, BlockHeight::from(3_543_404)), BranchId::Nu6_3);
        assert_eq!(BranchId::for_height(&main, BlockHeight::from(3_543_405)), BranchId::Nu7);
        assert_eq!(u32::from(BranchId::Nu7), 0x7719_0ad9);
        assert_eq!(u32::from(BranchId::Nu6_3), 0x37a5_165b);
    }

    #[test]
    fn full_view_of_a_public_v6_transaction() {
        let (tx, raw) = tx();
        let v = view(&tx, raw.len(), Some(BlockHeight::from_u32(4_427_819)), Some(1_790_856_791), &HashMap::new(), "wallet");
        assert_eq!(v.txid, TXID_3229);
        assert_eq!(v.version, 6);
        assert_eq!(v.size_bytes, 12_322);
        assert_eq!(v.fee_zats.as_deref(), Some("15000"));
        assert_eq!((v.transparent.inputs, v.transparent.outputs), (0, 0));
        assert_eq!(v.orchard.actions, 0);
        assert_eq!(v.ironwood.actions, 3);
        assert_eq!(v.ironwood.value_balance_zats, "15000");
        assert_eq!(v.ironwood.ciphertext_samples[0], "54a2e44f0c6d39ba4c8d781ce8cc154de18179700649d79ca3efd493125f9038");
        assert_eq!(v.consensus_branch_id.as_deref(), Some("37a5165b"));
        assert!(v.complete && v.estimated.is_empty() && v.fully_shielded_orchard_protocol);
    }

    #[test]
    fn compact_view_agrees_with_the_full_view() {
        let (tx, raw) = tx();
        let full = view(&tx, raw.len(), Some(BlockHeight::from_u32(4_427_819)), Some(1_790_856_791), &HashMap::new(), "wallet");
        let (block, ctx) = compact_of(&tx, 4_427_819, 1_790_856_791, 2);
        let c = crate::views::summarize(&block, &ctx, true);
        let v = compact_view(&c);
        assert_eq!(v.txid, full.txid);
        assert_eq!(v.height, full.height);
        assert_eq!(v.time, full.time);
        assert_eq!(v.version, full.version);
        assert_eq!(v.size_bytes, full.size_bytes, "size formula is exact for shielded-only txs");
        assert_eq!(v.ironwood.actions, full.ironwood.actions);
        assert_eq!(v.ironwood.ciphertext_samples, full.ironwood.ciphertext_samples);
        assert_eq!(v.orchard.actions, 0);
        assert_eq!(v.fee_zats, None);
        assert!(!v.complete);
        assert!(v.estimated.contains(&"feeZats") && v.estimated.contains(&"valueBalances"));
        assert!(!v.estimated.contains(&"transparent"));
        assert!(v.fully_shielded_orchard_protocol);

        // Without transparent data from the server the view says so.
        let c2 = crate::views::summarize(&block, &ctx, false);
        let v2 = compact_view(&c2);
        assert!(v2.estimated.contains(&"transparent"));
        assert!(!v2.fully_shielded_orchard_protocol);
    }
}
