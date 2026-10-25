// ProviderNode: directory entry → RFQ → BID → ACCEPT → run the job under a payment watchdog → result → CLOSE.
// See ARCHITECTURE.md §3–4.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CloseReason, GpuSpec, PaymentDto, ProviderJobDto, ProviderJobState, ProviderPolicyDto, StatusDto } from '@silicr/api';
import type { Accept, Bid, Channel, Close, DecodedMemo, Heartbeat, Pay, Rfq, Signer } from '@silicr/protocol';
import type { JobExit, RunHandle, Runner } from '@silicr/runner';
import { NodeBase, type NodeOptions } from './base.ts';
import { GPU_SLUG, closeRetryDelayMs, CLOSE_RETRY_MAX_MS } from './buyer.ts';
import { NoteWatcher, type NoteEvent, describeError } from './chain.ts';
import { aliasFor } from './alias.ts';
import { profileAtHeight } from './profile.ts';
import { badRequest, conflict, notFound } from './errors.ts';
import { decodeJobBlob, encodeCheckpointBlob, sanitizeEnv } from './jobblob.ts';
import { encodeLogBatch, readChunked, uploadChunked } from './blobs.ts';
import { maxBlobBytes } from '@silicr/protocol';
import { TX_FACTS, cipherPreview } from './leaks.ts';
import { ceilDiv, formatZec, parseZats, perHour, perInterval, withinHourly } from './zats.ts';
import { Mutex, StateFile, bytesEqual, errMsg, hex, readIfExists, shortHex, sleep, unhex, writePrivate, fromStateJson, toStateJson } from './util.ts';

const LOG_LINES_KEPT = 300;
/** Checkpoints above this are not uploaded (configurable: ProviderNodeOptions.maxCheckpointBytes). */
export const DEFAULT_MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
/** Fees a job costs a provider at most: a BID and a CLOSE, two ZIP 317 actions each (5000 zats per action). */
const JOB_FEE_RESERVE_ZATS = 20_000n;

export interface ProviderPolicy {
  autoBid: boolean;
  /** Price per hour this provider asks for any request it can serve (same unit as the buyer's max). */
  minPricePerHourZats: bigint;
  /**
   * When an RFQ carries no max (maxPricePerHourZats = 0, "undisclosed"), bid at
   * minPricePerHourZats × (1 + markupPct/100). Percent, 0..1000; default 0.
   */
  markupPct?: number;
  intervalS: number;
  graceS: number;
  gpus: GpuSpec[];
  region?: string;
}

export interface ProviderNodeOptions extends NodeOptions {
  runner: Runner;
  /** Overrides on top of the persisted policy (explicit flags win). */
  policy?: Partial<ProviderPolicy>;
  /** Extra environment for every job (demo knobs such as SILICR_STEP_DELAY_MS). */
  jobEnv?: Record<string, string>;
  /** Where job bundles are unpacked. Default <dataDir>/jobs. */
  workDir?: string;
  /** Largest checkpoint (packed) uploaded after each interval. Default 64 MiB; bigger ones are skipped and reported. */
  maxCheckpointBytes?: number;
}

interface ProviderPayment {
  seq: number;
  kind: 'accept' | 'pay';
  zats: bigint;
  txid: string;
  height: number | null;
  at: number;
}

export interface ProviderJob {
  rfqId: string;
  state: ProviderJobState;
  createdAt: number;
  rfq: {
    gpu: string;
    count: number;
    durationS: number;
    maxPricePerHourZats: bigint;
    replyTo: string;
    buyerKey: string;
    buyerEph: string;
    expiresHeight: number;
    txid: string;
  };
  bid: { pricePerIntervalZats: bigint; intervalS: number; startWithinS: number; payTo: string; ephSecret: string; ephPublic: string; txid: string };
  intervals?: number;
  payments: ProviderPayment[];
  earnedZats: bigint;
  servingSeq: number;
  lastHeartbeatSeq: number;
  logBatchSeq?: number;
  startedAt?: number;
  stoppedAt?: number;
  stopReason?: CloseReason;
  logTail: string[];
  manifest?: { command: string[]; image?: string; bundleSize: number; bundleSha256: string };
  resultDigest?: string;
  closeTxid?: string;
  /**
   * Our CLOSE could not be broadcast (chain unreachable): kept and retried with backoff until it
   * goes out. Persisted, so a restart keeps the intent. The digest is the result's, when there is one.
   */
  closeRetry?: { reason: CloseReason; digest?: string; attempts: number; nextAt: number; lastError: string };
  error?: string;
  heartbeatsStopped?: boolean;
  feesZats: bigint;
  /** Latest checkpoint sealed and uploaded (metered delivery). */
  checkpoint?: { seq: number; digest: string; sizeBytes: number; at: number };
  /** The job started from the buyer's checkpoint of an earlier deal (migration), taken at this interval. */
  resumedFromSeq?: number;
}

/** ProviderJobDto plus additive fields (reported to the api owner). */
export type ProviderJobDtoExt = ProviderJobDto & {
  intervals?: number;
  resultDigest?: string;
  error?: string;
  /** Fault injection: heartbeats deliberately withheld. */
  heartbeatsStopped: boolean;
  feesZats: string;
  /** Our CLOSE has not gone out yet (chain unreachable); it is retried at nextAt. */
  closePending?: { reason: CloseReason; attempts: number; nextAt: number };
  /** `unconfirmedSeq`: the interval being served on a payment that isn't mined yet (it must be by deadlineAt). */
  watchdog?: NonNullable<ProviderJobDto['watchdog']> & { unconfirmedSeq?: number };
};

type FinishCause =
  | { kind: 'exit'; exit: JobExit }
  | { kind: 'time_up' }
  | { kind: 'buyer_close'; reason: CloseReason }
  | { kind: 'unpaid'; why?: string }
  | { kind: 'operator_stop' }
  | { kind: 'error'; message: string };

interface JobRuntime {
  channel: Channel | null;
  handle: RunHandle | null;
  /** A CLOSE broadcast is in flight. */
  closingTx: boolean;
  hbTimer: NodeJS.Timeout | null;
  hbMutex: Mutex;
  pendingLogs: string[];
  intervalStartedAt: number;
  pausedAt: number | null;
  status: Heartbeat['status'];
  finishing: boolean;
  watchdogBusy: boolean;
  /** Why the job is paused: no PAY for the next interval, or the current one not yet mined. */
  pauseCause: 'unpaid' | 'unconfirmed' | null;
  /** Unconfirmed payments missing from recent polls. */
  missing: Map<string, { polls: number; since: number }>;
  /** Memo mode: the last heartbeat actually sent (one per interval unless status or interval changes). */
  lastMemoHb: { at: number; status: Heartbeat['status']; servingSeq: number } | null;
  /** Checkpoint uploads are serialised per job. */
  ckptMutex: Mutex;
  /** sha256 of the last packed checkpoint uploaded: an unchanged dir is not uploaded again. */
  lastCheckpointDigest: Uint8Array | null;
  /** The size cap was hit (reported once). */
  checkpointTooBig: boolean;
}

interface PersistedProvider {
  v: 1;
  scanHeight: number;
  jobs: ProviderJob[];
}

export type ProviderFault = 'stop_heartbeats' | 'resume_heartbeats';

const LIVE: ProviderJobState[] = ['won', 'running', 'paused'];

export class ProviderNode extends NodeBase {
  readonly role = 'provider' as const;
  readonly runner: Runner;
  private signer: Signer | null = null;
  providerId = '';
  alias = '';
  private policy: ProviderPolicy;
  private readonly policyOverrides: Partial<ProviderPolicy>;
  private readonly jobEnv: Record<string, string>;
  private readonly workDir: string;
  private readonly maxCheckpointBytes: number;
  private readonly jobs = new Map<string, ProviderJob>();
  private readonly rt = new Map<string, JobRuntime>();
  private readonly seenRfqs = new Set<string>();
  private readonly stateFile: StateFile<PersistedProvider>;
  private scanHeight = 0;
  private lastTip = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private directoryTimer: NodeJS.Timeout | null = null;
  lastPublishedAt = 0;

  constructor(o: ProviderNodeOptions) {
    super('provider', o);
    this.runner = o.runner;
    this.policyOverrides = o.policy ?? {};
    this.jobEnv = sanitizeEnv(o.jobEnv ?? {});
    this.workDir = resolve(o.workDir ?? join(o.dataDir, 'jobs'));
    // Memo transport: buyer blobs (the sealed job) are signed with the RFQ's buyer key.
    this.memo.keyFor = (rfqId) => {
      const j = this.jobs.get(rfqId);
      return j ? unhex(j.rfq.buyerKey) : null;
    };
    this.maxCheckpointBytes = o.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
    this.policy = {
      autoBid: true,
      minPricePerHourZats: 50_000_000n,
      intervalS: this.profile.intervalS,
      graceS: this.profile.graceS,
      gpus: [{ model: 'cpu', count: 1, vramGb: 0 }],
    };
    this.stateFile = new StateFile(join(o.dataDir, 'provider-state.json'), () => ({
      v: 1,
      scanHeight: this.watcher?.since ?? this.scanHeight,
      jobs: [...this.jobs.values()],
    }));
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.assertMainnetCap();
    const p = this.deps.protocol;
    const idPath = join(this.dataDir, 'identity.key');
    const saved = await readIfExists(idPath);
    if (saved && saved.length === 32) {
      this.signer = p.signerFromSecret(new Uint8Array(saved));
    } else if (saved) {
      throw new Error(`${idPath} is not a 32-byte Ed25519 secret`);
    } else {
      const g = p.generateSigner();
      await writePrivate(idPath, g.secret);
      this.signer = g.signer;
    }
    this.providerId = hex(this.signer.publicKey);
    this.alias = aliasFor(this.signer.publicKey);

    const pol = await readIfExists(join(this.dataDir, 'policy.json'));
    if (pol) {
      try {
        this.policy = { ...this.policy, ...fromStateJson<ProviderPolicy>(pol.toString('utf8')) };
      } catch {
        // keep defaults
      }
    }
    this.policy = { ...this.policy, ...stripUndefined(this.policyOverrides) };
    await this.savePolicy();

    const tip = await this.backend.height();
    this.lastTip = tip;
    this.scanHeight = tip;
    const st = await this.stateFile.load();
    if (st && st.v === 1) {
      this.scanHeight = Math.min(tip, st.scanHeight);
      for (const j of st.jobs) this.jobs.set(j.rfqId, j);
    }
    for (const j of this.jobs.values()) {
      for (const t of [j.rfq.txid, j.bid.txid, j.closeTxid, ...j.payments.map((p) => p.txid)]) if (t) this.knownTx.add(t.toLowerCase());
      this.rt.set(j.rfqId, newRuntime());
      if (LIVE.includes(j.state)) {
        // The process that ran this job is gone. Tell the buyer so it stops paying.
        j.error = 'provider restarted while the job was running';
        j.state = 'stopped';
        j.stopReason = 'error';
        j.stoppedAt = Date.now();
        void this.sendCloseRetrying(j, 'error', undefined);
      } else if (j.closeRetry && !j.closeTxid) {
        j.closeRetry.nextAt = Date.now() + 1000; // the watchdog timer retries it
      } else {
        delete j.closeRetry;
      }
    }
    await mkdir(this.workDir, { recursive: true, mode: 0o700 });
    await this.publishDirectory();
    await this.initWallet();
    this.watcher = new NoteWatcher({
      backend: this.backend,
      decode: (m) => this.deps.protocol.decodeMemo(m),
      pollMs: this.profile.pollMs,
      since: Math.max(0, this.scanHeight - 1),
      onNote: (e) => this.onNote(e),
      onTick: (h) => this.onTick(h),
      onPolled: (notes) => this.onPolled(notes),
      onError: (e) => this.log(`provider poll: ${errMsg(e)}`),
    });
    this.watcher.start();
    this.watchdogTimer = setInterval(() => void this.watchdog(), 100);
    this.directoryTimer = setInterval(() => void this.publishDirectory().catch((e) => this.log(`directory publish: ${errMsg(e)}`)), this.profile.directoryRefreshS * 1000);
    this.stateFile.touch();
  }

  async close(): Promise<void> {
    this.watcher?.stop();
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.directoryTimer) clearInterval(this.directoryTimer);
    // Graceful: stop live jobs and tell their buyers (CLOSE provider_stop) so they stop paying.
    const live = [...this.jobs.values()].filter((j) => LIVE.includes(j.state));
    await Promise.race([Promise.all(live.map((j) => this.finishJob(j, { kind: 'operator_stop' }))), sleep(10_000)]);
    this.stopped = true;
    for (const [id, rt] of this.rt) {
      if (rt.hbTimer) clearInterval(rt.hbTimer);
      rt.hbTimer = null;
      const j = this.jobs.get(id);
      if (rt.handle && j && LIVE.includes(j.state)) {
        await rt.handle.stop('provider shutting down').catch(() => undefined);
        j.state = 'stopped';
        j.stopReason = 'provider_stop';
        j.stoppedAt = Date.now();
      }
    }
    this.sender.closed = true;
    this.stateFile.touch();
    await this.stateFile.flush();
  }

  // ------------------------------------------------------------------ directory & policy

  private async publishDirectory(): Promise<void> {
    if (!this.signer) return;
    const p = this.deps.protocol;
    const entry: Parameters<typeof p.signDirectoryEntry>[0] = {
      v: 1,
      providerId: this.providerId,
      alias: this.alias,
      address: await this.address(),
      gpus: this.policy.gpus.map((g) => ({ model: g.model, count: g.count, vramGb: g.vramGb })),
      minPricePerHourZats: this.policy.minPricePerHourZats.toString(),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    if (this.policy.region) entry.region = this.policy.region;
    try {
      await this.relay.publishDirectory(p.signDirectoryEntry(entry, this.signer));
    } catch (e) {
      // 409: the relay holds a newer entry of ours (clock skew, earlier run). Publish just after it.
      if ((e as { status?: number }).status !== 409) throw e;
      const mine = (await this.relay.listDirectory()).find((x) => (x as { providerId?: string }).providerId === this.providerId) as { updatedAt?: number } | undefined;
      entry.updatedAt = Math.max(entry.updatedAt, (mine?.updatedAt ?? 0) + 1);
      await this.relay.publishDirectory(p.signDirectoryEntry(entry, this.signer));
    }
    this.directory.invalidate();
    const first = this.lastPublishedAt === 0;
    this.lastPublishedAt = Date.now();
    if (first) {
      this.recordText('provider', 'directory-published', `Signed directory entry published as ${this.alias}`, [
        ['Pseudonym', this.alias, true, false],
        ['Provider key', this.providerId, true, false],
        ['RFQ address (Orchard-only)', entry.address, true, false],
        ['GPUs', entry.gpus.map((g) => `${g.count}× ${g.model}`).join(', '), true, false],
        ['Min price', `${formatZec(this.policy.minPricePerHourZats)} ZEC/h`, true, false],
        ['Anything about buyers', 'never part of a directory entry', false, false],
      ]);
    }
  }

  getPolicy(): ProviderPolicyDto {
    return {
      autoBid: this.policy.autoBid,
      minPricePerHourZats: this.policy.minPricePerHourZats.toString(),
      intervalS: this.policy.intervalS,
      graceS: this.policy.graceS,
      gpus: this.policy.gpus.map((g) => ({ ...g })),
      markupPct: this.policy.markupPct ?? 0,
    };
  }

  async setPolicy(patch: Partial<ProviderPolicyDto>): Promise<ProviderPolicyDto> {
    if (!patch || typeof patch !== 'object') throw badRequest('body must be a ProviderPolicyDto patch');
    const next: ProviderPolicy = { ...this.policy, gpus: this.policy.gpus.map((g) => ({ ...g })) };
    if (patch.autoBid !== undefined) {
      if (typeof patch.autoBid !== 'boolean') throw badRequest('autoBid must be a boolean');
      next.autoBid = patch.autoBid;
    }
    if (patch.minPricePerHourZats !== undefined) {
      try {
        next.minPricePerHourZats = parseZats(patch.minPricePerHourZats, 'minPricePerHourZats');
      } catch (e) {
        throw badRequest(errMsg(e));
      }
    }
    if (patch.intervalS !== undefined) {
      if (!Number.isInteger(patch.intervalS) || patch.intervalS < 1 || patch.intervalS > 86400) throw badRequest('intervalS must be an integer 1..86400');
      next.intervalS = patch.intervalS;
    }
    if (patch.graceS !== undefined) {
      if (!Number.isInteger(patch.graceS) || patch.graceS < 0 || patch.graceS > 86400) throw badRequest('graceS must be an integer 0..86400');
      next.graceS = patch.graceS;
    }
    if (patch.markupPct !== undefined) {
      if (typeof patch.markupPct !== 'number' || !Number.isFinite(patch.markupPct) || patch.markupPct < 0 || patch.markupPct > 1000) throw badRequest('markupPct must be a number 0..1000');
      next.markupPct = patch.markupPct;
    }
    if (patch.gpus !== undefined) {
      if (!Array.isArray(patch.gpus) || patch.gpus.length === 0 || patch.gpus.length > 16) throw badRequest('gpus must list 1..16 GPU specs');
      next.gpus = patch.gpus.map((g) => {
        const model = String(g?.model ?? '').trim().toLowerCase();
        if (!GPU_SLUG.test(model)) throw badRequest('gpu model must be a slug like "a100" (a-z, 0-9, -; at most 16 chars)');
        if (!Number.isInteger(g.count) || g.count < 1 || g.count > 64) throw badRequest('gpu count must be 1..64');
        const vramGb = Number(g.vramGb ?? 0);
        if (!Number.isFinite(vramGb) || vramGb < 0 || vramGb > 4096) throw badRequest('vramGb must be a number of GB');
        return { model, count: g.count, vramGb };
      });
    }
    this.policy = next;
    await this.savePolicy();
    await this.publishDirectory();
    void this.status().then((s) => this.emit({ type: 'status', status: s })).catch(() => undefined);
    return this.getPolicy();
  }

  private async savePolicy(): Promise<void> {
    await writePrivate(join(this.dataDir, 'policy.json'), toStateJson(this.policy));
  }

  // ------------------------------------------------------------------ queries

  async status(): Promise<StatusDto & { runner: { mode: string; sandboxed: boolean; warning?: string } }> {
    const s = await this.baseStatus();
    const sandboxed = this.runner.sandboxed ?? this.runner.mode === 'docker';
    const runner: { mode: string; sandboxed: boolean; warning?: string } = { mode: this.runner.mode, sandboxed };
    if (this.runner.notice) runner.warning = this.runner.notice;
    else if (!sandboxed) runner.warning = 'process mode: jobs run as plain child processes, NOT in a sandbox (dev/demo only)';
    return { ...s, alias: this.alias, providerId: this.providerId, runner };
  }

  protected override onMemoSpent(rfqId: string, feeZats: bigint, valueZats: bigint): void {
    const j = this.jobs.get(rfqId);
    if (!j) return;
    j.feesZats += feeZats + valueZats;
    this.changed(j);
  }

  /** A job is won, running or paused: its CLOSE needs a fee. */
  busy(): boolean {
    for (const j of this.jobs.values()) if (LIVE.includes(j.state)) return true;
    return false;
  }

  /** A provider only ever spends fees (BIDs, CLOSEs): their sum over every job, persisted with the jobs. */
  capSpentZats(): bigint {
    let sum = 0n;
    for (const j of this.jobs.values()) sum += j.feesZats;
    return sum;
  }

  listJobs(): ProviderJobDtoExt[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((j) => this.dto(j));
  }

  getJob(id: string): ProviderJobDtoExt {
    return this.dto(this.must(id));
  }

  record(id: string): ProviderJob | undefined {
    return this.jobs.get(id);
  }

  private must(id: string): ProviderJob {
    const j = this.jobs.get(String(id).toLowerCase());
    if (!j) throw notFound(`no job ${id}`);
    return j;
  }

  private runtime(j: ProviderJob): JobRuntime {
    let x = this.rt.get(j.rfqId);
    if (!x) {
      x = newRuntime();
      this.rt.set(j.rfqId, x);
    }
    return x;
  }

  // ------------------------------------------------------------------ notes

  private async onNote(e: NoteEvent): Promise<void> {
    const d = e.decoded;
    this.received(e.note.txid);
    this.trackIncoming(e);
    if (!d) return;
    switch (d.msg.t) {
      case 'RFQ':
        return this.onRfq(e, d.msg, d);
      case 'ACCEPT':
        return this.onAccept(e, d.msg, d);
      case 'PAY':
        return this.onPay(e, d.msg, d);
      case 'CLOSE':
        return this.onBuyerClose(e, d.msg, d);
      default:
        return;
    }
  }

  private async onRfq(e: NoteEvent, rfq: Rfq, d: DecodedMemo): Promise<void> {
    if (!e.firstSeen) return;
    const rfqId = hex(rfq.rfqId);
    if (this.jobs.has(rfqId) || this.seenRfqs.has(rfqId)) return;
    this.seenRfqs.add(rfqId);
    if (!d.verifiedBy(rfq.buyerKey)) {
      this.recordText('provider', 'memo-rejected', 'Ignored an RFQ whose signature does not verify', [['Transaction', e.note.txid, true, false]], { rfqId });
      return;
    }
    this.recordText('provider', 'memo-received', `Sealed RFQ received: ${rfq.count}× ${rfq.gpu} for ${rfq.durationS} s`, [
      ['GPU', `${rfq.count}× ${rfq.gpu}`, true, true],
      ['Duration', `${rfq.durationS} s`, true, true],
      ...(rfq.maxPricePerHourZats === 0n
        ? [['Buyer budget', 'undisclosed: the RFQ carries no max; we bid our own price', false, true] as [string, string, boolean, boolean]]
        : [['Max price', `${formatZec(rfq.maxPricePerHourZats)} ZEC/h`, true, true] as [string, string, boolean, boolean]]),
      ['Reply address (one-time, unlinkable)', rfq.replyTo, true, false],
      ['Buyer key (this RFQ only)', hex(rfq.buyerKey), true, false],
      ['Bids expire at height', String(rfq.expiresHeight), true, false],
      ['Buyer identity', 'not present in any message', false, true],
      ['Buyer wallet address', 'not present in any message', false, true],
      ['Other providers asked', 'not visible to this provider', false, true],
    ], { rfqId, txid: e.note.txid });
    void this.observeTx(e.note.txid, { rfqId, event: 'tx-received', summary: 'RFQ transaction: what the public chain shows', sealed: TX_FACTS.rfq });

    // Transport negotiation: a memo-mode buyer sends a HELLO memo next to the RFQ; both sides must agree.
    const why = this.memo.bidRefusal(rfqId, rfq.buyerKey) ?? this.policyRefusal(rfq);
    if (why) {
      this.recordText('provider', 'no-bid', `Not bidding: ${why}`, [['Reason', why, true, false]], { rfqId });
      return;
    }
    let replyTo: string;
    try {
      replyTo = this.guard(rfq.replyTo);
    } catch (err) {
      this.recordText('provider', 'no-bid', `Refused the RFQ's reply address: ${errMsg(err)}`, [['Reason', errMsg(err), true, false]], { rfqId });
      return;
    }
    const intervalS = this.policy.intervalS;
    const undisclosed = rfq.maxPricePerHourZats === 0n;
    // Undisclosed budget: ask our own price (min plus the policy markup); the buyer filters privately.
    const price = perInterval(undisclosed ? askingPricePerHour(this.policy) : this.policy.minPricePerHourZats, intervalS);
    if (!undisclosed && !withinHourly(price, intervalS, rfq.maxPricePerHourZats)) {
      this.recordText('provider', 'no-bid', 'Not bidding: rounding the price to whole intervals exceeds the max', [], { rfqId });
      return;
    }
    const p = this.deps.protocol;
    const eph = p.generateX25519();
    const payTo = this.guard(await this.backend.newAddress());
    const job: ProviderJob = {
      rfqId,
      state: 'bid',
      createdAt: Date.now(),
      rfq: {
        gpu: rfq.gpu,
        count: rfq.count,
        durationS: rfq.durationS,
        maxPricePerHourZats: rfq.maxPricePerHourZats,
        replyTo,
        buyerKey: hex(rfq.buyerKey),
        buyerEph: hex(rfq.buyerEph),
        expiresHeight: rfq.expiresHeight,
        txid: e.note.txid,
      },
      bid: { pricePerIntervalZats: price, intervalS, startWithinS: this.profile.startWithinS, payTo, ephSecret: hex(eph.secretKey), ephPublic: hex(eph.publicKey), txid: '' },
      payments: [],
      earnedZats: 0n,
      servingSeq: 0,
      lastHeartbeatSeq: 0,
      logTail: [],
      feesZats: 0n,
    };
    this.jobs.set(rfqId, job);
    this.rt.set(rfqId, newRuntime());
    this.changed(job);
    const msg: Bid = {
      t: 'BID',
      rfqId: rfq.rfqId,
      providerId: this.signer!.publicKey,
      pricePerIntervalZats: price,
      intervalS,
      startWithinS: this.profile.startWithinS,
      providerEph: eph.publicKey,
      payTo,
    };
    try {
      const memo = p.encodeMemo(msg, this.signer!, this.transport);
      const res = await this.send([{ to: replyTo, zats: this.minOutput, memo }], { rfqId, what: 'Signed BID', sealed: TX_FACTS.bid });
      job.bid.txid = res.txid;
      job.feesZats += res.feeZats;
      this.recordText('provider', 'tx-broadcast', `Signed BID sent: ${formatZec(perHour(price, intervalS))} ZEC/h`, [
        ['Price', `${formatZec(price)} ZEC per ${intervalS} s`, true, true],
        ['Priced against', undisclosed ? `our own ask (min + ${this.policy.markupPct ?? 0}% markup); buyer budget: undisclosed` : 'the max the RFQ disclosed', true, false],
        ['Pay-to address (fresh)', payTo, true, false],
        ['Channel key (this job only)', hex(eph.publicKey), true, false],
        ['To', 'the buyer\'s one-time reply address', true, false],
      ], { rfqId, txid: res.txid });
    } catch (err) {
      const dsc = describeError(err);
      job.state = 'lost';
      job.error = `BID failed (${dsc.code}): ${dsc.message}`;
    }
    this.changed(job);
  }

  private policyRefusal(rfq: Rfq): string | null {
    if (!this.policy.autoBid) return 'auto-bid is off';
    if (!Number.isInteger(rfq.count) || rfq.count < 1 || rfq.count > 64) return 'bad GPU count';
    if (!Number.isInteger(rfq.durationS) || rfq.durationS < 1 || rfq.durationS > 30 * 86400) return 'bad duration';
    const gpu = this.policy.gpus.find((g) => g.model.toLowerCase() === rfq.gpu.toLowerCase());
    if (!gpu || gpu.count < rfq.count) return `no ${rfq.count}× ${rfq.gpu} here`;
    const busy = [...this.jobs.values()]
      .filter((j) => (j.state === 'bid' || LIVE.includes(j.state)) && j.rfq.gpu.toLowerCase() === gpu.model.toLowerCase())
      .reduce((n, j) => n + j.rfq.count, 0);
    if (gpu.count - busy < rfq.count) return `GPUs busy (${busy} of ${gpu.count} committed)`;
    // maxPricePerHourZats = 0 means the buyer keeps its budget private: nothing to compare against.
    if (rfq.maxPricePerHourZats !== 0n && this.policy.minPricePerHourZats > rfq.maxPricePerHourZats) return 'max price is below our minimum';
    // A bid needs at least one more block to be mined before expiry, so don't pay a fee for one that can't land.
    if (this.lastTip >= rfq.expiresHeight) return 'RFQ expired or expiring: a bid could not be mined in time';
    if (this.spendCap && this.capSpentZats() + JOB_FEE_RESERVE_ZATS > this.spendCap.totalZats) {
      return `spend cap reached: ${formatZec(this.capSpentZats())} of ${formatZec(this.spendCap.totalZats)} ZEC spent on fees; a BID and a CLOSE need ${formatZec(JOB_FEE_RESERVE_ZATS)} ZEC more`;
    }
    return null;
  }

  private async onAccept(e: NoteEvent, acc: Accept, d: DecodedMemo): Promise<void> {
    const job = this.jobs.get(hex(acc.rfqId));
    if (!job) return;
    if (job.state !== 'bid') {
      if (job.payments.some((p) => p.txid === e.note.txid)) this.updateHeight(job, e);
      return;
    }
    const reject = (reason: string) => {
      this.recordText('provider', 'memo-rejected', `Ignored an ACCEPT: ${reason}`, [['Reason', reason, true, false], ['Transaction', e.note.txid, true, false]], { rfqId: job.rfqId });
    };
    if (!e.firstSeen) return;
    if (!d.verifiedBy(unhex(job.rfq.buyerKey))) return reject('not signed by the RFQ key');
    if (hex(acc.providerId) !== this.providerId) return reject('accepts a different provider');
    if (acc.pricePerIntervalZats !== job.bid.pricePerIntervalZats) return reject('price differs from our bid');
    if (e.note.zats < job.bid.pricePerIntervalZats) return reject(`pays ${e.note.zats} zats, interval 0 costs ${job.bid.pricePerIntervalZats}`);
    const maxIntervals = Math.max(1, Math.ceil(job.rfq.durationS / job.bid.intervalS));
    if (!Number.isInteger(acc.intervals) || acc.intervals < 1 || acc.intervals > maxIntervals) return reject('bad interval count');
    const h = e.note.height ?? this.lastTip;
    if (h > job.rfq.expiresHeight + profileAtHeight(this.profile, job.rfq.expiresHeight).acceptWindowBlocks) return reject('arrived after we gave up');
    job.state = 'won';
    job.intervals = acc.intervals;
    job.payments.push({ seq: 0, kind: 'accept', zats: e.note.zats, txid: e.note.txid, height: e.note.height, at: Date.now() });
    job.earnedZats += e.note.zats;
    this.recordText('provider', 'memo-received', `Bid won: ACCEPT for ${acc.intervals} interval(s), interval 0 paid`, [
      ['Price', `${formatZec(acc.pricePerIntervalZats)} ZEC per ${job.bid.intervalS} s`, true, true],
      ['Intervals (max)', String(acc.intervals), true, true],
      ['Received with it', `${formatZec(e.note.zats)} ZEC`, true, true],
      ['Buyer identity', 'not present in any message', false, true],
    ], { rfqId: job.rfqId, txid: e.note.txid });
    void this.observeTx(e.note.txid, { rfqId: job.rfqId, event: 'tx-received', summary: 'ACCEPT transaction: what the public chain shows', sealed: TX_FACTS.accept });
    this.changed(job);
    void this.startJob(job);
  }

  private updateHeight(job: ProviderJob, e: NoteEvent): void {
    const p = job.payments.find((x) => x.txid === e.note.txid);
    if (p && p.height === null && e.note.height !== null) {
      p.height = e.note.height;
      this.changed(job);
    }
  }

  private async onPay(e: NoteEvent, pay: Pay, d: DecodedMemo): Promise<void> {
    const job = this.jobs.get(hex(pay.rfqId));
    if (!job || job.intervals === undefined) return;
    if (job.payments.some((p) => p.txid === e.note.txid)) return this.updateHeight(job, e);
    if (!e.firstSeen) return;
    const reject = (reason: string) => {
      this.recordText('provider', 'memo-rejected', `Ignored a PAY: ${reason}`, [['Reason', reason, true, false], ['Transaction', e.note.txid, true, false]], { rfqId: job.rfqId });
    };
    if (!d.verifiedBy(unhex(job.rfq.buyerKey))) return reject('not signed by the RFQ key');
    if (!Number.isInteger(pay.seq) || pay.seq < 1 || pay.seq >= job.intervals) return reject(`interval ${pay.seq} is outside 1..${job.intervals - 1}`);
    if (job.payments.some((p) => p.seq === pay.seq)) return reject(`interval ${pay.seq} was already paid (replay)`);
    if (pay.seq <= job.servingSeq) return reject(`interval ${pay.seq} is in the past`);
    if (e.note.zats < job.bid.pricePerIntervalZats) return reject(`pays ${e.note.zats} zats, an interval costs ${job.bid.pricePerIntervalZats}`);
    job.payments.push({ seq: pay.seq, kind: 'pay', zats: e.note.zats, txid: e.note.txid, height: e.note.height, at: Date.now() });
    job.earnedZats += e.note.zats;
    this.recordText('provider', 'memo-received', `PAY received for interval ${pay.seq}`, [
      ['Interval', String(pay.seq), true, false],
      ['Amount', `${formatZec(e.note.zats)} ZEC`, true, true],
      ['Signature', 'valid (RFQ key)', true, false],
    ], { rfqId: job.rfqId, txid: e.note.txid });
    void this.observeTx(e.note.txid, { rfqId: job.rfqId, event: 'tx-received', summary: 'PAY transaction: what the public chain shows', sealed: TX_FACTS.pay });
    this.changed(job);
    void this.watchdog();
  }

  private async onBuyerClose(e: NoteEvent, c: Close, d: DecodedMemo): Promise<void> {
    const job = this.jobs.get(hex(c.rfqId));
    if (!job || c.by !== 'buyer' || !e.firstSeen) return;
    if (!d.verifiedBy(unhex(job.rfq.buyerKey))) {
      this.recordText('provider', 'memo-rejected', 'Ignored a CLOSE not signed by the RFQ key', [['Transaction', e.note.txid, true, false]], { rfqId: job.rfqId });
      return;
    }
    this.recordText('provider', 'memo-received', `Buyer closed the job: ${c.reason}`, [
      ['Reason', c.reason, true, false],
      ['Last interval paid', String(c.finalSeq), true, false],
    ], { rfqId: job.rfqId, txid: e.note.txid });
    void this.observeTx(e.note.txid, { rfqId: job.rfqId, event: 'tx-received', summary: 'Buyer CLOSE transaction: what the public chain shows', sealed: TX_FACTS.buyerClose });
    if (LIVE.includes(job.state)) await this.finishJob(job, { kind: 'buyer_close', reason: c.reason });
  }

  private onTick(tip: number): void {
    this.lastTip = tip;
    for (const j of this.jobs.values()) {
      if (j.state === 'bid' && tip > j.rfq.expiresHeight + profileAtHeight(this.profile, j.rfq.expiresHeight).acceptWindowBlocks) {
        j.state = 'lost';
        this.changed(j);
      }
    }
  }

  // ------------------------------------------------------------------ running a job

  private async startJob(job: ProviderJob): Promise<void> {
    const p = this.deps.protocol;
    const rt = this.runtime(job);
    rt.channel = p.deriveChannel(unhex(job.bid.ephSecret), unhex(job.rfq.buyerEph), unhex(job.rfqId));
    if (this.blobTransport === 'memo') this.memo.register(job.rfqId, rt.channel, { to: job.rfq.replyTo, signer: this.signer! });
    rt.status = 'starting';
    rt.hbTimer = setInterval(() => void this.heartbeat(job), Math.max(50, this.profile.heartbeatS * 1000));
    void this.heartbeat(job);
    try {
      const { manifest, bundle, checkpoint } = decodeJobBlob(await this.fetchJobBlob(job, rt.channel));
      if (hex(p.sha256(bundle)) !== manifest.bundleSha256) throw new Error('job bundle digest mismatch');
      const dir = join(this.workDir, job.rfqId, 'bundle');
      await rm(join(this.workDir, job.rfqId), { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await this.deps.unpackBundle(bundle, dir);
      job.manifest = { command: manifest.command, bundleSize: bundle.length, bundleSha256: manifest.bundleSha256 };
      if (manifest.image) job.manifest.image = manifest.image;
      // A migrated job: the buyer's checkpoint from the earlier deal goes into SILICR_CHECKPOINT_DIR first.
      let checkpointDir: string | undefined;
      if (manifest.resumeFrom && checkpoint) {
        if (hex(p.sha256(checkpoint)) !== manifest.resumeFrom.sha256) throw new Error('job checkpoint digest mismatch');
        checkpointDir = join(this.workDir, job.rfqId, 'checkpoints');
        await mkdir(checkpointDir, { recursive: true, mode: 0o700 });
        await this.deps.unpackBundle(checkpoint, checkpointDir);
        job.resumedFromSeq = manifest.resumeFrom.seq;
        rt.lastCheckpointDigest = p.sha256(checkpoint);
        this.recordText('provider', 'job-resumed', `Job resumes from a buyer-supplied checkpoint (interval ${manifest.resumeFrom.seq} of an earlier deal)`, [
          ['Checkpoint', `${checkpoint.length} bytes, sha256 ${shortHex(manifest.resumeFrom.sha256)}`, true, true],
          ['Taken at', `interval ${manifest.resumeFrom.seq} of the earlier deal`, true, false],
          ['Earlier provider', 'not named: the checkpoint carries no provider or RFQ identity', false, false],
        ], { rfqId: job.rfqId });
      }
      this.recordText('provider', 'job-started', this.memo.isMemo(job.rfqId) ? 'Job reassembled from shielded memos, decrypted and started (relay-less)' : 'Job decrypted from the relay and started', [
        ['Command', manifest.command.join(' '), true, true],
        ['Image', manifest.image ?? 'python:3.12-slim', true, false],
        ['Bundle', `${bundle.length} bytes, sha256 ${shortHex(manifest.bundleSha256)}`, true, true],
        ['GPU', `${job.rfq.count}× ${job.rfq.gpu}`, true, true],
        ['Runner', (this.runner.sandboxed ?? this.runner.mode === 'docker') ? 'docker sandbox' : 'process mode (not a sandbox)', true, false],
        ['Buyer identity', 'not present in any message', false, true],
      ], { rfqId: job.rfqId });
      if (!LIVE.includes(job.state) || rt.finishing) return;
      const intervals = job.intervals ?? 1;
      const handle = await this.runner.start({
        bundleDir: dir,
        command: manifest.command,
        ...(manifest.image ? { image: manifest.image } : {}),
        gpu: { model: job.rfq.gpu, count: job.rfq.count },
        env: { ...sanitizeEnv(manifest.env), ...this.jobEnv },
        limits: { timeoutS: intervals * job.bid.intervalS + this.policy.graceS * 2 + 120 },
        ...(checkpointDir ? { checkpointDir } : {}),
      });
      if (!LIVE.includes(job.state) || rt.finishing) {
        await handle.stop('job closed before it started').catch(() => undefined);
        return;
      }
      rt.handle = handle;
      job.state = 'running';
      job.startedAt = Date.now();
      job.servingSeq = 0;
      rt.intervalStartedAt = Date.now();
      rt.status = 'running';
      this.changed(job);
      void this.pumpLogs(job, handle);
      handle
        .wait()
        .then((exit) => {
          if (!rt.finishing) void this.finishJob(job, { kind: 'exit', exit });
        })
        .catch((err) => {
          if (!rt.finishing) void this.finishJob(job, { kind: 'error', message: errMsg(err) });
        });
      void this.heartbeat(job);
    } catch (err) {
      job.error = `job start failed: ${errMsg(err)}`;
      await this.finishJob(job, { kind: 'error', message: errMsg(err) });
    }
  }

  private async fetchJobBlob(job: ProviderJob, ch: Channel): Promise<Uint8Array> {
    const got = await readChunked(this.relay, ch, 'job', this.deps.protocol.sha256, {
      waitS: this.profile.relayWaitS,
      deadline: Date.now() + this.profile.jobFetchTimeoutS * 1000,
      live: () => !this.stopped && LIVE.includes(job.state),
      idleMs: Math.min(250, this.profile.pollMs),
    });
    if (!got) throw new Error(this.memo.isMemo(job.rfqId) ? 'the sealed job never arrived in memos' : 'the sealed job never appeared on the relay');
    return got.payload;
  }

  private async pumpLogs(job: ProviderJob, handle: RunHandle): Promise<void> {
    const rt = this.runtime(job);
    try {
      for await (const raw of handle.logs()) {
        const line = raw.length > 4096 ? `${raw.slice(0, 4096)}…` : raw;
        job.logTail.push(line);
        if (job.logTail.length > LOG_LINES_KEPT) job.logTail.splice(0, job.logTail.length - LOG_LINES_KEPT);
        rt.pendingLogs.push(line);
        if (rt.pendingLogs.length > 2000) rt.pendingLogs.splice(0, rt.pendingLogs.length - 2000);
      }
    } catch (e) {
      this.log(`job logs: ${errMsg(e)}`);
    }
  }

  /** Signed heartbeat, sealed to the channel, plus any batched log lines. */
  private heartbeat(job: ProviderJob, final?: { status: Heartbeat['status']; note: string }): Promise<void> {
    const rt = this.runtime(job);
    return rt.hbMutex.run(async () => {
      const ch = rt.channel;
      if (!ch || this.stopped) return;
      if (!final && (rt.finishing || job.heartbeatsStopped || !LIVE.includes(job.state))) return;
      const p = this.deps.protocol;
      let step = 0;
      let checkpointDigest: Uint8Array = new Uint8Array(32);
      if (rt.handle) {
        try {
          const pr = await rt.handle.progress();
          step = pr.step;
          checkpointDigest = pr.checkpointDigest;
        } catch {
          // keep zeros
        }
      }
      const hb: Heartbeat = {
        rfqId: unhex(job.rfqId),
        seq: job.lastHeartbeatSeq + 1,
        ts: Date.now(),
        step,
        checkpointDigest,
        status: final?.status ?? rt.status,
        servingSeq: job.servingSeq,
      };
      if (final?.note) hb.note = final.note.slice(0, 200); // protocol cap is 1024 bytes
      // Memo mode: every heartbeat is a transaction, so send one per interval, plus any change of
      // status or interval (those gate the buyer's payments) and the final one.
      if (this.memo.isMemo(job.rfqId) && !final) {
        const last = rt.lastMemoHb;
        if (last && last.status === hb.status && last.servingSeq === hb.servingSeq && Date.now() - last.at < job.bid.intervalS * 1000) return;
      }
      try {
        await this.flushLogs(job, rt, ch);
        await this.relay.append(ch.mailboxes.heartbeat, ch.seal('heartbeat', p.encodeHeartbeat(hb, this.signer!)));
        rt.lastMemoHb = { at: Date.now(), status: hb.status, servingSeq: hb.servingSeq };
        job.lastHeartbeatSeq = hb.seq;
        this.stateFile.touch();
      } catch (e) {
        this.log(`heartbeat: ${errMsg(e)}`);
      }
    });
  }

  private async flushLogs(job: ProviderJob, rt: JobRuntime, ch: Channel): Promise<void> {
    if (rt.pendingLogs.length === 0) return;
    const lines = rt.pendingLogs.splice(0, rt.pendingLogs.length);
    if (this.memo.isMemo(job.rfqId)) {
      // A log batch is a transaction of memos: keep the tail that fits one transaction's worth.
      const budget = Math.max(1024, Math.min(this.memo.maxBlobBytes, maxBlobBytes(this.backend.capabilities.maxOutputsPerTx)) - 256);
      let bytes = 0;
      let keep = lines.length;
      while (keep > 0 && bytes + lines[keep - 1]!.length + 1 <= budget) bytes += lines[keep - 1]!.length + 1, keep--;
      if (keep > 0) lines.splice(0, keep, `[${keep} log line(s) dropped: relay-less transport keeps the last ${budget} bytes per batch]`);
    }
    try {
      const seq = (job.logBatchSeq ?? 0) + 1;
      await this.relay.append(ch.mailboxes.log, ch.seal('log', encodeLogBatch(seq, lines)));
      job.logBatchSeq = seq;
      this.emit({ type: 'log', rfqId: job.rfqId, lines });
    } catch (e) {
      rt.pendingLogs.unshift(...lines);
      throw e;
    }
  }

  /**
   * The payment watchdog (every 100 ms and after each PAY). Interval k+1 is served only if
   *   - PAY(k+1) has been received (the mempool is fine: that's the fast path), and
   *   - PAY(k) — or the ACCEPT for k = 0 — has been MINED.
   * So at most one unconfirmed payment is outstanding at any time: a buyer who double-spends a
   * PAY gets at most the one interval it was meant to pay for.
   */
  private async watchdog(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    for (const job of this.jobs.values()) {
      const cr = job.closeRetry;
      if (cr && !job.closeTxid && now >= cr.nextAt && !this.runtime(job).closingTx) void this.sendCloseRetrying(job, cr.reason, cr.digest ? unhex(cr.digest) : undefined);
      if (job.state !== 'running' && job.state !== 'paused') continue;
      const rt = this.runtime(job);
      if (!rt.handle || rt.finishing || rt.watchdogBusy || job.intervals === undefined) continue;
      rt.watchdogBusy = true;
      try {
        const next = job.servingSeq + 1;
        const paidNext = job.payments.some((p) => p.seq === next);
        const confirmedNow = isConfirmed(job, job.servingSeq);
        const intervalMs = job.bid.intervalS * 1000;
        if (job.state === 'running') {
          if (now < rt.intervalStartedAt + intervalMs) continue;
          if (next >= job.intervals) {
            void this.finishJob(job, { kind: 'time_up' });
            continue;
          }
          if (paidNext && confirmedNow) {
            job.servingSeq = next;
            rt.intervalStartedAt = now - rt.intervalStartedAt > 2 * intervalMs ? now : rt.intervalStartedAt + intervalMs;
            this.changed(job);
            void this.heartbeat(job);
            void this.uploadCheckpoint(job, next - 1, `interval ${next - 1} served`);
            continue;
          }
          await rt.handle.pause();
          job.state = 'paused';
          rt.status = 'paused';
          rt.pausedAt = now;
          rt.pauseCause = paidNext ? 'unconfirmed' : 'unpaid';
          void this.uploadCheckpoint(job, job.servingSeq, 'job paused');
          if (paidNext) {
            this.recordText('provider', 'watchdog', `PAY for interval ${job.servingSeq} is still unconfirmed: interval ${next} paused, ${this.policy.graceS} s grace`, [
              ['Waiting for', `the payment for interval ${job.servingSeq} to be mined`, true, false],
              ['Why', 'at most one unconfirmed payment may be outstanding: a double-spent PAY must not buy a second interval', true, false],
              ['Grace', `${this.policy.graceS} s`, true, false],
            ], { rfqId: job.rfqId });
          } else {
            this.recordText('provider', 'watchdog', `Interval ${next} not paid: job paused, ${this.policy.graceS} s grace`, [
              ['Unpaid interval', String(next), true, false],
              ['Grace', `${this.policy.graceS} s`, true, false],
            ], { rfqId: job.rfqId });
          }
          this.changed(job);
          void this.heartbeat(job);
        } else {
          if (paidNext && confirmedNow) {
            await rt.handle.resume();
            const cause = rt.pauseCause;
            job.state = 'running';
            rt.status = 'running';
            job.servingSeq = next;
            rt.intervalStartedAt = now;
            rt.pausedAt = null;
            rt.pauseCause = null;
            this.recordText(
              'provider',
              'watchdog',
              cause === 'unconfirmed' ? `PAY for interval ${next - 1} confirmed: job resumed` : `Interval ${next} paid during grace: job resumed`,
              [['Interval', String(next), true, false]],
              { rfqId: job.rfqId },
            );
            this.changed(job);
            void this.heartbeat(job);
          } else if (rt.pausedAt !== null && now >= rt.pausedAt + this.policy.graceS * 1000) {
            const why = paidNext
              ? `the payment for interval ${job.servingSeq} was never mined within ${this.policy.graceS} s`
              : `interval ${next} unpaid after ${this.policy.graceS} s grace`;
            void this.finishJob(job, { kind: 'unpaid', why });
          }
        }
      } catch (e) {
        this.log(`watchdog: ${errMsg(e)}`);
      } finally {
        rt.watchdogBusy = false;
      }
    }
  }

  /**
   * A payment we acted on that vanishes from the wallet before it's mined was evicted or
   * double-spent. poll() must list every unconfirmed received note, so missing from several
   * consecutive polls (and for a couple of seconds) means it's gone: stop the job.
   */
  private onPolled(notes: { txid: string }[]): void {
    const present = new Set(notes.map((n) => n.txid));
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (!LIVE.includes(job.state)) continue;
      const rt = this.runtime(job);
      if (rt.finishing) continue;
      for (const p of job.payments) {
        if (p.height !== null) continue;
        if (present.has(p.txid)) {
          rt.missing.delete(p.txid);
          continue;
        }
        const m = rt.missing.get(p.txid) ?? { polls: 0, since: now };
        m.polls += 1;
        rt.missing.set(p.txid, m);
        if (m.polls < 3 || now - m.since < Math.max(2000, 3 * this.profile.pollMs)) continue;
        job.payments = job.payments.filter((x) => x !== p);
        job.earnedZats -= p.zats;
        this.recordText('provider', 'watchdog', `The ${p.kind === 'accept' ? 'ACCEPT' : 'PAY'} for interval ${p.seq} disappeared before it was mined: stopping`, [
          ['Interval', String(p.seq), true, false],
          ['What happened', 'the unconfirmed payment left the wallet (evicted or double-spent)', true, false],
          ['Work at risk', 'at most that one interval', true, false],
        ], { rfqId: job.rfqId, txid: p.txid });
        this.changed(job);
        void this.finishJob(job, { kind: 'unpaid', why: `the payment for interval ${p.seq} disappeared before confirming` });
        break;
      }
    }
  }

  private async finishJob(job: ProviderJob, cause: FinishCause): Promise<void> {
    const rt = this.runtime(job);
    if (rt.finishing) return;
    rt.finishing = true;
    const p = this.deps.protocol;
    try {
      let exit: JobExit | null = cause.kind === 'exit' ? cause.exit : null;
      if (rt.handle && !exit) {
        const why = cause.kind === 'buyer_close' ? `buyer closed (${cause.reason})` : cause.kind;
        try {
          // The runner's stop() also handles a paused (frozen) job: SIGTERM, then SIGCONT.
          await rt.handle.stop(why);
        } catch (e) {
          this.log(`stop: ${errMsg(e)}`);
        }
        let timer: NodeJS.Timeout | undefined;
        exit = await Promise.race([rt.handle.wait(), new Promise<null>((r) => (timer = setTimeout(() => r(null), 30_000)))]).catch(() => null);
        clearTimeout(timer); // don't leave a 30 s timer pending after every job
      }
      // Metered delivery: whatever the job checkpointed up to the last paid interval goes to the buyer,
      // however the deal ended (an unpaid stop included: those intervals were paid for).
      if (rt.handle && rt.channel) await this.uploadCheckpoint(job, job.servingSeq, 'job stopping');
      let digest: Uint8Array | undefined;
      if (cause.kind !== 'unpaid' && exit && rt.channel) {
        try {
          const tar = await this.deps.packBundle(exit.outputDir, { special: 'skip' });
          const up = await uploadChunked(this.relay, rt.channel, 'result', tar, p.sha256);
          digest = up.sealedDigest;
          job.resultDigest = hex(digest);
          const viaMemo = this.memo.isMemo(job.rfqId);
          this.recordText('provider', 'blob-stored', viaMemo ? 'Result packed, sealed to the channel key and sent on-chain in memos (relay-less)' : 'Result packed, sealed to the channel key and uploaded', [
            ['Result size', `${tar.length} bytes (tar.gz, ${up.parts} chunk(s))`, true, true],
            ['SHA-256 of the sealed blob', hex(digest), true, false],
            viaMemo ? ['What the chain holds', `${cipherPreview(up.first)} (ciphertext inside shielded memos)`, true, false] : ['What the relay stores', cipherPreview(up.first), true, false],
          ], { rfqId: job.rfqId });
        } catch (e) {
          job.error = `result upload failed: ${errMsg(e)}`;
        }
      }
      let reason: CloseReason;
      let note: string;
      switch (cause.kind) {
        case 'exit':
          reason = cause.exit.exitCode === 0 ? 'done' : 'error';
          note = cause.exit.exitCode === 0 ? 'job finished' : `job exited with code ${cause.exit.exitCode}`;
          break;
        case 'time_up':
          reason = 'done';
          note = 'all paid intervals served';
          break;
        case 'buyer_close':
          reason = cause.reason;
          note = `stopped: buyer closed (${cause.reason})`;
          break;
        case 'unpaid':
          reason = 'unpaid';
          note = `stopped: ${cause.why ?? `interval ${job.servingSeq + 1} unpaid after ${this.policy.graceS} s grace`}`;
          break;
        case 'operator_stop':
          reason = 'provider_stop';
          note = 'stopped by the provider';
          break;
        default:
          reason = 'error';
          note = `error: ${cause.message}`;
      }
      const ok = digest !== undefined && (reason === 'done' || cause.kind === 'buyer_close');
      if (rt.channel) await this.heartbeat(job, { status: ok ? 'finished' : 'failed', note });
      if (rt.hbTimer) clearInterval(rt.hbTimer);
      rt.hbTimer = null;
      rt.status = ok ? 'finished' : 'failed';
      job.state = reason === 'done' ? 'done' : 'stopped';
      job.stopReason = reason;
      job.stoppedAt = Date.now();
      if (cause.kind === 'unpaid') {
        this.recordText('provider', 'watchdog', `Job stopped: ${cause.why ?? `payment for interval ${job.servingSeq + 1} never arrived`}`, [
          ['Paid and served', `intervals 0..${job.servingSeq}`, true, false],
          [
            'Unpaid work',
            cause.why?.includes('disappeared')
              ? 'at most the one interval the vanished payment was for'
              : 'none: the job was frozen at the boundary instead of serving an unpaid or unconfirmed interval',
            true,
            false,
          ],
        ], { rfqId: job.rfqId });
      }
      this.changed(job);
      await this.sendCloseRetrying(job, reason, digest);
      this.changed(job);
    } finally {
      await rt.handle?.cleanup?.().catch(() => undefined);
      await rm(join(this.workDir, job.rfqId), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Metered delivery: pack the job's checkpoint dir, seal it with kind 'checkpoint' and upload it
   * (chunked) tagged with the interval it belongs to. Skipped when the dir is empty or unchanged
   * since the last upload, or above maxCheckpointBytes. Never throws: a failed upload is logged.
   */
  private uploadCheckpoint(job: ProviderJob, seq: number, why: string): Promise<void> {
    const rt = this.runtime(job);
    return rt.ckptMutex.run(async () => {
      const dir = rt.handle?.checkpointDir;
      const ch = rt.channel;
      if (!dir || !ch || this.stopped) return;
      try {
        if (!(await hasFiles(dir))) return;
        const tar = await this.deps.packBundle(dir, { special: 'skip' });
        if (tar.length > this.maxCheckpointBytes) {
          if (!rt.checkpointTooBig) {
            rt.checkpointTooBig = true;
            this.recordText('provider', 'checkpoint-skipped', `Checkpoint not uploaded: ${tar.length} bytes is above the ${this.maxCheckpointBytes}-byte cap`, [
              ['Checkpoint size', `${tar.length} bytes`, true, false],
              ['Cap', `${this.maxCheckpointBytes} bytes (provider setting)`, true, false],
            ], { rfqId: job.rfqId });
          }
          return;
        }
        rt.checkpointTooBig = false;
        const p = this.deps.protocol;
        const digest = p.sha256(tar);
        if (rt.lastCheckpointDigest && bytesEqual(digest, rt.lastCheckpointDigest)) return;
        const up = await uploadChunked(this.relay, ch, 'checkpoint', encodeCheckpointBlob(seq, digest, tar), p.sha256);
        rt.lastCheckpointDigest = digest;
        job.checkpoint = { seq, digest: hex(digest), sizeBytes: tar.length, at: Date.now() };
        this.recordText('provider', 'blob-stored', `Checkpoint for interval ${seq} packed, sealed to the channel key and uploaded (${why})`, [
          ['Interval', String(seq), true, false],
          ['Checkpoint size', `${tar.length} bytes (tar.gz, ${up.parts} chunk(s))`, true, true],
          ['SHA-256 of the checkpoint', hex(digest), true, false],
          ['What the relay stores', cipherPreview(up.first), true, false],
          ['What the relay learns', `one more sealed blob of ${up.sealedBytes} bytes and when it was uploaded`, true, false],
        ], { rfqId: job.rfqId });
        this.changed(job);
      } catch (e) {
        this.log(`checkpoint upload: ${errMsg(e)}`);
      }
    });
  }

  /**
   * CLOSE, kept and retried with backoff when the chain is unreachable: the buyer needs it (and
   * the result digest it carries) to verify the result and close on its side.
   */
  private async sendCloseRetrying(job: ProviderJob, reason: CloseReason, digest: Uint8Array | undefined): Promise<void> {
    const rt = this.runtime(job);
    if (job.closeTxid || rt.closingTx || this.stopped) return;
    rt.closingTx = true;
    try {
      await this.sendClose(job, reason, digest);
      const retried = job.closeRetry?.attempts ?? 0;
      delete job.closeRetry;
      if (job.error?.startsWith('CLOSE failed')) delete job.error;
      if (retried) this.log(`CLOSE (${reason}) for ${shortHex(job.rfqId)} went out after ${retried} failed attempt(s)`);
    } catch (e) {
      const attempts = (job.closeRetry?.attempts ?? 0) + 1;
      const wait = closeRetryDelayMs(attempts, this.profile.pollMs);
      job.closeRetry = { reason, attempts, nextAt: Date.now() + wait, lastError: errMsg(e) };
      if (digest) job.closeRetry.digest = hex(digest);
      job.error = `CLOSE failed: ${errMsg(e)} (attempt ${attempts}; retrying in ${Math.round(wait / 1000)} s)`;
      if (attempts === 1) {
        this.recordText('provider', 'watchdog', `CLOSE (${reason}) could not be broadcast; it is kept and retried until the chain is reachable`, [
          ['Error', errMsg(e), true, false],
          ['Next attempt', `in ${Math.round(wait / 1000)} s, then doubling up to ${CLOSE_RETRY_MAX_MS / 1000} s`, true, false],
        ], { rfqId: job.rfqId });
      }
    } finally {
      rt.closingTx = false;
    }
    this.changed(job);
  }

  private async sendClose(job: ProviderJob, reason: CloseReason, digest: Uint8Array | undefined): Promise<void> {
    const msg: Close = { t: 'CLOSE', rfqId: unhex(job.rfqId), by: 'provider', reason, finalSeq: job.servingSeq };
    if (digest) msg.resultDigest = digest;
    const memo = this.deps.protocol.encodeMemo(msg, this.signer!, this.transport);
    const res = await this.send([{ to: job.rfq.replyTo, zats: this.minOutput, memo }], { rfqId: job.rfqId, what: `CLOSE (${reason})`, sealed: TX_FACTS.providerClose });
    job.closeTxid = res.txid;
    job.feesZats += res.feeZats;
    this.recordText('provider', 'tx-broadcast', `CLOSE sent: ${reason}`, [
      ['Reason', reason, true, false],
      ['Last interval served', String(job.servingSeq), true, false],
      ['Result digest', digest ? hex(digest) : 'none', true, false],
      ['Earned', `${formatZec(job.earnedZats)} ZEC`, true, true],
    ], { rfqId: job.rfqId, txid: res.txid });
  }

  /** Operator stop (not in the base API): CLOSE(provider_stop). */
  async stopJob(id: string): Promise<ProviderJobDtoExt> {
    const job = this.must(id);
    if (!LIVE.includes(job.state)) throw conflict(`job is ${job.state}`);
    await this.finishJob(job, { kind: 'operator_stop' });
    return this.dto(job);
  }

  /** Demo / test fault injection. */
  fault(id: string, fault: ProviderFault): ProviderJobDtoExt {
    const job = this.must(id);
    if (fault === 'stop_heartbeats') {
      job.heartbeatsStopped = true;
      this.recordText('provider', 'fault', 'Fault injected: heartbeats stopped (the job keeps running)', [['Fault', 'stop_heartbeats', true, false]], { rfqId: job.rfqId });
    } else if (fault === 'resume_heartbeats') {
      job.heartbeatsStopped = false;
    } else {
      throw badRequest(`unknown fault ${String(fault)}`);
    }
    this.changed(job);
    return this.dto(job);
  }

  // ------------------------------------------------------------------ DTOs

  private changed(j: ProviderJob): void {
    this.stateFile.touch();
    this.emit({ type: 'job.updated', job: this.dto(j) });
  }

  dto(j: ProviderJob): ProviderJobDtoExt {
    const d: ProviderJobDtoExt = {
      rfqId: j.rfqId,
      state: j.state,
      request: { gpu: j.rfq.gpu, count: j.rfq.count, durationS: j.rfq.durationS, maxPricePerHourZats: j.rfq.maxPricePerHourZats.toString() },
      bid: { pricePerIntervalZats: j.bid.pricePerIntervalZats.toString(), intervalS: j.bid.intervalS, txid: j.bid.txid },
      paymentsReceived: j.payments.map(
        (p): PaymentDto => ({ seq: p.seq, kind: p.kind, zats: p.zats.toString(), feeZats: '0', txid: p.txid, height: p.height, at: p.at }),
      ),
      earnedZats: j.earnedZats.toString(),
      servingSeq: j.servingSeq,
      lastHeartbeatSeq: j.lastHeartbeatSeq,
      logTail: j.logTail.slice(-100),
      heartbeatsStopped: !!j.heartbeatsStopped,
      feesZats: j.feesZats.toString(),
    };
    if (j.startedAt !== undefined) d.startedAt = j.startedAt;
    if (j.stoppedAt !== undefined) d.stoppedAt = j.stoppedAt;
    if (j.stopReason !== undefined) d.stopReason = j.stopReason;
    if (j.intervals !== undefined) d.intervals = j.intervals;
    if (j.resultDigest !== undefined) d.resultDigest = j.resultDigest;
    if (j.error !== undefined) d.error = j.error;
    if (j.closeRetry && !j.closeTxid) d.closePending = { reason: j.closeRetry.reason, attempts: j.closeRetry.attempts, nextAt: j.closeRetry.nextAt };
    if (j.checkpoint !== undefined) d.checkpoint = { ...j.checkpoint };
    if (j.resumedFromSeq !== undefined) d.resumedFromSeq = j.resumedFromSeq;
    const wd = this.watchdogView(j);
    if (wd) d.watchdog = wd;
    return d;
  }

  /** The watchdog's own state: paid ahead, in grace before the next boundary, or paused. */
  private watchdogView(j: ProviderJob): ProviderJobDtoExt['watchdog'] {
    const rt = this.rt.get(j.rfqId);
    if (!rt || (j.state !== 'running' && j.state !== 'paused') || j.intervals === undefined) return undefined;
    const paidThroughSeq = j.payments.reduce((m, p) => Math.max(m, p.seq), -1);
    const next = j.servingSeq + 1;
    const unconfirmed = !isConfirmed(j, j.servingSeq);
    let wd: NonNullable<ProviderJobDtoExt['watchdog']>;
    if (j.state === 'paused') {
      wd = { state: 'paused', paidThroughSeq, deadlineAt: (rt.pausedAt ?? Date.now()) + this.policy.graceS * 1000 };
    } else if (next >= j.intervals || (j.payments.some((p) => p.seq === next) && !unconfirmed)) {
      wd = { state: 'paid_ahead', paidThroughSeq };
    } else {
      wd = { state: 'grace', paidThroughSeq, deadlineAt: rt.intervalStartedAt + j.bid.intervalS * 1000 };
    }
    if (unconfirmed) wd.unconfirmedSeq = j.servingSeq;
    return wd;
  }
}

function newRuntime(): JobRuntime {
  return {
    channel: null,
    handle: null,
    closingTx: false,
    hbTimer: null,
    hbMutex: new Mutex(),
    pendingLogs: [],
    intervalStartedAt: 0,
    pausedAt: null,
    status: 'starting',
    finishing: false,
    watchdogBusy: false,
    pauseCause: null,
    missing: new Map(),
    lastMemoHb: null,
    ckptMutex: new Mutex(),
    lastCheckpointDigest: null,
    checkpointTooBig: false,
  };
}

/** Any regular file under `dir` (symlinks and specials don't count: packBundle skips them). */
async function hasFiles(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries.some((e) => e.isFile());
  } catch {
    return false;
  }
}

/** The payment for interval `seq` (the ACCEPT for 0) has been mined. */
function isConfirmed(job: ProviderJob, seq: number): boolean {
  const p = job.payments.find((x) => x.seq === seq);
  return !!p && p.height !== null;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** What this provider asks per hour when the buyer's budget is undisclosed: min × (1 + markupPct/100), rounded up. */
export function askingPricePerHour(policy: Pick<ProviderPolicy, 'minPricePerHourZats' | 'markupPct'>): bigint {
  const pct = policy.markupPct ?? 0;
  if (!(pct > 0)) return policy.minPricePerHourZats;
  // Percent with up to 2 decimals, as integer basis points, so the maths stays in bigint.
  const bp = BigInt(Math.round(pct * 100));
  return ceilDiv(policy.minPricePerHourZats * (10_000n + bp), 10_000n);
}
