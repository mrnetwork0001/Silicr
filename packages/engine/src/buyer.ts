// BuyerNode: sealed RFQ → bid collection → ACCEPT → metered PAY loop → result → CLOSE.
// See ARCHITECTURE.md §3–4.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  AutoAcceptRule,
  BidDto,
  CloseReason,
  HeartbeatDto,
  MigrateRequest,
  NewRfqRequest,
  PaymentDto,
  RfqDto,
  RfqState,
  StatusDto,
} from '@silicr/api';
import type { Bid, Channel, Close, DecodedMemo, Heartbeat, Rfq, RfqKeys } from '@silicr/protocol';
import type { Output } from '@silicr/zec';
import { NodeBase, type NodeOptions } from './base.ts';
import { NoteWatcher, dummyMemo, padBucket, type NoteEvent, describeError } from './chain.ts';
import { matchProviders, type VerifiedProvider } from './directory.ts';
import { badRequest, conflict, notFound, EngineError } from './errors.ts';
import { decodeCheckpointBlob, encodeJobBlob, sanitizeEnv, type JobManifest } from './jobblob.ts';
import { checkJobPath } from './jobpath.ts';
import { ChunkAssembler, MAX_PAYLOAD_BYTES, decodeLogBatch, readChunked, uploadChunked } from './blobs.ts';
import { TX_FACTS, cipherPreview } from './leaks.ts';
import { formatZec, parseZats, perHour, perInterval, withinHourly } from './zats.ts';
import { StateFile, bytesEqual, errMsg, hex, randomInt, readIfExists, shortHex, shuffle, sleep, unhex, writePrivate, randomBytes } from './util.ts';
import { maxExposureIntervals, payLeadFor, profileAtHeight } from './profile.ts';

const MAX_BUNDLE_BYTES = MAX_PAYLOAD_BYTES - 64 * 1024;
/** Same rule as the memo protocol's GPU field. */
export const GPU_SLUG = /^[a-z0-9][a-z0-9-]{0,15}$/;
const HEARTBEATS_KEPT = 50;
const LOG_LINES_KEPT = 500;
/** Largest checkpoint a buyer accepts from the relay (the provider's default cap is the same). */
export const DEFAULT_MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;

export interface BuyerBid {
  key: string;
  providerId: string;
  alias: string;
  pricePerIntervalZats: bigint;
  intervalS: number;
  startWithinS: number;
  providerEph: string;
  payTo: string;
  bondZats?: bigint;
  receivedAt: number;
  txid: string;
  height: number | null;
}

interface BuyerPayment {
  seq: number;
  kind: 'accept' | 'pay';
  zats: bigint;
  feeZats: bigint;
  txid: string;
  height: number | null;
  at: number;
}

interface AskedProvider {
  providerId: string;
  alias: string;
  address: string;
  bondZats?: bigint;
}

export interface BuyerRfq {
  rfqId: string;
  state: RfqState;
  createdAt: number;
  request: { gpu: string; count: number; durationS: number; maxPricePerHourZats: bigint };
  /**
   * True: the RFQ memo carried request.maxPricePerHourZats. False: it carried 0 ("undisclosed") and
   * the max is private to this daemon. Absent on records from before this field: those were disclosed.
   */
  discloseMax?: boolean;
  job: { path: string; command: string[]; image?: string; env?: Record<string, string> };
  bundleFile: string;
  bundleSize: number;
  bundleSha256: string;
  autoAccept: AutoAcceptRule | null;
  asked: AskedProvider[];
  paddedOutputs: number;
  rfqTxids: string[];
  replyTo: string;
  sentHeight: number;
  expiresHeight: number;
  bids: BuyerBid[];
  rejectedBids: number;
  accepted?: {
    providerId: string;
    alias: string;
    pricePerIntervalZats: bigint;
    intervalS: number;
    intervals: number;
    payTo: string;
    providerEph: string;
    startWithinS: number;
    at: number;
    bidKey: string;
  };
  payments: BuyerPayment[];
  heartbeats: HeartbeatDto[];
  lastHeartbeatAt?: number;
  lastHeartbeatSeq: number;
  hbCursor: number;
  logCursor: number;
  lastLogBatch?: number;
  servingSeq?: number;
  servingSince?: number;
  sawFinal?: 'finished' | 'failed';
  logTail: string[];
  spentZats: bigint;
  feesZats: bigint;
  result?: { digest: string; sizeBytes: number; file: string; verified?: boolean };
  providerClose?: { reason: CloseReason; finalSeq: number; resultDigest?: string; txid: string };
  closeSent?: { reason: CloseReason; txid: string };
  closeReason?: CloseReason;
  closingSince?: number;
  error?: string;
  withholdPayments?: boolean;
  /** The prepare-funds self-send, while its notes confirm. */
  preparing?: { txid: string; notes: number; confirmations: number; required: number };
  /**
   * Buyer-clock time the job started: receipt of the first valid heartbeat reporting it running,
   * never before the ACCEPT. Interval k may be paid from jobStart + k·I − lead, never earlier.
   */
  jobStart?: number;
  /** A PAY being broadcast (persisted first, so a crash mid-send is never paid twice). */
  payInFlight?: { seq: number; at: number };
  /** After a crash mid-send: that seq is not resent until the provider shows it unpaid. */
  ambiguousPay?: { seq: number; since: number };
  /** When the request reached closed, expired or failed. */
  closedAt?: number;
  /** Metered delivery: the latest verified checkpoint, kept at `file` (only one per RFQ is kept). */
  checkpoint?: { seq: number; digest: string; sizeBytes: number; at: number; file: string };
  /** Relay cursor of the checkpoint mailbox. */
  ckptCursor?: number;
  /** Migration: this RFQ's job starts from this checkpoint (a private copy, verified again before upload). */
  resumeFrom?: { rfqId: string; seq: number; digest: string; sizeBytes: number; file: string };
  /** Migration: the job continues under this RFQ. */
  migratedTo?: string;
}

/** RfqDto plus additive fields (reported to the api owner). */
export type BuyerRfqDto = RfqDto & {
  /** Every RFQ transaction, if the backend forced a split. */
  rfqTxids: string[];
  /** BIDs dropped: bad signature, provider not asked, above max, late, refused address. */
  rejectedBids: number;
  /** False: providers never saw the max (the RFQ carried 0); bids above it were filtered here. */
  discloseMax: boolean;
  /** Fault injection: the buyer is deliberately not paying. */
  paymentsWithheld: boolean;
  /** Result digest checked against the provider's signed CLOSE. */
  resultVerified?: boolean;
  /** While state is 'broadcasting': the funding self-send and its confirmations ("preparing funds (n/3)"). */
  preparing?: { txid: string; notes: number; confirmations: number; required: number };
  /** Buyer-clock start of interval 0 (unix ms), once the provider reports the job running. */
  jobStartedAt?: number;
  /**
   * How payments are scheduled: interval k is paid on the buyer's clock between leadS and
   * leadS/2 before it starts (random point), so at most maxExposureIntervals are ever at risk.
   */
  payPolicy?: { leadS: number; jitterMaxS: number; maxExposureIntervals: number };
};

interface Runtime {
  keys: RfqKeys;
  channel: Channel | null;
  paying: Set<number>;
  /** seq → random delay (ms) into that interval's payment window. */
  jitter: Map<number, number>;
  loops: boolean;
  fetchingResult: boolean;
  accepting: boolean;
  closingTx: boolean;
}

interface PersistedBuyer {
  v: 1;
  scanHeight: number;
  rfqs: BuyerRfq[];
}

export interface BuyerNodeOptions extends NodeOptions {
  /** Largest result (tar.gz) this buyer accepts. Default 128 MiB. */
  maxResultBytes?: number;
  /** Largest checkpoint (tar.gz) this buyer accepts and keeps per RFQ. Default 64 MiB. */
  maxCheckpointBytes?: number;
  /** $HOME for the job.path privacy checks (tests). Default os.homedir(). */
  homeDir?: string;
}

export type BuyerFault = 'stop_paying' | 'resume_paying';

const ACTIVE: RfqState[] = ['accepted', 'running', 'closing'];

export class BuyerNode extends NodeBase {
  readonly role = 'buyer' as const;
  private seed: Uint8Array | null = null;
  private readonly rfqs = new Map<string, BuyerRfq>();
  private readonly rt = new Map<string, Runtime>();
  private readonly stateFile: StateFile<PersistedBuyer>;
  private scanHeight = 0;
  private lastTip = 0;
  private lastHeightRefresh = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private payTimer: NodeJS.Timeout | null = null;
  private readonly maxResultBytes: number;
  private readonly homeDir: string | undefined;
  private readonly maxCheckpointBytes: number;

  constructor(o: BuyerNodeOptions) {
    super('buyer', o);
    this.maxResultBytes = o.maxResultBytes ?? MAX_PAYLOAD_BYTES;
    // Memo transport: provider blobs for an accepted RFQ are signed with the accepted provider's key.
    this.memo.keyFor = (rfqId) => {
      const r = this.rfqs.get(rfqId);
      return r?.accepted ? unhex(r.accepted.providerId) : null;
    };
    this.maxCheckpointBytes = o.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
    this.homeDir = o.homeDir;
    this.stateFile = new StateFile(join(o.dataDir, 'buyer-state.json'), () => ({
      v: 1,
      scanHeight: this.watcher?.since ?? this.scanHeight,
      rfqs: [...this.rfqs.values()],
    }));
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.assertMainnetCap();
    this.seed = await loadOrCreateSeed(join(this.dataDir, 'master.seed'));
    const tip = await this.backend.height();
    this.lastTip = tip;
    const saved = await this.stateFile.load();
    this.scanHeight = tip;
    if (saved && saved.v === 1) {
      this.scanHeight = Math.min(tip, saved.scanHeight);
      for (const r of saved.rfqs) this.rfqs.set(r.rfqId, r);
    }
    for (const r of this.rfqs.values()) {
      for (const t of [...r.rfqTxids, ...r.bids.map((b) => b.txid), ...r.payments.map((p) => p.txid), r.providerClose?.txid, r.closeSent?.txid, r.preparing?.txid]) {
        if (t) this.knownTx.add(t.toLowerCase());
      }
      this.resume(r);
    }
    await this.initWallet();
    this.watcher = new NoteWatcher({
      backend: this.backend,
      decode: (m) => this.deps.protocol.decodeMemo(m),
      pollMs: this.profile.pollMs,
      since: Math.max(0, this.scanHeight - 1),
      onNote: (e) => this.onNote(e),
      onTick: (h) => this.onTick(h),
      onError: (e) => this.log(`buyer poll: ${errMsg(e)}`),
    });
    this.watcher.start();
    this.tickTimer = setInterval(() => void this.timerTick(), Math.max(50, Math.min(250, this.profile.heartbeatS * 500)));
    // Payments are driven by this timer and the buyer's clock only, never by a heartbeat arriving.
    this.payTimer = setInterval(() => this.schedulePayments(Date.now()), 50);
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.sender.closed = true;
    this.watcher?.stop();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.payTimer) clearInterval(this.payTimer);
    this.payTimer = null;
    this.stateFile.touch();
    await this.stateFile.flush();
  }

  private resume(r: BuyerRfq): void {
    const keys = this.deps.protocol.deriveRfqKeys(this.seed!, unhex(r.rfqId));
    const runtime: Runtime = { keys, channel: null, paying: new Set(), jitter: new Map(), loops: false, fetchingResult: false, accepting: false, closingTx: false };
    this.rt.set(r.rfqId, runtime);
    if (r.state === 'broadcasting') {
      this.fail(r, 'interrupted while broadcasting the RFQ (restart); outcome unknown');
      return;
    }
    if (r.payInFlight) {
      // Crashed while a PAY was being broadcast: it may or may not have gone out. Never resend
      // blindly; schedulePayments() decides from the provider's heartbeats.
      if (!r.payments.some((p) => p.seq === r.payInFlight!.seq)) r.ambiguousPay = { seq: r.payInFlight.seq, since: Date.now() };
      delete r.payInFlight;
    }
    if (r.ambiguousPay) r.ambiguousPay.since = Date.now();
    if (r.accepted && ACTIVE.includes(r.state)) {
      runtime.channel = this.deps.protocol.deriveChannel(keys.eph.secretKey, unhex(r.accepted.providerEph), unhex(r.rfqId));
      if (this.blobTransport === 'memo') this.memo.register(r.rfqId, runtime.channel, { to: r.accepted.payTo, signer: keys.signer });
      if (r.state === 'closing') r.closingSince = Date.now();
      // Restarted: give the provider a fresh heartbeat window instead of closing on stale timestamps.
      if (r.lastHeartbeatAt !== undefined) r.lastHeartbeatAt = Date.now();
      this.startLoops(r);
      // The final heartbeat or CLOSE may have arrived before the restart: fetch what's owed.
      if (!r.result && (r.sawFinal === 'finished' || r.providerClose?.resultDigest)) void this.fetchResult(r);
    }
  }

  // ------------------------------------------------------------------ queries

  async status(): Promise<StatusDto> {
    return this.baseStatus();
  }

  protected override onMemoSpent(rfqId: string, feeZats: bigint, valueZats: bigint): void {
    const r = this.rfqs.get(rfqId);
    if (!r) return;
    r.feesZats += feeZats + valueZats;
    this.changed(r);
  }

  /** Any request not yet closed, expired or failed: its ACCEPT and PAYs need the balance. */
  busy(): boolean {
    for (const r of this.rfqs.values()) if (r.state === 'broadcasting' || r.state === 'collecting' || ACTIVE.includes(r.state)) return true;
    return false;
  }

  /** Paid to providers plus fees, over every request this data dir has ever made (persisted with them). */
  capSpentZats(): bigint {
    let sum = 0n;
    for (const r of this.rfqs.values()) sum += r.spentZats + r.feesZats;
    return sum;
  }

  // ------------------------------------------------------------------ spend caps

  /**
   * Gate 1, before an RFQ goes out: its worst case (every interval at the max price, with the
   * profile's interval) must fit the per-request cap and what is left of the total.
   */
  private assertRfqWithinCap(v: { durationS: number; maxPricePerHourZats: bigint }): void {
    const cap = this.spendCap;
    if (!cap) return;
    const I = this.profile.intervalS;
    const intervals = Math.max(1, Math.ceil(v.durationS / I));
    const perInt = perInterval(v.maxPricePerHourZats, I);
    const worst = BigInt(intervals) * perInt;
    const how = `${intervals} × ${formatZec(perInt)} ZEC per ${I} s interval`;
    if (worst > cap.perRfqZats) {
      throw new EngineError('spend_cap', `request refused by the spend cap: it could pay up to ${formatZec(worst)} ZEC (${how}), above the per-request cap of ${formatZec(cap.perRfqZats)} ZEC`, 400);
    }
    const spent = this.capSpentZats();
    if (worst > cap.totalZats - spent) {
      throw new EngineError(
        'spend_cap',
        `request refused by the spend cap: it could pay up to ${formatZec(worst)} ZEC (${how}), more than the ${formatZec(cap.totalZats - spent)} ZEC left of the ${formatZec(cap.totalZats)} ZEC total (${formatZec(spent)} ZEC spent so far, fees included)`,
        400,
      );
    }
  }

  /** Gate 2, before an ACCEPT: the bid's real worst case (intervals × its price) against the caps. */
  private capRefusal(r: BuyerRfq, bid: BuyerBid, intervals: number): string | null {
    const cap = this.spendCap;
    if (!cap) return null;
    const worst = BigInt(intervals) * payAmount(bid.pricePerIntervalZats, this.minOutput);
    if (r.spentZats + worst > cap.perRfqZats) {
      return `${bid.alias}'s bid could pay ${formatZec(worst)} ZEC (${intervals} × ${formatZec(bid.pricePerIntervalZats)} ZEC per ${bid.intervalS} s), above the per-request cap of ${formatZec(cap.perRfqZats)} ZEC`;
    }
    const spent = this.capSpentZats();
    if (worst > cap.totalZats - spent) {
      return `${bid.alias}'s bid could pay ${formatZec(worst)} ZEC, more than the ${formatZec(cap.totalZats - spent)} ZEC left of the ${formatZec(cap.totalZats)} ZEC total (${formatZec(spent)} ZEC spent so far, fees included)`;
    }
    return null;
  }

  /** Gate 3, before each PAY: the next payment itself must still fit both caps. */
  private payBlockedByCap(r: BuyerRfq, amount: bigint): boolean {
    const cap = this.spendCap;
    if (!cap) return false;
    return r.spentZats + amount > cap.perRfqZats || this.capSpentZats() + amount > cap.totalZats;
  }

  /** A PAY would break the cap: stop the job cleanly (CLOSE buyer_stop) instead of paying. */
  private async capStop(r: BuyerRfq, seq: number, amount: bigint): Promise<void> {
    const cap = this.spendCap;
    if (!cap || r.state !== 'running') return;
    const spent = this.capSpentZats();
    r.error = `spend cap reached: paying interval ${seq} (${formatZec(amount)} ZEC) would exceed it (${formatZec(spent)} of ${formatZec(cap.totalZats)} ZEC spent in total; this request ${formatZec(r.spentZats)} of ${formatZec(cap.perRfqZats)} ZEC); stopping the job`;
    this.recordText('buyer', 'watchdog', 'Spend cap reached: payments stopped and the job is being closed', [
      ['Next payment', `${formatZec(amount)} ZEC for interval ${seq}`, true, true],
      ['Spent in total (fees included)', `${formatZec(spent)} of ${formatZec(cap.totalZats)} ZEC`, true, true],
      ['This request', `${formatZec(r.spentZats)} of ${formatZec(cap.perRfqZats)} ZEC`, true, true],
    ], { rfqId: r.rfqId });
    await this.stop(r.rfqId).catch((e) => this.log(`cap stop: ${errMsg(e)}`));
  }

  listRfqs(): BuyerRfqDto[] {
    return [...this.rfqs.values()].sort((a, b) => b.createdAt - a.createdAt).map((r) => this.dto(r));
  }

  getRfq(id: string): BuyerRfqDto {
    return this.dto(this.must(id));
  }

  /** Raw record, for tests and the CLI demo view. */
  record(id: string): BuyerRfq | undefined {
    return this.rfqs.get(id);
  }

  async resultBytes(id: string): Promise<Uint8Array> {
    const r = this.must(id);
    if (!r.result) throw notFound('no result for this RFQ yet');
    const buf = await readIfExists(r.result.file);
    if (!buf) throw notFound('result file is missing from the data dir');
    return new Uint8Array(buf);
  }

  private must(id: string): BuyerRfq {
    const r = this.rfqs.get(String(id).toLowerCase());
    if (!r) throw notFound(`no RFQ ${id}`);
    return r;
  }

  private runtime(r: BuyerRfq): Runtime {
    const x = this.rt.get(r.rfqId);
    if (!x) throw new Error('missing runtime');
    return x;
  }

  // ------------------------------------------------------------------ RFQ

  /**
   * `from` (migration only): reuse the bundle already checked and packed for an earlier RFQ, carry its
   * checkpoint, and leave out the provider being migrated away from when no providers are named.
   */
  async createRfq(req: NewRfqRequest, from?: MigrationSource): Promise<{ rfqId: string }> {
    if (this.stopped) throw conflict('node is shutting down');
    const p = this.deps.protocol;
    const v = validateRequest(req);
    this.assertRfqWithinCap(v);
    // The whole directory goes to someone else's machine: refuse keys, wallets and $HOME (code 'privacy').
    // A migration ships the bundle that passed this check when the original RFQ was made.
    if (!from) v.job.path = await checkJobPath(v.job.path, this.homeDir);

    this.directory.invalidate();
    const listing = await this.directory.list();
    let chosen: VerifiedProvider[];
    if (v.providerIds) {
      chosen = [];
      for (const id of v.providerIds) {
        const pr = listing.verified.find((x) => x.providerId === id);
        if (!pr) throw badRequest(`provider ${shortHex(id)} is not in the directory, or its entry failed verification`);
        chosen.push(pr);
      }
    } else {
      chosen = matchProviders(listing.verified, v).slice(0, 16);
      if (from?.excludeProviderId && chosen.length > 1) chosen = chosen.filter((c) => c.providerId !== from.excludeProviderId);
    }
    if (chosen.length === 0) {
      throw badRequest(`no verified provider offers ${v.count}× ${v.gpu} at or below ${formatZec(v.maxPricePerHourZats)} ZEC/h`);
    }

    const rfqIdBytes = p.newRfqId();
    const rfqId = hex(rfqIdBytes);
    const keys = p.deriveRfqKeys(this.seed!, rfqIdBytes);
    const replyTo = this.guard(await this.backend.newAddress());
    const tip = await this.backend.height();

    // Memo mode: a HELLO output rides next to each RFQ output (two outputs per provider), same buckets.
    const bucket = padBucket(chosen.length * (this.blobTransport === 'memo' ? 2 : 1));
    const bal = await this.backend.balance();
    if (bal.spendable + bal.pending <= this.minOutput * BigInt(bucket) + 5000n * BigInt(bucket + 2)) {
      throw new EngineError('insufficient_funds', `wallet has ${formatZec(bal.spendable)} ZEC spendable (${formatZec(bal.pending)} pending); fund it with shielded ZEC first`, 402);
    }

    const bundle = from ? from.bundle : await this.deps.packBundle(v.job.path);
    if (bundle.length + (from?.checkpoint.length ?? 0) > MAX_BUNDLE_BYTES) {
      throw badRequest(`job bundle${from ? ' plus checkpoint' : ''} is ${bundle.length + (from?.checkpoint.length ?? 0)} bytes; the limit is ${MAX_BUNDLE_BYTES}`);
    }
    if (this.blobTransport === 'memo' && bundle.length + (from?.checkpoint.length ?? 0) + 1024 > this.memo.maxBlobBytes) {
      throw badRequest(
        `job bundle is ${bundle.length} bytes; relay-less (memo) transport carries at most ${this.memo.maxBlobBytes} bytes per blob ` +
          '(about 44 KB: 4 transactions of 40 memos). Use a smaller job, or run the daemon with --transport relay',
      );
    }
    const bundleFile = join(this.dataDir, 'rfqs', rfqId, 'bundle.tar.gz');
    await writePrivate(bundleFile, bundle);
    let resumeFrom: BuyerRfq['resumeFrom'];
    if (from) {
      // A private copy: the source RFQ's checkpoint file is replaced whenever a newer one arrives.
      const file = join(this.dataDir, 'rfqs', rfqId, 'resume.tar.gz');
      await writePrivate(file, from.checkpoint);
      resumeFrom = { rfqId: from.rfqId, seq: from.seq, digest: hex(p.sha256(from.checkpoint)), sizeBytes: from.checkpoint.length, file };
    }

    const r: BuyerRfq = {
      rfqId,
      state: 'broadcasting',
      createdAt: Date.now(),
      request: { gpu: v.gpu, count: v.count, durationS: v.durationS, maxPricePerHourZats: v.maxPricePerHourZats },
      discloseMax: v.discloseMax,
      job: v.job,
      bundleFile,
      bundleSize: bundle.length,
      bundleSha256: hex(p.sha256(bundle)),
      autoAccept: v.autoAccept,
      asked: chosen.map((c) => {
        const a: AskedProvider = { providerId: c.providerId, alias: c.alias, address: c.address };
        if (c.bondZats !== undefined) a.bondZats = c.bondZats;
        return a;
      }),
      paddedOutputs: bucket,
      rfqTxids: [],
      replyTo,
      sentHeight: tip,
      expiresHeight: tip + profileAtHeight(this.profile, tip).bidWindowBlocks,
      bids: [],
      rejectedBids: 0,
      payments: [],
      heartbeats: [],
      lastHeartbeatSeq: -1,
      hbCursor: 0,
      logCursor: 0,
      logTail: [],
      spentZats: 0n,
      feesZats: 0n,
    };
    this.rfqs.set(rfqId, r);
    if (resumeFrom) r.resumeFrom = resumeFrom;
    this.rt.set(rfqId, { keys, channel: null, paying: new Set(), jitter: new Map(), loops: false, fetchingResult: false, accepting: false, closingTx: false });
    this.changed(r);
    void this.launch(r);
    return { rfqId };
  }

  /** Prepare funds (if the profile says so), then sign and broadcast the RFQ. */
  private async launch(r: BuyerRfq): Promise<void> {
    try {
      const prepared = this.profile.prepareNotes > 0 ? await this.prepareFunds(r) : false;
      if (this.stopped || r.state !== 'broadcasting') return;
      const p = this.deps.protocol;
      const keys = this.runtime(r).keys;
      const tip = await this.backend.height();
      r.sentHeight = tip;
      r.expiresHeight = tip + profileAtHeight(this.profile, tip).bidWindowBlocks;
      const msg: Rfq = {
        t: 'RFQ',
        rfqId: unhex(r.rfqId),
        gpu: r.request.gpu,
        count: r.request.count,
        durationS: r.request.durationS,
        // 0 on the wire = undisclosed: the private max never leaves this daemon.
        maxPricePerHourZats: disclosesMax(r) ? r.request.maxPricePerHourZats : 0n,
        replyTo: r.replyTo,
        buyerKey: keys.signer.publicKey,
        buyerEph: keys.eph.publicKey,
        expiresHeight: r.expiresHeight,
      };
      const memo = p.encodeMemo(msg, keys.signer, this.transport);
      const minOut = this.minOutput;
      const real: Output[] = r.asked.map((a) => ({ to: a.address, zats: minOut, memo }));
      // Relay-less deals are announced with a HELLO memo in the same transaction (any output order).
      if (this.blobTransport === 'memo') for (const a of r.asked) real.push(this.memo.helloOutput(r.rfqId, keys.signer, a.address, minOut));
      // Without a prepare step, the padding outputs (they come back to us anyway) also split the
      // job budget into separate notes, so ACCEPT and the first PAYs don't wait on change.
      const dummyCount = r.paddedOutputs - real.length;
      const splitZats = prepared ? minOut : splitPerNote(r.request, dummyCount, (await this.backend.balance()).spendable, minOut);
      const dummies: Output[] = [];
      for (let i = 0; i < dummyCount; i++) {
        dummies.push({ to: this.guard(await this.backend.newAddress()), zats: splitZats, memo: dummyMemo(this.transport) });
      }
      await this.broadcast(r, shuffle([...real, ...dummies]), real.length, splitZats > minOut);
    } catch (e) {
      const d = describeError(e);
      this.fail(r, `RFQ broadcast failed (${d.code}): ${d.message}`);
    }
  }

  /**
   * One self-send that splits the balance into notes sized for this job (RFQ, ACCEPT, the first
   * PAYs, CLOSE), then waits until they are spendable. Returns false if the wallet can't afford it
   * (the sends then simply wait for change).
   */
  private async prepareFunds(r: BuyerRfq): Promise<boolean> {
    const pr = this.profile;
    const intervalsEst = Math.max(1, Math.ceil(r.request.durationS / pr.intervalS));
    const fee = 60_000n; // a send with up to 12 logical actions
    const perInterval = (r.request.maxPricePerHourZats * BigInt(pr.intervalS) + 3599n) / 3600n;
    const rfqCost = this.minOutput * BigInt(r.paddedOutputs) + 5000n * BigInt(r.paddedOutputs + 2);
    const value = (perInterval > rfqCost ? perInterval : rfqCost) + fee;
    const spendable = (await this.backend.balance()).spendable;
    let k = Math.min(intervalsEst, pr.prepareNotes) + 3; // + RFQ, ACCEPT, CLOSE
    while (k > 3 && value * BigInt(k) + 5000n * BigInt(k + 2) > spendable) k--;
    if (value * BigInt(k) + 5000n * BigInt(k + 2) > spendable) {
      this.recordText('buyer', 'prepare-skipped', 'Not enough spendable funds to split into job-sized notes; payments may wait for change', [], { rfqId: r.rfqId });
      return false;
    }
    const outputs: Output[] = [];
    for (let i = 0; i < k; i++) outputs.push({ to: this.guard(await this.backend.newAddress()), zats: value, memo: dummyMemo(this.transport) });
    const res = await this.send(outputs, { rfqId: r.rfqId, what: 'Funding notes for this job (self-send)', sealed: TX_FACTS.selfSend });
    r.feesZats += res.feeZats;
    r.preparing = { txid: res.txid, notes: k, confirmations: 0, required: pr.changeConfirmations };
    this.recordText('buyer', 'tx-broadcast', `Split ${formatZec(value * BigInt(k))} ZEC into ${k} notes for this job (to fresh addresses of our own)`, [
      ['Notes', `${k} × ${formatZec(value)} ZEC`, true, true],
      ['Why', 'interval payments must not wait for change to confirm', true, false],
      ['Spendable after', `${pr.changeConfirmations} confirmation(s)`, true, false],
    ], { rfqId: r.rfqId, txid: res.txid });
    this.changed(r);
    const deadline = Date.now() + pr.prepareTimeoutS * 1000;
    while (!this.stopped && Date.now() < deadline) {
      const tip = await this.backend.height();
      let conf = 0;
      if (this.backend.capabilities.inspectTx && this.backend.inspectTx) {
        const h = await this.backend.inspectTx(res.txid).then((v) => v.height, () => null);
        conf = h === null ? 0 : tip - h + 1;
      } else if ((await this.backend.balance()).pending === 0n) {
        conf = pr.changeConfirmations;
      }
      const shown = Math.min(conf, pr.changeConfirmations);
      if (shown !== r.preparing.confirmations) {
        r.preparing.confirmations = shown;
        this.changed(r);
      }
      if (conf >= pr.changeConfirmations && (await this.backend.balance()).spendable >= value) break;
      await sleep(pr.pollMs);
    }
    return true;
  }

  private async broadcast(r: BuyerRfq, outputs: Output[], realCount: number, splitInPadding: boolean): Promise<void> {
    const maxPer = Math.max(1, this.backend.capabilities.maxOutputsPerTx);
    const chunks: Output[][] = [];
    for (let i = 0; i < outputs.length; i += maxPer) chunks.push(outputs.slice(i, i + maxPer));
    if (chunks.length > 1) {
      this.recordText(
        'chain',
        'privacy-tradeoff',
        `Wallet backend carries at most ${maxPer} output(s) per transaction, so this RFQ went out as ${chunks.length} transactions`,
        [
          ['Transactions for one RFQ', String(chunks.length), true, false],
          ['Outputs per transaction', String(maxPer), true, false],
          ['Trade-off', 'back-to-back transactions can be linked by timing; the padded total still hides how many providers were asked', true, false],
        ],
        { rfqId: r.rfqId },
      );
    }
    for (const chunk of chunks) {
      const res = await this.send(chunk, { rfqId: r.rfqId, what: 'Sealed RFQ', sealed: TX_FACTS.rfq });
      r.rfqTxids.push(res.txid);
      r.feesZats += res.feeZats;
    }
    r.feesZats += this.minOutput * BigInt(realCount);
    r.sentHeight = Math.max(r.sentHeight, await this.backend.height().catch(() => r.sentHeight));
    r.state = 'collecting';
    const job = r.job.command.join(' ');
    this.recordText(
      'buyer',
      'tx-broadcast',
      `Sealed RFQ sent to ${r.asked.length} provider(s) in ${chunks.length} transaction(s), ${r.paddedOutputs} outputs after padding${this.blobTransport === 'memo' ? ' (relay-less: a HELLO memo per provider rides along)' : ''}`,
      [
        ['GPU', `${r.request.count}× ${r.request.gpu}`, true, true],
        ['Duration', `${r.request.durationS} s`, true, true],
        disclosesMax(r)
          ? ['Max price', `${formatZec(r.request.maxPricePerHourZats)} ZEC/h (disclosed to every provider asked)`, true, true]
          : ['Max price', `${formatZec(r.request.maxPricePerHourZats)} ZEC/h: withheld from providers (the memo says 0 = undisclosed)`, true, true],
        ['Providers asked', r.asked.map((a) => a.alias).join(', '), true, true],
        ['Outputs (real / padded)', `${realCount} / ${r.paddedOutputs}`, true, false],
        ['Padding outputs', splitInPadding ? 'to fresh addresses of our own; they also split the job budget into separate notes' : 'to fresh addresses of our own', true, false],
        ['Reply address (one-time)', r.replyTo, true, true],
        ['Per-RFQ signing key', hex(this.runtime(r).keys.signer.publicKey), true, false],
        ['Job command', job, true, true],
        ['Job bundle', `${r.bundleSize} bytes, sha256 ${shortHex(r.bundleSha256)}`, true, true],
        ['Memo transport', this.transport, true, false],
        ['Bids accepted until height', String(r.expiresHeight), true, false],
      ],
      { rfqId: r.rfqId, txid: r.rfqTxids[0]! },
    );
    this.changed(r);
  }

  // ------------------------------------------------------------------ notes

  private async onNote(e: NoteEvent): Promise<void> {
    const d = e.decoded;
    this.received(e.note.txid);
    this.trackIncoming(e);
    if (!d) return;
    if (d.msg.t === 'BID') await this.onBid(e, d.msg, d);
    else if (d.msg.t === 'CLOSE') await this.onProviderClose(e, d.msg, d);
  }

  private async onBid(e: NoteEvent, bid: Bid, d: DecodedMemo): Promise<void> {
    const r = this.rfqs.get(hex(bid.rfqId));
    if (!r) return; // not ours: ignore without a trace
    const key = `${e.note.txid}:${e.note.index}`;
    const existing = r.bids.find((b) => b.key === key);
    if (existing) {
      if (existing.height === null && e.note.height !== null) {
        existing.height = e.note.height;
        this.changed(r);
      }
      return;
    }
    if (!e.firstSeen) return; // judged when first seen
    const providerId = hex(bid.providerId);
    const asked = r.asked.find((a) => a.providerId === providerId);
    const reject = (reason: string) => {
      r.rejectedBids += 1;
      this.recordText('buyer', 'bid-rejected', `Ignored a BID: ${reason}`, [
        ['Claimed provider', asked ? asked.alias : shortHex(providerId), true, false],
        ['Reason', reason, true, false],
        ['Transaction', e.note.txid, true, false],
      ], { rfqId: r.rfqId, txid: e.note.txid });
      this.changed(r);
    };
    if (r.state !== 'collecting' && r.state !== 'broadcasting') return reject(`arrived while the RFQ is ${r.state}`);
    if (!d.verifiedBy(bid.providerId)) return reject('signature does not verify under the claimed provider key');
    if (!asked) return reject('provider was not asked');
    if (!Number.isInteger(bid.intervalS) || bid.intervalS < 1 || bid.intervalS > 86400) return reject('bad interval length');
    if (bid.pricePerIntervalZats < 0n) return reject('negative price');
    if (!withinHourly(bid.pricePerIntervalZats, bid.intervalS, r.request.maxPricePerHourZats)) {
      const hourly = formatZec(perHour(bid.pricePerIntervalZats, bid.intervalS));
      return reject(disclosesMax(r) ? `price ${hourly} ZEC/h is above the max` : `price ${hourly} ZEC/h is above private max (the provider never saw it)`);
    }
    const height = e.note.height ?? this.lastTip;
    if (height > r.expiresHeight) return reject(`mined at height ${height}, after expiry ${r.expiresHeight}`);
    let payTo: string;
    try {
      payTo = this.guard(bid.payTo);
    } catch (err) {
      return reject(`payTo address refused: ${errMsg(err)}`);
    }
    const b: BuyerBid = {
      key,
      providerId,
      alias: asked.alias,
      pricePerIntervalZats: bid.pricePerIntervalZats,
      intervalS: bid.intervalS,
      startWithinS: Math.max(0, Math.min(bid.startWithinS, 86400)),
      providerEph: hex(bid.providerEph),
      payTo,
      receivedAt: Date.now(),
      txid: e.note.txid,
      height: e.note.height,
    };
    if (asked.bondZats !== undefined) b.bondZats = asked.bondZats;
    r.bids.push(b);
    this.recordText('buyer', 'memo-received', `Signed BID from ${asked.alias}`, [
      ['Provider', `${asked.alias} (${shortHex(providerId)})`, true, false],
      ['Price', `${formatZec(b.pricePerIntervalZats)} ZEC per ${b.intervalS} s (${formatZec(perHour(b.pricePerIntervalZats, b.intervalS))} ZEC/h)`, true, true],
      ['Starts within', `${b.startWithinS} s`, true, false],
      ['Pay-to address (fresh)', payTo, true, true],
      ['Signature', 'valid (directory key)', true, false],
    ], { rfqId: r.rfqId, txid: e.note.txid });
    void this.observeTx(e.note.txid, { rfqId: r.rfqId, event: 'tx-received', summary: 'BID transaction: what the public chain shows', sealed: TX_FACTS.bid });
    this.changed(r);
    this.maybeAutoAccept(r);
  }

  private async onProviderClose(e: NoteEvent, c: Close, d: DecodedMemo): Promise<void> {
    const r = this.rfqs.get(hex(c.rfqId));
    if (!r || !r.accepted || c.by !== 'provider') return;
    if (!d.verifiedBy(unhex(r.accepted.providerId))) {
      this.recordText('buyer', 'memo-rejected', 'Ignored a CLOSE that is not signed by the accepted provider', [['Transaction', e.note.txid, true, false]], { rfqId: r.rfqId });
      return;
    }
    if (r.providerClose) return;
    r.providerClose = { reason: c.reason, finalSeq: c.finalSeq, txid: e.note.txid };
    if (c.resultDigest) r.providerClose.resultDigest = hex(c.resultDigest);
    this.recordText('buyer', 'memo-received', `Provider closed the job: ${c.reason}`, [
      ['Reason', c.reason, true, false],
      ['Last interval served', String(c.finalSeq), true, false],
      ['Result digest', r.providerClose.resultDigest ?? 'none', true, false],
    ], { rfqId: r.rfqId, txid: e.note.txid });
    void this.observeTx(e.note.txid, { rfqId: r.rfqId, event: 'tx-received', summary: 'Provider CLOSE transaction: what the public chain shows', sealed: TX_FACTS.providerClose });
    if (r.result && r.providerClose.resultDigest) this.checkDigest(r);
    // Unless the buyer itself ended the deal, the provider's CLOSE says why it ended
    // (our own CLOSE after fetching a result is only an acknowledgment).
    if (!buyerInitiated(r)) r.closeReason = c.reason;
    this.enterClosing(r, c.reason);
    if (r.providerClose.resultDigest && !r.result) void this.fetchResult(r);
    this.changed(r);
    this.settle(r);
  }

  // ------------------------------------------------------------------ ticks

  private async onTick(tip: number): Promise<void> {
    this.lastTip = tip;
    for (const r of this.rfqs.values()) {
      if (r.state === 'collecting') {
        this.maybeAutoAccept(r);
        const rt = this.rt.get(r.rfqId);
        if (rt?.accepting) continue;
        if (tip > r.expiresHeight && r.bids.length === 0) {
          r.state = 'expired';
          r.error = 'no acceptable bids before expiry';
          this.changed(r);
        } else if (tip > r.expiresHeight + profileAtHeight(this.profile, r.expiresHeight).acceptWindowBlocks) {
          r.state = 'expired';
          r.error = 'bids were not accepted in time';
          this.changed(r);
        }
      }
    }
    if (this.backend.capabilities.inspectTx && Date.now() - this.lastHeightRefresh > 2000) {
      this.lastHeightRefresh = Date.now();
      await this.refreshPaymentHeights();
    }
  }

  /** Fast timer: heartbeat timeouts and closing deadlines. */
  private async timerTick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    for (const r of this.rfqs.values()) {
      if (!r.accepted) continue;
      if (r.state === 'accepted' || r.state === 'running') {
        // The job must be reported running by its start deadline ('starting' heartbeats don't count),
        // and after that heartbeats must keep coming.
        const startDeadline = r.accepted.at + (r.accepted.startWithinS + this.profile.heartbeatTimeoutS + 2 * this.profile.blockTimeS) * 1000;
        const late = r.jobStart === undefined ? now > startDeadline : false;
        const silent = r.lastHeartbeatAt !== undefined && now > r.lastHeartbeatAt + this.heartbeatTimeoutS(r) * 1000;
        if (late || silent) void this.noHeartbeat(r);
      } else if (r.state === 'closing') {
        if (r.closingSince !== undefined && now > r.closingSince + this.profile.closeWaitS * 1000) {
          if (r.result && r.result.verified === undefined) r.error = "provider's CLOSE never arrived; result digest unverified";
          this.finish(r, 'closed');
        }
      }
    }
  }

  private async refreshPaymentHeights(): Promise<void> {
    for (const r of this.rfqs.values()) {
      if (!ACTIVE.includes(r.state) && r.state !== 'closed') continue;
      let touched = false;
      for (const pay of r.payments) {
        if (pay.height !== null || Date.now() - pay.at > 3_600_000) continue;
        try {
          const view = await this.backend.inspectTx!(pay.txid);
          if (view.height !== null) {
            pay.height = view.height;
            touched = true;
          }
        } catch {
          // not visible yet
        }
      }
      if (touched) this.changed(r);
    }
  }

  private maybeAutoAccept(r: BuyerRfq): void {
    const rule = r.autoAccept;
    if (!rule || r.state !== 'collecting' || r.bids.length === 0) return;
    const rt = this.rt.get(r.rfqId);
    if (!rt || rt.accepting) return;
    const minBond = rule.minBondZats !== undefined ? BigInt(rule.minBondZats) : 0n;
    const bonded = r.bids.filter((b) => (b.bondZats ?? 0n) >= minBond);
    const eligible = bonded.filter((b) => this.capRefusal(r, b, Math.max(1, Math.ceil(r.request.durationS / b.intervalS))) === null);
    if (eligible.length === 0) {
      if (bonded.length > 0) {
        const why = `auto-accept: no bid fits the spend cap (${this.capRefusal(r, rankBids(bonded)[0]!, Math.max(1, Math.ceil(r.request.durationS / rankBids(bonded)[0]!.intervalS)))})`;
        if (r.error !== why) {
          r.error = why;
          this.changed(r);
        }
      }
      return;
    }
    const everyoneBid = r.asked.every((a) => r.bids.some((b) => b.providerId === a.providerId));
    if (this.lastTip < r.sentHeight + rule.waitBlocks && !everyoneBid) return;
    const best = rankBids(eligible)[0]!;
    this.accept(r.rfqId, best.providerId).catch((e) => {
      r.error = `auto-accept failed: ${errMsg(e)}`;
      this.changed(r);
    });
  }

  // ------------------------------------------------------------------ accept

  async accept(rfqId: string, providerId: string): Promise<BuyerRfqDto> {
    const r = this.must(rfqId);
    const rt = this.runtime(r);
    if (r.state !== 'collecting') throw conflict(`RFQ is ${r.state}; only a collecting RFQ can be accepted`);
    if (rt.accepting) throw conflict('an accept is already in progress');
    if (this.lastTip > r.expiresHeight + profileAtHeight(this.profile, r.expiresHeight).acceptWindowBlocks) throw conflict('too late: providers have given up on this RFQ');
    const pid = String(providerId).toLowerCase();
    const candidates = r.bids.filter((b) => b.providerId === pid);
    if (candidates.length === 0) throw notFound(`no valid bid from provider ${shortHex(pid)}`);
    const bid = rankBids(candidates)[0]!;
    rt.accepting = true;
    try {
      const p = this.deps.protocol;
      const intervals = Math.max(1, Math.ceil(r.request.durationS / bid.intervalS));
      const capWhy = this.capRefusal(r, bid, intervals);
      if (capWhy) throw new EngineError('spend_cap', `accept refused by the spend cap: ${capWhy}`, 400);
      const channel = p.deriveChannel(rt.keys.eph.secretKey, unhex(bid.providerEph), unhex(r.rfqId));
      if (this.blobTransport === 'memo') this.memo.register(r.rfqId, channel, { to: bid.payTo, signer: rt.keys.signer });
      const bundle = new Uint8Array(await readFile(r.bundleFile));
      const manifest: JobManifest = {
        v: 1,
        command: r.job.command,
        gpu: { model: r.request.gpu, count: r.request.count },
        bundleSize: bundle.length,
        bundleSha256: hex(p.sha256(bundle)),
      };
      if (r.job.image) manifest.image = r.job.image;
      if (r.job.env && Object.keys(r.job.env).length) manifest.env = r.job.env;
      let checkpoint: Uint8Array | undefined;
      if (r.resumeFrom) {
        const buf = await readIfExists(r.resumeFrom.file);
        if (!buf) throw new EngineError('internal', 'the checkpoint to resume from is missing from the data dir', 500);
        checkpoint = new Uint8Array(buf);
        if (hex(p.sha256(checkpoint)) !== r.resumeFrom.digest) throw new EngineError('internal', 'the checkpoint to resume from does not match its digest', 500);
        manifest.resumeFrom = { seq: r.resumeFrom.seq, sizeBytes: checkpoint.length, sha256: r.resumeFrom.digest };
      }
      const up = await uploadChunked(this.relay, channel, 'job', encodeJobBlob(manifest, bundle, checkpoint), p.sha256);
      const viaMemo = this.memo.isMemo(r.rfqId);
      this.recordText('buyer', 'blob-stored', `Job${checkpoint ? ' and its checkpoint' : ''} sealed to the channel key and ${viaMemo ? 'sent on-chain in memos (relay-less)' : 'uploaded to the relay'}`, [
        viaMemo ? ['Relay', 'not used: the sealed job travels in shielded memos to the provider', true, false] : ['Relay mailbox (derived from the channel secret)', channel.mailboxes.job, true, false],
        ['Sealed size', `${up.sealedBytes} bytes in ${up.parts} chunk(s)`, true, false],
        ['What the relay stores', cipherPreview(up.first), true, false],
        ['Job command', r.job.command.join(' '), true, true],
        ['Image', r.job.image ?? 'python:3.12-slim', true, false],
        ...(r.resumeFrom
          ? [['Resumes from', `the checkpoint taken at interval ${r.resumeFrom.seq} of the earlier deal (${r.resumeFrom.sizeBytes} bytes); the earlier RFQ and provider are not named`, true, true] as [string, string, boolean, boolean]]
          : []),
      ], { rfqId: r.rfqId });

      const amount = bid.pricePerIntervalZats > this.minOutput ? bid.pricePerIntervalZats : this.minOutput;
      const memo = p.encodeMemo(
        { t: 'ACCEPT', rfqId: unhex(r.rfqId), providerId: unhex(bid.providerId), intervals, pricePerIntervalZats: bid.pricePerIntervalZats },
        rt.keys.signer,
        this.transport,
      );
      if (this.stopped) throw conflict('node is shutting down');
      const res = await this.send([{ to: bid.payTo, zats: amount, memo }], { rfqId: r.rfqId, what: 'ACCEPT (pays interval 0)', sealed: TX_FACTS.accept });
      rt.channel = channel;
      r.accepted = {
        providerId: bid.providerId,
        alias: bid.alias,
        pricePerIntervalZats: bid.pricePerIntervalZats,
        intervalS: bid.intervalS,
        intervals,
        payTo: bid.payTo,
        providerEph: bid.providerEph,
        startWithinS: bid.startWithinS,
        at: Date.now(),
        bidKey: bid.key,
      };
      r.payments.push({ seq: 0, kind: 'accept', zats: amount, feeZats: res.feeZats, txid: res.txid, height: null, at: Date.now() });
      r.spentZats += amount;
      r.feesZats += res.feeZats;
      r.state = 'accepted';
      delete r.error;
      this.recordText('buyer', 'tx-broadcast', `ACCEPT sent to ${bid.alias}; its value pays interval 0`, [
        ['Provider', bid.alias, true, false],
        ['Price', `${formatZec(bid.pricePerIntervalZats)} ZEC per ${bid.intervalS} s`, true, true],
        ['Intervals bought (max)', String(intervals), true, true],
        ['Paid now', `${formatZec(amount)} ZEC`, true, true],
        ['To (provider pay-to)', bid.payTo, true, true],
      ], { rfqId: r.rfqId, txid: res.txid });
      this.startLoops(r);
    } finally {
      rt.accepting = false;
    }
    this.changed(r);
    return this.dto(r);
  }

  // ------------------------------------------------------------------ channel loops

  private startLoops(r: BuyerRfq): void {
    const rt = this.runtime(r);
    if (rt.loops || !rt.channel) return;
    rt.loops = true;
    void this.mailboxLoop(r, 'heartbeat');
    void this.mailboxLoop(r, 'log');
    void this.checkpointLoop(r);
  }

  /** Memo mode: heartbeats come once per interval and a block later, so the timeouts stretch to fit. */
  private heartbeatTimeoutS(r: BuyerRfq): number {
    const base = this.profile.heartbeatTimeoutS;
    if (!r.accepted || !this.memo.isMemo(r.rfqId)) return base;
    return Math.max(base, 2 * r.accepted.intervalS + 2 * this.profile.blockTimeS);
  }

  private payFreshS(r: BuyerRfq): number {
    const base = this.profile.payFreshS;
    if (!r.accepted || !this.memo.isMemo(r.rfqId)) return base;
    return Math.max(base, r.accepted.intervalS + payLeadFor(this.profile, r.accepted.intervalS) + this.profile.blockTimeS);
  }

  private live(r: BuyerRfq): boolean {
    return !this.stopped && ACTIVE.includes(r.state);
  }

  private async mailboxLoop(r: BuyerRfq, kind: 'heartbeat' | 'log'): Promise<void> {
    const ch = this.runtime(r).channel!;
    const box = ch.mailboxes[kind];
    while (this.live(r)) {
      try {
        const after = kind === 'heartbeat' ? r.hbCursor : r.logCursor;
        const msgs = await this.relay.read(box, after, this.profile.relayWaitS);
        if (!this.live(r)) break;
        for (const m of msgs) {
          if (kind === 'heartbeat') {
            r.hbCursor = Math.max(r.hbCursor, m.seq);
            await this.onHeartbeatBlob(r, ch, m.data);
          } else {
            r.logCursor = Math.max(r.logCursor, m.seq);
            this.onLogBlob(r, ch, m.data);
          }
        }
        if (msgs.length === 0) await sleep(Math.min(250, this.profile.pollMs));
      } catch (e) {
        if (!this.live(r)) break;
        this.log(`relay ${kind} read: ${errMsg(e)}`);
        await sleep(Math.min(1000, this.profile.pollMs * 5));
      }
    }
  }

  /**
   * Metered delivery: the provider uploads a sealed checkpoint at the end of every served interval
   * (and when it pauses or stops). Only the latest verified one is kept, at <data>/checkpoints/<rfqId>/.
   */
  private async checkpointLoop(r: BuyerRfq): Promise<void> {
    const ch = this.runtime(r).channel!;
    const box = ch.mailboxes.checkpoint;
    const asm = new ChunkAssembler(this.deps.protocol.sha256, this.maxCheckpointBytes);
    while (this.live(r)) {
      try {
        const msgs = await this.relay.read(box, r.ckptCursor ?? 0, this.profile.relayWaitS);
        if (!this.live(r)) break;
        for (const m of msgs) {
          r.ckptCursor = Math.max(r.ckptCursor ?? 0, m.seq);
          let plain: Uint8Array;
          try {
            plain = ch.open('checkpoint', m.data);
          } catch {
            continue; // not ours / tampered
          }
          let payload: Uint8Array | null;
          try {
            payload = asm.push(plain);
          } catch (e) {
            this.recordText('buyer', 'checkpoint-rejected', `Rejected a checkpoint: ${errMsg(e)}`, [['Reason', errMsg(e), true, false]], { rfqId: r.rfqId });
            continue;
          }
          if (payload) await this.onCheckpoint(r, payload);
        }
        if (msgs.length === 0) await sleep(Math.min(250, this.profile.pollMs));
      } catch (e) {
        if (!this.live(r)) break;
        this.log(`relay checkpoint read: ${errMsg(e)}`);
        await sleep(Math.min(1000, this.profile.pollMs * 5));
      }
    }
  }

  private async onCheckpoint(r: BuyerRfq, payload: Uint8Array): Promise<void> {
    const ck = decodeCheckpointBlob(payload);
    if (!ck) return;
    const digest = this.deps.protocol.sha256(ck.tar);
    if (!bytesEqual(digest, ck.sha256)) {
      this.recordText('buyer', 'checkpoint-rejected', `Rejected the checkpoint for interval ${ck.seq}: its digest does not match`, [['Interval', String(ck.seq), true, false]], { rfqId: r.rfqId });
      return;
    }
    const d = hex(digest);
    const cur = r.checkpoint;
    if (cur && (ck.seq < cur.seq || (ck.seq === cur.seq && cur.digest === d))) return; // older, or a duplicate upload
    const file = join(this.dataDir, 'checkpoints', r.rfqId, 'checkpoint.tar.gz');
    await writePrivate(file, ck.tar); // replaces the previous one: only the latest is kept
    r.checkpoint = { seq: ck.seq, digest: d, sizeBytes: ck.tar.length, at: Date.now(), file };
    this.recordText('buyer', 'checkpoint-received', `Checkpoint for interval ${ck.seq} received, sealed; digest verified`, [
      ['Interval', String(ck.seq), true, false],
      ['Size', `${ck.tar.length} bytes (tar.gz)`, true, true],
      ['SHA-256 of the checkpoint', d, true, false],
      ['Verified', 'the packed bytes match the digest in the sealed header', true, false],
      ['Kept on disk', file, true, false],
      ['What the relay saw', 'one more sealed blob, its size and when it was uploaded; not what it is', false, false],
    ], { rfqId: r.rfqId });
    this.changed(r);
  }

  private onLogBlob(r: BuyerRfq, ch: Channel, data: Uint8Array): void {
    let batch: { seq: number; lines: string[] } | null;
    try {
      batch = decodeLogBatch(ch.open('log', data));
    } catch {
      return;
    }
    if (!batch || batch.seq <= (r.lastLogBatch ?? 0)) return; // duplicate PUT
    r.lastLogBatch = batch.seq;
    const lines = batch.lines;
    r.logTail.push(...lines);
    if (r.logTail.length > LOG_LINES_KEPT) r.logTail.splice(0, r.logTail.length - LOG_LINES_KEPT);
    this.emit({ type: 'log', rfqId: r.rfqId, lines });
    this.stateFile.touch();
  }

  private async onHeartbeatBlob(r: BuyerRfq, ch: Channel, data: Uint8Array): Promise<void> {
    let hb: Heartbeat | null = null;
    try {
      hb = this.deps.protocol.decodeHeartbeat(ch.open('heartbeat', data), unhex(r.accepted!.providerId));
    } catch {
      hb = null;
    }
    if (!hb || hex(hb.rfqId) !== r.rfqId || hb.seq <= r.lastHeartbeatSeq) return;
    const first = r.heartbeats.length === 0;
    const prev = r.heartbeats[0];
    r.lastHeartbeatSeq = hb.seq;
    r.lastHeartbeatAt = Date.now();
    const dto: HeartbeatDto = {
      seq: hb.seq,
      at: Date.now(),
      step: hb.step,
      status: hb.status,
      servingSeq: hb.servingSeq,
      checkpointDigest: hex(hb.checkpointDigest),
    };
    if (hb.note !== undefined) dto.note = hb.note;
    r.heartbeats.unshift(dto);
    if (r.heartbeats.length > HEARTBEATS_KEPT) r.heartbeats.length = HEARTBEATS_KEPT;
    if (r.servingSeq !== hb.servingSeq) {
      r.servingSeq = hb.servingSeq;
      r.servingSince = Date.now();
    }
    if (r.state === 'accepted' && hb.status !== 'starting') r.state = 'running';
    if (r.jobStart === undefined && hb.status !== 'starting') {
      r.jobStart = Math.max(Date.now(), r.accepted!.at);
      this.stateFile.touch();
      void this.stateFile.flush();
      const a = r.accepted!;
      const lead = payLeadFor(this.profile, a.intervalS);
      this.recordText('buyer', 'watchdog', 'Job reported running: interval 0 starts now on the buyer\'s own clock', [
        ['Payment schedule', `interval k is paid between ${lead} s and ${lead / 2} s before jobStart + k × ${a.intervalS} s, at a random point`, true, false],
        ['Why', "the provider's heartbeats can only delay payments, never bring them forward", true, false],
        ['Most at risk', `${+(maxExposureIntervals(this.profile, a.intervalS)).toFixed(3)} intervals (${a.intervalS + lead} s of compute)`, true, false],
      ], { rfqId: r.rfqId });
    }
    if (first || !prev || prev.status !== hb.status || prev.servingSeq !== hb.servingSeq) {
      this.recordText('buyer', 'heartbeat-received', `Signed heartbeat: ${hb.status}, serving interval ${hb.servingSeq}, step ${hb.step}`, [
        ['Status', hb.status, true, false],
        ['Serving interval', String(hb.servingSeq), true, false],
        ['Step', String(hb.step), true, false],
        ['Checkpoint digest', hex(hb.checkpointDigest), true, false],
        ['Signature', 'valid (provider directory key)', true, false],
      ], { rfqId: r.rfqId });
    }
    this.changed(r);
    if (hb.status === 'finished' || hb.status === 'failed') {
      r.sawFinal = hb.status;
      if (r.state === 'accepted' || r.state === 'running') this.enterClosing(r);
      void this.fetchResult(r);
    }
  }

  // ------------------------------------------------------------------ metered payments

  private paid(r: BuyerRfq, seq: number): boolean {
    return r.payments.some((p) => p.seq === seq);
  }

  /** Next interval to pay: one past the highest paid (payments are made strictly in order). */
  private nextSeq(r: BuyerRfq): number {
    return r.payments.reduce((m, p) => Math.max(m, p.seq), 0) + 1;
  }

  private jitterMs(rt: Runtime, seq: number, leadMs: number): number {
    let j = rt.jitter.get(seq);
    if (j === undefined) {
      j = randomInt(Math.floor(leadMs / 2) + 1); // crypto randomness: no fixed PAY cadence
      rt.jitter.set(seq, j);
    }
    return j;
  }

  /** When interval `seq` may be paid on the buyer's clock (window open + random delay). */
  private payDueAt(r: BuyerRfq, rt: Runtime, seq: number): { open: number; due: number; leadMs: number } | null {
    if (!r.accepted || r.jobStart === undefined) return null;
    const iMs = r.accepted.intervalS * 1000;
    const leadMs = Math.round(payLeadFor(this.profile, r.accepted.intervalS) * 1000);
    const open = r.jobStart + seq * iMs - leadMs;
    return { open, due: open + this.jitterMs(rt, seq, leadMs), leadMs };
  }

  /**
   * The metered-payment scheduler (runs every 50 ms). Interval k ≥ 1 is paid only when ALL hold:
   *   (a) now ≥ jobStart + k·I − lead + jitter_k   (buyer's own clock; jitter_k ∈ [0, lead/2])
   *   (b) the latest valid heartbeat is fresh and shows servingSeq ≥ k − 1 (running or paused)
   *   (c) payments aren't withheld
   *   (d) k < intervals
   * So at any time t the buyer has paid at most 1 + floor((t − jobStart + lead) / I) intervals:
   * never more than I + lead of compute ahead of its own clock, whatever the provider claims.
   */
  private schedulePayments(now: number): void {
    if (this.stopped) return;
    for (const r of this.rfqs.values()) {
      const a = r.accepted;
      if (!a || r.state !== 'running' || r.jobStart === undefined || r.withholdPayments) continue;
      const rt = this.rt.get(r.rfqId);
      if (!rt || rt.paying.size > 0) continue;
      const k = this.nextSeq(r);
      if (k >= a.intervals) continue; // (d)
      const hb = r.heartbeats[0];
      const fresh = hb !== undefined && now - hb.at <= this.payFreshS(r) * 1000;
      if (r.ambiguousPay) {
        const amb = r.ambiguousPay;
        if (amb.seq < k) {
          delete r.ambiguousPay;
        } else if (fresh && hb!.servingSeq >= amb.seq) {
          // The provider serves that interval, so the lost PAY did arrive. Record it, don't resend.
          r.payments.push({ seq: amb.seq, kind: 'pay', zats: payAmount(a.pricePerIntervalZats, this.minOutput), feeZats: 0n, txid: 'unknown (broadcast result was lost)', height: null, at: amb.since });
          r.spentZats += payAmount(a.pricePerIntervalZats, this.minOutput);
          delete r.ambiguousPay;
          this.changed(r);
          continue;
        } else if (fresh && hb!.status === 'paused' && hb!.servingSeq === amb.seq - 1 && now - amb.since > this.profile.graceS * 500) {
          delete r.ambiguousPay; // the provider is waiting for it: it never went out
        } else {
          continue;
        }
      }
      const when = this.payDueAt(r, rt, k);
      if (!when || now < when.due) continue; // (a)
      if (!fresh || hb!.servingSeq < k - 1 || (hb!.status !== 'running' && hb!.status !== 'paused')) continue; // (b)
      const amount = payAmount(a.pricePerIntervalZats, this.minOutput);
      if (this.payBlockedByCap(r, amount)) {
        void this.capStop(r, k, amount); // (e) the spend cap: stop instead of paying
        continue;
      }
      void this.pay(r, k, when.due - when.open);
    }
  }

  private async pay(r: BuyerRfq, seq: number, jitterMs: number): Promise<void> {
    const a = r.accepted;
    const rt = this.runtime(r);
    if (!a || r.withholdPayments || seq < 1 || seq >= a.intervals) return;
    if (this.paid(r, seq) || rt.paying.has(seq)) return;
    if (r.state !== 'running') return;
    rt.paying.add(seq);
    try {
      const amount = payAmount(a.pricePerIntervalZats, this.minOutput);
      const memo = this.deps.protocol.encodeMemo({ t: 'PAY', rfqId: unhex(r.rfqId), seq }, rt.keys.signer, this.transport);
      r.payInFlight = { seq, at: Date.now() };
      this.stateFile.touch();
      await this.stateFile.flush();
      const res = await this.send([{ to: a.payTo, zats: amount, memo }], { rfqId: r.rfqId, what: `PAY interval ${seq}`, sealed: TX_FACTS.pay });
      r.payments.push({ seq, kind: 'pay', zats: amount, feeZats: res.feeZats, txid: res.txid, height: null, at: Date.now() });
      delete r.payInFlight;
      r.spentZats += amount;
      r.feesZats += res.feeZats;
      this.stateFile.touch();
      await this.stateFile.flush();
      const lead = payLeadFor(this.profile, a.intervalS);
      this.recordText('buyer', 'tx-broadcast', `PAY for interval ${seq}`, [
        ['Interval', `${seq} of ${a.intervals - 1}`, true, false],
        ['Amount', `${formatZec(amount)} ZEC`, true, true],
        ['To (provider pay-to)', a.payTo, true, true],
        ['Scheduled by', `the buyer's clock: interval ${seq} starts at jobStart + ${seq} × ${a.intervalS} s; its window opens ${lead} s before`, true, false],
        ['Send time', `${jitterMs} ms into the window, drawn at random (0–${(lead * 500) | 0} ms) so payments have no fixed cadence`, true, false],
      ], { rfqId: r.rfqId, txid: res.txid });
      if (r.error?.startsWith('payment')) delete r.error;
    } catch (e) {
      delete r.payInFlight;
      if (notBroadcast(e)) {
        r.error = `payment for interval ${seq} failed: ${errMsg(e)}`; // retried by the scheduler
      } else {
        // Might have been broadcast (e.g. a timeout after sending): never resend blindly.
        r.ambiguousPay = { seq, since: Date.now() };
        r.error = `payment for interval ${seq} may or may not have gone out (${errMsg(e)}); waiting for the provider's heartbeats before resending`;
      }
    } finally {
      rt.paying.delete(seq);
    }
    this.stateFile.touch();
    this.changed(r);
  }

  // ------------------------------------------------------------------ results & close

  private async fetchResult(r: BuyerRfq): Promise<void> {
    const rt = this.runtime(r);
    if (r.result || rt.fetchingResult || !rt.channel) return;
    rt.fetchingResult = true;
    const ch = rt.channel;
    try {
      const waiting = () => !this.stopped && (r.state === 'closing' || r.state === 'running' || r.state === 'accepted');
      let got: Awaited<ReturnType<typeof readChunked>>;
      try {
        got = await readChunked(this.relay, ch, 'result', this.deps.protocol.sha256, {
          waitS: this.profile.relayWaitS,
          deadline: Date.now() + this.profile.closeWaitS * 1000,
          live: waiting,
          idleMs: Math.min(250, this.profile.pollMs),
          maxBytes: this.maxResultBytes,
        });
      } catch (e) {
        this.fail(r, `result refused: ${errMsg(e)}`);
        return;
      }
      if (!got) {
        if (waiting()) {
          r.error = this.memo.isMemo(r.rfqId) ? 'result never arrived in memos' : 'result never appeared on the relay';
          this.changed(r);
          this.settle(r);
        }
        return;
      }
      const digest = hex(got.sealedDigest);
      const tar = got.payload;
      const file = join(this.dataDir, 'results', `${r.rfqId}.tar.gz`);
      await writePrivate(file, tar);
      r.result = { digest, sizeBytes: tar.length, file };
      this.recordText('buyer', 'blob-fetched', this.memo.isMemo(r.rfqId) ? 'Result reassembled from shielded memos and decrypted (relay-less)' : 'Result fetched from the relay and decrypted', [
        ['Size', `${tar.length} bytes (tar.gz, ${got.parts} chunk(s))`, true, true],
        ['SHA-256 of the sealed blob', digest, true, false],
        ['Saved to', file, true, false],
      ], { rfqId: r.rfqId });
      if (r.providerClose?.resultDigest) this.checkDigest(r);
      if (r.state === 'failed') return;
      if (!r.closeSent) await this.sendClose(r, r.providerClose?.reason ?? (r.sawFinal === 'failed' ? 'error' : 'done'));
      this.changed(r);
      this.settle(r);
    } finally {
      rt.fetchingResult = false;
    }
  }

  private checkDigest(r: BuyerRfq): void {
    if (!r.result || !r.providerClose?.resultDigest || r.result.verified !== undefined) return;
    r.result.verified = bytesEqual(unhex(r.result.digest), unhex(r.providerClose.resultDigest));
    if (!r.result.verified) {
      this.fail(r, `result digest ${shortHex(r.result.digest)} does not match the provider's signed CLOSE (${shortHex(r.providerClose.resultDigest)})`);
    }
  }

  private async sendClose(r: BuyerRfq, reason: CloseReason): Promise<void> {
    const a = r.accepted;
    const rt = this.runtime(r);
    if (!a || r.closeSent || rt.closingTx) return;
    rt.closingTx = true;
    try {
      const finalSeq = r.payments.reduce((m, p) => Math.max(m, p.seq), 0);
      const memo = this.deps.protocol.encodeMemo({ t: 'CLOSE', rfqId: unhex(r.rfqId), by: 'buyer', reason, finalSeq }, rt.keys.signer, this.transport);
      const res = await this.send([{ to: a.payTo, zats: this.minOutput, memo }], { rfqId: r.rfqId, what: `CLOSE (${reason})`, sealed: TX_FACTS.buyerClose });
      r.closeSent = { reason, txid: res.txid };
      if (r.closeReason === undefined) r.closeReason = reason;
      r.feesZats += res.feeZats + this.minOutput;
      this.recordText('buyer', 'tx-broadcast', `CLOSE sent: ${reason}`, [
        ['Reason', reason, true, false],
        ['Last interval paid', String(finalSeq), true, false],
        ['Total paid to provider', `${formatZec(r.spentZats)} ZEC`, true, true],
      ], { rfqId: r.rfqId, txid: res.txid });
    } catch (e) {
      r.error = `CLOSE failed: ${errMsg(e)}`;
    } finally {
      rt.closingTx = false;
    }
    this.changed(r);
  }

  /** `reason` only when a CLOSE says so; heartbeats alone don't decide why a deal ended. */
  private enterClosing(r: BuyerRfq, reason?: CloseReason): void {
    if (reason !== undefined && r.closeReason === undefined) r.closeReason = reason;
    if (r.state === 'closing' || r.state === 'closed' || r.state === 'failed') return;
    r.state = 'closing';
    r.closingSince = Date.now();
    this.changed(r);
  }

  /** Close out once every expected piece has arrived. */
  private settle(r: BuyerRfq): void {
    if (r.state !== 'closing') return;
    const pc = r.providerClose;
    const needResult = !!pc?.resultDigest || r.sawFinal === 'finished';
    if (needResult && !r.result) return;
    if (r.result && !r.closeSent) return;
    if (r.closeSent && !pc) {
      // Buyer-initiated: wait for the provider's CLOSE (it carries the result digest) until closeWaitS.
      if (r.result || r.closeSent.reason === 'buyer_stop') return;
    }
    if (r.result && pc?.resultDigest && r.result.verified !== true) return;
    if (!pc && !r.closeSent) return;
    this.finish(r, 'closed');
  }

  private finish(r: BuyerRfq, state: 'closed' | 'failed'): void {
    if (r.state === 'closed' || r.state === 'failed') return;
    r.state = state;
    if (r.closeReason === undefined) r.closeReason = r.providerClose?.reason ?? r.closeSent?.reason ?? 'error';
    this.changed(r);
  }

  private fail(r: BuyerRfq, error: string): void {
    r.error = error;
    if (r.state !== 'closed') r.state = 'failed';
    this.changed(r);
  }

  private async noHeartbeat(r: BuyerRfq): Promise<void> {
    if (r.state !== 'accepted' && r.state !== 'running') return;
    r.state = 'closing';
    r.closeReason = 'no_heartbeat';
    r.closingSince = Date.now();
    this.recordText('buyer', 'watchdog', 'Provider heartbeats stopped: payments stopped and the job is being closed', [
      ['Last heartbeat', r.lastHeartbeatAt ? new Date(r.lastHeartbeatAt).toISOString() : 'never', true, false],
      ['Timeout', `${this.profile.heartbeatTimeoutS} s`, true, false],
    ], { rfqId: r.rfqId });
    this.changed(r);
    await this.sendClose(r, 'no_heartbeat');
    this.finish(r, 'closed');
  }

  /** CLOSE(buyer_stop). Before an ACCEPT, just cancels locally (nothing to tell anyone). */
  async stop(rfqId: string): Promise<BuyerRfqDto> {
    const r = this.must(rfqId);
    if (r.state === 'collecting' || r.state === 'broadcasting') {
      r.state = 'closed';
      r.closeReason = 'buyer_stop';
      this.changed(r);
      return this.dto(r);
    }
    if (r.state !== 'accepted' && r.state !== 'running') throw conflict(`RFQ is ${r.state}`);
    this.enterClosing(r, 'buyer_stop');
    r.closeReason = 'buyer_stop';
    await this.sendClose(r, 'buyer_stop');
    if (!r.closeSent) {
      // Couldn't tell the provider; payments stop regardless.
      this.finish(r, 'closed');
    }
    this.changed(r);
    return this.dto(r);
  }

  /**
   * Job migration: a NEW RFQ for the same request and job, whose sealed job blob carries the latest
   * verified checkpoint of `rfqId`, so the next provider resumes where the last paid interval left
   * off. The old RFQ gets CLOSE(buyer_stop) if it is still open. Returns the new RFQ.
   */
  async migrate(rfqId: string, opts: MigrateRequest = {}): Promise<BuyerRfqDto> {
    const old = this.must(rfqId);
    if (!opts || typeof opts !== 'object') throw badRequest('body must be a MigrateRequest object');
    if (!old.checkpoint) throw conflict('no checkpoint has arrived for this RFQ yet: nothing to resume from');
    if (old.migratedTo) throw conflict(`already migrated to RFQ ${old.migratedTo}`);
    const p = this.deps.protocol;
    const ckBuf = await readIfExists(old.checkpoint.file);
    if (!ckBuf) throw notFound('the checkpoint file is missing from the data dir');
    const checkpoint = new Uint8Array(ckBuf);
    if (hex(p.sha256(checkpoint)) !== old.checkpoint.digest) throw new EngineError('internal', 'the checkpoint on disk does not match its verified digest', 500);
    const bundleBuf = await readIfExists(old.bundleFile);
    if (!bundleBuf) throw notFound('the job bundle is missing from the data dir');
    const req: NewRfqRequest = {
      gpu: old.request.gpu,
      count: old.request.count,
      durationS: old.request.durationS,
      maxPricePerHourZats: old.request.maxPricePerHourZats.toString(),
      job: { ...old.job, command: [...old.job.command], ...(old.job.env ? { env: { ...old.job.env } } : {}) },
      autoAccept: opts.autoAccept === undefined ? { rule: 'cheapest', waitBlocks: old.autoAccept?.waitBlocks ?? 1 } : opts.autoAccept,
    };
    if (opts.providerIds !== undefined && opts.providerIds !== null) req.providerIds = opts.providerIds;
    const from: MigrationSource = { rfqId: old.rfqId, seq: old.checkpoint.seq, checkpoint, bundle: new Uint8Array(bundleBuf) };
    if (old.accepted) from.excludeProviderId = old.accepted.providerId;
    const { rfqId: newId } = await this.createRfq(req, from);
    old.migratedTo = newId;
    this.recordText('buyer', 'migrate', `Migrating: new RFQ ${shortHex(newId)} resumes this job from the checkpoint of interval ${old.checkpoint.seq}`, [
      ['Checkpoint', `interval ${old.checkpoint.seq}, ${old.checkpoint.sizeBytes} bytes, sha256 ${shortHex(old.checkpoint.digest)}`, true, true],
      ['New RFQ', newId, true, false],
      ['Link between the two RFQs', 'held by this buyer only: fresh keys, reply address and channel; nothing in either RFQ names the other', false, false],
    ], { rfqId: old.rfqId });
    this.changed(old);
    if (old.state === 'accepted' || old.state === 'running' || old.state === 'collecting' || old.state === 'broadcasting') {
      await this.stop(old.rfqId).catch((e) => this.log(`migrate: stop ${shortHex(old.rfqId)}: ${errMsg(e)}`));
    }
    return this.getRfq(newId);
  }

  /** Demo / test fault injection. */
  fault(rfqId: string, fault: BuyerFault): BuyerRfqDto {
    const r = this.must(rfqId);
    if (fault === 'stop_paying') {
      r.withholdPayments = true;
      this.recordText('buyer', 'fault', 'Fault injected: the buyer stops paying (no CLOSE sent)', [['Fault', 'stop_paying', true, false]], { rfqId: r.rfqId });
    } else if (fault === 'resume_paying') {
      r.withholdPayments = false; // the scheduler pays what is due on its next tick
      delete r.ambiguousPay;
    } else {
      throw badRequest(`unknown fault ${String(fault)}`);
    }
    this.changed(r);
    return this.dto(r);
  }

  // ------------------------------------------------------------------ DTOs

  private changed(r: BuyerRfq): void {
    if (r.closedAt === undefined && (r.state === 'closed' || r.state === 'expired' || r.state === 'failed')) r.closedAt = Date.now();
    this.stateFile.touch();
    this.emit({ type: 'rfq.updated', rfq: this.dto(r) });
  }

  dto(r: BuyerRfq): BuyerRfqDto {
    const ranked = rankBids(r.bids);
    const out: BuyerRfqDto = {
      rfqId: r.rfqId,
      state: r.state,
      createdAt: r.createdAt,
      request: {
        gpu: r.request.gpu,
        count: r.request.count,
        durationS: r.request.durationS,
        maxPricePerHourZats: r.request.maxPricePerHourZats.toString(),
      },
      providersAsked: r.asked.length,
      paddedOutputs: r.paddedOutputs,
      expiresHeight: r.expiresHeight,
      bids: ranked.map(bidDto),
      payments: r.payments.map(paymentDto),
      heartbeats: r.heartbeats.slice(0, 20),
      logTail: r.logTail.slice(-100),
      spentZats: r.spentZats.toString(),
      feesZats: r.feesZats.toString(),
      rfqTxids: [...r.rfqTxids],
      rejectedBids: r.rejectedBids,
      discloseMax: disclosesMax(r),
      paymentsWithheld: !!r.withholdPayments,
    };
    if (r.rfqTxids[0]) out.rfqTxid = r.rfqTxids[0];
    if (r.accepted) {
      out.accepted = {
        providerId: r.accepted.providerId,
        alias: r.accepted.alias,
        pricePerIntervalZats: r.accepted.pricePerIntervalZats.toString(),
        intervalS: r.accepted.intervalS,
        intervals: r.accepted.intervals,
      };
      const next = this.nextPaymentAt(r);
      if (next !== undefined) out.nextPaymentAt = next;
    }
    if (r.result) {
      out.result = { digest: r.result.digest, sizeBytes: r.result.sizeBytes };
      if (r.result.verified !== undefined) out.resultVerified = r.result.verified;
    }
    if (r.closeReason) out.closeReason = r.closeReason;
    if (r.error) out.error = r.error;
    if (r.preparing) out.preparing = { ...r.preparing };
    if (r.jobStart !== undefined) out.jobStartedAt = r.jobStart;
    if (r.checkpoint) out.checkpoint = { seq: r.checkpoint.seq, digest: r.checkpoint.digest, sizeBytes: r.checkpoint.sizeBytes, at: r.checkpoint.at };
    if (r.resumeFrom) out.migratedFrom = { rfqId: r.resumeFrom.rfqId, seq: r.resumeFrom.seq };
    if (r.migratedTo) out.migratedTo = r.migratedTo;
    if (r.closedAt !== undefined) out.closedAt = r.closedAt;
    if (r.accepted) {
      const lead = payLeadFor(this.profile, r.accepted.intervalS);
      out.payPolicy = { leadS: lead, jitterMaxS: lead / 2, maxExposureIntervals: maxExposureIntervals(this.profile, r.accepted.intervalS) };
    }
    return out;
  }

  private nextPaymentAt(r: BuyerRfq): number | undefined {
    const a = r.accepted;
    const rt = this.rt.get(r.rfqId);
    if (!a || !rt || r.state !== 'running' || r.jobStart === undefined || r.withholdPayments) return undefined;
    const k = this.nextSeq(r);
    if (k >= a.intervals) return undefined;
    return this.payDueAt(r, rt, k)?.due;
  }
}

// ---------------------------------------------------------------------- helpers

/** Errors that are certainly raised before anything is broadcast, so a retry can't pay twice. */
function notBroadcast(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return ['InsufficientFundsError', 'PrivacyError', 'RangeError', 'TypeError', 'ProtocolError'].includes(e.name) || e.message === 'node is shutting down';
}

function payAmount(price: bigint, minOut: bigint): bigint {
  return price > minOut ? price : minOut;
}

function buyerInitiated(r: BuyerRfq): boolean {
  const mine = (x?: CloseReason) => x === 'buyer_stop' || x === 'no_heartbeat';
  return mine(r.closeReason) || mine(r.closeSent?.reason);
}

export function rankBids(bids: BuyerBid[]): BuyerBid[] {
  return bids.slice().sort((a, b) => {
    const pa = a.pricePerIntervalZats * BigInt(b.intervalS);
    const pb = b.pricePerIntervalZats * BigInt(a.intervalS);
    if (pa !== pb) return pa < pb ? -1 : 1;
    const ba = a.bondZats ?? 0n;
    const bb = b.bondZats ?? 0n;
    if (ba !== bb) return ba > bb ? -1 : 1;
    return a.receivedAt - b.receivedAt;
  });
}

function bidDto(b: BuyerBid): BidDto {
  const d: BidDto = {
    providerId: b.providerId,
    alias: b.alias,
    pricePerIntervalZats: b.pricePerIntervalZats.toString(),
    intervalS: b.intervalS,
    pricePerHourZats: perHour(b.pricePerIntervalZats, b.intervalS).toString(),
    startWithinS: b.startWithinS,
    receivedAt: b.receivedAt,
    txid: b.txid,
    height: b.height,
    signatureValid: true,
  };
  if (b.bondZats !== undefined) d.bondZats = b.bondZats.toString();
  return d;
}

function paymentDto(p: BuyerPayment): PaymentDto {
  return { seq: p.seq, kind: p.kind, zats: p.zats.toString(), feeZats: p.feeZats.toString(), txid: p.txid, height: p.height, at: p.at };
}

/** What createRfq() takes over from an earlier RFQ when migrating (see BuyerNode.migrate). */
interface MigrationSource {
  rfqId: string;
  seq: number;
  checkpoint: Uint8Array;
  bundle: Uint8Array;
  excludeProviderId?: string;
}

interface ValidRequest {
  gpu: string;
  count: number;
  durationS: number;
  maxPricePerHourZats: bigint;
  /** Put the max in the RFQ memo. Default false (0 on the wire). */
  discloseMax: boolean;
  providerIds: string[] | null;
  job: { path: string; command: string[]; image?: string; env?: Record<string, string> };
  autoAccept: AutoAcceptRule | null;
}

function validateRequest(req: NewRfqRequest): ValidRequest {
  if (!req || typeof req !== 'object') throw badRequest('body must be a NewRfqRequest object');
  const gpu = String(req.gpu ?? '').trim().toLowerCase();
  if (!GPU_SLUG.test(gpu)) throw badRequest('gpu must be a model slug like "a100" (a-z, 0-9, -; at most 16 chars)');
  if (!Number.isInteger(req.count) || req.count < 1 || req.count > 64) throw badRequest('count must be an integer 1..64');
  if (!Number.isInteger(req.durationS) || req.durationS < 1 || req.durationS > 30 * 86400) throw badRequest('durationS must be an integer number of seconds, at most 30 days');
  let max: bigint;
  try {
    max = parseZats(req.maxPricePerHourZats, 'maxPricePerHourZats');
  } catch (e) {
    throw badRequest(errMsg(e));
  }
  if (max <= 0n) throw badRequest('maxPricePerHourZats must be positive (it stays private unless discloseMax is true)');
  if (req.discloseMax !== undefined && typeof req.discloseMax !== 'boolean') throw badRequest('discloseMax must be a boolean');
  const discloseMax = req.discloseMax === true;
  const job = req.job as NewRfqRequest['job'] & { env?: unknown };
  if (!job || typeof job.path !== 'string' || !job.path) throw badRequest('job.path is required');
  if (!Array.isArray(job.command) || job.command.length === 0 || job.command.length > 64 || !job.command.every((c) => typeof c === 'string' && c.length <= 4096)) {
    throw badRequest('job.command must be a non-empty array of strings');
  }
  if (job.image !== undefined && (typeof job.image !== 'string' || !/^[\w./:@-]{1,256}$/.test(job.image))) throw badRequest('job.image is not a valid image name');
  let providerIds: string[] | null = null;
  if (req.providerIds !== undefined && req.providerIds !== null) {
    if (!Array.isArray(req.providerIds) || req.providerIds.length === 0 || req.providerIds.length > 16) throw badRequest('providerIds must list 1..16 provider ids');
    providerIds = req.providerIds.map((x) => String(x).toLowerCase());
    if (!providerIds.every((x) => /^[0-9a-f]{64}$/.test(x))) throw badRequest('providerIds must be 64-char hex keys');
    providerIds = [...new Set(providerIds)];
  }
  let autoAccept: AutoAcceptRule | null = null;
  if (req.autoAccept) {
    const a = req.autoAccept;
    if (a.rule !== 'cheapest') throw badRequest('autoAccept.rule must be "cheapest"');
    if (!Number.isInteger(a.waitBlocks) || a.waitBlocks < 0 || a.waitBlocks > 1000) throw badRequest('autoAccept.waitBlocks must be an integer 0..1000');
    autoAccept = { rule: 'cheapest', waitBlocks: a.waitBlocks };
    if (a.minBondZats !== undefined) {
      try {
        autoAccept.minBondZats = parseZats(a.minBondZats, 'minBondZats').toString();
      } catch (e) {
        throw badRequest(errMsg(e));
      }
    }
  }
  const outJob: ValidRequest['job'] = { path: resolve(job.path), command: [...job.command] };
  if (job.image) outJob.image = job.image;
  const env = sanitizeEnv(job.env);
  if (Object.keys(env).length) outJob.env = env;
  return { gpu, count: req.count, durationS: req.durationS, maxPricePerHourZats: max, discloseMax, providerIds, job: outJob, autoAccept };
}

/** Records written before `discloseMax` existed always put the max on the wire. */
function disclosesMax(r: Pick<BuyerRfq, 'discloseMax'>): boolean {
  return r.discloseMax ?? true;
}

/** Value for each padding output: the job's worst-case budget spread over the padding (plus change). */
export function splitPerNote(v: { maxPricePerHourZats: bigint; durationS: number }, dummies: number, spendable: bigint, minOut: bigint): bigint {
  if (dummies <= 0) return minOut;
  const budget = (v.maxPricePerHourZats * BigInt(v.durationS)) / 3600n + 200_000n; // + fees for the PAYs and CLOSE
  const room = spendable / 2n; // never park more than half the wallet in one RFQ
  const per = (budget < room ? budget : room) / BigInt(dummies + 1);
  return per > minOut ? per : minOut;
}

async function loadOrCreateSeed(path: string): Promise<Uint8Array> {
  const buf = await readIfExists(path);
  if (buf && buf.length === 32) return new Uint8Array(buf);
  if (buf) throw new Error(`${path} is not a 32-byte seed`);
  const seed = randomBytes(32);
  await writePrivate(path, seed);
  return seed;
}
