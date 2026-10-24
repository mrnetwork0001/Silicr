// Fault handling: each side limits its loss to one interval, and forged messages are ignored.
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeMemo, encodeMemo, generateSigner, generateX25519, signerFromSecret, type Bid, type MemoMessage, type Signer } from '@silicr/protocol';
import { InsufficientFundsError, type Output, type ZecBackend } from '@silicr/zec';
import { unhex } from '../src/util.ts';
import { makeWorld, TEST_PROFILE, unbundle, waitFor, type World } from './helpers.ts';

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
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function sendMemo(from: ZecBackend, to: string, msg: MemoMessage, signer: Signer, zats = 1n): Promise<string> {
  return sendRetry(from, [{ to, zats, memo: encodeMemo(msg, signer, 'binary') }]);
}

async function providerSigner(w: World, name: string): Promise<Signer> {
  return signerFromSecret(new Uint8Array(await readFile(join(w.root, name, 'identity.key'))));
}

async function startRunning(w: World, durationS = 120): Promise<string> {
  const { rfqId } = await w.buyer.createRfq({
    gpu: 'a100',
    count: 1,
    durationS,
    maxPricePerHourZats: '72000000',
    job: job(w),
    autoAccept: { rule: 'cheapest', waitBlocks: 1 },
  });
  await waitFor(() => w.buyer.getRfq(rfqId).payments.some((p) => p.seq === 1), 'PAY 1', 10_000);
  return rfqId;
}

describe('metered settlement faults', () => {
  it('buyer stops paying → provider pauses at the boundary, then stops with CLOSE(unpaid) within grace', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 100_000, stepMs: 50 } }] }));
    const rfqId = await startRunning(w);
    w.buyer.fault(rfqId, 'stop_paying');
    expect(w.buyer.getRfq(rfqId).paymentsWithheld).toBe(true);
    const p = w.providers[0]!;
    await waitFor(() => p.getJob(rfqId).state === 'paused', 'provider pause', 5000, 10);
    const pausedAt = Date.now();
    const handle = w.runners[0]!.handles[0]!;
    expect(handle.paused).toBe(true);
    await waitFor(() => p.getJob(rfqId).state === 'stopped', 'provider stop', 5000, 10);
    const stoppedAt = Date.now();
    const graceMs = TEST_PROFILE.graceS * 1000;
    expect(stoppedAt - pausedAt).toBeGreaterThan(graceMs - 300);
    expect(stoppedAt - pausedAt).toBeLessThan(graceMs + 1500);
    const pj = p.getJob(rfqId);
    expect(pj.stopReason).toBe('unpaid');
    expect(handle.pauses).toBeGreaterThanOrEqual(1);
    expect(handle.stoppedBy).toBe('unpaid');
    // it served exactly the intervals it was paid for
    const paidSeqs = pj.paymentsReceived.map((x) => x.seq);
    expect(pj.servingSeq).toBe(Math.max(...paidSeqs));
    // the buyer hears CLOSE(unpaid) and ends the deal
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'buyer close', 8000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('unpaid');
    expect(r.result).toBeUndefined();
    expect(w.providers[0]!.listLeaks({ rfqId }).filter((o) => o.event === 'watchdog').length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('resumes the job when the late payment arrives during grace', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 100_000, stepMs: 50 } }], profile: { graceS: 3 } }));
    const rfqId = await startRunning(w);
    w.buyer.fault(rfqId, 'stop_paying');
    const p = w.providers[0]!;
    await waitFor(() => p.getJob(rfqId).state === 'paused', 'provider pause', 5000, 10);
    const servingWhenPaused = p.getJob(rfqId).servingSeq;
    w.buyer.fault(rfqId, 'resume_paying');
    await waitFor(() => p.getJob(rfqId).state === 'running' && p.getJob(rfqId).servingSeq === servingWhenPaused + 1, 'resume', 5000, 10);
    expect(w.runners[0]!.handles[0]!.paused).toBe(false);
    await w.buyer.stop(rfqId);
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 10_000);
  }, 30_000);

  it('provider stops heartbeating → buyer stops paying and closes no_heartbeat', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 100_000, stepMs: 50 } }] }));
    const rfqId = await startRunning(w);
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'running', 'running');
    w.providers[0]!.fault(rfqId, 'stop_heartbeats');
    const t0 = Date.now();
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'buyer close', 6000, 10);
    expect(Date.now() - t0).toBeLessThan((TEST_PROFILE.heartbeatTimeoutS + 2.5) * 1000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('no_heartbeat');
    const paid = r.payments.length;
    // the provider gets CLOSE(no_heartbeat) and stops; the buyer pays nothing more
    await waitFor(() => w.providers[0]!.getJob(rfqId).state === 'stopped', 'provider stop', 5000);
    expect(w.providers[0]!.getJob(rfqId).stopReason).toBe('no_heartbeat');
    await new Promise((res) => setTimeout(res, 1500));
    expect(w.buyer.getRfq(rfqId).payments.length).toBe(paid);
    // loss bounded: paid at most one interval beyond what heartbeats showed served
    expect(Math.max(...r.payments.map((x) => x.seq))).toBeLessThanOrEqual((r.heartbeats[0]?.servingSeq ?? 0) + 1);
  }, 30_000);

  it('buyer stop → provider stops, returns the partial result, both sides close', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 100_000, stepMs: 50 } }] }));
    const rfqId = await startRunning(w);
    const r1 = await w.buyer.stop(rfqId);
    expect(r1.state).toBe('closing');
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 10_000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('buyer_stop');
    expect(r.resultVerified).toBe(true);
    expect(unbundle(await w.buyer.resultBytes(rfqId))['result.txt']).toMatch(/steps=\d+/);
    const pj = w.providers[0]!.getJob(rfqId);
    expect(pj.state).toBe('stopped');
    expect(pj.stopReason).toBe('buyer_stop');
  }, 30_000);
});

describe('forged and out-of-policy messages', () => {
  it('ignores a forged BID, a BID above max and a BID from a provider that was not asked', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1' }] }));
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w) });
    await waitFor(() => w.buyer.getRfq(rfqId).bids.length === 1, 'honest bid');
    const rec = w.buyer.record(rfqId)!;
    const mallory = w.network.wallet('mallory', { fundZats: 100_000_000n });
    const malloryAddr = await mallory.address();
    const base: Bid = {
      t: 'BID',
      rfqId: unhex(rfqId),
      providerId: unhex(w.providers[0]!.providerId),
      pricePerIntervalZats: 1n,
      intervalS: 1,
      startWithinS: 1,
      providerEph: generateX25519().publicKey,
      payTo: malloryAddr,
    };
    // 1) claims to be p1 but is signed by another key
    await sendMemo(mallory, rec.replyTo, base, generateSigner().signer);
    // 2) really signed by p1's directory key, but above the buyer's max
    await sendMemo(mallory, rec.replyTo, { ...base, pricePerIntervalZats: 1_000_000_000n }, await providerSigner(w, 'p1'));
    // 3) validly self-signed by a provider nobody asked
    const stranger = generateSigner().signer;
    await sendMemo(mallory, rec.replyTo, { ...base, providerId: stranger.publicKey }, stranger);
    await waitFor(() => w.buyer.getRfq(rfqId).rejectedBids === 3, 'three rejections', 5000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.bids).toHaveLength(1);
    expect(r.bids[0]!.providerId).toBe(w.providers[0]!.providerId);
    expect(w.buyer.record(rfqId)!.bids.every((b) => b.payTo !== malloryAddr)).toBe(true);
    const reasons = w.buyer.listLeaks({ rfqId }).filter((o) => o.event === 'bid-rejected').map((o) => o.summary);
    expect(reasons.some((s) => /signature/.test(s))).toBe(true);
    expect(reasons.some((s) => /above (the|private) max/.test(s))).toBe(true);
    expect(reasons.some((s) => /not asked/.test(s))).toBe(true);
    await expect(w.buyer.accept(rfqId, Buffer.from(stranger.publicKey).toString('hex'))).rejects.toThrow(/no valid bid/);
  }, 20_000);

  it('provider ignores a forged PAY and a replayed PAY', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 100_000, stepMs: 50 } }] }));
    const rfqId = await startRunning(w);
    const rec = w.buyer.record(rfqId)!;
    const p = w.providers[0]!;
    await waitFor(() => p.getJob(rfqId).paymentsReceived.some((x) => x.seq === 1), 'provider saw PAY 1');
    const mallory = w.network.wallet('mallory', { fundZats: 100_000_000n });
    // forged: PAY for the next interval signed by a key that is not the RFQ's
    const next = Math.max(...p.getJob(rfqId).paymentsReceived.map((x) => x.seq)) + 1;
    await sendMemo(mallory, rec.accepted!.payTo, { t: 'PAY', rfqId: unhex(rfqId), seq: next }, generateSigner().signer, 1_000_000n);
    // replay: the buyer's genuine PAY 1 memo, re-sent in a new transaction
    const pay1 = w.buyerBackend.sends.flat().find((o) => {
      const d = decodeMemo(o.memo);
      return d?.msg.t === 'PAY' && d.msg.seq === 1;
    })!;
    await sendRetry(mallory, [{ to: rec.accepted!.payTo, zats: 1_000_000n, memo: pay1.memo }]);
    await waitFor(() => p.listLeaks({ rfqId }).filter((o) => o.event === 'memo-rejected').length >= 2, 'two rejections', 5000);
    const reasons = p.listLeaks({ rfqId }).filter((o) => o.event === 'memo-rejected').map((o) => o.summary).join(' | ');
    expect(reasons).toMatch(/not signed by the RFQ key/);
    expect(reasons).toMatch(/already paid \(replay\)|in the past/);
    const fromMallory = p.getJob(rfqId).paymentsReceived.filter((x) => x.zats === '1000000');
    expect(fromMallory).toHaveLength(0);
    await w.buyer.stop(rfqId);
  }, 30_000);

  it('provider refuses an underpaid ACCEPT', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1' }] }));
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w) });
    await waitFor(() => w.buyer.getRfq(rfqId).bids.length === 1, 'bid');
    const rec = w.buyer.record(rfqId)!;
    const bid = rec.bids[0]!;
    // a correctly signed ACCEPT (we derive the buyer's RFQ key the same way the buyer does) that pays too little
    const { deriveRfqKeys } = await import('@silicr/protocol');
    const seed = new Uint8Array(await readFile(join(w.root, 'buyer', 'master.seed')));
    const keys = deriveRfqKeys(seed, unhex(rfqId));
    const mallory = w.network.wallet('mallory', { fundZats: 100_000_000n });
    await sendMemo(
      mallory,
      bid.payTo,
      { t: 'ACCEPT', rfqId: unhex(rfqId), providerId: unhex(bid.providerId), intervals: 10, pricePerIntervalZats: bid.pricePerIntervalZats },
      keys.signer,
      1n,
    );
    await waitFor(() => w.providers[0]!.listLeaks({ rfqId }).some((o) => o.event === 'memo-rejected'), 'rejection');
    expect(w.providers[0]!.getJob(rfqId).state).toBe('bid');
    await w.buyer.stop(rfqId);
  }, 20_000);
});
