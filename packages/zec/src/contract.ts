/**
 * @silicr/zec contract: the only way the rest of Silicr touches Zcash.
 *
 * Owned by the lead. Engine, CLI and web are written against these types in
 * parallel, so do not change them silently. Additive, backward-compatible
 * changes are fine; flag anything else in your report.
 */

/** Zatoshis. 1 ZEC = 100_000_000n. Always bigint in code, decimal string in JSON. */
export type Zats = bigint;
export const ZATS_PER_ZEC = 100_000_000n;

/** 'memory' is the in-process simulated chain: test suite and `pnpm verify` only. The app runs on 'main' or 'test'. */
export type Network = 'main' | 'test' | 'regtest' | 'memory';

/** A ZIP 302 memo field: exactly 512 bytes. */
export type MemoBytes = Uint8Array;
export const MEMO_SIZE = 512;

export interface Output {
  /**
   * Recipient: a unified address with an Orchard receiver. Backends MUST send to
   * the Orchard receiver only (see toOrchardOnly) and MUST refuse anything else.
   */
  to: string;
  zats: Zats;
  memo: MemoBytes;
}

export interface BackendCapabilities {
  /** Binary memos (ZIP 302 0xFF prefix) survive send → receive intact. If false, only UTF-8 text memos do. */
  binaryMemos: boolean;
  /** Max outputs, each with its own memo, in one transaction. 1 = no multi-output support. */
  maxOutputsPerTx: number;
  /** newAddress() returns a fresh diversified address on each call. */
  diversifiedAddresses: boolean;
  /** Smallest output value the backend accepts (some wallets reject 0-value notes). */
  minOutputZats: Zats;
  /** Unconfirmed (mempool) notes show up in poll() before they are mined. */
  mempoolNotes: boolean;
  /** inspectTx() is implemented. */
  inspectTx: boolean;
}

export interface SendResult {
  txid: string;
  feeZats: Zats;
}

export interface ReceivedNote {
  txid: string;
  /** Position of the output within the transaction; (txid, index) is unique. */
  index: number;
  /** null while unconfirmed. The same note may come back first with null, later with a height. */
  height: number | null;
  /** Which of this wallet's addresses received it, exactly as returned by address()/newAddress(). */
  toAddress: string;
  zats: Zats;
  memo: MemoBytes;
  /** Receiver type the note was paid to. Silicr only ever uses 'orchard' receivers. */
  pool: 'orchard' | 'sapling' | 'transparent';
  /**
   * Value pool the note actually lives in. Since NU6.3 (Ironwood, mainnet 2026-07-28) payments to
   * Orchard receivers land in the Ironwood pool, and the legacy Orchard pool is withdraw-only.
   * Absent means the backend doesn't distinguish (the memory backend before it modelled Ironwood).
   */
  valuePool?: 'ironwood' | 'orchard' | 'sapling' | 'transparent';
}

export interface Balance {
  /** Confirmed, spendable shielded funds in the current pool (Ironwood since NU6.3). */
  spendable: Zats;
  /** Received but not yet spendable (unconfirmed, or change awaiting confirmation). */
  pending: Zats;
}

/** Everything a public chain observer can learn about one transaction. Feeds the Leak Inspector. */
export interface PublicTxView {
  txid: string;
  height: number | null;
  /** Block time, unix seconds; null if unmined. */
  time: number | null;
  version: number;
  sizeBytes: number;
  feeZats: Zats | null;
  transparent: { inputs: number; outputs: number };
  sapling: { spends: number; outputs: number; valueBalanceZats: Zats };
  /**
   * The legacy Orchard bundle. Since NU6.3 it can only be withdrawn from, through the turnstile,
   * which publishes the amount. Silicr transactions always have 0 actions here; never merge it with
   * `ironwood`, or a turnstile crossing would be hidden.
   */
  orchard: {
    actions: number;
    valueBalanceZats: Zats;
    /** Hex of the first 32 bytes of each action's encrypted note ciphertext: literally what an observer sees. */
    ciphertextSamples: string[];
  };
  /** The Ironwood bundle (NU6.3+, v6 transactions): where Silicr's actions are. Absent before NU6.3. */
  ironwood?: {
    actions: number;
    valueBalanceZats: Zats;
    ciphertextSamples: string[];
  };
  /**
   * Where the view came from, so the Leak Inspector can label it honestly.
   * 'broadcast' | 'wallet' | 'mempool': exact transaction bytes already held locally.
   * 'compact-block': a summary of a compact block the wallet scanned anyway. Counts and ciphertext
   * samples are exact; fee and value balances are unknown (see `estimated`).
   * 'simulated': the memory backend. Absent: the backend doesn't say.
   * Backends never fetch another party's transaction by txid to build a view.
   */
  source?: 'broadcast' | 'wallet' | 'mempool' | 'compact-block' | 'simulated';
  /** False when some fields are estimates or unknown placeholders (listed in `estimated`). Absent means complete. */
  complete?: boolean;
  /** Fields that are estimated or unknown, e.g. 'sizeBytes', 'feeZats', 'valueBalances'. Display as "unknown", never as values. */
  estimated?: string[];
}

export interface ZecBackend {
  readonly network: Network;
  readonly capabilities: BackendCapabilities;
  /** The wallet's default receiving address (Orchard-only UA). Stable across calls. */
  address(): Promise<string>;
  /** A fresh address that cannot be linked on-chain to the others. Falls back to address() if unsupported. */
  newAddress(): Promise<string>;
  balance(): Promise<Balance>;
  /** Current chain tip height as seen by the backend. */
  height(): Promise<number>;
  /**
   * Build, prove and broadcast ONE shielded transaction with these outputs.
   * MUST spend only notes in the current shielded pool (Ironwood since NU6.3, paid via Orchard
   * receivers) and MUST NOT create transparent inputs/outputs, Sapling parts, legacy-Orchard
   * (turnstile) spends or any other cross-pool transfer: all of those reveal amounts.
   * Throws PrivacyError if it cannot meet that, InsufficientFundsError if short.
   */
  send(outputs: Output[]): Promise<SendResult>;
  /**
   * Notes received at any of this wallet's addresses that were mined at
   * height >= sinceHeight, plus every currently-unconfirmed received note.
   * Callers dedupe on (txid, index). Syncs as needed before answering.
   */
  poll(sinceHeight: number): Promise<ReceivedNote[]>;
  /** Public view of any transaction. Only present if capabilities.inspectTx. */
  inspectTx?(txid: string): Promise<PublicTxView>;
  /**
   * The wallet's unified full viewing key (ZIP 316 UFVK, `uview1…` / `uviewtest1…`, Orchard
   * component only), for auditors. Its holder sees every payment this wallet ever sent or
   * received, with amounts and memos, and can link all of its addresses; it can never spend.
   * One wallet per audit scope. Only present on backends with a real wallet; callers must never
   * log the result.
   */
  exportViewingKey?(): Promise<string>;
  close(): Promise<void>;
}

/** send() on a watch-only backend (opened from a viewing key): it can see but never spend. */
export class ReadOnlyError extends Error {
  override name = 'ReadOnlyError';
}

export class PrivacyError extends Error {
  override name = 'PrivacyError';
}

export class InsufficientFundsError extends Error {
  override name = 'InsufficientFundsError';
}

// ---------------------------------------------------------------------------
// Unified addresses (ZIP 316) and the Orchard-only guard

export type ReceiverKind = 'p2pkh' | 'p2sh' | 'sapling' | 'orchard' | 'unknown';

export interface Receiver {
  /** ZIP 316 typecode: 0x00 p2pkh, 0x01 p2sh, 0x02 sapling, 0x03 orchard. */
  typecode: number;
  kind: ReceiverKind;
  /** Raw receiver bytes (Orchard: 43 bytes = 11-byte diversifier + 32-byte pk_d). */
  data: Uint8Array;
}

/** Address HRP network. 'memory' backends use regtest encoding ("uregtest"). */
export type AddressNetwork = 'main' | 'test' | 'regtest';

export interface DecodedAddress {
  network: AddressNetwork;
  receivers: Receiver[];
}

// ---------------------------------------------------------------------------
// Backend factories

export interface MemoryNetworkOptions {
  /** Simulated block interval. Default 1000 ms. 0 = no timer: blocks are mined only by mine(). */
  blockTimeMs?: number;
  /** ZIP 317 marginal fee per logical action. Default 5000n. */
  marginalFeeZats?: Zats;
  /**
   * Simulated mempool propagation delay: an unmined transaction shows up in other
   * wallets' poll()/balance() only this many ms after it was sent (the sender sees
   * it at once; a mined one is visible to all). Default 0.
   */
  deliveryDelayMs?: number;
  /**
   * Seed for every random choice (addresses, txids, action order, ciphertext
   * samples). The same seed and the same sequence of calls give the same chain.
   * Default: fresh randomness.
   */
  seed?: string | Uint8Array;
  /**
   * Simulate a more limited backend (e.g. { maxOutputsPerTx: 1, binaryMemos: false })
   * so callers can test their fallbacks. Defaults: binaryMemos true, maxOutputsPerTx 50,
   * diversifiedAddresses true, minOutputZats 1n, mempoolNotes true.
   */
  capabilities?: Partial<
    Pick<BackendCapabilities, 'binaryMemos' | 'maxOutputsPerTx' | 'diversifiedAddresses' | 'minOutputZats' | 'mempoolNotes'>
  >;
}

export interface MemoryNetwork {
  /** Get or create a named wallet on this simulated chain. fundZats only applies on creation. */
  wallet(name: string, opts?: { fundZats?: Zats }): ZecBackend;
  /** Mine a block now (in addition to the timer). */
  mine(): void;
  readonly height: number;
  /** Public views of every transaction, oldest first: the simulated block explorer. */
  explorer(): PublicTxView[];
  stop(): void;
}

export type BackendConfig =
  | { kind: 'memory'; network: MemoryNetwork; wallet: string; fundZats?: Zats }
  | {
      /** The zec-sidecar light wallet on a real chain. Nothing defaults to mainnet. */
      kind: 'sidecar';
      /** 'main' (real ZEC: small balances, spend caps, see docs/MAINNET.md) or 'test'. */
      network: 'main' | 'test';
      /** Wallet directory, e.g. .silicr/wallets/main-buyer. Never committed. A wallet is locked to its network. */
      dataDir: string;
      /** lightwalletd / Zaino endpoint (host:port). Default by network; its reported chain must match `network`. */
      server?: string;
      /** SOCKS5 proxy (socks5h://host:port, e.g. Tor) for every connection to the server. Default $SILICR_PROXY; null = direct. */
      proxy?: string | null;
      /**
       * Watch-only: create (or open) the wallet in dataDir from this unified full viewing key
       * instead of a seed. The backend can sync, poll, inspect and list a ledger, and send()
       * throws ReadOnlyError. The key must be for `network`.
       */
      viewingKey?: string;
      [option: string]: unknown;
    }
  | {
      /** The old spelling of `{ kind: 'sidecar', network: 'test' }`. */
      kind: 'testnet';
      /** Wallet directory, e.g. .silicr/wallets/buyer. Never committed. */
      dataDir: string;
      /** lightwalletd / Zaino endpoint, if the implementation uses one. */
      server?: string;
      /** SOCKS5 proxy (socks5h://host:port, e.g. Tor) for every connection to the server. Default $SILICR_PROXY; null = direct. */
      proxy?: string | null;
      [option: string]: unknown;
    };
