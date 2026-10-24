/**
 * The mock world: a small discrete-event simulation of one buyer, the provider
 * directory, the relay and a (compressed) Zcash mainnet with small balances and
 * spend caps, as the real daemons run. It produces exactly the
 * DTOs the real daemons would (RfqDto, ProviderJobDto, LeakObservation,
 * PublicTxViewDto) and writes them into the store.
 *
 * The same code runs in two modes:
 *  - live:    timers, for requests made in this tab (bids trickle in, intervals tick)
 *  - instant: a virtual clock, to seed one finished request from ~47 minutes ago
 *
 * Every observation lists only what that party actually holds in this design
 * (THREAT_MODEL.md). Fact tags are explicit (local contract extension).
 */

import type {
  BidDto,
  CloseReason,
  HeartbeatDto,
  LeakObservation,
  NewRfqRequest,
  Party,
  PaymentDto,
  ProviderJobDto,
  ProviderPolicyDto,
  PublicTxViewDto,
} from '@silicr/api';
import { ApiError } from '../client';
import type { FactKey, LeakFieldExt, ProviderJobExt, RfqExt, WatchdogState } from '../contract-ext';
import {
  formatBytes,
  formatDuration,
  formatInt,
  formatZec,
  gpuLabel,
  joinArgv,
  normalizeGpu,
  paddedOutputsFor,
  toZats,
  truncateMiddle,
  zecString,
  zip317Fee,
} from '../format';
import { actions } from '../store';
import * as fx from './fixtures';
import { Rng } from './rng';

// ---------------------------------------------------------------------------
// Schedulers

type Task = (t: number) => void;

interface Scheduler {
  now(): number;
  at(t: number, fn: Task): number;
  cancel(id: number): void;
}

class LiveScheduler implements Scheduler {
  private readonly handles = new Map<number, ReturnType<typeof setTimeout>>();
  private nextId = 1;
  private disposed = false;

  now(): number {
    return Date.now();
  }

  at(t: number, fn: Task): number {
    const id = this.nextId++;
    if (this.disposed) return id;
    const h = setTimeout(() => {
      this.handles.delete(id);
      if (!this.disposed) fn(Date.now());
    }, Math.max(0, t - Date.now()));
    this.handles.set(id, h);
    return id;
  }

  cancel(id: number): void {
    const h = this.handles.get(id);
    if (h) clearTimeout(h);
    this.handles.delete(id);
  }

  dispose(): void {
    this.disposed = true;
    for (const h of this.handles.values()) clearTimeout(h);
    this.handles.clear();
  }
}

/** Runs tasks in timestamp order on a virtual clock, without waiting. */
class InstantScheduler implements Scheduler {
  private q: { t: number; n: number; id: number; fn: Task }[] = [];
  private cur: number;
  private nextId = 1;
  private n = 0;

  constructor(start: number) {
    this.cur = start;
  }

  now(): number {
    return this.cur;
  }

  at(t: number, fn: Task): number {
    const id = this.nextId++;
    this.q.push({ t: Math.max(t, this.cur), n: this.n++, id, fn });
    return id;
  }

  cancel(id: number): void {
    this.q = this.q.filter((x) => x.id !== id);
  }

  run(until: number): void {
    for (let guard = 0; guard < 200_000 && this.q.length; guard++) {
      let bi = 0;
      for (let i = 1; i < this.q.length; i++) {
        const a = this.q[i]!;
        const b = this.q[bi]!;
        if (a.t < b.t || (a.t === b.t && a.n < b.n)) bi = i;
      }
      const next = this.q[bi]!;
      if (next.t > until) return;
      this.q.splice(bi, 1);
      this.cur = next.t;
      next.fn(next.t);
    }
  }
}

// ---------------------------------------------------------------------------
// Observation fields (with explicit fact tags)

const know = (label: string, value: string, facts: FactKey[] = []): LeakFieldExt => ({ label, value, readable: true, sensitive: true, facts });
const plain = (label: string, value: string, facts: FactKey[] = []): LeakFieldExt => ({ label, value, readable: true, sensitive: false, facts });
const sealed = (label: string, value: string, facts: FactKey[] = []): LeakFieldExt => ({ label, value, readable: false, sensitive: true, facts });

const short = (hex: string) => truncateMiddle(hex, 6, 4);
const perHourStr = (z: bigint) => `${formatZec(z)}/h`;

interface MockTx {
  view: PublicTxViewDto;
  onMined: ((height: number, t: number) => void)[];
}

interface BidPlan {
  p: fx.MockProvider;
  ppi: bigint;
  perHour: bigint;
  intervalS: number;
  delayMs: number;
  payTo: string;
  providerEph: string;
  txid?: string;
  height: number | null;
  bid?: BidDto;
}

// ---------------------------------------------------------------------------

export class MockWorld {
  readonly rng = new Rng(0x51c1c0de);
  readonly t0: number;
  readonly h0 = fx.START_HEIGHT;
  readonly directory: fx.MockProvider[];
  readonly persona: fx.MockProvider;
  readonly buyerAddress: string;
  policy: ProviderPolicyDto;
  private readonly live = new LiveScheduler();
  private readonly sims = new Map<string, RfqSim>();
  private buyerBalance = fx.BUYER_BALANCE;
  private providerBalance = fx.PROVIDER_BALANCE;
  private providerPending = 0n;
  /** What each daemon has spent against its cap since it started (payments and fees). */
  private buyerCapSpent = 0n;
  private providerCapSpent = 0n;
  private obsSeq = 0;
  private running = false;

  constructor() {
    const now = Date.now();
    this.t0 = now - (now % fx.BLOCK_MS);
    this.directory = fx.makeDirectory(this.rng, now);
    this.persona = this.directory.find((p) => p.alias === fx.PERSONA_ALIAS) ?? this.directory[0]!;
    this.buyerAddress = this.rng.ua();
    this.policy = {
      autoBid: true,
      minPricePerHourZats: this.persona.minPricePerHourZats,
      intervalS: fx.INTERVAL_S,
      graceS: fx.GRACE_S,
      gpus: this.persona.gpus,
    };
  }

  // --- chain clock -------------------------------------------------------

  heightAt(t: number): number {
    return this.h0 + Math.floor((t - this.t0) / fx.BLOCK_MS);
  }

  nextBlockAt(t: number): number {
    return this.t0 + (Math.floor((t - this.t0) / fx.BLOCK_MS) + 1) * fx.BLOCK_MS;
  }

  timeOfHeight(h: number): number {
    return this.t0 + (h - this.h0) * fx.BLOCK_MS;
  }

  // --- lifecycle ---------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    const now = Date.now();
    actions.setProviders(this.directory.map(fx.toProviderDto), null);
    actions.setPolicy({ ...this.policy });
    this.seedOlderJobs(now);
    this.seedHistory(now);
    actions.setRfqsLoaded();
    this.publishStatus(now);
    const tick = (t: number) => {
      if (!this.running) return;
      this.publishStatus(t);
      this.live.at(this.nextBlockAt(t) + 5, tick);
    };
    this.live.at(this.nextBlockAt(now) + 5, tick);
  }

  stop(): void {
    this.running = false;
    this.live.dispose();
  }

  publishStatus(t: number): void {
    const height = this.heightAt(t);
    const common = { network: 'main' as const, height, relayUrl: 'http://127.0.0.1:7700', version: '0.1.0-mock', demoMode: true, blockTimeS: fx.BLOCK_MS / 1000 };
    actions.setStatus('buyer', {
      ...common,
      role: 'buyer',
      address: this.buyerAddress,
      balance: { spendable: this.buyerBalance.toString(), pending: '0' },
      spendCap: { perRfqZats: fx.BUYER_CAP.perRfq.toString(), totalZats: fx.BUYER_CAP.total.toString(), spentZats: this.buyerCapSpent.toString() },
    });
    actions.setStatus('provider', {
      ...common,
      role: 'provider',
      address: this.persona.address,
      alias: this.persona.alias,
      providerId: this.persona.providerId,
      balance: { spendable: this.providerBalance.toString(), pending: this.providerPending.toString() },
      spendCap: { perRfqZats: fx.PROVIDER_CAP.perRfq.toString(), totalZats: fx.PROVIDER_CAP.total.toString(), spentZats: this.providerCapSpent.toString() },
    });
  }

  buyerSpend(z: bigint): void {
    this.buyerBalance -= z;
    this.buyerCapSpent += z;
  }

  providerSpend(z: bigint): void {
    this.providerBalance -= z;
    this.providerCapSpent += z;
  }

  providerEarn(z: bigint, mined: boolean): void {
    if (mined) this.providerBalance += z;
    else this.providerPending += z;
  }

  providerSettle(z: bigint): void {
    this.providerPending -= z;
    this.providerBalance += z;
  }

  // --- primitives used by simulations ------------------------------------

  /**
   * Broadcast one fully shielded transaction; the chain only ever sees this view.
   * `seenBy`: 'own' = the buyer broadcast it (exact copy); 'received' = the buyer only
   * learns it from the mempool, then compact blocks (exact counts, unknown fee and values).
   */
  sendTx(s: Scheduler, t: number, nActions: number, onMined?: (height: number, t: number) => void, seenBy: 'own' | 'received' = 'own'): MockTx {
    const fee = zip317Fee(nActions);
    const view: PublicTxViewDto = {
      txid: this.rng.txid(),
      height: null,
      time: null,
      version: 6,
      sizeBytes: 164 + nActions * (820 + 64 + 2272) + 2720 + this.rng.int(0, 48),
      feeZats: fee.toString(),
      transparent: { inputs: 0, outputs: 0 },
      sapling: { spends: 0, outputs: 0, valueBalanceZats: '0' },
      // Legacy Orchard is withdraw-only since NU6.3: Silicr never touches it.
      orchard: { actions: 0, valueBalanceZats: '0', ciphertextSamples: [] },
      // A fully shielded tx moves only the fee out of the Ironwood pool.
      ironwood: { actions: nActions, valueBalanceZats: fee.toString(), ciphertextSamples: Array.from({ length: nActions }, () => this.rng.hex(32)) },
      source: 'broadcast',
      complete: true,
    };
    const tx: MockTx = { view, onMined: onMined ? [onMined] : [] };
    // What the buyer can see of a transaction it didn't send: counts and ciphertexts, not fee or values.
    const partial = (v: PublicTxViewDto, source: 'mempool' | 'compact-block'): PublicTxViewDto => ({
      ...structuredClone(v),
      feeZats: null,
      ironwood: { ...v.ironwood!, valueBalanceZats: '0', ciphertextSamples: [...v.ironwood!.ciphertextSamples] },
      source,
      complete: false,
      estimated: ['feeZats', 'valueBalances', 'sizeBytes'],
    });
    actions.setChainTx(seenBy === 'own' ? structuredClone(view) : partial(view, 'mempool'), t);
    const minedAt = this.nextBlockAt(t + 900);
    s.at(minedAt, (tm) => {
      view.height = this.heightAt(minedAt);
      view.time = Math.floor(minedAt / 1000);
      actions.setChainTx(seenBy === 'own' ? structuredClone(view) : partial(view, 'compact-block'), t);
      for (const cb of tx.onMined) cb(view.height, tm);
    });
    return tx;
  }

  obs(party: Party, t: number, event: string, summary: string, fields: LeakFieldExt[], extra: { rfqId?: string; txid?: string } = {}): void {
    // The relay never learns which request a blob belongs to: never tag relay observations.
    const { rfqId, txid } = extra;
    const o: LeakObservation = {
      id: `mock-${party}-${(++this.obsSeq).toString(36).padStart(4, '0')}`,
      party,
      at: Math.round(t),
      event,
      summary,
      fields,
      ...(rfqId && party !== 'relay' ? { rfqId } : {}),
      ...(txid ? { txid } : {}),
    };
    actions.addLeaks([o]);
  }

  // --- commands -----------------------------------------------------------

  matching(gpu: string, count: number): fx.MockProvider[] {
    const want = normalizeGpu(gpu);
    return this.directory.filter((p) => p.gpus.some((g) => normalizeGpu(g.model).includes(want) && g.count >= count));
  }

  demoRequest(): NewRfqRequest {
    const asked = this.matching('a100', 4).filter((p) => p.verified);
    return {
      gpu: 'a100',
      count: 4,
      durationS: 3600,
      maxPricePerHourZats: fx.zec(0.8).toString(),
      providerIds: asked.map((p) => p.providerId),
      job: { path: fx.DEMO_JOB.path, command: [...fx.DEMO_JOB.command], image: fx.DEMO_JOB.image },
      autoAccept: { rule: 'cheapest', waitBlocks: 2 },
    };
  }

  createRfq(req: NewRfqRequest): string {
    const asked = this.validate(req);
    const sim = new RfqSim(this, this.live, req, asked, Date.now());
    this.sims.set(sim.id, sim);
    sim.submit(Date.now());
    return sim.id;
  }

  accept(rfqId: string, providerId: string): RfqExt {
    return this.sim(rfqId).accept(Date.now(), providerId, false);
  }

  stopRfq(rfqId: string): RfqExt {
    return this.sim(rfqId).stopByBuyer(Date.now());
  }

  setPaying(rfqId: string, paying: boolean): void {
    this.sim(rfqId).setPaying(Date.now(), paying);
  }

  setHeartbeats(rfqId: string, on: boolean): void {
    this.sim(rfqId).setHeartbeats(Date.now(), on);
  }

  stopJob(rfqId: string): void {
    this.sim(rfqId).stopByProvider(Date.now());
  }

  updatePolicy(patch: Partial<ProviderPolicyDto>): ProviderPolicyDto {
    const next = { ...this.policy };
    if (patch.autoBid !== undefined) next.autoBid = !!patch.autoBid;
    if (patch.minPricePerHourZats !== undefined) {
      if (!/^\d+$/.test(String(patch.minPricePerHourZats)) || toZats(patch.minPricePerHourZats) <= 0n) {
        throw new ApiError('minPricePerHourZats must be a positive zatoshi amount', 400, 'bad_request');
      }
      next.minPricePerHourZats = String(patch.minPricePerHourZats);
    }
    if (patch.intervalS !== undefined) {
      if (!Number.isInteger(patch.intervalS) || patch.intervalS < 10 || patch.intervalS > 3600) {
        throw new ApiError('intervalS must be a whole number of seconds between 10 and 3600', 400, 'bad_request');
      }
      next.intervalS = patch.intervalS;
    }
    if (patch.graceS !== undefined) {
      if (!Number.isInteger(patch.graceS) || patch.graceS < 0 || patch.graceS > 3600) {
        throw new ApiError('graceS must be between 0 and 3600 seconds', 400, 'bad_request');
      }
      next.graceS = patch.graceS;
    }
    this.policy = next;
    // The provider re-publishes its signed directory entry with the new floor.
    this.persona.minPricePerHourZats = next.minPricePerHourZats;
    this.persona.updatedAt = Date.now();
    actions.setProviders(this.directory.map(fx.toProviderDto), null);
    actions.setPolicy({ ...next });
    return { ...next };
  }

  resultBlob(rfqId: string): Blob {
    const sim = this.sim(rfqId);
    const r = sim.dto.result;
    if (!r) throw new ApiError('No result for this request yet', 404, 'not_found');
    const text = [
      'SILICR MOCK RESULT',
      '',
      "This file was produced by the web terminal's mock replay. It is NOT a real job result,",
      'and no job ran anywhere. Connect the buyer daemon to download real results.',
      '',
      `rfqId:          ${rfqId}`,
      `result digest:  ${r.digest}`,
      `size (claimed): ${r.sizeBytes} bytes`,
      `files (claimed): ${fx.DEMO_JOB.resultFiles}`,
      '',
    ].join('\n');
    return new Blob([text], { type: 'text/plain' });
  }

  private sim(rfqId: string): RfqSim {
    const s = this.sims.get(rfqId);
    if (!s) throw new ApiError(`Unknown request ${rfqId}`, 404, 'not_found');
    return s;
  }

  private validate(req: NewRfqRequest): fx.MockProvider[] {
    if (!req || typeof req.gpu !== 'string' || !req.gpu.trim()) throw new ApiError('Choose a GPU model', 400, 'bad_request');
    if (!Number.isInteger(req.count) || req.count < 1 || req.count > 64) throw new ApiError('GPU count must be 1 to 64', 400, 'bad_request');
    if (!Number.isFinite(req.durationS) || req.durationS < 60) throw new ApiError('Duration must be at least one minute', 400, 'bad_request');
    if (!/^\d+$/.test(String(req.maxPricePerHourZats)) || toZats(req.maxPricePerHourZats) <= 0n) {
      throw new ApiError('Max price must be a positive amount', 400, 'bad_request');
    }
    if (!req.job?.path?.trim()) throw new ApiError('Job folder is required', 400, 'bad_request');
    if (!req.job.command?.length) throw new ApiError('Command is required', 400, 'bad_request');
    let asked: fx.MockProvider[];
    if (req.providerIds?.length) {
      asked = req.providerIds.map((id) => {
        const p = this.directory.find((d) => d.providerId === id);
        if (!p) throw new ApiError(`Provider ${truncateMiddle(id, 8, 4)} is not in the directory`, 400, 'bad_request');
        return p;
      });
    } else {
      asked = this.matching(req.gpu, req.count).filter((p) => p.verified);
    }
    for (const p of asked) {
      if (!p.verified) throw new ApiError(`Refusing to send an RFQ to ${p.alias}: its directory signature does not verify`, 400, 'privacy');
    }
    if (!asked.length) throw new ApiError(`No verified provider offers ${req.count}× ${gpuLabel(req.gpu)}`, 400, 'bad_request');
    if (this.buyerBalance < zip317Fee(paddedOutputsFor(asked.length)) * 3n) {
      throw new ApiError('Not enough shielded funds for the RFQ transaction', 400, 'insufficient_funds');
    }
    // The spend cap, as the real daemon enforces it on mainnet: the request's worst case must fit.
    const worst = (toZats(req.maxPricePerHourZats) * BigInt(Math.round(req.durationS))) / 3600n + zip317Fee(paddedOutputsFor(asked.length));
    if (worst > fx.BUYER_CAP.perRfq) {
      throw new ApiError(`Over the per-request spend cap: up to ${zecString(worst)} ZEC at your max price, cap ${zecString(fx.BUYER_CAP.perRfq)} ZEC`, 400, 'spend_cap');
    }
    if (worst > fx.BUYER_CAP.total - this.buyerCapSpent) {
      throw new ApiError(`Over the total spend cap: ${zecString(fx.BUYER_CAP.total - this.buyerCapSpent)} ZEC left of ${zecString(fx.BUYER_CAP.total)} ZEC`, 400, 'spend_cap');
    }
    return asked;
  }

  // --- seeding ------------------------------------------------------------

  /** A complete request from ~47 minutes ago, so every screen has data at load. */
  private seedHistory(now: number): void {
    const start = now - 47 * 60_000 - 13_000;
    const inst = new InstantScheduler(start);
    const sim = new RfqSim(this, inst, this.demoRequest(), this.validate(this.demoRequest()), start);
    this.sims.set(sim.id, sim);
    sim.submit(start);
    inst.run(now - 1000);
  }

  /** The provider persona's jobs for other (unknown) buyers. */
  private seedOlderJobs(now: number): void {
    const mk = (startedAt: number, intervals: number, ppi: bigint, intervalS: number, state: ProviderJobDto['state'], count: number, durationS: number, max: number): ProviderJobDto => {
      const rfqId = this.rng.hex(16);
      const payments: PaymentDto[] = [];
      for (let k = 0; k < intervals; k++) {
        const at = startedAt + k * intervalS * 1000 - 3000;
        payments.push({ seq: k, kind: k === 0 ? 'accept' : 'pay', zats: ppi.toString(), feeZats: '10000', txid: this.rng.txid(), height: this.heightAt(at) + 1, at });
      }
      return {
        rfqId,
        state,
        request: { gpu: 'a100', count, durationS, maxPricePerHourZats: fx.zec(max).toString() },
        bid: { pricePerIntervalZats: ppi.toString(), intervalS, txid: this.rng.txid() },
        paymentsReceived: payments,
        earnedZats: (ppi * BigInt(intervals)).toString(),
        servingSeq: Math.max(0, intervals - 1),
        lastHeartbeatSeq: intervals * Math.round(intervalS / 15),
        ...(state === 'done' ? { startedAt, stoppedAt: startedAt + intervals * intervalS * 1000, stopReason: 'done' as CloseReason } : {}),
        logTail: state === 'done' ? ['[03:00:02] done in 10802s'] : [],
      };
    };
    const day = mk(now - 26 * 3_600_000, 18, fx.zec(0.105), 600, 'done', 4, 3 * 3600, 0.75);
    const lost = mk(now - 2 * 3_600_000 - 7 * 60_000, 0, fx.zec(0.105), 600, 'lost', 2, 3600, 0.7);
    actions.upsertJobs([day, lost]);
  }
}

// ---------------------------------------------------------------------------
// One request's lifecycle

type Phase = 'open' | 'running' | 'finishing' | 'closed';

class RfqSim {
  readonly id: string;
  readonly dto: RfqExt;
  job: ProviderJobExt | null = null;

  private readonly w: MockWorld;
  private readonly s: Scheduler;
  private readonly req: NewRfqRequest;
  private readonly asked: fx.MockProvider[];
  private readonly plans: BidPlan[];
  private readonly replyTo: string;
  private readonly buyerKey: string;
  private readonly buyerEph: string;
  private readonly mb: Record<'job' | 'log' | 'heartbeat' | 'result', string>;
  private readonly logRng: Rng;
  private readonly max: bigint;
  /** The max went on the wire (old behaviour). Default false: the memo says 0 = undisclosed. */
  private readonly disclose: boolean;

  private accepted: BidPlan | null = null;
  private phase: Phase = 'open';
  private spent = 0n;
  private fees = 0n;
  private startedAt = 0;
  /** PAY k is due at payBaseAt + k * interval - 2 s. Shifts when payments resume after a fault. */
  private payBaseAt = 0;
  private progressMs = 0;
  private lastTickAt = 0;
  private runMs: number = fx.RUN_MS;
  private maxSeq = 0;
  private hbSeq = 0;
  private logIdx = 0;
  private logPending = 0;
  private paidThrough = -1;
  private winnerPaidThrough = -1;
  private servingSeq = 0;
  private waitingSeq: number | null = null;
  private paying = true;
  private heartbeatsOn = true;
  private lastHeartbeatAt = 0;
  private providerFees = 0n;
  private payTimer: number | null = null;
  private paused = false;
  private watchdog: { state: WatchdogState; deadlineAt?: number } = { state: 'paid_ahead' };
  private checkpoint = '0'.repeat(64);
  private lastCheckpointStep = 0;

  constructor(w: MockWorld, s: Scheduler, req: NewRfqRequest, asked: fx.MockProvider[], t: number) {
    this.w = w;
    this.s = s;
    this.req = req;
    this.asked = asked;
    this.id = w.rng.hex(16);
    this.replyTo = w.rng.ua();
    this.buyerKey = w.rng.hex(32);
    this.buyerEph = w.rng.hex(32);
    this.mb = { job: w.rng.hex(16), log: w.rng.hex(16), heartbeat: w.rng.hex(16), result: w.rng.hex(16) };
    this.logRng = new Rng(parseInt(this.id.slice(0, 8), 16));
    this.max = toZats(req.maxPricePerHourZats);
    this.disclose = req.discloseMax === true;
    this.plans = this.planBids();
    this.dto = {
      rfqId: this.id,
      state: 'broadcasting',
      createdAt: t,
      request: { gpu: req.gpu, count: req.count, durationS: req.durationS, maxPricePerHourZats: req.maxPricePerHourZats },
      discloseMax: this.disclose,
      providersAsked: asked.length,
      paddedOutputs: paddedOutputsFor(asked.length),
      expiresHeight: w.heightAt(t) + 36,
      bids: [],
      payments: [],
      heartbeats: [],
      logTail: [],
      spentZats: '0',
      feesZats: '0',
    };
  }

  private get personaAsked(): boolean {
    return this.asked.includes(this.w.persona);
  }

  private get personaWon(): boolean {
    return !!this.accepted && this.accepted.p === this.w.persona;
  }

  private planBids(): BidPlan[] {
    const delays = [3200, 5600, 8400, 10_900, 13_300];
    const order = [...this.asked].filter((p) => !p.silent && p.verified).sort((a, b) => a.latencyRank - b.latencyRank);
    const plans: BidPlan[] = [];
    for (const p of order) {
      // Provider policy: 5% over its floor, priced per interval in 0.00005 ZEC steps. With the max undisclosed
      // providers bid this ask regardless; the buyer drops bids above its max locally, so the plan is the same.
      const raw = (toZats(p.minPricePerHourZats) * 105n * BigInt(fx.INTERVAL_S)) / (100n * 3600n);
      const ppi = ((raw + 4999n) / 5000n) * 5000n;
      const perHour = (ppi * 3600n) / BigInt(fx.INTERVAL_S);
      if (perHour > this.max) continue;
      plans.push({
        p,
        ppi,
        perHour,
        intervalS: fx.INTERVAL_S,
        delayMs: delays[plans.length] ?? 15_000,
        payTo: this.w.rng.ua(),
        providerEph: this.w.rng.hex(32),
        height: null,
      });
    }
    return plans;
  }

  // --- emit -----------------------------------------------------------------

  private emit(): void {
    this.dto.spentZats = this.spent.toString();
    this.dto.feesZats = this.fees.toString();
    this.dto.paymentsWithheld = !this.paying;
    actions.upsertRfq(structuredClone(this.dto));
  }

  private emitJob(): void {
    if (!this.job) return;
    this.job.heartbeatsStopped = !this.heartbeatsOn;
    this.job.feesZats = this.providerFees.toString();
    if (this.accepted) this.job.intervals = this.maxSeq + 1;
    this.job.watchdog = { state: this.watchdog.state, paidThroughSeq: this.winnerPaidThrough, ...(this.watchdog.deadlineAt ? { deadlineAt: this.watchdog.deadlineAt } : {}) };
    actions.upsertJob(structuredClone(this.job));
  }

  private requestLabel(): string {
    return `${this.req.count}× ${gpuLabel(this.req.gpu)} · ${formatDuration(this.req.durationS)}`;
  }

  // --- 1. broadcast -----------------------------------------------------------

  submit(t: number): void {
    this.emit();
    this.w.obs('relay', t, 'directory-read', `GET /directory from ${fx.BUYER_IP}`, [
      know('Client IP', fx.BUYER_IP, ['buyer_ip']),
      plain('Request', 'GET /directory'),
      plain('Query', 'none: the full list is downloaded'),
      plain('Response', `${this.w.directory.length} signed provider entries (public)`),
    ]);
    this.s.at(t + 650, (tt) => this.broadcast(tt));
  }

  private broadcast(t: number): void {
    if (this.phase === 'closed') return;
    const n = this.asked.length;
    const padded = paddedOutputsFor(n);
    const tx = this.w.sendTx(this.s, t, padded, (_h, tm) => {
      if (this.personaAsked) this.s.at(tm + 400, (tt) => this.providerGetsRfq(tt, tx.view.txid));
    });
    const fee = toZats(tx.view.feeZats);
    this.fees += fee;
    this.w.buyerSpend(fee);
    this.dto.rfqTxid = tx.view.txid;
    this.dto.paddedOutputs = padded;
    this.dto.state = 'collecting';
    this.w.obs(
      'buyer',
      t,
      'tx-broadcast',
      `RFQ sent to ${n} providers in one shielded transaction (${padded} outputs)`,
      [
        know('Request', this.requestLabel()),
        know('Max price', this.disclose ? `${perHourStr(this.max)} (disclosed to every provider asked)` : `${perHourStr(this.max)}: withheld from providers (the memo says 0 = undisclosed)`, ['price']),
        know('Recipients', this.asked.map((p) => p.alias).join(', '), ['provider_identity']),
        know('Paid from', this.w.buyerAddress, ['buyer_identity']),
        plain('Outputs', `${padded}: ${n} to providers + ${padded - n} padding and change`),
        plain('Reply-to (one-time)', this.replyTo),
        plain('Per-RFQ key', this.buyerKey),
        plain('txid', tx.view.txid),
        plain('Fee', formatZec(fee)),
      ],
      { rfqId: this.id, txid: tx.view.txid },
    );
    this.emit();
    for (const plan of this.plans) this.s.at(t + plan.delayMs, (tt) => this.providerBids(tt, plan));
    const rule = this.req.autoAccept;
    if (rule) this.s.at(t + Math.max(1, rule.waitBlocks) * fx.BLOCK_MS + 1500, (tt) => this.autoAccept(tt));
    this.s.at(this.w.timeOfHeight(this.dto.expiresHeight), (tt) => this.expire(tt));
  }

  private providerGetsRfq(t: number, txid: string): void {
    this.w.obs(
      'provider',
      t,
      'memo-received',
      'RFQ memo decrypted from a shielded transaction',
      [
        know('Request', this.requestLabel()),
        this.disclose ? know('Max price', perHourStr(this.max), ['price']) : sealed('Buyer budget', 'undisclosed: the RFQ carries no max; we bid our own price', ['price']),
        plain('Reply-to (one-time)', this.replyTo),
        plain('Buyer key (per-RFQ)', this.buyerKey),
        sealed('Sender', 'not in the transaction (Orchard hides it)', ['buyer_identity']),
        sealed('Buyer IP', 'none: arrived via the chain, not a connection', ['buyer_ip']),
        plain('txid', txid),
      ],
      { rfqId: this.id, txid },
    );
  }

  // --- 2. bids ---------------------------------------------------------------

  private providerBids(t: number, plan: BidPlan): void {
    // Providers bid even if the buyer already withdrew: they can't know. The buyer ignores late bids.
    const isPersona = plan.p === this.w.persona;
    const tx = this.w.sendTx(
      this.s,
      t,
      2,
      (h) => {
        plan.height = h;
        if (plan.bid) {
          plan.bid.height = h;
          this.emit();
        }
      },
      'received',
    );
    plan.txid = tx.view.txid;
    const fee = toZats(tx.view.feeZats);
    if (isPersona) {
      this.w.providerSpend(fee);
      this.providerFees += fee;
      this.job = {
        rfqId: this.id,
        state: 'bid',
        request: { ...this.dto.request },
        bid: { pricePerIntervalZats: plan.ppi.toString(), intervalS: plan.intervalS, txid: tx.view.txid },
        paymentsReceived: [],
        earnedZats: '0',
        servingSeq: 0,
        lastHeartbeatSeq: 0,
        logTail: [],
      };
      this.w.obs(
        'provider',
        t,
        'tx-broadcast',
        `Bid sent: ${zecString(plan.perHour)} ZEC/h (${zecString(plan.ppi)} ZEC per ${plan.intervalS} s)`,
        [
          know('Price', `${perHourStr(plan.perHour)} · ${formatZec(plan.ppi)} per ${plan.intervalS} s`, ['price']),
          plain('Priced against', this.disclose ? 'the max the RFQ disclosed' : 'our own ask (min + 5% markup); buyer budget: undisclosed'),
          know('Signed as', `${plan.p.alias} (${short(plan.p.providerId)})`, ['provider_identity']),
          plain('Pay-to (fresh)', plan.payTo),
          plain('Bond', plan.p.bondZats ? formatZec(plan.p.bondZats) : 'none'),
          plain('Sent to', this.replyTo),
          plain('txid', tx.view.txid),
          plain('Fee', formatZec(fee)),
        ],
        { rfqId: this.id, txid: tx.view.txid },
      );
      this.emitJob();
    }
    this.s.at(t + 900, (tt) => this.buyerGetsBid(tt, plan));
  }

  private buyerGetsBid(t: number, plan: BidPlan): void {
    if (this.dto.state !== 'collecting' || !plan.txid) return;
    const bid: BidDto = {
      providerId: plan.p.providerId,
      alias: plan.p.alias,
      pricePerIntervalZats: plan.ppi.toString(),
      intervalS: plan.intervalS,
      pricePerHourZats: plan.perHour.toString(),
      startWithinS: plan.p.startWithinS,
      ...(plan.p.bondZats ? { bondZats: plan.p.bondZats } : {}),
      receivedAt: t,
      txid: plan.txid,
      height: plan.height,
      signatureValid: true,
    };
    plan.bid = bid;
    this.dto.bids.push(bid);
    this.w.obs(
      'buyer',
      t,
      'memo-received',
      `Bid from ${plan.p.alias}: ${zecString(plan.perHour)} ZEC/h, signature valid`,
      [
        know('Provider', `${plan.p.alias} · ${short(plan.p.providerId)}`, ['provider_identity']),
        know('Price', `${perHourStr(plan.perHour)} · ${formatZec(plan.ppi)} per ${plan.intervalS} s`, ['price']),
        plain('Bond', plan.p.bondZats ? formatZec(plan.p.bondZats) : 'none'),
        plain('Start within', formatDuration(plan.p.startWithinS)),
        know('Pay-to address (fresh)', plan.payTo, ['provider_identity']),
        plain('Signature', `valid · directory key ${short(plan.p.providerId)}`),
        plain('Received at', `one-time reply address ${truncateMiddle(this.replyTo, 10, 6)}`),
        plain('txid', plan.txid),
      ],
      { rfqId: this.id, txid: plan.txid },
    );
    this.emit();
  }

  private autoAccept(t: number): void {
    if (this.dto.state !== 'collecting' || !this.req.autoAccept) return;
    const minBond = toZats(this.req.autoAccept.minBondZats ?? '0');
    const candidates = this.plans
      .filter((p) => p.bid && p.bid.signatureValid && toZats(p.p.bondZats) >= minBond)
      .sort((a, b) => (a.perHour < b.perHour ? -1 : a.perHour > b.perHour ? 1 : 0));
    const best = candidates[0];
    if (!best) {
      this.s.at(t + fx.BLOCK_MS, (tt) => this.autoAccept(tt));
      return;
    }
    this.accept(t, best.p.providerId, true);
  }

  private expire(t: number): void {
    if (this.dto.state === 'collecting') {
      this.phase = 'closed';
      this.dto.state = 'expired';
      this.dto.closedAt = t;
      this.w.obs('buyer', t, 'expired', `No bid accepted before height ${formatInt(this.dto.expiresHeight)}`, [
        plain('Bids received', String(this.dto.bids.length)),
        plain('Expiry height', formatInt(this.dto.expiresHeight)),
      ], { rfqId: this.id });
      this.emit();
    }
    if (this.job && this.job.state === 'bid') {
      this.job.state = 'lost';
      this.w.obs('provider', t, 'bid-expired', `No ACCEPT before height ${formatInt(this.dto.expiresHeight)}: bid lost`, [
        plain('Expiry height', formatInt(this.dto.expiresHeight)),
        sealed('Winner', 'not revealed to losing bidders', []),
      ], { rfqId: this.id });
      this.emitJob();
    }
  }

  // --- 3. accept -------------------------------------------------------------

  accept(t: number, providerId: string, auto: boolean): RfqExt {
    if (this.dto.state !== 'collecting') {
      throw new ApiError(`This request is ${this.dto.state}; bids can only be accepted while collecting`, 409, 'bad_state');
    }
    const plan = this.plans.find((p) => p.p.providerId === providerId && p.bid);
    if (!plan || !plan.bid) throw new ApiError('No bid from that provider', 404, 'not_found');
    this.accepted = plan;
    const intervals = Math.max(1, Math.ceil(this.req.durationS / plan.intervalS));
    this.maxSeq = intervals - 1;
    this.runMs = Math.min(fx.RUN_MS, intervals * plan.intervalS * 1000 - 3000);
    this.dto.accepted = { providerId, alias: plan.p.alias, pricePerIntervalZats: plan.ppi.toString(), intervalS: plan.intervalS, intervals };
    this.dto.state = 'accepted';
    const payment: PaymentDto = { seq: 0, kind: 'accept', zats: plan.ppi.toString(), feeZats: '0', txid: '', height: null, at: t };
    const tx = this.w.sendTx(this.s, t, 2, (h) => this.paymentMined(payment, h));
    const fee = toZats(tx.view.feeZats);
    payment.txid = tx.view.txid;
    payment.feeZats = fee.toString();
    this.dto.payments.push(payment);
    this.spent += plan.ppi;
    this.fees += fee;
    this.paidThrough = 0;
    this.w.buyerSpend(plan.ppi + fee);
    this.w.obs(
      'buyer',
      t,
      'tx-broadcast',
      `ACCEPT sent to ${plan.p.alias}; this transaction pays interval 0`,
      [
        know('Provider', plan.p.alias, ['provider_identity']),
        know('Price', `${formatZec(plan.ppi)} per ${plan.intervalS} s`, ['price']),
        know('Amount', `${formatZec(plan.ppi)} (interval 0)`, ['amount']),
        know('Paid from', this.w.buyerAddress, ['buyer_identity']),
        plain('Intervals', `up to ${intervals} × ${formatDuration(plan.intervalS)}`),
        plain('Channel key', `X25519 ${short(this.buyerEph)} → XChaCha20-Poly1305`),
        plain('Chosen by', auto ? `auto-accept rule (cheapest after ${this.req.autoAccept?.waitBlocks ?? 0} blocks)` : 'you'),
        plain('txid', tx.view.txid),
        plain('Fee', formatZec(fee)),
      ],
      { rfqId: this.id, txid: tx.view.txid },
    );
    this.emit();
    this.s.at(t + 1200, (tt) => this.winnerSeesPayment(tt, payment));
    // A losing bidder hears nothing: its bid simply expires (see expire()).
    this.s.at(t + 1500, (tt) => this.uploadJob(tt));
    return structuredClone(this.dto);
  }

  private paymentMined(payment: PaymentDto, h: number): void {
    payment.height = h;
    this.emit();
    if (this.job && this.personaWon) {
      const got = this.job.paymentsReceived.find((p) => p.seq === payment.seq);
      if (got) {
        got.height = h;
        this.w.providerSettle(toZats(got.zats));
        this.emitJob();
      }
    }
  }

  private uploadJob(t: number): void {
    if (this.phase === 'closed' || this.phase === 'finishing') return;
    const size = fx.DEMO_JOB.bundleBytes + 331;
    const cmd = joinArgv(this.req.job.command);
    this.w.obs(
      'buyer',
      t,
      'blob-stored',
      `Job sealed and uploaded to the relay (${formatBytes(size)})`,
      [
        know('Job folder', this.req.job.path, ['workload']),
        know('Command', cmd, ['workload']),
        know('Image', this.req.job.image ?? 'python:3.12-slim', ['workload']),
        plain('Sealed with', 'XChaCha20-Poly1305 (channel key)'),
        plain('Mailbox', this.mb.job),
        know('Your IP (seen by relay)', fx.BUYER_IP, ['buyer_ip']),
      ],
      { rfqId: this.id },
    );
    this.w.obs('relay', t + 60, 'blob-stored', `Stored ${formatBytes(size)} in mailbox ${short(this.mb.job)}`, [
      plain('Mailbox', this.mb.job),
      plain('Size', `${formatInt(size)} bytes`),
      sealed('Contents', this.w.rng.hex(32), ['workload']),
      know('Client IP', fx.BUYER_IP, ['buyer_ip']),
      sealed('Linked request', 'none: mailbox ids derive from the channel secret', []),
    ]);
    this.s.at(t + 1700, (tt) => this.fetchJob(tt, size));
  }

  private fetchJob(t: number, size: number): void {
    if (this.phase === 'closed' || this.phase === 'finishing') return;
    this.w.obs('relay', t, 'blob-fetched', `Mailbox ${short(this.mb.job)} read (${formatBytes(size)})`, [
      plain('Mailbox', this.mb.job),
      plain('Size', `${formatInt(size)} bytes`),
      know('Client IP', fx.PROVIDER_IP, []),
    ]);
    if (this.personaWon) {
      this.w.obs(
        'provider',
        t + 300,
        'job-started',
        'Job fetched from the relay, decrypted and started in the sandbox',
        [
          know('Command', joinArgv(this.req.job.command), ['workload']),
          know('Image', this.req.job.image ?? 'python:3.12-slim', ['workload']),
          know('Bundle', `${fx.DEMO_JOB.bundleFiles} files · ${formatBytes(fx.DEMO_JOB.bundleBytes)} · sha256 bc4c9b8e…437b`, ['workload']),
          plain('Sandbox', `docker · network none · ${this.req.count}× ${gpuLabel(this.req.gpu)}`),
          sealed('Buyer IP', 'not visible: the job came from the relay', ['buyer_ip']),
          sealed('Buyer wallet', 'not revealed', ['buyer_identity']),
          know('Your IP (seen by relay)', fx.PROVIDER_IP, []),
        ],
        { rfqId: this.id },
      );
    }
    this.s.at(t + 600, (tt) => this.startRunning(tt));
  }

  // --- 4. running ------------------------------------------------------------

  private get intervalMs(): number {
    return (this.accepted?.intervalS ?? fx.INTERVAL_S) * 1000;
  }

  private startRunning(t: number): void {
    if (this.phase !== 'open') return;
    this.phase = 'running';
    this.startedAt = t;
    this.payBaseAt = t;
    this.lastTickAt = t;
    this.dto.state = 'running';
    if (this.job && this.personaWon) {
      this.job.state = 'running';
      this.job.startedAt = t;
      this.job.servingSeq = 0;
      this.emitJob();
    }
    this.schedulePay(1);
    this.emit();
    this.s.at(t + 300, (tt) => this.logTick(tt));
    this.s.at(t + 1000, (tt) => this.heartbeat(tt));
    this.lastHeartbeatAt = t;
    this.s.at(t + 2000, (tt) => this.buyerWatch(tt));
    if (this.maxSeq >= 1) this.s.at(t + this.intervalMs, (tt) => this.serve(tt, 1));
  }

  private advance(t: number): void {
    if (!this.paused) this.progressMs += Math.max(0, t - this.lastTickAt);
    this.lastTickAt = t;
  }

  private get step(): number {
    return Math.min(fx.TOTAL_STEPS, Math.round((fx.TOTAL_STEPS * this.progressMs) / this.runMs));
  }

  private schedulePay(k: number): void {
    if (k > this.maxSeq) {
      delete this.dto.nextPaymentAt;
      return;
    }
    // The buyer's own clock, shortly before interval k starts, with jitter: never the provider's progress reports.
    const jitter = this.w.rng.int(-600, 600);
    const due = Math.max(this.s.now() + 300, this.payBaseAt + k * this.intervalMs - 2000 + jitter);
    this.dto.nextPaymentAt = due;
    this.payTimer = this.s.at(due, (tt) => this.pay(tt, k));
  }

  private pay(t: number, k: number): void {
    this.payTimer = null;
    if (this.phase !== 'running' || !this.accepted) return;
    if (!this.paying) {
      this.emit();
      return; // fault injection: the buyer simply doesn't pay; the provider's watchdog reacts
    }
    const plan = this.accepted;
    const payment: PaymentDto = { seq: k, kind: 'pay', zats: plan.ppi.toString(), feeZats: '0', txid: '', height: null, at: t };
    const tx = this.w.sendTx(this.s, t, 2, (h) => this.paymentMined(payment, h));
    const fee = toZats(tx.view.feeZats);
    payment.txid = tx.view.txid;
    payment.feeZats = fee.toString();
    this.dto.payments.push(payment);
    this.spent += plan.ppi;
    this.fees += fee;
    this.paidThrough = k;
    this.w.buyerSpend(plan.ppi + fee);
    this.w.obs(
      'buyer',
      t,
      'tx-broadcast',
      `PAY #${k} sent: ${zecString(plan.ppi)} ZEC to ${plan.p.alias}`,
      [
        know('Amount', formatZec(plan.ppi), ['amount']),
        know('To', plan.p.alias, ['provider_identity']),
        know('To (provider pay-to)', plan.payTo, ['provider_identity']),
        know('Paid from', this.w.buyerAddress, ['buyer_identity']),
        plain('Interval', `${k} of ${this.maxSeq + 1}`),
        plain('txid', tx.view.txid),
        plain('Fee', formatZec(fee)),
      ],
      { rfqId: this.id, txid: tx.view.txid },
    );
    this.schedulePay(k + 1);
    this.emit();
    this.s.at(t + 1200, (tt) => this.winnerSeesPayment(tt, payment));
  }

  setPaying(t: number, paying: boolean): void {
    if (this.phase !== 'running') throw new ApiError('Only a running job has payments to pause', 409, 'bad_state');
    if (this.paying === paying) return;
    this.paying = paying;
    this.w.obs(
      'buyer',
      t,
      'local',
      paying ? 'Payments resumed' : 'Stopped paying (mock fault injection)',
      [plain('Paid through interval', String(this.paidThrough)), plain('Next due', paying ? `PAY #${this.paidThrough + 1} now` : 'never, until resumed')],
      { rfqId: this.id },
    );
    if (paying && this.payTimer === null && this.paidThrough < this.maxSeq) {
      const k = this.paidThrough + 1;
      // Pay the overdue interval now, then continue one interval apart from here.
      this.payBaseAt = t + 2300 - k * this.intervalMs;
      this.payTimer = this.s.at(t + 300, (tt) => this.pay(tt, k));
    }
    this.emit();
  }

  private winnerSeesPayment(t: number, payment: PaymentDto): void {
    if (this.phase === 'closed' || !this.accepted) return;
    this.winnerPaidThrough = Math.max(this.winnerPaidThrough, payment.seq);
    if (this.job && this.personaWon) {
      if (payment.kind === 'accept') this.job.state = 'won';
      // The fee is the buyer's; the receiver's copy carries none (as the real daemon reports).
      this.job.paymentsReceived.push({ ...payment, feeZats: '0' });
      this.job.earnedZats = (toZats(this.job.earnedZats) + toZats(payment.zats)).toString();
      this.w.providerEarn(toZats(payment.zats), payment.height !== null);
      this.w.obs(
        'provider',
        t,
        'memo-received',
        payment.kind === 'accept'
          ? `Bid accepted; interval 0 paid (${zecString(payment.zats)} ZEC)`
          : `PAY #${payment.seq} received: ${zecString(payment.zats)} ZEC`,
        [
          know('Amount', formatZec(payment.zats), ['amount']),
          ...(payment.kind === 'accept'
            ? [
                know('Price', `${formatZec(this.accepted.ppi)} per ${this.accepted.intervalS} s`, ['price']),
                plain('Intervals', `up to ${this.maxSeq + 1} × ${formatDuration(this.accepted.intervalS)}`),
                plain('Buyer key', `${short(this.buyerKey)} (matches the RFQ)`),
              ]
            : [plain('Watchdog', `paid through interval ${this.winnerPaidThrough}`)]),
          sealed('Sender', 'not in the transaction (Orchard hides it)', ['buyer_identity']),
          plain('txid', payment.txid),
        ],
        { rfqId: this.id, txid: payment.txid },
      );
    }
    if (this.waitingSeq !== null && this.winnerPaidThrough >= this.waitingSeq) this.resume(t, this.waitingSeq);
    this.emitJob();
  }

  /** The start of interval k: serve it if paid, otherwise start the grace window. */
  private serve(t: number, k: number): void {
    if (this.phase !== 'running') return;
    if (this.winnerPaidThrough >= k) {
      this.servingSeq = k;
      this.watchdog = { state: 'paid_ahead' };
      if (this.job && this.personaWon) this.job.servingSeq = k;
      this.emitJob();
      if (k + 1 <= this.maxSeq) this.s.at(t + this.intervalMs, (tt) => this.serve(tt, k + 1));
      return;
    }
    const graceMs = this.w.policy.graceS * 1000;
    this.waitingSeq = k;
    this.watchdog = { state: 'grace', deadlineAt: t + graceMs };
    this.pushLog(t, [`[watchdog] PAY #${k} not seen at interval start; grace ${this.w.policy.graceS} s`]);
    this.emitJob();
    this.s.at(t + graceMs, (tt) => this.graceOver(tt, k));
  }

  private graceOver(t: number, k: number): void {
    if (this.phase !== 'running' || this.waitingSeq !== k) return;
    const graceMs = this.w.policy.graceS * 1000;
    this.advance(t);
    this.paused = true;
    this.watchdog = { state: 'paused', deadlineAt: t + graceMs };
    if (this.job && this.personaWon) this.job.state = 'paused';
    this.pushLog(t, [`[watchdog] still no PAY #${k}: paused at checkpoint (step ${this.step}); stopping in ${this.w.policy.graceS} s`]);
    this.emitJob();
    this.emit();
    this.s.at(t + graceMs, (tt) => this.unpaidStop(tt, k));
  }

  private resume(t: number, k: number): void {
    this.advance(t);
    this.waitingSeq = null;
    const wasPaused = this.paused;
    this.paused = false;
    this.servingSeq = k;
    this.watchdog = { state: 'paid_ahead' };
    if (this.job && this.personaWon) {
      this.job.state = 'running';
      this.job.servingSeq = k;
    }
    this.pushLog(t, [`[watchdog] PAY #${k} arrived; ${wasPaused ? 'resuming from checkpoint' : 'serving interval'} ${k}`]);
    if (k + 1 <= this.maxSeq) this.s.at(t + this.intervalMs, (tt) => this.serve(tt, k + 1));
    this.emit();
  }

  private unpaidStop(t: number, k: number): void {
    if (this.phase !== 'running' || this.waitingSeq !== k) return;
    this.phase = 'finishing';
    if (this.payTimer !== null) this.s.cancel(this.payTimer);
    this.payTimer = null;
    const served = k - 1;
    this.pushLog(t, [`[watchdog] PAY #${k} missing after ${this.w.policy.graceS * 2} s: job stopped. Paid and served: intervals 0–${served}.`]);
    const tx = this.w.sendTx(this.s, t, 2, undefined, 'received');
    if (this.job && this.personaWon) {
      this.w.providerSpend(toZats(tx.view.feeZats));
      this.providerFees += toZats(tx.view.feeZats);
      this.job.state = 'stopped';
      this.job.stopReason = 'unpaid';
      this.job.stoppedAt = t;
      this.w.obs(
        'provider',
        t,
        'tx-broadcast',
        'CLOSE sent: payment missed, job stopped',
        [
          plain('Reason', 'unpaid'),
          plain('Final interval', String(served)),
          know('Earned', `${formatZec(this.job.earnedZats)} for ${served + 1} intervals`, ['amount']),
          plain('Sent to', this.replyTo),
          plain('txid', tx.view.txid),
        ],
        { rfqId: this.id, txid: tx.view.txid },
      );
    }
    this.emitJob();
    this.s.at(t + 1500, (tt) => {
      this.w.obs(
        'buyer',
        tt,
        'memo-received',
        `CLOSE from ${this.accepted?.p.alias ?? 'provider'}: stopped for non-payment`,
        [
          plain('Reason', 'unpaid'),
          plain('Final interval', String(served)),
          plain('Signature', 'valid'),
          know('Exposure', `${formatZec(this.accepted?.ppi ?? 0n)} prepaid (at most about one interval ahead)`, ['amount']),
          plain('txid', tx.view.txid),
        ],
        { rfqId: this.id, txid: tx.view.txid },
      );
      this.dto.state = 'closing';
      delete this.dto.nextPaymentAt;
      this.emit();
    });
    this.s.at(t + 2800, (tt) => this.close(tt, 'unpaid'));
  }

  private heartbeat(t: number): void {
    if (this.phase !== 'running') return;
    this.advance(t);
    if (!this.heartbeatsOn) {
      // Fault injection: the provider keeps working but withholds heartbeats.
      this.s.at(t + fx.HEARTBEAT_MS, (tt) => this.heartbeat(tt));
      return;
    }
    this.hbSeq++;
    const hb: HeartbeatDto = {
      seq: this.hbSeq,
      at: t,
      step: this.step,
      status: this.paused ? 'paused' : this.hbSeq === 1 ? 'starting' : 'running',
      servingSeq: this.servingSeq,
      checkpointDigest: this.checkpoint,
      ...(this.paused && this.waitingSeq !== null ? { note: `waiting for PAY #${this.waitingSeq}` } : {}),
    };
    this.pushHeartbeat(t, hb);
    this.s.at(t + fx.HEARTBEAT_MS, (tt) => this.heartbeat(tt));
  }

  private pushHeartbeat(t: number, hb: HeartbeatDto): void {
    this.lastHeartbeatAt = t;
    this.dto.heartbeats.unshift(hb);
    if (this.dto.heartbeats.length > 60) this.dto.heartbeats.length = 60;
    if (this.job && this.personaWon) this.job.lastHeartbeatSeq = hb.seq;
    const size = 236 + this.w.rng.int(0, 8);
    this.w.obs('relay', t + 40, 'blob-stored', `Stored ${size} B in mailbox ${short(this.mb.heartbeat)}`, [
      plain('Mailbox', this.mb.heartbeat),
      plain('Size', `${size} bytes`),
      sealed('Contents', this.w.rng.hex(32), ['workload']),
      know('Client IP', fx.PROVIDER_IP, []),
    ]);
    this.w.obs(
      'buyer',
      t + 260,
      'heartbeat',
      `Heartbeat #${hb.seq} verified · step ${hb.step} · interval ${hb.servingSeq}`,
      [
        plain('Status', hb.note ? `${hb.status} (${hb.note})` : hb.status),
        plain('Progress', `step ${hb.step} of ${fx.TOTAL_STEPS}`),
        plain('Checkpoint', hb.checkpointDigest),
        plain('Signature', `valid (${this.accepted?.p.alias ?? 'provider'})`),
      ],
      { rfqId: this.id },
    );
    if (hb.seq % 2 === 0 || hb.status === 'finished') {
      this.w.obs('relay', t + 250, 'blob-fetched', `Mailbox ${short(this.mb.heartbeat)} read (${size} B)`, [
        plain('Mailbox', this.mb.heartbeat),
        plain('Size', `${size} bytes`),
        know('Client IP', fx.BUYER_IP, ['buyer_ip']),
      ]);
    }
    this.emitJob();
    this.emit();
  }

  private logTick(t: number): void {
    if (this.phase !== 'running') return;
    this.advance(t);
    if (this.progressMs >= this.runMs) {
      this.finish(t);
      return;
    }
    if (!this.paused) {
      const { text, step } = fx.logLine(this.logIdx++, this.progressMs, this.logRng);
      const lines = [text];
      if (step >= this.lastCheckpointStep + 150 && step < fx.TOTAL_STEPS) {
        this.lastCheckpointStep += 150;
        this.checkpoint = this.w.rng.hex(32);
        lines.push(fx.checkpointLine(this.progressMs, this.lastCheckpointStep, this.checkpoint));
      }
      this.pushLog(t, lines);
    }
    this.s.at(t + fx.LOG_MS, (tt) => this.logTick(tt));
  }

  private pushLog(t: number, lines: string[]): void {
    this.dto.logTail.push(...lines);
    if (this.dto.logTail.length > 200) this.dto.logTail.splice(0, this.dto.logTail.length - 200);
    if (this.job && this.personaWon) {
      this.job.logTail.push(...lines);
      if (this.job.logTail.length > 200) this.job.logTail.splice(0, this.job.logTail.length - 200);
    }
    this.logPending += lines.length;
    if (this.logPending >= 3) {
      const n = this.logPending;
      this.logPending = 0;
      const latest = lines[lines.length - 1] ?? '';
      const size = 120 * n + 40 + this.w.rng.int(0, 60);
      this.w.obs('relay', t + 30, 'blob-stored', `Stored ${formatBytes(size)} in mailbox ${short(this.mb.log)}`, [
        plain('Mailbox', this.mb.log),
        plain('Size', `${formatInt(size)} bytes`),
        sealed('Contents', this.w.rng.hex(32), ['workload']),
        know('Client IP', fx.PROVIDER_IP, []),
      ]);
      if (this.personaWon) {
        this.w.obs('provider', t, 'blob-stored', `Sealed ${n} log lines and sent them to the relay`, [
          know('Latest line', latest, ['workload']),
          plain('Mailbox', this.mb.log),
          know('Your IP (seen by relay)', fx.PROVIDER_IP, []),
        ], { rfqId: this.id });
      }
      this.w.obs('relay', t + 220, 'blob-fetched', `Mailbox ${short(this.mb.log)} read (${formatBytes(size)})`, [
        plain('Mailbox', this.mb.log),
        plain('Size', `${formatInt(size)} bytes`),
        know('Client IP', fx.BUYER_IP, ['buyer_ip']),
      ]);
      this.w.obs('buyer', t + 300, 'log-received', `Decrypted ${n} log lines`, [
        know('Latest line', latest, ['workload']),
        plain('Sealed size', `${formatInt(size)} bytes`),
        plain('Mailbox', this.mb.log),
      ], { rfqId: this.id });
    }
    this.emitJob();
    this.emit();
  }

  // --- 5. close ---------------------------------------------------------------

  private finish(t: number): void {
    if (this.phase !== 'running' || !this.accepted) return;
    this.phase = 'finishing';
    if (this.payTimer !== null) this.s.cancel(this.payTimer);
    this.payTimer = null;
    delete this.dto.nextPaymentAt;
    const plan = this.accepted;
    this.pushLog(t, fx.finishLines(this.progressMs));
    this.checkpoint = this.w.rng.hex(32);
    this.hbSeq++;
    this.pushHeartbeat(t, { seq: this.hbSeq, at: t, step: fx.TOTAL_STEPS, status: 'finished', servingSeq: this.servingSeq, checkpointDigest: this.checkpoint });
    const digest = this.w.rng.hex(32);
    const size = fx.DEMO_JOB.resultBytes;
    this.w.obs('relay', t + 400, 'blob-stored', `Stored ${formatBytes(size)} in mailbox ${short(this.mb.result)}`, [
      plain('Mailbox', this.mb.result),
      plain('Size', `${formatInt(size)} bytes`),
      sealed('Contents', this.w.rng.hex(32), ['workload']),
      know('Client IP', fx.PROVIDER_IP, []),
    ]);
    const tx = this.w.sendTx(this.s, t + 600, 2, undefined, 'received');
    const finalSeq = this.servingSeq;
    if (this.job && this.personaWon) {
      this.w.providerSpend(toZats(tx.view.feeZats));
      this.providerFees += toZats(tx.view.feeZats);
      this.job.resultDigest = digest;
      this.w.obs('provider', t + 400, 'blob-stored', `Result sealed and uploaded (${formatBytes(size)})`, [
        know('Files', fx.DEMO_JOB.resultFiles, ['workload']),
        plain('Digest', digest),
        plain('Mailbox', this.mb.result),
      ], { rfqId: this.id });
      this.job.state = 'done';
      this.job.stopReason = 'done';
      this.job.stoppedAt = t + 600;
      this.w.obs(
        'provider',
        t + 600,
        'tx-broadcast',
        'CLOSE sent: job finished, result ready',
        [
          plain('Reason', 'done'),
          plain('Final interval', String(finalSeq)),
          plain('Result digest', digest),
          know('Earned', `${formatZec(this.job.earnedZats)} for ${this.job.paymentsReceived.length} intervals`, ['amount']),
          plain('Sent to', this.replyTo),
          plain('txid', tx.view.txid),
        ],
        { rfqId: this.id, txid: tx.view.txid },
      );
    }
    this.emitJob();
    this.emit();
    this.s.at(t + 2100, (tt) => {
      this.w.obs(
        'buyer',
        tt,
        'memo-received',
        `CLOSE from ${plan.p.alias}: job finished, result ready`,
        [
          plain('Reason', 'done'),
          plain('Final interval', String(finalSeq)),
          plain('Result digest', digest),
          plain('Signature', `valid (${plan.p.alias})`),
          plain('txid', tx.view.txid),
        ],
        { rfqId: this.id, txid: tx.view.txid },
      );
      this.dto.state = 'closing';
      this.emit();
    });
    this.s.at(t + 3300, (tt) => {
      this.w.obs('relay', tt, 'blob-fetched', `Mailbox ${short(this.mb.result)} read (${formatBytes(size)})`, [
        plain('Mailbox', this.mb.result),
        plain('Size', `${formatInt(size)} bytes`),
        know('Client IP', fx.BUYER_IP, ['buyer_ip']),
      ]);
      this.w.obs('buyer', tt + 500, 'result-fetched', 'Result downloaded and decrypted; digest matches CLOSE', [
        know('Files', fx.DEMO_JOB.resultFiles, ['workload']),
        plain('Size', formatBytes(size)),
        plain('Digest', digest),
        know('Your IP (seen by relay)', fx.BUYER_IP, ['buyer_ip']),
      ], { rfqId: this.id });
    });
    this.s.at(t + 4200, (tt) => this.close(tt, 'done', { digest, sizeBytes: size }));
  }

  setHeartbeats(t: number, on: boolean): void {
    if (this.phase !== 'running') throw new ApiError('Only a running job sends heartbeats', 409, 'conflict');
    if (this.heartbeatsOn === on) return;
    this.heartbeatsOn = on;
    if (this.job && this.personaWon) {
      this.w.obs('provider', t, 'local', on ? 'Heartbeats resumed' : 'Withholding heartbeats (demo fault injection)', [
        plain('Last heartbeat sent', `#${this.hbSeq}`),
        plain('Buyer reaction', on ? 'payments continue' : `stops paying after ${fx.HEARTBEAT_TIMEOUT_MS / 1000} s without one`),
      ], { rfqId: this.id });
    }
    if (on) this.lastHeartbeatAt = Math.max(this.lastHeartbeatAt, t - fx.HEARTBEAT_MS);
    this.emitJob();
  }

  /** The buyer's side of the bargain: no heartbeats, no payments. */
  private buyerWatch(t: number): void {
    if (this.phase !== 'running') return;
    if (t - this.lastHeartbeatAt > fx.HEARTBEAT_TIMEOUT_MS) {
      this.buyerNoHeartbeat(t);
      return;
    }
    this.s.at(t + 2000, (tt) => this.buyerWatch(tt));
  }

  private buyerNoHeartbeat(t: number): void {
    this.phase = 'finishing';
    if (this.payTimer !== null) this.s.cancel(this.payTimer);
    this.payTimer = null;
    const plan = this.accepted;
    const tx = this.w.sendTx(this.s, t, 2);
    const fee = toZats(tx.view.feeZats);
    this.fees += fee;
    this.w.buyerSpend(fee);
    this.w.obs(
      'buyer',
      t,
      'tx-broadcast',
      `No heartbeat for ${Math.round((t - this.lastHeartbeatAt) / 1000)} s: stopped paying and sent CLOSE`,
      [
        plain('Reason', 'no_heartbeat'),
        plain('Last interval paid', String(this.paidThrough)),
        know('To', plan?.p.alias ?? 'provider', ['provider_identity']),
        know('Exposure', `${formatZec(plan?.ppi ?? 0n)} prepaid (at most about one interval ahead)`, ['amount']),
        plain('txid', tx.view.txid),
      ],
      { rfqId: this.id, txid: tx.view.txid },
    );
    this.dto.state = 'closing';
    delete this.dto.nextPaymentAt;
    this.emit();
    this.s.at(t + 1300, (tt) => {
      this.pushLog(tt, [`[runner] CLOSE from buyer (no heartbeat): stopping after interval ${this.paidThrough}`]);
      if (this.job && this.personaWon) {
        this.job.state = 'stopped';
        this.job.stopReason = 'no_heartbeat';
        this.job.stoppedAt = tt;
        this.w.obs('provider', tt, 'memo-received', 'CLOSE received: the buyer saw no heartbeats', [
          plain('Reason', 'no_heartbeat'),
          plain('Final interval', String(this.paidThrough)),
          sealed('Sender', 'not in the transaction (Orchard hides it)', ['buyer_identity']),
          plain('txid', tx.view.txid),
        ], { rfqId: this.id, txid: tx.view.txid });
        this.emitJob();
      }
    });
    this.s.at(t + 2600, (tt) => this.close(tt, 'no_heartbeat'));
  }

  stopByProvider(t: number): void {
    if (!this.personaWon || !this.job) throw new ApiError('This provider is not serving that job', 409, 'conflict');
    if (this.phase !== 'running' && this.phase !== 'open') throw new ApiError(`The job is already ${this.job.state}`, 409, 'conflict');
    if (this.dto.state !== 'running' && this.dto.state !== 'accepted') throw new ApiError(`The job is already ${this.job.state}`, 409, 'conflict');
    this.phase = 'finishing';
    if (this.payTimer !== null) this.s.cancel(this.payTimer);
    this.payTimer = null;
    const served = this.servingSeq;
    this.pushLog(t, [`[runner] stopped by the provider after interval ${served}`]);
    const tx = this.w.sendTx(this.s, t, 2, undefined, 'received');
    this.w.providerSpend(toZats(tx.view.feeZats));
    this.providerFees += toZats(tx.view.feeZats);
    this.job.state = 'stopped';
    this.job.stopReason = 'provider_stop';
    this.job.stoppedAt = t;
    this.w.obs('provider', t, 'tx-broadcast', 'CLOSE sent: you stopped the job', [
      plain('Reason', 'provider_stop'),
      plain('Final interval', String(served)),
      know('Earned', `${formatZec(this.job.earnedZats)} for ${this.job.paymentsReceived.length} intervals`, ['amount']),
      plain('Sent to', this.replyTo),
      plain('txid', tx.view.txid),
    ], { rfqId: this.id, txid: tx.view.txid });
    this.emitJob();
    this.s.at(t + 1500, (tt) => {
      this.w.obs('buyer', tt, 'memo-received', `CLOSE from ${this.accepted?.p.alias ?? 'provider'}: the provider stopped the job`, [
        plain('Reason', 'provider_stop'),
        plain('Final interval', String(served)),
        plain('Signature', 'valid'),
        plain('txid', tx.view.txid),
      ], { rfqId: this.id, txid: tx.view.txid });
      this.dto.state = 'closing';
      delete this.dto.nextPaymentAt;
      this.emit();
    });
    this.s.at(t + 2800, (tt) => this.close(tt, 'provider_stop'));
  }

  stopByBuyer(t: number): RfqExt {
    const st = this.dto.state;
    if (st === 'closed' || st === 'expired' || st === 'failed' || st === 'closing') {
      throw new ApiError(`This request is already ${st}`, 409, 'bad_state');
    }
    if (st === 'broadcasting' || st === 'collecting') {
      this.phase = 'closed';
      this.dto.state = 'closed';
      this.dto.closeReason = 'buyer_stop';
      this.dto.closedAt = t;
      this.w.obs('buyer', t, 'local', 'Request withdrawn before accepting: no ACCEPT was sent', [
        plain('Bids received', String(this.dto.bids.length)),
        plain('On chain', 'nothing further; the bids simply expire'),
      ], { rfqId: this.id });
      this.emit();
      return structuredClone(this.dto);
    }
    // accepted or running: CLOSE to the provider's pay-to address
    this.phase = 'finishing';
    if (this.payTimer !== null) this.s.cancel(this.payTimer);
    this.payTimer = null;
    const plan = this.accepted;
    const tx = this.w.sendTx(this.s, t, 2);
    const fee = toZats(tx.view.feeZats);
    this.fees += fee;
    this.w.buyerSpend(fee);
    this.w.obs(
      'buyer',
      t,
      'tx-broadcast',
      `CLOSE sent to ${plan?.p.alias ?? 'provider'}: stopped by you`,
      [
        plain('Reason', 'buyer_stop'),
        plain('Final interval', String(this.paidThrough)),
        know('To', plan?.p.alias ?? 'provider', ['provider_identity']),
        plain('txid', tx.view.txid),
        plain('Fee', formatZec(fee)),
      ],
      { rfqId: this.id, txid: tx.view.txid },
    );
    this.dto.state = 'closing';
    delete this.dto.nextPaymentAt;
    this.emit();
    this.s.at(t + 1300, (tt) => {
      this.pushLog(tt, [`[runner] CLOSE from buyer: stopping after interval ${this.paidThrough}`]);
      if (this.job && this.personaWon) {
        this.job.state = 'stopped';
        this.job.stopReason = 'buyer_stop';
        this.job.stoppedAt = tt;
        this.w.obs(
          'provider',
          tt,
          'memo-received',
          'CLOSE received: buyer stopped the job',
          [
            plain('Reason', 'buyer_stop'),
            plain('Final interval', String(this.paidThrough)),
            sealed('Sender', 'not in the transaction (Orchard hides it)', ['buyer_identity']),
            plain('txid', tx.view.txid),
          ],
          { rfqId: this.id, txid: tx.view.txid },
        );
        this.emitJob();
      }
    });
    this.s.at(t + 2600, (tt) => this.close(tt, 'buyer_stop'));
    return structuredClone(this.dto);
  }

  private close(t: number, reason: CloseReason, result?: { digest: string; sizeBytes: number }): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.dto.state = 'closed';
    this.dto.closeReason = reason;
    this.dto.closedAt = t;
    if (result) this.dto.result = result;
    delete this.dto.nextPaymentAt;
    this.watchdog = { state: 'paid_ahead' };
    const paid = this.dto.payments.length;
    this.w.obs(
      'buyer',
      t,
      'settled',
      `Settled: ${paid} intervals, ${zecString(this.spent)} ZEC + ${zecString(this.fees)} ZEC fees`,
      [
        know('Total paid', `${formatZec(this.spent)} to ${this.accepted?.p.alias ?? 'provider'}`, ['amount', 'provider_identity']),
        plain('Fees', formatZec(this.fees)),
        plain('Receipt', `.silicr/receipts/${this.id.slice(0, 8)}.json (this machine only)`),
      ],
      { rfqId: this.id },
    );
    this.emitJob();
    this.emit();
  }
}
