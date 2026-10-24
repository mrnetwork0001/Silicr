// Metered settlement is driven by the BUYER's clock. A provider can only delay payments.
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeMemo,
  deriveChannel,
  encodeHeartbeat,
  encodeMemo,
  generateSigner,
  generateX25519,
  signDirectoryEntry,
  type DecodedMemo,
  type Heartbeat,
  type Rfq,
  type Signer,
} from '@silicr/protocol';
import { InsufficientFundsError, toOrchardOnly, type Output, type ReceivedNote, type ZecBackend } from '@silicr/zec';
import { hex, sleep } from '../src/util.ts';
import { payLeadFor, maxExposureIntervals, MEMORY_PROFILE, FAST_PROFILE, TESTNET_PROFILE } from '../src/profile.ts';
import { perInterval } from '../src/zats.ts';
import { makeWorld, TEST_PROFILE, waitFor, type World } from './helpers.ts';

let world: World | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const job = (w: World) => ({ path: w.jobDir, command: ['python3', 'train.py'] });

async function sendRetry(backend: ZecBackend, outputs: Output[]): Promise<string> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return (await backend.send(outputs)).txid;
    } catch (e) {
      if (!(e instanceof InsufficientFundsError) || Date.now() > deadline) throw e;
      await sleep(30);
    }
  }
}

/** A provider that follows the protocol up to ACCEPT, then lies in its heartbeats. */
async function evilProvider(w: World) {
  const id = generateSigner();
  const wallet = w.network.wallet('evil', { fundZats: 100_000_000n });
  const providerId = hex(id.signer.publicKey);
  await w.relay.publishDirectory(
    signDirectoryEntry(
      {
        v: 1,
        providerId,
        alias: 'evil-eel-1',
        address: toOrchardOnly(await wallet.address(), 'memory'),
        gpus: [{ model: 'a100', count: 1, vramGb: 80 }],
        minPricePerHourZats: '36000000',
        updatedAt: Math.floor(Date.now() / 1000),
      },
      id.signer,
    ),
  );
  const seen = new Set<string>();
  const next = async (pred: (d: DecodedMemo) => boolean): Promise<{ note: ReceivedNote; d: DecodedMemo }> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const n of await wallet.poll(0)) {
        const key = `${n.txid}:${n.index}`;
        if (seen.has(key)) continue;
        const d = decodeMemo(n.memo);
        if (d && pred(d)) {
          seen.add(key);
          return { note: n, d };
        }
      }
      await sleep(20);
    }
    throw new Error('evil provider: timed out');
  };
  return { providerId, signer: id.signer as Signer, wallet, next };
}

/** RFQ → BID → ACCEPT with the evil provider; returns what it needs to forge heartbeats. */
async function acceptedByEvil(w: World, durationS: number, startWithinS = 5) {
  const evil = await evilProvider(w);
  const { rfqId } = await w.buyer.createRfq({
    gpu: 'a100',
    count: 1,
    durationS,
    maxPricePerHourZats: '72000000',
    job: job(w),
    providerIds: [evil.providerId],
    autoAccept: { rule: 'cheapest', waitBlocks: 0 },
  });
  const rfq = (await evil.next((d) => d.msg.t === 'RFQ')).d.msg as Rfq;
  const eph = generateX25519();
  const payTo = await evil.wallet.newAddress();
  const bid = { t: 'BID' as const, rfqId: rfq.rfqId, providerId: evil.signer.publicKey, pricePerIntervalZats: perInterval(36_000_000n, 1), intervalS: 1, startWithinS, providerEph: eph.publicKey, payTo };
  await sendRetry(evil.wallet, [{ to: rfq.replyTo, zats: 1n, memo: encodeMemo(bid, evil.signer, 'binary') }]);
  await evil.next((d) => d.msg.t === 'ACCEPT');
  const ch = deriveChannel(eph.secretKey, rfq.buyerEph, rfq.rfqId);
  let hbSeq = 0;
  const heartbeat = (status: Heartbeat['status'], servingSeq: number) => {
    hbSeq += 1;
    const hb: Heartbeat = { rfqId: rfq.rfqId, seq: hbSeq, ts: Date.now(), step: hbSeq * 100, checkpointDigest: new Uint8Array(32), status, servingSeq };
    return w.relay.append(ch.mailboxes.heartbeat, ch.seal('heartbeat', encodeHeartbeat(hb, evil.signer)));
  };
  return { rfqId, heartbeat };
}

describe('buyer-clock settlement (C1)', () => {
  it('a provider forging fast-advancing servingSeq is never paid ahead of the buyer clock', async () => {
    const w = (world = await makeWorld({ providers: [] }));
    const { rfqId, heartbeat } = await acceptedByEvil(w, 10); // 10 intervals of 1 s
    const I = 1000;
    const lead = payLeadFor(TEST_PROFILE, 1) * 1000; // 250 ms
    let stop = false;
    const flood = (async () => {
      // claims a new interval every 20 ms: the old engine paid all 10 intervals within ~0.3 s
      for (let i = 1; !stop; i++) {
        await heartbeat('running', Math.min(i, 9));
        await sleep(20);
      }
    })();
    const t0 = Date.now();
    let samples = 0;
    while (Date.now() - t0 < 3500) {
      const rec = w.buyer.record(rfqId)!;
      const paid = rec.payments.length;
      const now = Date.now();
      // total paid at every t ≤ 1 + floor((t − jobStart + lead) / I) intervals; before jobStart only interval 0
      const bound = rec.jobStart === undefined ? 1 : 1 + Math.max(0, Math.floor((now - rec.jobStart + lead) / I));
      expect(paid, `paid ${paid} intervals at t = ${now - (rec.jobStart ?? now)} ms after jobStart`).toBeLessThanOrEqual(bound);
      samples++;
      await sleep(10);
    }
    stop = true;
    await flood;
    expect(samples).toBeGreaterThan(100);
    const rec = w.buyer.record(rfqId)!;
    expect(rec.jobStart).toBeGreaterThanOrEqual(rec.accepted!.at);
    for (const p of rec.payments.filter((x) => x.seq > 0)) {
      // the clock gate held for every single payment, and no payment came before its window
      expect(p.at - (rec.jobStart! + p.seq * I - lead)).toBeGreaterThanOrEqual(0);
    }
    // 3.5 s in: at most 1 + floor((3.5 + 0.25) / 1) = 4 intervals (allowing one more for the tail of the loop)
    expect(rec.payments.length).toBeLessThanOrEqual(5);
    expect(rec.payments.length).toBeGreaterThanOrEqual(3); // still paid on schedule while it looks alive
  }, 30_000);

  it('pays nothing beyond interval 0 to a provider stuck in "starting", and closes no_heartbeat', async () => {
    const w = (world = await makeWorld({ providers: [] }));
    const { rfqId, heartbeat } = await acceptedByEvil(w, 10, 1);
    let stop = false;
    const flood = (async () => {
      while (!stop) {
        await heartbeat('starting', 5); // claims progress but never reports the job running
        await sleep(50);
      }
    })();
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 10_000);
    stop = true;
    await flood;
    const r = w.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('no_heartbeat');
    expect(r.payments.map((p) => p.seq)).toEqual([0]);
  }, 20_000);

  it('honest provider: each PAY goes out inside its window at a random point, before the provider boundary', async () => {
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', script: { steps: 90, stepMs: 100 } }],
      profile: { intervalS: 2, payLeadS: 0.5 },
    }));
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 30_000);
    const rec = w.buyer.record(rfqId)!;
    const I = 2000;
    const lead = 500;
    const pays = rec.payments.filter((p) => p.seq > 0);
    expect(pays.length).toBeGreaterThanOrEqual(3);
    const offsets = pays.map((p) => p.at - (rec.jobStart! + p.seq * I - lead));
    for (const o of offsets) {
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(lead / 2 + 250);
    }
    expect(new Set(offsets.map((o) => Math.round(o / 5))).size).toBeGreaterThan(1); // no fixed cadence
    // PAY(k) reached the provider before its boundary: it never had to pause
    expect(w.providers[0]!.listLeaks({ rfqId }).some((o) => o.event === 'watchdog' && /paused/.test(o.summary))).toBe(false);
    expect(rec.closeReason).toBe('done');
    const dto = w.buyer.getRfq(rfqId);
    expect(dto.payPolicy).toEqual({ leadS: 0.5, jitterMaxS: 0.25, maxExposureIntervals: 1.25 });
    expect(dto.jobStartedAt).toBe(rec.jobStart);
    expect(w.buyer.listLeaks({ rfqId }).some((o) => o.fields.some((f) => f.label === 'Send time' && /random/.test(f.value)))).toBe(true);
  }, 40_000);

  it('a PAY whose send result is lost after broadcast is not paid twice', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 45, stepMs: 100 } }] }));
    const inner = w.buyerBackend.send.bind(w.buyerBackend);
    let tripped = false;
    w.buyerBackend.send = async (outs: Output[]) => {
      const d = decodeMemo(outs[0]!.memo);
      if (!tripped && d?.msg.t === 'PAY' && d.msg.seq === 2) {
        tripped = true;
        await inner(outs); // it went out…
        throw new Error('sidecar timed out'); // …but we never heard back
      }
      return inner(outs);
    };
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 30_000);
    expect(tripped).toBe(true);
    const r = w.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('done');
    const seqs = r.payments.map((p) => p.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i)); // each interval once, in order
    expect(r.payments.find((p) => p.seq === 2)!.txid).toMatch(/unknown/);
    const pj = w.providers[0]!.getJob(rfqId);
    expect(pj.paymentsReceived.map((p) => p.seq)).toEqual(seqs); // the provider got exactly one PAY 2
    expect(w.providers[0]!.listLeaks({ rfqId }).some((o) => /already paid/.test(o.summary))).toBe(false);
  }, 40_000);

  it('a PAY that failed before broadcast is resent once the provider shows it is waiting', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 45, stepMs: 100 } }] }));
    const inner = w.buyerBackend.send.bind(w.buyerBackend);
    let tripped = false;
    w.buyerBackend.send = async (outs: Output[]) => {
      const d = decodeMemo(outs[0]!.memo);
      if (!tripped && d?.msg.t === 'PAY' && d.msg.seq === 2) {
        tripped = true;
        throw new Error('connection reset'); // ambiguous to the buyer; in fact nothing was sent
      }
      return inner(outs);
    };
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 30_000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('done');
    const seqs = r.payments.map((p) => p.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(seqs).toContain(2);
    // the provider paused waiting for PAY 2 and resumed when the resend arrived, within its grace
    const watch = w.providers[0]!.listLeaks({ rfqId }).filter((o) => o.event === 'watchdog').map((o) => o.summary);
    expect(watch.some((s) => /Interval 2 not paid/.test(s))).toBe(true);
    expect(watch.some((s) => /Interval 2 paid during grace/.test(s))).toBe(true);
  }, 40_000);
});

describe('exposure bound per profile', () => {
  it('is (I + lead) / I intervals: 1.25 on memory and fast, 1.2 on testnet', () => {
    expect(maxExposureIntervals(MEMORY_PROFILE)).toBe(1.25);
    expect(maxExposureIntervals(FAST_PROFILE)).toBe(1.25);
    expect(maxExposureIntervals(TESTNET_PROFILE)).toBe(1.2);
    expect(payLeadFor(TESTNET_PROFILE, 300)).toBe(60);
    // a provider bidding a shorter interval can't push the lead past I/4
    expect(maxExposureIntervals(TESTNET_PROFILE, 120)).toBe(1.25);
    expect(maxExposureIntervals(MEMORY_PROFILE, 1)).toBe(1.25);
  });
});

/** The provider's view of the chain: PAY(seq) is seen but never mined. */
function neverConfirms(seq: number) {
  return (inner: ZecBackend): ZecBackend => {
    const w = Object.create(inner) as ZecBackend;
    let pinned: ReceivedNote | null = null;
    w.poll = async (since: number) => {
      const out = (await inner.poll(since)).map((n) => {
        const d = decodeMemo(n.memo);
        if (d?.msg.t === 'PAY' && d.msg.seq === seq) return (pinned = { ...n, height: null });
        return n;
      });
      if (pinned && !out.some((n) => n.txid === pinned!.txid)) out.push(pinned);
      return out;
    };
    return w;
  };
}

/**
 * The provider's view of the chain: PAY(seq) shows up once, unconfirmed, then vanishes (evicted or
 * double-spent). The first sighting is always presented unmined: on the real memory chain the PAY
 * may already be mined by the provider's first poll, and then there'd be nothing to vanish.
 */
function vanishes(seq: number) {
  return (inner: ZecBackend): ZecBackend => {
    const w = Object.create(inner) as ZecBackend;
    let txid: string | null = null;
    w.poll = async (since: number) => {
      const out: ReceivedNote[] = [];
      for (const n of await inner.poll(since)) {
        const d = decodeMemo(n.memo);
        if (!(d?.msg.t === 'PAY' && d.msg.seq === seq)) out.push(n);
        else if (txid === null) {
          txid = n.txid;
          out.push({ ...n, height: null });
        } else if (n.txid !== txid) out.push(n);
      }
      return out;
    };
    return w;
  };
}

describe('provider: at most one unconfirmed payment outstanding (M5)', () => {
  it('a PAY that never confirms: the provider pauses at the next boundary, then stops with CLOSE(unpaid)', async () => {
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', script: { steps: 100_000, stepMs: 50 }, wrapBackend: neverConfirms(2), policy: { graceS: 4 } }],
    }));
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    const p = w.providers[0]!;
    // it may START interval 2 on the unconfirmed PAY(2)…
    await waitFor(() => p.getJob(rfqId).servingSeq === 2, 'serving interval 2', 15_000);
    expect(p.getJob(rfqId).watchdog).toMatchObject({ unconfirmedSeq: 2 });
    // …but not serve interval 3 until PAY(2) is mined
    await waitFor(() => p.getJob(rfqId).state === 'paused', 'pause', 10_000);
    const paused = p.getJob(rfqId);
    expect(paused.servingSeq).toBe(2);
    expect(paused.watchdog).toMatchObject({ state: 'paused', unconfirmedSeq: 2 });
    // PAY(3) arrives too, and still isn't enough while PAY(2) is unmined
    await waitFor(() => p.getJob(rfqId).paymentsReceived.some((x) => x.seq === 3), 'PAY 3 at the provider', 10_000);
    expect(['paused', 'stopped']).toContain(p.getJob(rfqId).state);
    expect(p.getJob(rfqId).servingSeq).toBe(2);
    await waitFor(() => p.getJob(rfqId).state === 'stopped', 'stop', 15_000);
    expect(p.getJob(rfqId).stopReason).toBe('unpaid');
    const watch = p.listLeaks({ rfqId }).filter((o) => o.event === 'watchdog').map((o) => o.summary);
    expect(watch.some((x) => /PAY for interval 2 is still unconfirmed/.test(x))).toBe(true);
    expect(watch.some((x) => /never mined/.test(x))).toBe(true);
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'buyer close', 8000);
    expect(w.buyer.getRfq(rfqId).closeReason).toBe('unpaid');
  }, 40_000);

  it('a PAY that vanishes before it is mined stops the job', async () => {
    const w = (world = await makeWorld({
      // grace far longer than vanish detection (~2 s), so the stop can only come from the vanished payment
      providers: [{ name: 'p1', script: { steps: 100_000, stepMs: 50 }, wrapBackend: vanishes(2), policy: { graceS: 20 } }],
    }));
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    const p = w.providers[0]!;
    // the provider acted on the unconfirmed PAY(2)…
    await waitFor(() => w.providers[0]!.listLeaks({ rfqId }).some((o) => /PAY received for interval 2/.test(o.summary)), 'PAY 2 at the provider', 15_000);
    // …and stops once it's gone
    await waitFor(() => p.getJob(rfqId).state === 'stopped', 'stop', 15_000);
    const pj = p.getJob(rfqId);
    expect(pj.stopReason).toBe('unpaid');
    expect(pj.paymentsReceived.some((x) => x.seq === 2)).toBe(false); // the vanished payment isn't counted as earned
    expect(p.listLeaks({ rfqId }).some((o) => /disappeared before it was mined/.test(o.summary))).toBe(true);
    expect(pj.servingSeq).toBeLessThanOrEqual(2); // never served past the interval the vanished PAY was for
  }, 40_000);

  it('the watchdog view tracks paid-ahead and grace states with deadlines', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 40, stepMs: 100 } }] }));
    const states = new Set<string>();
    let sawDeadline = false;
    w.providers[0]!.on((e) => {
      if (e.type !== 'job.updated' || !e.job.watchdog) return;
      states.add(e.job.watchdog.state);
      if (e.job.watchdog.state === 'grace' && typeof e.job.watchdog.deadlineAt === 'number') sawDeadline = true;
      expect(e.job.watchdog.paidThroughSeq).toBeGreaterThanOrEqual(0);
    });
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 20_000);
    expect(states.has('grace')).toBe(true);
    expect(states.has('paid_ahead')).toBe(true);
    expect(sawDeadline).toBe(true);
    expect(w.providers[0]!.getJob(rfqId).watchdog).toBeUndefined(); // done: no watchdog
  }, 30_000);
});
