//! The wallet: one zcash_client_sqlite account, synced from a lightwalletd on the configured network.
//!
//! Privacy rules enforced here (independently of the TypeScript layer):
//! - recipients must be unified addresses with an Orchard receiver; only that receiver is paid;
//! - notes are selected from the Ironwood pool only (the Orchard-protocol pool that accepts new
//!   value since NU6.3), so no pool is ever crossed and no amount is revealed;
//! - the proposal and the built transaction are both checked for transparent, Sapling or legacy
//!   Orchard components before anything is broadcast.

use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::Write,
    num::{NonZeroU32, NonZeroUsize},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, anyhow, bail};
use bip0039::{Count, English, Mnemonic};
use futures_util::TryStreamExt;
use orchard::tree::MerkleHashOrchard;
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;

/// The OS RNG; `UnwrapErr` turns rand 0.10's fallible `SysRng` into the infallible `Rng` the wallet DB needs.
type OsRng = UnwrapErr<SysRng>;
fn os_rng() -> OsRng {
    UnwrapErr(SysRng)
}
use secrecy::{ExposeSecret, SecretVec, Zeroize};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use zcash_client_backend::{
    data_api::{
        Account, AccountBirthday, AccountPurpose, TransactionDataRequest, TransactionStatus,
        WalletCommitmentTrees, WalletRead, WalletWrite,
        chain::{BlockSource, CommitmentTreeRoot, error::Error as ChainError, scan_cached_blocks},
        wallet::{
            ConfirmationsPolicy, SpendingKeys, create_proposed_transactions,
            decrypt_and_store_transaction,
            input_selection::{GreedyInputSelector, NoteSelection, SpendPolicy},
            propose_transfer,
        },
    },
    fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule, standard::MultiOutputChangeStrategy},
    proto::{compact_formats::CompactBlock, service},
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{
    AccountUuid, WalletDb, error::SqliteClientError, util::SystemClock, wallet::init::init_wallet_db,
};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_primitives::{
    block::BlockHash,
    merkle_tree::HashSer,
    transaction::{Transaction, TxId},
};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    PoolType, ShieldedPool,
    consensus::{BlockHeight, Network, NetworkUpgrade, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};
use zip32::DiversifierIndex;
use zip321::{Payment, TransactionRequest};

use crate::{
    addr::{encode_orchard, orchard_only},
    inspect,
    keys,
    mempool,
    remote::{Client, Server, chain_name},
    views::{self, ViewStore},
};

type Db = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

const META_FILE: &str = "wallet.json";
/// BIP-39 phrase. Matches the repo's `*.seed` gitignore rule; mode 0600; never printed.
const SEED_FILE: &str = "wallet.seed";
const DB_FILE: &str = "data.sqlite";
const LOCK_FILE: &str = "sidecar.lock";

const BATCH_BLOCKS: u32 = 1000;
const REORG_MARGIN: u32 = 10;
/// Hard cap on payments in one transaction (proving time and tx size grow linearly).
pub const MAX_OUTPUTS: usize = 50;
/// Legacy-Orchard note indices are offset so (txid, index) stays unique across pools.
const ORCHARD_INDEX_OFFSET: usize = 1 << 20;

#[derive(Debug)]
pub enum WalletError {
    Privacy(String),
    InsufficientFunds { available: Option<u64>, required: Option<u64>, detail: String },
    BadRequest(String),
    /// inspectTx for a transaction this wallet holds no local data about.
    TxNotKnown(String),
    /// A watch-only wallet (opened from a viewing key, or with --view-only) was asked to spend.
    ReadOnly(String),
    Other(anyhow::Error),
}

impl From<anyhow::Error> for WalletError {
    fn from(e: anyhow::Error) -> Self {
        WalletError::Other(e)
    }
}

impl std::fmt::Display for WalletError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WalletError::Privacy(m) => write!(f, "{m}"),
            WalletError::InsufficientFunds { detail, .. } => write!(f, "{detail}"),
            WalletError::BadRequest(m) => write!(f, "{m}"),
            WalletError::TxNotKnown(m) => write!(f, "{m}"),
            WalletError::ReadOnly(m) => write!(f, "{m}"),
            WalletError::Other(e) => write!(f, "{e:#}"),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalletMeta {
    network: String,
    birthday: u32,
    account_uuid: String,
    created_unix: u64,
    created_by: String,
    /// Created from a viewing key: no seed, no spending authority, ever.
    #[serde(default)]
    view_only: bool,
}

#[derive(Clone, Debug)]
pub struct Opts {
    /// Consensus parameters: wallet DB, key derivation (ZIP 32 coin type), UA encoding, activation heights.
    pub network: Network,
    pub data_dir: PathBuf,
    pub server: Server,
    pub create: bool,
    pub birthday: Option<u32>,
    pub trusted_confirmations: u32,
    pub untrusted_confirmations: u32,
    pub target_note_count: usize,
    pub min_split_zats: u64,
    /// Refuse every send, whatever the wallet holds.
    pub view_only: bool,
    /// Create a watch-only wallet from this unified full viewing key (Orchard component required).
    pub ufvk: Option<String>,
}

/// One row of the audit ledger: a note this wallet received, or a payment it sent.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub txid: String,
    pub height: Option<u32>,
    /// Block time, unix seconds, when known.
    pub time: Option<u32>,
    /// "received" (paid to one of this wallet's addresses), "sent" (a payment to someone else,
    /// recovered with the outgoing viewing key), or "change" (our own change coming back).
    pub direction: &'static str,
    pub zats: String,
    /// For "received"/"change": the receiving Orchard-only address. For "sent": the recipient.
    pub address: Option<String>,
    /// Silicr message type (RFQ, BID, ACCEPT, PAY, CLOSE), else "none", "text" or "binary".
    pub memo_type: &'static str,
    pub memo_hex: String,
    /// The transaction's fee, when the wallet knows it (always for its own sends).
    pub fee_zats: Option<String>,
    pub value_pool: &'static str,
    /// Output position within the transaction.
    pub index: usize,
}

pub struct OutputReq {
    pub to: String,
    pub zats: u64,
    pub memo: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReport {
    pub txid: String,
    pub fee_zats: String,
    pub actions: usize,
    pub propose_ms: u128,
    pub prove_ms: u128,
    pub broadcast_ms: u128,
    pub expiry_height: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteView {
    pub txid: String,
    pub index: usize,
    pub height: Option<u32>,
    pub to_address: String,
    pub zats: String,
    pub memo_hex: String,
    /// Contract pool family. Ironwood notes are Orchard-protocol notes paid to Orchard receivers.
    pub pool: &'static str,
    /// The actual value pool: "ironwood" (NU6.3+) or "orchard" (legacy).
    pub value_pool: &'static str,
    pub source: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolBalance {
    pub spendable: String,
    pub change_pending: String,
    pub value_pending: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceView {
    pub spendable: String,
    pub pending: String,
    pub mempool_incoming: String,
    pub ironwood: PoolBalance,
    pub legacy_orchard: PoolBalance,
    pub sapling: PoolBalance,
    pub synced: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub tip: u32,
    pub scanned_blocks: u32,
    pub fully_scanned: Option<u32>,
    pub ms: u128,
}

pub struct Wallet {
    pub params: Network,
    pub opts: Opts,
    db: Db,
    ro: rusqlite::Connection,
    account: AccountUuid,
    ufvk: UnifiedFullViewingKey,
    client: Client,
    pub server_info: service::LightdInfo,
    pub mempool: mempool::Shared,
    last_sync: Option<Instant>,
    subtree_roots_loaded: bool,
    chain_tip: Option<BlockHeight>,
    birthday: u32,
    /// Local material for inspectTx (our broadcasts' raw bytes, compact-block summaries).
    views: ViewStore,
    /// Whether the server returns transparent data in compact blocks (pool_types request).
    transparent_in_compact: bool,
    /// No sends: created from a viewing key, or opened with --view-only.
    view_only: bool,
    _lock: fs::File,
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn lock_dir(dir: &Path) -> anyhow::Result<fs::File> {
    let f = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(dir.join(LOCK_FILE))
        .context("opening wallet lock file")?;
    // SAFETY: flock on a valid, owned fd.
    let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        bail!("wallet {} is already open in another zec-sidecar process", dir.display());
    }
    Ok(f)
}

fn read_mnemonic(dir: &Path) -> anyhow::Result<Mnemonic<English>> {
    let mut phrase = fs::read_to_string(dir.join(SEED_FILE)).context("reading wallet seed file")?;
    let m = Mnemonic::<English>::from_phrase(phrase.trim()).map_err(|_| anyhow!("wallet seed file is corrupt"));
    phrase.zeroize();
    m
}

pub(crate) fn read_seed(dir: &Path) -> anyhow::Result<SecretVec<u8>> {
    let m = read_mnemonic(dir)?;
    let mut seed = m.to_seed("");
    let secret = SecretVec::new(seed.to_vec());
    seed.zeroize();
    Ok(secret)
}

fn write_private(path: &Path, bytes: &[u8], create_new: bool) -> anyhow::Result<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).mode(0o600);
    if create_new {
        opts.create_new(true);
    } else {
        opts.create(true).truncate(true);
    }
    let mut f = opts.open(path).with_context(|| format!("writing {}", path.display()))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}

fn expand_memo(stored: Vec<u8>) -> Vec<u8> {
    // zcash_client_sqlite stores the empty memo as a single 0xF6 byte.
    if stored == [0xf6] {
        let mut m = vec![0u8; 512];
        m[0] = 0xf6;
        m
    } else {
        let mut m = stored;
        m.resize(512, 0);
        m
    }
}

struct MemBlocks(Vec<CompactBlock>);

impl BlockSource for MemBlocks {
    type Error = std::convert::Infallible;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let mut n = 0usize;
        for b in &self.0 {
            if from_height.is_some_and(|h| b.height() < h) {
                continue;
            }
            if limit.is_some_and(|l| n >= l) {
                break;
            }
            with_block(b.clone())?;
            n += 1;
        }
        Ok(())
    }
}

impl Wallet {
    pub async fn open(opts: Opts) -> anyhow::Result<Self> {
        let params = opts.network;
        fs::create_dir_all(&opts.data_dir)
            .with_context(|| format!("creating wallet dir {}", opts.data_dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&opts.data_dir, fs::Permissions::from_mode(0o700));
        }
        let lock = lock_dir(&opts.data_dir)?;
        let (mut client, server_info) = opts.server.connect_checked().await?;

        let meta_path = opts.data_dir.join(META_FILE);
        if !meta_path.exists() {
            if let Some(ufvk) = &opts.ufvk {
                Self::create_view_only(&opts, &mut client, &params, ufvk).await?;
            } else if opts.view_only {
                bail!(
                    "no wallet in {}: a watch-only wallet is created from a viewing key (--ufvk)",
                    opts.data_dir.display()
                );
            } else {
                if !opts.create {
                    bail!(
                        "no wallet in {} (pass --create to make one)",
                        opts.data_dir.display()
                    );
                }
                Self::create(&opts, &mut client, &params).await?;
            }
        }
        let meta: WalletMeta = serde_json::from_slice(&fs::read(&meta_path)?)
            .context("parsing wallet.json")?;
        if meta.view_only && !opts.view_only {
            bail!(
                "wallet {} is watch-only (created from a viewing key); open it with --view-only",
                opts.data_dir.display()
            );
        }
        if let (Some(given), true) = (&opts.ufvk, meta.view_only) {
            // Re-opening with a key: it must be the one the wallet was created from.
            let want = keys::decode_ufvk(&params, given)?;
            let have = Self::stored_ufvk(&opts.data_dir, &params)?;
            if want.orchard().map(|k| k.to_bytes()) != have.orchard().map(|k| k.to_bytes()) {
                bail!("wallet {} was created from a different viewing key; use another --data-dir", opts.data_dir.display());
            }
        }
        if meta.network != chain_name(params) {
            bail!(
                "wallet {} was created for network {:?} but this sidecar was started with --network {}; refusing (a wallet never crosses networks)",
                opts.data_dir.display(),
                meta.network,
                chain_name(params)
            );
        }

        let db_path = opts.data_dir.join(DB_FILE);
        let mut db = WalletDb::for_path(&db_path, params, SystemClock, os_rng())?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&db_path, fs::Permissions::from_mode(0o600));
        }
        let seed = if meta.view_only { None } else { Some(read_seed(&opts.data_dir)?) };
        init_wallet_db(&mut db, seed).map_err(|e| anyhow!("wallet database migration failed: {e:?}"))?;
        let account = *db
            .get_account_ids()?
            .first()
            .ok_or_else(|| anyhow!("wallet has no account"))?;
        let ufvk = db
            .get_account(account)?
            .and_then(|a| a.ufvk().cloned())
            .ok_or_else(|| anyhow!("wallet account has no full viewing key"))?;
        if ufvk.orchard().is_none() {
            bail!("wallet account has no Orchard key");
        }
        let ro = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        ro.busy_timeout(Duration::from_secs(10))?;

        let views = ViewStore::open(&opts.data_dir)?;
        let mempool = mempool::Shared::default();
        let view_only = meta.view_only || opts.view_only;
        Ok(Wallet {
            params,
            opts,
            db,
            ro,
            account,
            ufvk,
            client,
            server_info,
            mempool,
            last_sync: None,
            subtree_roots_loaded: false,
            chain_tip: None,
            birthday: meta.birthday,
            views,
            transparent_in_compact: true,
            view_only,
            _lock: lock,
        })
    }

    /// The account's UFVK as stored in the wallet database (read-only, no lock).
    fn stored_ufvk(dir: &Path, params: &Network) -> anyhow::Result<UnifiedFullViewingKey> {
        let ro = rusqlite::Connection::open_with_flags(
            dir.join(DB_FILE),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let s: String = ro.query_row("SELECT ufvk FROM accounts ORDER BY id LIMIT 1", [], |r| r.get(0))?;
        UnifiedFullViewingKey::decode(params, &s).map_err(|e| anyhow!("stored viewing key is corrupt: {e}"))
    }

    /// A watch-only wallet: the account is imported from a UFVK (`AccountPurpose::ViewOnly`), so
    /// the database never holds spend information and there is no seed file to protect.
    async fn create_view_only(opts: &Opts, client: &mut Client, params: &Network, ufvk: &str) -> anyhow::Result<()> {
        let dir = &opts.data_dir;
        let ufvk = keys::decode_ufvk(params, ufvk)?;
        let tip = client
            .get_latest_block(service::ChainSpec::default())
            .await?
            .into_inner()
            .height as u32;
        let sapling_activation = u32::from(params.activation_height(NetworkUpgrade::Sapling).unwrap());
        let birthday_height = opts.birthday.unwrap_or(tip.saturating_sub(100)).max(sapling_activation + 1);
        let treestate = client
            .get_tree_state(service::BlockId { height: u64::from(birthday_height - 1), hash: vec![] })
            .await
            .context("GetTreeState for the wallet birthday")?
            .into_inner();
        let birthday = AccountBirthday::from_treestate(treestate, None)
            .map_err(|e| anyhow!("bad tree state from server: {e:?}"))?;

        let db_path = dir.join(DB_FILE);
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", db_path.display()));
        }
        let mut db = WalletDb::for_path(&db_path, *params, SystemClock, os_rng())?;
        init_wallet_db(&mut db, None).map_err(|e| anyhow!("initialising wallet database: {e:?}"))?;
        let account = db.import_account_ufvk("silicr-watch", &ufvk, &birthday, AccountPurpose::ViewOnly, Some("silicr export-viewing-key"))?;

        let meta = WalletMeta {
            network: chain_name(*params).into(),
            birthday: birthday_height,
            account_uuid: account.id().expose_uuid().to_string(),
            created_unix: now_unix(),
            created_by: format!("zec-sidecar {}", env!("CARGO_PKG_VERSION")),
            view_only: true,
        };
        let tmp = dir.join(format!("{META_FILE}.tmp"));
        write_private(&tmp, &serde_json::to_vec_pretty(&meta)?, false)?;
        fs::rename(&tmp, dir.join(META_FILE))?;
        info!("created watch-only {} wallet in {} with birthday {birthday_height} (no spending key)", chain_name(*params), dir.display());
        Ok(())
    }

    /// Watch-only: created from a viewing key, or opened with --view-only. Never spends.
    pub fn view_only(&self) -> bool {
        self.view_only
    }

    /// The wallet's Orchard-only unified full viewing key. Reveals every payment this wallet ever
    /// sent or received (amounts, memos, all of its addresses); never spending authority.
    pub fn export_viewing_key(&self) -> anyhow::Result<String> {
        keys::orchard_only_ufvk(&self.params, &self.ufvk)
    }

    async fn create(opts: &Opts, client: &mut Client, params: &Network) -> anyhow::Result<()> {
        let dir = &opts.data_dir;
        let tip = client
            .get_latest_block(service::ChainSpec::default())
            .await?
            .into_inner()
            .height as u32;
        let sapling_activation = u32::from(params.activation_height(NetworkUpgrade::Sapling).unwrap());
        let birthday_height = opts.birthday.unwrap_or(tip.saturating_sub(100)).max(sapling_activation + 1);

        // Reuse a seed from an interrupted init (no address can have been handed out yet).
        let seed_path = dir.join(SEED_FILE);
        if !seed_path.exists() {
            let m = Mnemonic::<English>::generate(Count::Words24);
            let mut phrase = format!("{}\n", m.phrase());
            write_private(&seed_path, phrase.as_bytes(), true)?;
            phrase.zeroize();
        }
        let seed = read_seed(dir)?;

        let treestate = client
            .get_tree_state(service::BlockId { height: u64::from(birthday_height - 1), hash: vec![] })
            .await
            .context("GetTreeState for the wallet birthday")?
            .into_inner();
        let birthday = AccountBirthday::from_treestate(treestate, None)
            .map_err(|e| anyhow!("bad tree state from server: {e:?}"))?;

        let db_path = dir.join(DB_FILE);
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", db_path.display()));
        }
        let mut db = WalletDb::for_path(&db_path, *params, SystemClock, os_rng())?;
        init_wallet_db(&mut db, None).map_err(|e| anyhow!("initialising wallet database: {e:?}"))?;
        let (account, _) = db.create_account("silicr", &seed, &birthday, None)?;

        let meta = WalletMeta {
            network: chain_name(*params).into(),
            birthday: birthday_height,
            account_uuid: account.expose_uuid().to_string(),
            created_unix: now_unix(),
            created_by: format!("zec-sidecar {}", env!("CARGO_PKG_VERSION")),
            view_only: false,
        };
        let tmp = dir.join(format!("{META_FILE}.tmp"));
        write_private(&tmp, &serde_json::to_vec_pretty(&meta)?, false)?;
        fs::rename(&tmp, dir.join(META_FILE))?;
        info!("created {} wallet in {} with birthday {birthday_height}", chain_name(*params), dir.display());
        Ok(())
    }

    pub fn ufvks(&self) -> HashMap<AccountUuid, UnifiedFullViewingKey> {
        HashMap::from([(self.account, self.ufvk.clone())])
    }

    pub fn birthday(&self) -> u32 {
        self.birthday
    }

    fn confirmations(&self) -> ConfirmationsPolicy {
        let t = NonZeroU32::new(self.opts.trusted_confirmations.max(1)).unwrap();
        let u = NonZeroU32::new(self.opts.untrusted_confirmations.max(self.opts.trusted_confirmations).max(1)).unwrap();
        ConfirmationsPolicy::new(t, u).unwrap_or_default()
    }

    pub fn sync_age(&self) -> Option<Duration> {
        self.last_sync.map(|t| t.elapsed())
    }

    pub fn last_known_tip(&self) -> Option<u32> {
        self.chain_tip.map(u32::from)
    }

    // ------------------------------------------------------------------ sync

    async fn update_subtree_roots(&mut self) -> anyhow::Result<()> {
        let mut req = service::GetSubtreeRootsArg::default();
        req.set_shielded_protocol(service::ShieldedProtocol::Sapling);
        let sapling_roots: Vec<CommitmentTreeRoot<sapling::Node>> = self
            .client
            .get_subtree_roots(req)
            .await?
            .into_inner()
            .map_err(anyhow::Error::from)
            .and_then(|r| async move {
                Ok(CommitmentTreeRoot::from_parts(
                    BlockHeight::from_u32(r.completing_block_height as u32),
                    sapling::Node::read(&r.root_hash[..])?,
                ))
            })
            .try_collect()
            .await?;
        self.db.put_sapling_subtree_roots(0, &sapling_roots)?;

        for (proto, name) in [
            (service::ShieldedProtocol::Orchard, "orchard"),
            (service::ShieldedProtocol::Ironwood, "ironwood"),
        ] {
            let mut req = service::GetSubtreeRootsArg::default();
            req.set_shielded_protocol(proto);
            let roots: Vec<CommitmentTreeRoot<MerkleHashOrchard>> = self
                .client
                .get_subtree_roots(req)
                .await?
                .into_inner()
                .map_err(anyhow::Error::from)
                .and_then(|r| async move {
                    Ok(CommitmentTreeRoot::from_parts(
                        BlockHeight::from_u32(r.completing_block_height as u32),
                        MerkleHashOrchard::read(&r.root_hash[..])?,
                    ))
                })
                .try_collect()
                .await?;
            debug!("{name} tree has {} subtrees", roots.len());
            if name == "orchard" {
                self.db.put_orchard_subtree_roots(0, &roots)?;
            } else {
                self.db.put_ironwood_subtree_roots(0, &roots)?;
            }
        }
        Ok(())
    }

    async fn latest_block(&mut self) -> anyhow::Result<(BlockHeight, BlockHash)> {
        let latest = self
            .client
            .get_latest_block(service::ChainSpec::default())
            .await
            .context("GetLatestBlock")?
            .into_inner();
        let h = BlockHeight::from_u32(u32::try_from(latest.height).context("tip height")?);
        let hash = BlockHash(
            latest.hash.as_slice().try_into().map_err(|_| anyhow!("tip hash was not 32 bytes"))?,
        );
        Ok((h, hash))
    }

    pub async fn tip(&mut self) -> anyhow::Result<u32> {
        let (h, _) = self.latest_block().await?;
        self.chain_tip = Some(h);
        Ok(u32::from(h))
    }

    fn rewind(&mut self, at: BlockHeight, requested: BlockHeight) -> anyhow::Result<()> {
        let h = match self.db.truncate_to_height(requested) {
            Ok(h) => h,
            Err(SqliteClientError::RequestedRewindInvalid { .. }) => {
                self.db.truncate_to_height(at.saturating_sub(2)).map_err(|e| {
                    anyhow!("unrecoverable reorg at {at}: {e:?}; delete the wallet's data.sqlite to resync from the birthday")
                })?
            }
            Err(e) => return Err(e.into()),
        };
        info!("rewound wallet to {h} after a reorg at {at}");
        self.views.truncate_above(u32::from(h))?;
        if let Some(tip) = self.chain_tip {
            self.db.update_chain_tip(tip)?;
        }
        Ok(())
    }

    /// Downloads compact blocks. Transparent data is requested too (everyone may ask for it, so it
    /// reveals nothing) so that compact-block views know the transparent input/output counts; the
    /// scanner ignores it. Falls back to shielded-only blocks if the server refuses pool types.
    async fn download_blocks(&mut self, start: BlockHeight, end_exclusive: BlockHeight) -> anyhow::Result<Vec<CompactBlock>> {
        let all_pools = vec![
            service::PoolType::Transparent as i32,
            service::PoolType::Sapling as i32,
            service::PoolType::Orchard as i32,
            service::PoolType::Ironwood as i32,
        ];
        let range = |pool_types: Vec<i32>| service::BlockRange {
            start: Some(service::BlockId { height: u64::from(start), hash: vec![] }),
            end: Some(service::BlockId { height: u64::from(end_exclusive - 1), hash: vec![] }),
            pool_types,
        };
        if self.transparent_in_compact {
            match self.client.get_block_range(range(all_pools)).await {
                Ok(resp) => {
                    return resp.into_inner().try_collect().await.context("streaming compact blocks");
                }
                Err(status) if status.code() == tonic::Code::InvalidArgument || status.code() == tonic::Code::Unimplemented => {
                    warn!("server refuses pool_types ({status}); compact-block views will not know transparent counts");
                    self.transparent_in_compact = false;
                }
                Err(status) => return Err(anyhow!("GetBlockRange: {status}")),
            }
        }
        self.client
            .get_block_range(range(vec![]))
            .await
            .context("GetBlockRange")?
            .into_inner()
            .try_collect()
            .await
            .context("streaming compact blocks")
    }

    /// Keeps a compact-block summary of every transaction in `blocks` that the wallet recorded
    /// (received or spent notes), for inspectTx views without a server request.
    fn record_compact_summaries(&self, blocks: &[CompactBlock], start: BlockHeight, end: BlockHeight) -> anyhow::Result<()> {
        for (txid, summary) in
            views::relevant_summaries(&self.ro, blocks, u32::from(start), u32::from(end), self.transparent_in_compact)?
        {
            self.views.put_compact(&txid, &summary)?;
        }
        Ok(())
    }

    pub async fn sync(&mut self) -> anyhow::Result<SyncReport> {
        let started = Instant::now();
        if !self.subtree_roots_loaded {
            self.update_subtree_roots().await.context("downloading note commitment subtree roots")?;
            self.subtree_roots_loaded = true;
        }
        let mut scanned = 0u32;
        let mut tip = BlockHeight::from_u32(0);
        for _ in 0..100_000 {
            let (t, tip_hash) = self.latest_block().await?;
            tip = t;
            self.chain_tip = Some(t);
            self.db.update_chain_tip(t)?;

            // A tip below our scanned height is only a reorg if the hashes disagree.
            if let Some(max_scanned) = self.db.block_max_scanned()?.map(|b| b.block_height()) {
                let diverged = t < max_scanned
                    && self.db.block_metadata(t)?.map(|m| m.block_hash()) != Some(tip_hash);
                if diverged {
                    self.rewind(t, t.saturating_sub(REORG_MARGIN))?;
                    continue;
                }
            }

            let ranges = self.db.suggest_scan_ranges()?;
            let Some(range) = ranges.into_iter().next() else { break };
            let start = range.block_range().start;
            let end = std::cmp::min(range.block_range().end, start + BATCH_BLOCKS);
            if end <= start {
                break;
            }
            let blocks = self.download_blocks(start, end).await?;
            if blocks.is_empty() {
                warn!("server returned no blocks for {start}..{end}; will retry later");
                break;
            }
            let chain_state = self
                .client
                .get_tree_state(service::BlockId { height: u64::from(start - 1), hash: vec![] })
                .await
                .context("GetTreeState")?
                .into_inner()
                .to_chain_state()
                .map_err(|e| anyhow!("bad tree state: {e:?}"))?;
            let n = blocks.len();
            let source = MemBlocks(blocks);
            match scan_cached_blocks(&self.params, &source, &mut self.db, start, &chain_state, n) {
                Ok(_) => {
                    scanned += n as u32;
                    if let Err(e) = self.record_compact_summaries(&source.0, start, end) {
                        warn!("could not keep compact-block summaries: {e:#}");
                    }
                }
                Err(ChainError::Scan(err)) if err.is_continuity_error() => {
                    let at = err.at_height();
                    warn!("chain reorg detected at {at}");
                    self.rewind(at, at.saturating_sub(REORG_MARGIN))?;
                }
                Err(e) => bail!("scanning blocks {start}..{end}: {e:?}"),
            }
        }
        self.enhance().await?;
        self.last_sync = Some(Instant::now());
        let fully = self.db.block_fully_scanned()?.map(|m| u32::from(m.block_height()));
        let report = SyncReport { tip: u32::from(tip), scanned_blocks: scanned, fully_scanned: fully, ms: started.elapsed().as_millis() };
        if scanned > 0 {
            info!("synced {scanned} blocks to {} in {} ms", report.tip, report.ms);
        }
        Ok(report)
    }

    /// Downloads full transactions the wallet needs (memos, mined status). Transactions the
    /// mempool watcher already holds are used directly, without a per-txid request.
    async fn enhance(&mut self) -> anyhow::Result<()> {
        let tip = self.chain_tip.or(self.db.chain_height()?).ok_or_else(|| anyhow!("no chain tip yet"))?;
        let mut done = BTreeSet::new();
        for _ in 0..50 {
            let mut progressed = false;
            for req in self.db.transaction_data_requests()? {
                if !done.insert(req.clone()) {
                    continue;
                }
                progressed = true;
                match req {
                    TransactionDataRequest::GetStatus(txid) => {
                        let status = match inspect::fetch_raw(&mut self.client, &txid).await? {
                            None => TransactionStatus::TxidNotRecognized,
                            Some(raw) => inspect::mined_height(&raw)
                                .map_or(TransactionStatus::NotInMainChain, TransactionStatus::Mined),
                        };
                        self.db.set_transaction_status(txid, status)?;
                    }
                    TransactionDataRequest::Enhancement(txid) => {
                        let cached = self
                            .mempool
                            .lock()
                            .ok()
                            .and_then(|m| m.raw.get(&txid).map(|(b, _)| b.clone()));
                        let parsed = match cached {
                            Some(bytes) => {
                                let raw = service::RawTransaction { data: bytes, height: 0 };
                                // Height comes from the wallet's own scan of the block.
                                inspect::parse_raw(&self.params, tip, &raw).ok().map(|tx| (tx, None))
                            }
                            None => None,
                        };
                        let parsed = match parsed {
                            Some(p) => Some(p),
                            None => match inspect::fetch_raw(&mut self.client, &txid).await? {
                                None => {
                                    self.db.set_transaction_status(txid, TransactionStatus::TxidNotRecognized)?;
                                    None
                                }
                                Some(raw) => {
                                    let h = inspect::mined_height(&raw);
                                    Some((inspect::parse_raw(&self.params, tip, &raw)?, h))
                                }
                            },
                        };
                        if let Some((tx, h)) = parsed {
                            decrypt_and_store_transaction(&self.params, &mut self.db, &tx, h)?;
                        }
                    }
                }
            }
            if !progressed {
                break;
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------- addresses

    /// The default address: the Orchard-only UA at diversifier index 0. Stable.
    pub fn address(&self) -> anyhow::Result<String> {
        let ua = self
            .ufvk
            .address(DiversifierIndex::new(), UnifiedAddressRequest::ORCHARD)
            .map_err(|e| anyhow!("address derivation failed: {e:?}"))?;
        Ok(ua.encode(&self.params))
    }

    /// A fresh diversified Orchard-only UA (persisted, never reused).
    pub fn new_address(&mut self) -> anyhow::Result<(String, String)> {
        for _ in 0..4 {
            let (ua, idx) = self
                .db
                .get_next_available_address(self.account, UnifiedAddressRequest::ORCHARD)?
                .ok_or_else(|| anyhow!("account not found"))?;
            if idx == DiversifierIndex::new() {
                continue;
            }
            if ua.orchard().is_none() || ua.sapling().is_some() || ua.transparent().is_some() {
                bail!("address generation produced a non-Orchard-only address");
            }
            return Ok((ua.encode(&self.params), hex::encode(idx.as_bytes())));
        }
        bail!("could not allocate a fresh diversifier index")
    }

    fn label_for_diversifier(&self, d: [u8; 11]) -> anyhow::Result<String> {
        let fvk = self.ufvk.orchard().ok_or_else(|| anyhow!("no Orchard key"))?;
        let a = fvk.address(orchard::keys::Diversifier::from_bytes(d), orchard::keys::Scope::External);
        Ok(encode_orchard(&self.params, a))
    }

    // --------------------------------------------------------------- balance

    pub fn balance(&self) -> anyhow::Result<BalanceView> {
        let summary = self.db.get_wallet_summary(self.confirmations())?;
        let bal = summary.as_ref().and_then(|s| s.account_balances().get(&self.account));
        let pb = |b: Option<&zcash_client_backend::data_api::Balance>| PoolBalance {
            spendable: b.map_or(0, |b| b.spendable_value().into_u64()).to_string(),
            change_pending: b.map_or(0, |b| b.change_pending_confirmation().into_u64()).to_string(),
            value_pending: b.map_or(0, |b| b.value_pending_spendability().into_u64()).to_string(),
        };
        let iw = bal.map(|b| b.ironwood_balance());
        let spendable = iw.map_or(0, |b| b.spendable_value().into_u64());
        let pending_db = iw.map_or(0, |b| {
            b.change_pending_confirmation().into_u64() + b.value_pending_spendability().into_u64()
        });
        let known = self.db_note_keys()?;
        let mempool_incoming: u64 = self
            .mempool
            .lock()
            .map(|m| m.notes.values().filter(|n| !known.contains(&(n.txid, n.index))).map(|n| n.zats).sum())
            .unwrap_or(0);
        Ok(BalanceView {
            spendable: spendable.to_string(),
            pending: (pending_db + mempool_incoming).to_string(),
            mempool_incoming: mempool_incoming.to_string(),
            ironwood: pb(iw),
            legacy_orchard: pb(bal.map(|b| b.orchard_balance())),
            sapling: pb(bal.map(|b| b.sapling_balance())),
            synced: summary.is_some(),
        })
    }

    // ------------------------------------------------------------------ poll

    fn db_note_keys(&self) -> anyhow::Result<BTreeSet<(TxId, usize)>> {
        let mut keys = BTreeSet::new();
        for table in ["ironwood_received_notes", "orchard_received_notes"] {
            let mut stmt = self.ro.prepare_cached(&format!(
                "SELECT t.txid, n.action_index FROM {table} n JOIN transactions t ON t.id_tx = n.transaction_id WHERE t.mined_height IS NOT NULL"
            ))?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, i64>(1)?)))?;
            for row in rows {
                let (txid, idx) = row?;
                if let Ok(b) = <[u8; 32]>::try_from(txid) {
                    keys.insert((TxId::from_bytes(b), idx as usize));
                }
            }
        }
        Ok(keys)
    }

    /// Notes received at this wallet's external (Orchard-receiver) addresses mined at
    /// height >= since, plus all unconfirmed ones (wallet DB and mempool).
    pub fn poll(&self, since: u32) -> anyhow::Result<Vec<NoteView>> {
        let tip = self.chain_tip.map(u32::from).unwrap_or(0);
        let mut out: Vec<NoteView> = vec![];
        let mut seen: BTreeSet<(String, usize)> = BTreeSet::new();
        let mut mined_txids: BTreeSet<TxId> = BTreeSet::new();
        for (table, value_pool, offset) in [
            ("ironwood_received_notes", "ironwood", 0usize),
            ("orchard_received_notes", "orchard", ORCHARD_INDEX_OFFSET),
        ] {
            let mut stmt = self.ro.prepare_cached(&format!(
                "SELECT t.txid, n.action_index, t.mined_height, n.diversifier, n.value, n.memo, t.expiry_height
                 FROM {table} n JOIN transactions t ON t.id_tx = n.transaction_id
                 WHERE n.recipient_key_scope = 0
                   AND (t.mined_height >= ?1 OR t.mined_height IS NULL)
                 ORDER BY COALESCE(t.mined_height, 4294967295), t.id_tx, n.action_index"
            ))?;
            let rows = stmt.query_map([since as i64], |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<Vec<u8>>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                ))
            })?;
            for row in rows {
                let (txid, idx, height, div, value, memo, expiry) = row?;
                let Ok(txid_b) = <[u8; 32]>::try_from(txid) else { continue };
                let txid = TxId::from_bytes(txid_b);
                let Some(memo) = memo else {
                    debug!("note {txid}:{idx} awaiting memo (enhancement)");
                    continue;
                };
                if height.is_none() && expiry.is_some_and(|e| e > 0 && (e as u32) < tip) {
                    continue; // expired, never mined
                }
                let Ok(div) = <[u8; 11]>::try_from(div) else { continue };
                if height.is_some() {
                    mined_txids.insert(txid);
                }
                let index = idx as usize + offset;
                seen.insert((txid.to_string(), index));
                out.push(NoteView {
                    txid: txid.to_string(),
                    index,
                    height: height.map(|h| h as u32),
                    to_address: self.label_for_diversifier(div)?,
                    zats: value.to_string(),
                    memo_hex: hex::encode(expand_memo(memo)),
                    pool: "orchard",
                    value_pool,
                    source: "wallet",
                });
            }
        }
        // Mempool notes the wallet hasn't recorded (or has recorded only as unmined).
        let mined_any: BTreeSet<TxId> = mined_txids.union(&self.mined_txids_all()?).copied().collect();
        if let Ok(m) = self.mempool.lock() {
            let mut notes: Vec<_> = m.notes.values().cloned().collect();
            notes.sort_by_key(|n| (n.last_seen, n.index));
            for n in notes {
                let index = if n.value_pool == "orchard" { n.index + ORCHARD_INDEX_OFFSET } else { n.index };
                if mined_any.contains(&n.txid) || seen.contains(&(n.txid.to_string(), index)) {
                    continue;
                }
                out.push(NoteView {
                    txid: n.txid.to_string(),
                    index,
                    height: None,
                    to_address: n.to_address.clone(),
                    zats: n.zats.to_string(),
                    memo_hex: hex::encode(&n.memo),
                    pool: "orchard",
                    value_pool: n.value_pool,
                    source: "mempool",
                });
            }
        }
        Ok(out)
    }

    /// The audit ledger: every note received (external addresses and change) and every payment
    /// sent, from the wallet database, oldest first. Sent payments come from the outgoing
    /// viewing key, so a watch-only wallet made from the UFVK sees them too.
    pub fn ledger(&self) -> anyhow::Result<Vec<LedgerEntry>> {
        let mut out: Vec<(u64, i64, usize, LedgerEntry)> = vec![];
        for (table, value_pool, offset) in [
            ("ironwood_received_notes", "ironwood", 0usize),
            ("orchard_received_notes", "orchard", ORCHARD_INDEX_OFFSET),
        ] {
            let mut stmt = self.ro.prepare_cached(&format!(
                "SELECT t.txid, n.action_index, t.mined_height, n.diversifier, n.value, n.memo, t.fee, n.is_change, n.recipient_key_scope, t.id_tx
                 FROM {table} n JOIN transactions t ON t.id_tx = n.transaction_id
                 WHERE t.mined_height IS NOT NULL
                 ORDER BY t.mined_height, t.id_tx, n.action_index"
            ))?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<Vec<u8>>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, i64>(9)?,
                ))
            })?;
            for row in rows {
                let (txid, idx, height, div, value, memo, fee, is_change, scope, id_tx) = row?;
                let Ok(txid_b) = <[u8; 32]>::try_from(txid) else { continue };
                let Ok(div) = <[u8; 11]>::try_from(div) else { continue };
                let memo = expand_memo(memo.unwrap_or_default());
                let height = height as u32;
                let change = is_change != 0 || scope == Some(1);
                out.push((
                    u64::from(height),
                    id_tx,
                    idx as usize + offset,
                    LedgerEntry {
                        txid: TxId::from_bytes(txid_b).to_string(),
                        height: Some(height),
                        time: self.block_time(BlockHeight::from_u32(height)),
                        direction: if change { "change" } else { "received" },
                        zats: value.to_string(),
                        address: Some(self.label_for_diversifier(div)?),
                        memo_type: keys::memo_kind(&memo),
                        memo_hex: hex::encode(&memo),
                        fee_zats: fee.map(|f| f.to_string()),
                        value_pool,
                        index: idx as usize + offset,
                    },
                ));
            }
        }
        let mut stmt = self.ro.prepare_cached(
            "SELECT t.txid, s.output_index, t.mined_height, s.to_address, s.value, s.memo, t.fee, s.output_pool, t.id_tx
             FROM sent_notes s JOIN transactions t ON t.id_tx = s.transaction_id
             WHERE s.to_address IS NOT NULL AND t.mined_height IS NOT NULL
             ORDER BY t.mined_height, t.id_tx, s.output_index",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Vec<u8>>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<Vec<u8>>>(5)?,
                r.get::<_, Option<i64>>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })?;
        for row in rows {
            let (txid, idx, height, to, value, memo, fee, pool, id_tx) = row?;
            let Ok(txid_b) = <[u8; 32]>::try_from(txid) else { continue };
            let memo = expand_memo(memo.unwrap_or_default());
            let height = height as u32;
            // sent_notes.output_pool: 0 transparent, 2 Sapling, 3 legacy Orchard, 4 Ironwood.
            let (value_pool, offset) = match pool {
                4 => ("ironwood", 0),
                3 => ("orchard", ORCHARD_INDEX_OFFSET),
                2 => ("sapling", 2 * ORCHARD_INDEX_OFFSET),
                _ => ("transparent", 3 * ORCHARD_INDEX_OFFSET),
            };
            out.push((
                u64::from(height),
                id_tx,
                idx as usize + offset,
                LedgerEntry {
                    txid: TxId::from_bytes(txid_b).to_string(),
                    height: Some(height),
                    time: self.block_time(BlockHeight::from_u32(height)),
                    direction: "sent",
                    zats: value.to_string(),
                    address: Some(to),
                    memo_type: keys::memo_kind(&memo),
                    memo_hex: hex::encode(&memo),
                    fee_zats: fee.map(|f| f.to_string()),
                    value_pool,
                    index: idx as usize + offset,
                },
            ));
        }
        out.sort_by_key(|(h, id, i, e)| (*h, *id, e.direction == "sent", *i));
        Ok(out.into_iter().map(|(_, _, _, e)| e).collect())
    }

    fn mined_txids_all(&self) -> anyhow::Result<BTreeSet<TxId>> {
        let mut s = BTreeSet::new();
        let mut stmt = self.ro.prepare_cached("SELECT txid FROM transactions WHERE mined_height IS NOT NULL")?;
        for row in stmt.query_map([], |r| r.get::<_, Vec<u8>>(0))? {
            if let Ok(b) = <[u8; 32]>::try_from(row?) {
                s.insert(TxId::from_bytes(b));
            }
        }
        Ok(s)
    }

    // ------------------------------------------------------------------ send

    fn usk(&self) -> anyhow::Result<UnifiedSpendingKey> {
        let seed = read_seed(&self.opts.data_dir)?;
        let account = self.db.get_account(self.account)?.ok_or_else(|| anyhow!("account missing"))?;
        let derivation = account
            .source()
            .key_derivation()
            .ok_or_else(|| anyhow!("view-only account cannot spend"))?;
        UnifiedSpendingKey::from_seed(&self.params, seed.expose_secret(), derivation.account_index())
            .map_err(|e| anyhow!("spending key derivation failed: {e:?}"))
    }

    pub async fn send(&mut self, outputs: Vec<OutputReq>) -> Result<SendReport, WalletError> {
        if self.view_only {
            return Err(WalletError::ReadOnly(
                "this wallet is watch-only (opened from a viewing key): it can see every payment but holds no spending key, so it cannot send".into(),
            ));
        }
        if outputs.is_empty() {
            return Err(WalletError::BadRequest("send needs at least one output".into()));
        }
        if outputs.len() > MAX_OUTPUTS {
            return Err(WalletError::BadRequest(format!("at most {MAX_OUTPUTS} outputs per transaction")));
        }
        let mut payments = Vec::with_capacity(outputs.len());
        for (i, o) in outputs.iter().enumerate() {
            let (ua, _) = orchard_only(&self.params, &o.to).map_err(|m| WalletError::Privacy(format!("output {i}: {m}")))?;
            if o.memo.len() != 512 {
                return Err(WalletError::BadRequest(format!("output {i}: memo must be exactly 512 bytes, got {}", o.memo.len())));
            }
            let memo = MemoBytes::from_bytes(&o.memo).map_err(|e| WalletError::BadRequest(format!("output {i}: bad memo: {e:?}")))?;
            let zats = Zatoshis::from_u64(o.zats).map_err(|_| WalletError::BadRequest(format!("output {i}: bad amount")))?;
            let addr: zcash_address::ZcashAddress = ua.parse().map_err(|e| WalletError::Other(anyhow!("{e}")))?;
            payments.push(
                Payment::new(addr, Some(zats), Some(memo), None, None, vec![])
                    .map_err(|e| WalletError::BadRequest(format!("output {i}: {e:?}")))?,
            );
        }
        let request = TransactionRequest::new(payments).map_err(|e| WalletError::BadRequest(format!("{e:?}")))?;

        let t0 = Instant::now();
        let change_strategy = MultiOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Ironwood,
            DustOutputPolicy::default(),
            SplitPolicy::with_min_output_value(
                NonZeroUsize::new(self.opts.target_note_count.max(1)).unwrap(),
                Zatoshis::from_u64(self.opts.min_split_zats).map_err(|_| anyhow!("bad min split value"))?,
            ),
        );
        let input_selector = GreedyInputSelector::new();
        // Ironwood only: never draw on Sapling, legacy Orchard (turnstile) or transparent funds.
        let spend_policy = SpendPolicy::shielded_pools([ShieldedPool::Ironwood])
            .with_note_selection(NoteSelection::PreferSingle);
        let confirmations = self.confirmations();
        let untrusted_confs = self.opts.untrusted_confirmations;
        let proposal = propose_transfer::<_, _, _, _, std::convert::Infallible>(
            &mut self.db,
            &self.params,
            self.account,
            &input_selector,
            &change_strategy,
            request,
            confirmations,
            &spend_policy,
            None,
            None,
        )
        .map_err(|e| {
            use zcash_client_backend::data_api::error::Error as E;
            match &e {
                E::InsufficientFunds { available, required } => WalletError::InsufficientFunds {
                    available: Some(available.into_u64()),
                    required: Some(required.into_u64()),
                    detail: format!(
                        "insufficient spendable Ironwood funds: {} available, {} required (notes need {} confirmations; legacy Orchard/Sapling/transparent funds are never spent)",
                        available.into_u64(),
                        required.into_u64(),
                        untrusted_confs
                    ),
                },
                _ => {
                    let s = format!("{e}");
                    if s.to_ascii_lowercase().contains("insufficient") {
                        WalletError::InsufficientFunds { available: None, required: None, detail: s }
                    } else {
                        WalletError::Other(anyhow!("proposal failed: {s}"))
                    }
                }
            }
        })?;
        check_proposal(&proposal)?;
        let step = proposal.steps().first();
        let fee = step.balance().fee_required();
        let propose_ms = t0.elapsed().as_millis();

        let t1 = Instant::now();
        let usk = self.usk()?;
        let prover = LocalTxProver::bundled();
        let txids = tokio::task::block_in_place(|| {
            create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
                &mut self.db,
                &self.params,
                &SystemClock,
                &mut os_rng(),
                &prover,
                &prover,
                &SpendingKeys::from_unified_spending_key(usk),
                OvkPolicy::Sender,
                &proposal,
                None,
            )
        })
        .map_err(|e| WalletError::Other(anyhow!("building transaction failed: {e}")))?;
        if txids.len() != 1 {
            return Err(WalletError::Privacy("refusing a multi-transaction proposal".into()));
        }
        let txid = *txids.first();
        let prove_ms = t1.elapsed().as_millis();

        let tx = self
            .db
            .get_transaction(txid)
            .map_err(|e| anyhow!("reading built transaction: {e}"))?
            .ok_or_else(|| anyhow!("built transaction {txid} not found in wallet"))?;
        let actions = check_built_tx(&tx)?;
        let mut raw = service::RawTransaction::default();
        tx.write(&mut raw.data).map_err(|e| anyhow!("serialising tx: {e}"))?;
        // Keep the exact bytes locally, so inspectTx never has to ask the server for this tx.
        self.views.put_sent_raw(&txid, &raw.data, now_unix())?;

        let t2 = Instant::now();
        let mut last_err = None;
        for attempt in 0..3 {
            match self.client.send_transaction(raw.clone()).await {
                Ok(resp) => {
                    let r = resp.into_inner();
                    if r.error_code != 0 {
                        // Already-in-mempool on a retry is success.
                        if attempt > 0 && r.error_message.to_ascii_lowercase().contains("already") {
                            last_err = None;
                            break;
                        }
                        return Err(WalletError::Other(anyhow!(
                            "server rejected transaction {txid}: code {} {}; its inputs stay locked until expiry height {}",
                            r.error_code,
                            r.error_message,
                            u32::from(tx.expiry_height())
                        )));
                    }
                    last_err = None;
                    break;
                }
                Err(e) => {
                    warn!("broadcast attempt {} failed: {e}", attempt + 1);
                    last_err = Some(e);
                    tokio::time::sleep(Duration::from_millis(750 * (attempt + 1) as u64)).await;
                    if let Ok(c) = self.opts.server.connect().await {
                        self.client = c;
                    }
                }
            }
        }
        if let Some(e) = last_err {
            return Err(WalletError::Other(anyhow!("broadcast of {txid} failed: {e}")));
        }
        let broadcast_ms = t2.elapsed().as_millis();
        info!("broadcast {txid} ({} outputs, {actions} actions, fee {})", outputs.len(), fee.into_u64());
        Ok(SendReport {
            txid: txid.to_string(),
            fee_zats: fee.into_u64().to_string(),
            actions,
            propose_ms,
            prove_ms,
            broadcast_ms,
            expiry_height: u32::from(tx.expiry_height()),
        })
    }

    fn block_time(&self, height: BlockHeight) -> Option<u32> {
        self.ro
            .query_row("SELECT time FROM blocks WHERE height = ?1", [u32::from(height) as i64], |r| r.get::<_, i64>(0))
            .ok()
            .map(|t| t as u32)
    }

    /// The public view of `txid` built only from data this wallet already holds, in order of
    /// precedence: the bytes of our own broadcast, bytes the wallet stored while syncing (memo
    /// enhancement or the mempool stream), a mempool-stream copy, or the compact-block summary
    /// kept during sync. Never asks the server: GetTransaction(txid) would tell its operator that
    /// this IP cares about that transaction.
    pub fn inspect_local(&self, txid_hex: &str) -> Result<inspect::PublicTxView, WalletError> {
        let txid = inspect::parse_txid(txid_hex).map_err(|e| WalletError::BadRequest(format!("{e:#}")))?;
        let compact = self.views.compact(&txid)?;
        let height = self
            .db
            .get_tx_height(txid)
            .map_err(|e| anyhow!("reading tx height: {e}"))?
            .or(compact.as_ref().map(|c| BlockHeight::from_u32(c.height)));
        let time = compact.as_ref().map(|c| c.time).or_else(|| height.and_then(|h| self.block_time(h)));
        let tip = self.chain_tip.unwrap_or_else(|| BlockHeight::from_u32(0));
        let branch = zcash_protocol::consensus::BranchId::for_height(&self.params, height.unwrap_or(tip + 1));
        let no_prevouts = HashMap::new();

        if let Some(raw) = self.views.sent_raw(&txid)? {
            let tx = Transaction::read(&raw[..], branch).map_err(|e| anyhow!("parsing stored tx: {e}"))?;
            return Ok(inspect::view(&tx, raw.len(), height, time, &no_prevouts, "broadcast"));
        }
        if let Some(tx) = self.db.get_transaction(txid).map_err(|e| anyhow!("reading stored tx: {e}"))? {
            let mut bytes = vec![];
            tx.write(&mut bytes).map_err(|e| anyhow!("serialising tx: {e}"))?;
            return Ok(inspect::view(&tx, bytes.len(), height, time, &no_prevouts, "wallet"));
        }
        let cached = self.mempool.lock().ok().and_then(|m| m.raw.get(&txid).map(|(b, _)| b.clone()));
        if let Some(bytes) = cached {
            let tx = Transaction::read(&bytes[..], branch).map_err(|e| anyhow!("parsing mempool tx: {e}"))?;
            return Ok(inspect::view(&tx, bytes.len(), height, time, &no_prevouts, "mempool"));
        }
        if let Some(c) = compact {
            return Ok(inspect::compact_view(&c));
        }
        Err(WalletError::TxNotKnown(format!(
            "transaction {txid_hex} is unknown to this wallet: it did not broadcast it, has not seen it in the mempool stream and has not scanned a block where it touches this wallet. Silicr never asks the light-wallet server about other transactions, because the request would tie this IP to that txid."
        )))
    }
}

/// The proposal must be one step, spend only Ironwood notes and pay/change only into Ironwood.
fn check_proposal<F, N>(proposal: &zcash_client_backend::proposal::Proposal<F, N>) -> Result<(), WalletError> {
    if proposal.steps().len() != 1 {
        return Err(WalletError::Privacy("refusing a multi-step proposal (would route through transparent ephemeral addresses)".into()));
    }
    let step = proposal.steps().first();
    if step.is_shielding() || step.input_in_pool(PoolType::TRANSPARENT) || !step.prior_step_inputs().is_empty() {
        return Err(WalletError::Privacy("refusing a proposal with transparent inputs".into()));
    }
    for pool in [PoolType::SAPLING, PoolType::ORCHARD] {
        if step.input_in_pool(pool) {
            return Err(WalletError::Privacy(format!(
                "refusing to spend {pool} notes: crossing into Ironwood would reveal the amount"
            )));
        }
    }
    for (i, pool) in step.payment_pools() {
        if *pool != PoolType::IRONWOOD {
            return Err(WalletError::Privacy(format!("refusing payment {i} into the {pool} pool")));
        }
    }
    for c in step.balance().proposed_change() {
        if c.output_pool() != PoolType::IRONWOOD {
            return Err(WalletError::Privacy(format!("refusing change into the {} pool", c.output_pool())));
        }
    }
    Ok(())
}

/// Last check before broadcast: the transaction itself has only an Ironwood bundle.
fn check_built_tx(tx: &Transaction) -> Result<usize, WalletError> {
    if tx.transparent_bundle().is_some_and(|b| !b.vin.is_empty() || !b.vout.is_empty()) {
        return Err(WalletError::Privacy("built transaction has transparent parts; not broadcasting".into()));
    }
    if tx.sapling_bundle().is_some() {
        return Err(WalletError::Privacy("built transaction has a Sapling bundle; not broadcasting".into()));
    }
    if tx.orchard_bundle().is_some() {
        return Err(WalletError::Privacy("built transaction touches the legacy Orchard pool; not broadcasting".into()));
    }
    tx.ironwood_bundle()
        .map(|b| b.actions().len())
        .ok_or_else(|| WalletError::Privacy("built transaction has no Ironwood bundle; not broadcasting".into()))
}
