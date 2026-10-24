/**
 * @silicr/api: the JSON contract between a local Silicr daemon and the web terminal.
 *
 * Type-only: no runtime code, so the web app can import it freely.
 * Money is a decimal zatoshi string, bytes are lowercase hex, times are unix ms.
 *
 * Owned by the lead; the web terminal and the engine are built against it in
 * parallel. Additive changes are fine; flag anything else in your report.
 *
 * Daemons (one per party, same API, behaviour depends on role):
 *   buyer    http://127.0.0.1:7701
 *   provider http://127.0.0.1:7702
 *   relay    http://127.0.0.1:7700  (serves GET /_observer, see RelayObserverResponse)
 * Daemons must send CORS headers allowing http://localhost:7703 and http://127.0.0.1:7703 (the web terminal).
 *
 * Endpoints (all JSON unless noted):
 *   GET  /api/status                     → StatusDto
 *   GET  /api/providers                  → ProviderDto[]               (directory, signatures checked)
 *   GET  /api/rfqs                       → RfqDto[]                    (buyer)
 *   POST /api/rfqs        NewRfqRequest  → { rfqId: Hex }              (buyer)
 *   GET  /api/rfqs/:id                   → RfqDto                      (buyer)
 *   POST /api/rfqs/:id/accept { providerId: Hex } → RfqDto             (buyer)
 *   POST /api/rfqs/:id/stop              → RfqDto                      (buyer)
 *   GET  /api/rfqs/:id/result            → application/octet-stream (tar.gz)   (buyer)
 *   GET  /api/jobs                       → ProviderJobDto[]            (provider)
 *   GET  /api/jobs/:id                   → ProviderJobDto              (provider)
 *   GET  /api/policy                     → ProviderPolicyDto           (provider)
 *   PUT  /api/policy      Partial<ProviderPolicyDto> → ProviderPolicyDto (provider)
 *   GET  /api/leaks?rfqId=&after=        → LeakObservation[]           (what THIS party holds)
 *   GET  /api/chain/tx/:txid             → PublicTxViewDto             (what the public chain shows)
 *   GET  /api/events                     → text/event-stream of DaemonEvent (JSON in `data:`)
 *   POST /api/rfqs/:id/fault { fault: BuyerFault }     → RfqDto        (buyer; demo fault injection)
 *   POST /api/jobs/:id/fault { fault: ProviderFault }  → ProviderJobDto (provider; demo fault injection)
 *   POST /api/jobs/:id/stop              → ProviderJobDto              (provider)
 *   POST /api/rfqs/:id/migrate MigrateRequest → RfqDto                  (buyer; the NEW RFQ, resumed from the latest checkpoint)
 *   GET  /api/wallet?amount=<ZEC>        → WalletDto                   (both; deposit address, ZIP 321 URI, balance)
 *   POST /api/wallet/withdraw WithdrawRequest → WithdrawResultDto       (both; 409 WithdrawConfirmDto on mainnet first)
 * Errors: non-2xx with ErrorDto.
 *
 * On connect, /api/events first sends a snapshot: one 'status' event, then the 20 most recent
 * 'rfq.updated' (buyer) or 'job.updated' (provider) events.
 * Leak observation ids are "<party>-<n>", e.g. "buyer-12"; `after=` accepts "buyer-12" or "12".
 * Requests with a foreign Origin or a non-loopback Host header get 403; POST/PUT bodies must be JSON (else 415).
 * A daemon started with --public-origin <url> also accepts that Origin and its host name (hosted demo
 * behind a reverse proxy, base URL may carry a path prefix such as https://host/buyer).
 */

/** Demo fault injection on the buyer: deliberately stop (or resume) interval payments. */
export type BuyerFault = 'stop_paying' | 'resume_paying';
/** Demo fault injection on the provider: deliberately stop (or resume) heartbeats. */
export type ProviderFault = 'stop_heartbeats' | 'resume_heartbeats';

export type Hex = string;
/** Decimal zatoshis, e.g. "125000000" = 1.25 ZEC. */
export type ZatsString = string;
export type UnixMs = number;

export type Role = 'buyer' | 'provider';
export type NetworkName = 'main' | 'test' | 'regtest' | 'memory';

export interface ErrorDto {
  error: string;
  /**
   * Machine-readable code: 'privacy', 'insufficient_funds', 'not_found', 'bad_request', 'wrong_role',
   * 'conflict', 'forbidden', 'method_not_allowed', 'unsupported', 'internal', 'spend_cap' (request exceeds the daemon's cap)
   * or 'blob_too_large' (memo transport: the sealed job, result or log batch exceeds what memos carry; use the relay).
   * Wallet: 'confirm_required' (409, WithdrawConfirmDto: mainnet withdraw, echo the token) and 'busy' (409: a job is live).
   * Public demo: 'demo_disabled' (403), 'busy' (409: another request is live), 'rate_limited' (429).
   */
  code: string;
}

export interface StatusDto {
  role: Role;
  network: NetworkName;
  height: number;
  /** This daemon's default Orchard-only UA. */
  address: string;
  balance: { spendable: ZatsString; pending: ZatsString };
  relayUrl: string;
  /** Provider only. */
  alias?: string;
  providerId?: Hex;
  version: string;
  /**
   * True when every party runs on this machine (zero-setup demo or local testnet demo),
   * so the web terminal may query the other parties' daemons for the Leak Inspector.
   */
  demoMode: boolean;
  /** Seconds per block on this network (75 on testnet). */
  blockTimeS: number;
  /** Provider only: how jobs run. sandboxed is false in process mode, and `warning` says why to show it. */
  runner?: { mode: string; sandboxed: boolean; warning?: string };
  /**
   * Spending guard. Required on mainnet (the daemon refuses to start there without it). The UI shows
   * it prominently whenever network === 'main': real ZEC is at stake.
   */
  spendCap?: { perRfqZats: ZatsString; totalZats: ZatsString; spentZats: ZatsString };
  /** Set when outbound traffic goes through a SOCKS5 proxy (Tor), so IPs aren't exposed. */
  proxy?: { url: string; kind: 'socks5' };
  /**
   * How job, logs, heartbeats and result travel: 'relay' (default) or 'memo' (relay-less: in Zcash
   * memos, nothing but the chain; `silicr daemon --transport memo`). Negotiated per RFQ; a provider
   * in the other mode does not bid. Absent on older daemons = 'relay'.
   */
  blobTransport?: 'relay' | 'memo';
  /**
   * Public testnet demo (`silicr daemon --public-demo`, buyer): a shared wallet with testnet coins
   * only. POST /api/rfqs then takes `job: { preset }` (PresetRfqRequest) instead of a folder,
   * command and env; withdraw, policy changes, migration and provider stops are refused (403
   * `demo_disabled`); one live request at a time (409 `busy`) and a per-IP rate limit (429
   * `rate_limited`). Absent = false.
   */
  publicDemo?: boolean;
  /** Public demo only: the server-side example jobs a request may run. */
  presets?: JobPresetDto[];
  /** Public demo only: the limits the daemon enforces on POST /api/rfqs. */
  publicDemoLimits?: { maxDurationS: number; maxCount: number; maxActive: number; perIpPerHour: number; maxPricePerHourZats?: ZatsString };
}

/** A server-side example job offered by a public-demo daemon. */
export interface JobPresetDto {
  id: string;
  title: string;
  description: string;
  /** What runs, for display (the daemon decides; clients cannot change it). */
  command: string[];
  /** Suggested request defaults for the form. */
  gpu: string;
  durationS: number;
}

/** POST /api/rfqs on a public-demo daemon: the job is a preset id, everything else as NewRfqRequest. */
export type PresetRfqRequest = Omit<NewRfqRequest, 'job'> & { job: { preset: string } };

export interface GpuSpec {
  model: string;
  count: number;
  vramGb: number;
}

export interface ProviderDto {
  providerId: Hex;
  alias: string;
  address: string;
  gpus: GpuSpec[];
  minPricePerHourZats: ZatsString;
  bondZats?: ZatsString;
  region?: string;
  updatedAt: UnixMs;
  /** Directory signature verified by this daemon. */
  verified: boolean;
}

export type AutoAcceptRule = {
  rule: 'cheapest';
  /** Wait this many blocks for bids before choosing. */
  waitBlocks: number;
  minBondZats?: ZatsString;
};

export interface NewRfqRequest {
  gpu: string;
  count: number;
  durationS: number;
  /** The buyer's private ceiling. Kept off the wire unless `discloseMax` is true. */
  maxPricePerHourZats: ZatsString;
  /**
   * Put the max in the RFQ memo so providers see it (old behaviour). Default false: the RFQ
   * carries 0 ("undisclosed"), providers bid their own price and the daemon filters bids locally.
   */
  discloseMax?: boolean;
  /** Default: every directory provider whose GPUs match. */
  providerIds?: Hex[];
  job: {
    /** Directory on the buyer's machine; the daemon packs, encrypts and uploads it. */
    path: string;
    command: string[];
    /** Container image; default 'python:3.12-slim'. */
    image?: string;
    /** Extra environment for the job. Reserved SILICR_* names are dropped. */
    env?: Record<string, string>;
  };
  autoAccept?: AutoAcceptRule | null;
}

export type RfqState =
  | 'broadcasting' // RFQ transaction being built / sent
  | 'collecting' //   waiting for bids
  | 'accepted' //     ACCEPT sent, waiting for the provider to start
  | 'running' //      heartbeats arriving, intervals being paid
  | 'closing' //      CLOSE sent or received, fetching results
  | 'closed'
  | 'expired' //      no acceptable bids before expiry
  | 'failed';

export type CloseReason = 'done' | 'buyer_stop' | 'provider_stop' | 'unpaid' | 'no_heartbeat' | 'error';

export interface BidDto {
  providerId: Hex;
  alias: string;
  pricePerIntervalZats: ZatsString;
  intervalS: number;
  /** Derived: price normalised to one hour. */
  pricePerHourZats: ZatsString;
  startWithinS: number;
  bondZats?: ZatsString;
  receivedAt: UnixMs;
  txid: string;
  height: number | null;
  signatureValid: boolean;
}

export interface PaymentDto {
  /** 0 = paid by the ACCEPT transaction. */
  seq: number;
  /* txid is "unknown (broadcast result was lost)" when a send's result was lost and the payment was confirmed only by the provider's progress. */
  kind: 'accept' | 'pay';
  zats: ZatsString;
  feeZats: ZatsString;
  txid: string;
  height: number | null;
  at: UnixMs;
}

export interface HeartbeatDto {
  seq: number;
  at: UnixMs;
  step: number;
  status: 'starting' | 'running' | 'paused' | 'finished' | 'failed';
  servingSeq: number;
  checkpointDigest: Hex;
  note?: string;
}

export interface RfqRequestDto {
  gpu: string;
  count: number;
  durationS: number;
  /** Buyer side: the private max. Provider side: what the RFQ memo carried ("0" = undisclosed). */
  maxPricePerHourZats: ZatsString;
}

export interface RfqDto {
  rfqId: Hex;
  state: RfqState;
  createdAt: UnixMs;
  request: RfqRequestDto;
  rfqTxid?: string;
  /** Real providers the RFQ was sent to. */
  providersAsked: number;
  /** Outputs in the RFQ transaction after padding (what the chain sees). */
  paddedOutputs: number;
  expiresHeight: number;
  bids: BidDto[];
  accepted?: {
    providerId: Hex;
    alias: string;
    pricePerIntervalZats: ZatsString;
    intervalS: number;
    intervals: number;
  };
  payments: PaymentDto[];
  /** Most recent first, capped. */
  heartbeats: HeartbeatDto[];
  /** Decrypted job log, last lines. */
  logTail: string[];
  /** Paid to the provider: the ACCEPT (interval 0) plus every PAY. */
  spentZats: ZatsString;
  /** Network fees, plus the minimum-value outputs sent to other parties (RFQ memos, CLOSE). Padding outputs return to the buyer and are not counted. */
  feesZats: ZatsString;
  /** Unix ms when the next interval payment is due, while running. */
  nextPaymentAt?: UnixMs;
  result?: { digest: Hex; sizeBytes: number };
  closeReason?: CloseReason;
  error?: string;
  /** Every RFQ transaction, when the backend's output limit forced a split (a privacy trade-off). */
  rfqTxids?: string[];
  /** BIDs dropped: bad signature, provider not asked, above max, late, or refused address. */
  rejectedBids?: number;
  /** Demo fault injection: the buyer is deliberately withholding payments. */
  paymentsWithheld?: boolean;
  /** The result's digest was checked against the provider's signed CLOSE. */
  resultVerified?: boolean;
  /** While 'broadcasting' on testnet: the note-splitting self-send and its confirmations ("preparing funds n/3"). */
  preparing?: { txid: string; notes: number; confirmations: number; required: number };
  /** When the request reached closed, expired or failed. */
  closedAt?: UnixMs;
  /** False: the RFQ memo carried 0 and providers never saw `request.maxPricePerHourZats`. */
  discloseMax?: boolean;
  /** Buyer-clock time of the first valid 'running' heartbeat: the origin of the payment schedule. */
  jobStartedAt?: UnixMs;
  /**
   * How payments are timed. Interval k is paid at a random point in [jobStart + k·I − lead, + jitterMaxS],
   * on the buyer's clock. A provider can't make the buyer pay faster than real time; worst case at risk is
   * maxExposureIntervals = 1 + lead/I.
   */
  payPolicy?: { leadS: number; jitterMaxS: number; maxExposureIntervals: number };
  /**
   * Metered delivery: the latest checkpoint the provider sealed and uploaded (one at the end of every
   * served interval, and when it pauses or stops), verified against its digest and kept on disk. It is
   * what the buyer keeps if the provider vanishes, and what `migrate` hands to the next provider.
   */
  checkpoint?: CheckpointDto;
  /** This RFQ was created by `migrate`: it resumes the job of `rfqId` from the checkpoint taken at interval `seq`. */
  migratedFrom?: { rfqId: Hex; seq: number };
  /** This RFQ was migrated away from (CLOSE buyer_stop if it was still open); the job continues under `migratedTo`. */
  migratedTo?: Hex;
}

/** A checkpoint of the job's working state, as sealed to the channel and relayed. */
export interface CheckpointDto {
  /** The interval it was taken at the end of (or during, when the provider paused or stopped). */
  seq: number;
  /** Hex SHA-256 of the packed checkpoint (tar.gz), checked by the buyer. */
  digest: Hex;
  sizeBytes: number;
  at: UnixMs;
}

/** POST /api/rfqs/:id/migrate: start a NEW RFQ for the same job, resumed from the latest checkpoint of :id. */
export interface MigrateRequest {
  /** Providers to ask. Default: every directory match except the provider being migrated away from. */
  providerIds?: Hex[];
  /** Default: cheapest, waiting the original RFQ's waitBlocks (1 if it was accepted by hand). */
  autoAccept?: AutoAcceptRule | null;
}

export type ProviderJobState = 'bid' | 'won' | 'lost' | 'running' | 'paused' | 'stopped' | 'done';

export interface ProviderJobDto {
  rfqId: Hex;
  state: ProviderJobState;
  request: RfqRequestDto;
  bid: { pricePerIntervalZats: ZatsString; intervalS: number; txid: string };
  paymentsReceived: PaymentDto[];
  earnedZats: ZatsString;
  /** Interval currently being served. */
  servingSeq: number;
  lastHeartbeatSeq: number;
  startedAt?: UnixMs;
  stoppedAt?: UnixMs;
  stopReason?: CloseReason;
  logTail: string[];
  /** Intervals the buyer said it intends to buy. */
  intervals?: number;
  /** SHA-256 of the sealed result, as sent in the provider's CLOSE. */
  resultDigest?: Hex;
  error?: string;
  /** Demo fault injection: heartbeats deliberately withheld. */
  heartbeatsStopped?: boolean;
  /** Fees this provider paid (BIDs, CLOSE). */
  feesZats?: ZatsString;
  /** The payment watchdog's own view of this job. */
  watchdog?: {
    state: 'paid_ahead' | 'grace' | 'paused';
    /** Highest interval seq paid for (-1 if none). */
    paidThroughSeq: number;
    /** While in grace or paused: when the watchdog escalates (pause, then stop). */
    deadlineAt?: UnixMs;
    /** Interval being served on a payment that is not yet mined (at most one at a time). */
    unconfirmedSeq?: number;
  };
  /** Metered delivery: the latest checkpoint this provider sealed and uploaded for the job. */
  checkpoint?: CheckpointDto;
  /** The job started from a buyer-supplied checkpoint (a migrated job): the interval of the earlier deal it was taken at. */
  resumedFromSeq?: number;
}

export interface ProviderPolicyDto {
  autoBid: boolean;
  minPricePerHourZats: ZatsString;
  intervalS: number;
  /** How late a payment may be before the job is paused, then stopped. */
  graceS: number;
  gpus: GpuSpec[];
  /** Markup over minPricePerHourZats when an RFQ's max is undisclosed, in percent (default 0). */
  markupPct?: number;
}

// ---------------------------------------------------------------------------
// Leak Inspector: what each party actually holds, from real data.

export type Party = 'chain' | 'relay' | 'provider' | 'buyer';

export interface LeakField {
  label: string;
  /** Literal value. Ciphertext as truncated hex; plaintext as-is. */
  value: string;
  /** True if this party can read it in the clear (as opposed to holding ciphertext or nothing). */
  readable: boolean;
  /** True if it is sensitive (price, workload, identity, amount). readable && sensitive = this party knows it. */
  sensitive: boolean;
  /**
   * Which key facts this field carries: in the clear when readable, sealed when not. The Leak Inspector
   * matrix is computed from these tags. An empty array means it carries none; absent means untagged, and
   * the UI falls back to classifying by label.
   */
  facts?: FactKey[];
}

/** The key facts in the Leak Inspector's summary matrix. */
export type FactKey = 'buyer_identity' | 'workload' | 'price' | 'amount' | 'provider_identity' | 'buyer_ip';

export interface LeakObservation {
  id: string;
  party: Party;
  at: UnixMs;
  rfqId?: Hex;
  txid?: string;
  /** e.g. 'tx-broadcast', 'memo-received', 'blob-stored', 'blob-fetched', 'directory-read', 'job-started' */
  event: string;
  summary: string;
  fields: LeakField[];
}

/** Public view of a transaction (from @silicr/zec PublicTxView, JSON-encoded). */
export interface PublicTxViewDto {
  txid: string;
  height: number | null;
  time: number | null;
  version: number;
  sizeBytes: number;
  feeZats: ZatsString | null;
  transparent: { inputs: number; outputs: number };
  sapling: { spends: number; outputs: number; valueBalanceZats: ZatsString };
  /** Legacy Orchard bundle: withdraw-only since NU6.3; always 0 actions for Silicr transactions. */
  orchard: { actions: number; valueBalanceZats: ZatsString; ciphertextSamples: string[] };
  /** Ironwood bundle (NU6.3+): where Silicr's shielded actions are. Show this, not orchard, as "shielded actions". */
  ironwood?: { actions: number; valueBalanceZats: ZatsString; ciphertextSamples: string[] };
  /**
   * Provenance of the view. 'compact-block' views have exact counts and ciphertext samples, but the
   * fee and value balances are unknown: render the fields named in `estimated` as "unknown" (or "≈"
   * for sizeBytes), never as zeros.
   */
  source?: 'broadcast' | 'wallet' | 'mempool' | 'compact-block' | 'simulated';
  complete?: boolean;
  estimated?: string[];
}

/** GET {relay}/_observer?after=<id> */
export interface RelayObserverResponse {
  observations: LeakObservation[];
}

// ---------------------------------------------------------------------------
// Server-sent events on GET /api/events

export type DaemonEvent =
  | { type: 'status'; status: StatusDto }
  | { type: 'rfq.updated'; rfq: RfqDto }
  | { type: 'job.updated'; job: ProviderJobDto }
  | { type: 'log'; rfqId: Hex; lines: string[] }
  | { type: 'leak'; observation: LeakObservation }
  | { type: 'chain.tx'; view: PublicTxViewDto };

// ---------------------------------------------------------------------------
// Wallet connection: fund the local wallet from the user's own Zcash wallet, withdraw back out.
// Keys never leave the daemon: the web terminal only ever sees addresses, amounts and txids.

/** GET /api/wallet[?amount=<decimal ZEC>] */
export interface WalletDto {
  role: Role;
  network: NetworkName;
  height: number;
  /** Deposit address: this daemon's default Orchard-only UA. */
  address: string;
  /** ZIP 321 payment URI, "zcash:<ua>" plus "?amount=<ZEC>" when the request carried ?amount=. Render it as the QR. */
  zip321Uri: string;
  balance: { spendable: ZatsString; pending: ZatsString };
  /** Confirmations before funds are spendable: notes received from others, and this wallet's own change. */
  confirmationsRequired: { received: number; change: number };
  /** ZIP 317 fee of a plain shielded withdraw (2 logical actions); more if many notes are spent. */
  feeEstimateZats: ZatsString;
  /** The most recent payment into this wallet from outside Silicr (a deposit), if any was seen since start. */
  lastIncoming?: { txid: string; zats: ZatsString; height: number | null; confirmations: number };
  /** A request or job is live: withdraws are refused (code 'busy') unless `force` is set. */
  busy: boolean;
}

/** POST /api/wallet/withdraw */
export interface WithdrawRequest {
  /** Recipient: a unified address with an Orchard receiver (u1… / utest1…). Anything else: 400 'privacy'. */
  to: string;
  /** Zatoshis, or "all" to sweep the spendable balance minus the fee. */
  amountZats: ZatsString | 'all';
  /** Mainnet: the token from the 409 WithdrawConfirmDto, echoed within 60 s with the same to/amount. */
  confirm?: string;
  /** Withdraw even while a request or job is live (it may then run out of funds). */
  force?: boolean;
}

export interface WithdrawResultDto {
  txid: string;
  /** Sent to the recipient. */
  zats: ZatsString;
  feeZats: ZatsString;
  network: NetworkName;
}

/** 409 on mainnet: nothing was sent. Echo `confirm` in a second call to send. Not counted against the spend cap. */
export interface WithdrawConfirmDto extends ErrorDto {
  code: 'confirm_required';
  confirm: string;
  expiresAt: UnixMs;
  summary: { to: string; zats: ZatsString; feeZats: ZatsString; network: NetworkName; all: boolean };
}
