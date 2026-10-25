/**
 * Pure conversions between zec-sidecar JSON (decimal-string zats, hex bytes) and the
 * @silicr/zec contract types. No I/O, so it is unit-tested without a network or funds.
 */
import { hex } from '@scure/base';
import {
  InsufficientFundsError,
  MEMO_SIZE,
  PrivacyError,
  ReadOnlyError,
  type Balance,
  type PublicTxView,
  type ReceivedNote,
  type SendResult,
} from '../contract.ts';

/** The Zcash value pool a note actually lives in. Ironwood (NU6.3+) is the Orchard-protocol pool that
 *  receives all new value paid to Orchard receivers; "orchard" here means the legacy, withdraw-only pool. */
export type ValuePool = 'ironwood' | 'orchard';

/**
 * A received note. `pool` stays 'orchard' (the Orchard-receiver, Orchard-protocol family the
 * contract calls "orchard"); `valuePool` says which value pool the note is really in.
 */
export interface TestnetReceivedNote extends ReceivedNote {
  valuePool: ValuePool;
  /** 'wallet' = recorded by the wallet DB (mined, or our own unmined tx); 'mempool' = seen in the mempool stream. */
  source: 'wallet' | 'mempool';
}

export interface ActionsView {
  actions: number;
  valueBalanceZats: bigint;
  ciphertextSamples: string[];
}

/**
 * PublicTxView plus what NU6.3 added. `orchard` is the legacy Orchard bundle only; Ironwood
 * actions are reported separately in `ironwood` so a turnstile crossing (legacy Orchard value
 * leaving into Ironwood, which reveals the amount) is never hidden by summing the two.
 */
/**
 * Where an inspectTx view came from. inspectTx never asks the light-wallet server about a txid
 * (that request would tie this IP to the transaction); it uses only what the wallet already holds:
 * - 'broadcast': the exact bytes of a transaction this wallet built (kept at send time);
 * - 'wallet': bytes the wallet stored while syncing (memo enhancement or the mempool stream);
 * - 'mempool': a copy from the mempool stream, not yet stored;
 * - 'compact-block': a summary kept from a compact block the wallet scanned (see `complete`).
 */
export type TxViewSource = 'broadcast' | 'wallet' | 'mempool' | 'compact-block';

/** Fields a compact-block view cannot know exactly. */
export type EstimatedField = 'sizeBytes' | 'version' | 'feeZats' | 'valueBalances' | 'expiryHeight' | 'consensusBranchId' | 'transparent';

export interface TestnetPublicTxView extends PublicTxView {
  ironwood: ActionsView;
  /** null in compact-block views. */
  expiryHeight: number | null;
  /** null in compact-block views. */
  consensusBranchId: string | null;
  coinbase: boolean;
  /** No transparent or Sapling parts, and at least one Orchard-protocol action. */
  fullyShieldedOrchardProtocol: boolean;
  source: TxViewSource;
  /**
   * True when built from the full transaction: every field is exact. False for 'compact-block'
   * views: counts, heights, time and ciphertext samples are exact; `sizeBytes` is a formula
   * estimate (exact for shielded-only transactions); `version` is inferred; `feeZats` is null and
   * every `valueBalanceZats` is reported as 0n but unknown. `estimated` lists those fields.
   */
  complete: boolean;
  estimated: EstimatedField[];
}

/** inspectTx on a transaction this wallet holds no local data about (it never asks the server). */
export class TxNotKnownError extends Error {
  override name = 'TxNotKnownError';
}

export interface SendReport extends SendResult {
  actions: number;
  proposeMs: number;
  proveMs: number;
  broadcastMs: number;
  expiryHeight: number;
}

export interface TestnetBalance extends Balance {
  /** Part of `pending` seen only in the mempool so far. */
  mempoolIncoming: bigint;
  /** Funds in the legacy Orchard pool. Never spent by this backend: leaving it crosses the turnstile, which reveals the amount. */
  legacyOrchardZats: bigint;
  synced: boolean;
}

/** Silicr message types a ledger can name; anything else is `none`, `text`, `binary` or `silicr:unknown`. */
export type LedgerMemoType = 'RFQ' | 'BID' | 'ACCEPT' | 'PAY' | 'CLOSE' | 'silicr:unknown' | 'none' | 'text' | 'binary';

/**
 * One row of the audit ledger (`ledger()`): a note this wallet received, its own change, or a
 * payment it sent (recovered with the outgoing viewing key, so a watch-only wallet sees them too).
 */
export interface LedgerEntry {
  txid: string;
  height: number;
  /** Block time, unix seconds, when the wallet knows it. */
  time: number | null;
  direction: 'received' | 'sent' | 'change';
  zats: bigint;
  /** received/change: the receiving Orchard-only address; sent: the recipient. */
  address: string | null;
  memoType: LedgerMemoType;
  memo: Uint8Array;
  /** The transaction's fee when known (always for the wallet's own sends). */
  feeZats: bigint | null;
  valuePool: 'ironwood' | 'orchard' | 'sapling' | 'transparent';
  index: number;
}

export interface Ledger {
  entries: LedgerEntry[];
  tip: number | null;
  birthday: number;
  viewOnly: boolean;
}

export class SidecarProtocolError extends Error {
  override name = 'SidecarProtocolError';
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new SidecarProtocolError(`expected string field ${k}`);
  return v;
}

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SidecarProtocolError(`expected number field ${k}`);
  return v;
}

function optNum(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SidecarProtocolError(`expected number|null field ${k}`);
  return v;
}

/** Decimal string (or safe integer) → bigint. */
export function zats(v: unknown, field = 'zats'): bigint {
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new SidecarProtocolError(`expected decimal zatoshi string for ${field}, got ${JSON.stringify(v)}`);
}

/**
 * A memo field as the sidecar reports it, always returned as the full 512 bytes. A memo shorter
 * than that is the same memo with its ZIP 302 null padding stripped (librustzcash's
 * `MemoBytes::as_slice()` does exactly that), so it is padded back here rather than refused: a
 * refused memo would have dropped the whole poll, Silicr messages included. Only a memo longer
 * than 512 bytes is malformed.
 */
export function memoFromHex(h: string): Uint8Array {
  const bytes = hex.decode(h.toLowerCase());
  if (bytes.length > MEMO_SIZE) throw new SidecarProtocolError(`memo must be at most ${MEMO_SIZE} bytes, got ${bytes.length}`);
  if (bytes.length === MEMO_SIZE) return bytes;
  const full = new Uint8Array(MEMO_SIZE);
  full.set(bytes);
  return full;
}

export function memoToHex(m: Uint8Array): string {
  if (!(m instanceof Uint8Array) || m.length !== MEMO_SIZE) {
    throw new TypeError(`memo must be a ${MEMO_SIZE}-byte Uint8Array`);
  }
  return hex.encode(m);
}

export function parseNote(v: unknown): TestnetReceivedNote {
  if (!isObj(v)) throw new SidecarProtocolError('note must be an object');
  const valuePool = str(v, 'valuePool');
  if (valuePool !== 'ironwood' && valuePool !== 'orchard') {
    throw new SidecarProtocolError(`unexpected value pool ${valuePool}`);
  }
  const source = str(v, 'source');
  if (source !== 'wallet' && source !== 'mempool') throw new SidecarProtocolError(`unexpected note source ${source}`);
  const txid = str(v, 'txid');
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new SidecarProtocolError(`bad txid ${txid}`);
  const index = num(v, 'index');
  if (!Number.isSafeInteger(index) || index < 0) throw new SidecarProtocolError(`bad note index ${index}`);
  return {
    txid,
    index,
    height: optNum(v, 'height'),
    toAddress: str(v, 'toAddress'),
    zats: zats(v['zats']),
    memo: memoFromHex(str(v, 'memoHex')),
    pool: 'orchard',
    valuePool,
    source,
  };
}

export function parsePollResult(v: unknown): TestnetReceivedNote[] {
  if (!isObj(v) || !Array.isArray(v['notes'])) throw new SidecarProtocolError('poll result must have notes[]');
  return v['notes'].map(parseNote);
}

/**
 * How fresh a read-only answer (poll, height) is. `stale` means the sidecar could not reach the
 * light-wallet server and answered from what the wallet already holds; `syncError` says why.
 * Older sidecars send none of these fields: then the answer is taken as fresh.
 */
export interface Freshness {
  stale: boolean;
  syncError: string | null;
  /** Milliseconds since the wallet last synced; null before the first sync. */
  syncAgeMs: number | null;
  /** The wallet's last known chain tip (poll answers only). */
  tip: number | null;
}

export function parseFreshness(v: unknown): Freshness {
  if (!isObj(v)) throw new SidecarProtocolError('sidecar answer must be an object');
  const err = v['syncError'];
  return {
    stale: v['stale'] === true,
    syncError: typeof err === 'string' && err !== '' ? err : null,
    syncAgeMs: optNum(v, 'syncAgeMs'),
    tip: optNum(v, 'tip'),
  };
}

export function parseBalance(v: unknown): TestnetBalance {
  if (!isObj(v)) throw new SidecarProtocolError('balance must be an object');
  const legacy = v['legacyOrchard'];
  let legacyOrchardZats = 0n;
  if (isObj(legacy)) {
    legacyOrchardZats =
      zats(legacy['spendable'], 'legacyOrchard.spendable') +
      zats(legacy['changePending'], 'legacyOrchard.changePending') +
      zats(legacy['valuePending'], 'legacyOrchard.valuePending');
  }
  return {
    spendable: zats(v['spendable'], 'spendable'),
    pending: zats(v['pending'], 'pending'),
    mempoolIncoming: zats(v['mempoolIncoming'] ?? '0', 'mempoolIncoming'),
    legacyOrchardZats,
    synced: v['synced'] === true,
  };
}

export function parseSendResult(v: unknown): SendReport {
  if (!isObj(v)) throw new SidecarProtocolError('send result must be an object');
  const txid = str(v, 'txid');
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new SidecarProtocolError(`bad txid ${txid}`);
  return {
    txid,
    feeZats: zats(v['feeZats'], 'feeZats'),
    actions: num(v, 'actions'),
    proposeMs: num(v, 'proposeMs'),
    proveMs: num(v, 'proveMs'),
    broadcastMs: num(v, 'broadcastMs'),
    expiryHeight: num(v, 'expiryHeight'),
  };
}

function parseActions(v: unknown, field: string): ActionsView {
  if (!isObj(v)) throw new SidecarProtocolError(`${field} must be an object`);
  const samples = v['ciphertextSamples'];
  if (!Array.isArray(samples) || !samples.every((s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s))) {
    throw new SidecarProtocolError(`${field}.ciphertextSamples must be 32-byte hex strings`);
  }
  return {
    actions: num(v, 'actions'),
    valueBalanceZats: zats(v['valueBalanceZats'], `${field}.valueBalanceZats`),
    ciphertextSamples: samples as string[],
  };
}

export function parseTxView(v: unknown): TestnetPublicTxView {
  if (!isObj(v)) throw new SidecarProtocolError('tx view must be an object');
  const t = v['transparent'];
  const s = v['sapling'];
  if (!isObj(t) || !isObj(s)) throw new SidecarProtocolError('tx view missing transparent/sapling');
  const fee = v['feeZats'];
  return {
    txid: str(v, 'txid'),
    height: optNum(v, 'height'),
    time: optNum(v, 'time'),
    version: num(v, 'version'),
    sizeBytes: num(v, 'sizeBytes'),
    feeZats: fee === null || fee === undefined ? null : zats(fee, 'feeZats'),
    transparent: { inputs: num(t, 'inputs'), outputs: num(t, 'outputs') },
    sapling: {
      spends: num(s, 'spends'),
      outputs: num(s, 'outputs'),
      valueBalanceZats: zats(s['valueBalanceZats'], 'sapling.valueBalanceZats'),
    },
    orchard: parseActions(v['orchard'], 'orchard'),
    ironwood: parseActions(v['ironwood'], 'ironwood'),
    expiryHeight: optNum(v, 'expiryHeight'),
    consensusBranchId: v['consensusBranchId'] === null || v['consensusBranchId'] === undefined ? null : str(v, 'consensusBranchId'),
    coinbase: t['coinbase'] === true,
    fullyShieldedOrchardProtocol: v['fullyShieldedOrchardProtocol'] === true,
    source: parseSource(v['source']),
    complete: v['complete'] === true,
    estimated: parseEstimated(v['estimated']),
  };
}

const SOURCES: readonly TxViewSource[] = ['broadcast', 'wallet', 'mempool', 'compact-block'];
const ESTIMATED: readonly EstimatedField[] = ['sizeBytes', 'version', 'feeZats', 'valueBalances', 'expiryHeight', 'consensusBranchId', 'transparent'];

function parseSource(v: unknown): TxViewSource {
  if (typeof v === 'string' && (SOURCES as readonly string[]).includes(v)) return v as TxViewSource;
  throw new SidecarProtocolError(`unexpected tx view source ${JSON.stringify(v)}`);
}

function parseEstimated(v: unknown): EstimatedField[] {
  if (!Array.isArray(v) || !v.every((f) => typeof f === 'string' && (ESTIMATED as readonly string[]).includes(f))) {
    throw new SidecarProtocolError('tx view estimated must list known field names');
  }
  return v as EstimatedField[];
}

const MEMO_TYPES: readonly LedgerMemoType[] = ['RFQ', 'BID', 'ACCEPT', 'PAY', 'CLOSE', 'silicr:unknown', 'none', 'text', 'binary'];
const POOLS = ['ironwood', 'orchard', 'sapling', 'transparent'] as const;

export function parseLedgerEntry(v: unknown): LedgerEntry {
  if (!isObj(v)) throw new SidecarProtocolError('ledger entry must be an object');
  const txid = str(v, 'txid');
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new SidecarProtocolError(`bad txid ${txid}`);
  const direction = str(v, 'direction');
  if (direction !== 'received' && direction !== 'sent' && direction !== 'change') throw new SidecarProtocolError(`unexpected direction ${direction}`);
  const memoType = str(v, 'memoType');
  if (!(MEMO_TYPES as readonly string[]).includes(memoType)) throw new SidecarProtocolError(`unexpected memo type ${memoType}`);
  const valuePool = str(v, 'valuePool');
  if (!(POOLS as readonly string[]).includes(valuePool)) throw new SidecarProtocolError(`unexpected value pool ${valuePool}`);
  const address = v['address'];
  if (address !== null && address !== undefined && typeof address !== 'string') throw new SidecarProtocolError('address must be a string or null');
  const fee = v['feeZats'];
  return {
    txid,
    height: num(v, 'height'),
    time: optNum(v, 'time'),
    direction,
    zats: zats(v['zats']),
    address: address ?? null,
    memoType: memoType as LedgerMemoType,
    memo: memoFromHex(str(v, 'memoHex')),
    feeZats: fee === null || fee === undefined ? null : zats(fee, 'feeZats'),
    valuePool: valuePool as LedgerEntry['valuePool'],
    index: num(v, 'index'),
  };
}

export function parseLedger(v: unknown): Ledger {
  if (!isObj(v) || !Array.isArray(v['entries'])) throw new SidecarProtocolError('ledger must have entries[]');
  return {
    entries: v['entries'].map(parseLedgerEntry),
    tip: optNum(v, 'tip'),
    birthday: num(v, 'birthday'),
    viewOnly: v['viewOnly'] === true,
  };
}

/** A UFVK string as the sidecar returns it: `uview1…` on mainnet, `uviewtest1…` on testnet. */
export function parseViewingKey(v: unknown, network: 'main' | 'test'): string {
  if (!isObj(v)) throw new SidecarProtocolError('exportViewingKey result must be an object');
  const key = str(v, 'ufvk');
  const hrp = network === 'main' ? 'uview1' : 'uviewtest1';
  if (!key.startsWith(hrp) || !/^[a-z0-9]+$/.test(key)) throw new SidecarProtocolError(`viewing key is not a ${hrp}… UFVK`);
  if (v['orchardOnly'] !== true) throw new SidecarProtocolError('viewing key is not Orchard-only');
  return key;
}

export interface SidecarErrorBody {
  code: string;
  message: string;
  available?: string | null;
  required?: string | null;
}

/** Maps a sidecar error to the contract's error classes. */
export function toError(method: string, e: SidecarErrorBody): Error {
  const msg = `${method}: ${e.message}`;
  switch (e.code) {
    case 'PrivacyError':
      return new PrivacyError(msg);
    case 'InsufficientFunds':
      return new InsufficientFundsError(msg);
    case 'TxNotKnown':
      return new TxNotKnownError(msg);
    case 'ReadOnly':
      return new ReadOnlyError(msg);
    default: {
      const err = new Error(msg);
      (err as Error & { code?: string }).code = e.code;
      return err;
    }
  }
}
