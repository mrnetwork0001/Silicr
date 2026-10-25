// A light-wallet-server outage mid-deal (mainnet run 2, 2026-10-24): chain calls hang and fail for
// a while. The relay side must keep flowing, a CLOSE that cannot be broadcast is retried until the
// chain is back, and a result already on the relay closes the deal as done, not no_heartbeat.
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveChannel, deriveRfqKeys } from '@silicr/protocol';
import { unhex } from '../src/util.ts';
import { closeRetryDelayMs, CLOSE_RETRY_MAX_MS } from '../src/buyer.ts';
import { makeWorld, outage, outageBackend, unbundle, waitFor, type World } from './helpers.ts';

let world: World | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const job = (w: World) => ({ path: w.jobDir, command: ['python3', 'train.py'] });

/** Start a deal and wait until it is running, interval 0 is mined on the provider's side, and PAY 1 was seen by both. */
async function startPaid(w: World, durationS: number): Promise<string> {
  const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 } });
  await waitFor(() => w.buyer.getRfq(rfqId).state === 'running', 'running', 10_000);
  await waitFor(() => w.buyer.getRfq(rfqId).payments.some((p) => p.seq === 1), 'PAY 1 sent', 10_000);
  const p = w.providers[0]!;
  await waitFor(() => p.getJob(rfqId).paymentsReceived.some((x) => x.seq === 1), 'PAY 1 seen by the provider', 5000, 10);
  await waitFor(() => p.getJob(rfqId).paymentsReceived.some((x) => x.seq === 0 && x.height !== null), 'ACCEPT mined', 5000, 10);
  return rfqId;
}

/** The buyer's view of the deal's channel (tests may read the buyer's own seed). */
async function buyerChannel(w: World, rfqId: string) {
  const rec = w.buyer.record(rfqId)!;
  const seed = new Uint8Array(await readFile(join(w.root, 'buyer', 'master.seed')));
  const keys = deriveRfqKeys(seed, unhex(rfqId));
  return deriveChannel(keys.eph.secretKey, unhex(rec.accepted!.providerEph), unhex(rfqId));
}

describe('light-wallet-server outage mid-deal', () => {
  it('heartbeats, logs and the result keep flowing while the chain hangs; both CLOSEs go out when it is back; the deal closes done', async () => {
    const buyerOut = outage(150);
    const provOut = outage(150);
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', script: { steps: 60, stepMs: 50 }, wrapBackend: (b) => outageBackend(b, provOut) }],
      buyerWrapBackend: (b) => outageBackend(b, buyerOut),
      profile: { intervalS: 2, graceS: 4, closeWaitS: 8 },
    }));
    // 4 s of compute = 2 intervals; the job itself takes ~3 s, so it finishes inside interval 1.
    const rfqId = await startPaid(w, 4);
    const before = w.buyer.getRfq(rfqId);
    const hbBefore = before.heartbeats[0]!.seq;
    const logBefore = before.logTail.length;

    buyerOut.on = true;
    provOut.on = true;
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 1200));
    // Relay traffic is independent of the chain: heartbeats and logs kept arriving.
    const during = w.buyer.getRfq(rfqId);
    expect(during.heartbeats[0]!.seq).toBeGreaterThan(hbBefore);
    expect(during.logTail.length).toBeGreaterThan(logBefore);
    expect(during.state).toMatch(/running|closing/);
    expect(buyerOut.failures + provOut.failures).toBeGreaterThan(0);

    // The job finishes during the outage: the result reaches the relay and the buyer fetches it,
    // but neither side can broadcast its CLOSE yet.
    await waitFor(() => w.buyer.getRfq(rfqId).result, 'result fetched during the outage', 6000);
    await waitFor(() => w.buyer.getRfq(rfqId).closePending, "buyer's CLOSE kept for retry", 6000);
    await waitFor(() => w.providers[0]!.getJob(rfqId).closePending, "provider's CLOSE kept for retry", 6000);
    expect(w.buyer.getRfq(rfqId).error).toMatch(/CLOSE failed/);
    expect(w.providers[0]!.getJob(rfqId).state).toBe('done');

    buyerOut.on = false;
    provOut.on = false;
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'buyer closed', 15_000);
    const r = w.buyer.getRfq(rfqId);
    expect(Date.now() - t0).toBeLessThan(14_000);
    expect(r.closeReason).toBe('done');
    expect(r.resultVerified).toBe(true);
    expect(r.closePending).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(w.buyer.record(rfqId)!.closeSent?.reason).toBe('done');
    expect(unbundle(await w.buyer.resultBytes(rfqId))['result.txt']).toMatch(/steps=60/);
    const pj = w.providers[0]!.getJob(rfqId);
    expect(pj.state).toBe('done');
    expect(pj.closePending).toBeUndefined();
    expect(w.providers[0]!.record(rfqId)!.closeTxid).toBeDefined();
    const retried = w.buyer.listLeaks({ rfqId }).filter((o) => o.event === 'tx-broadcast' && /CLOSE sent: done \(after \d+ failed attempt/.test(o.summary));
    expect(retried).toHaveLength(1);
  }, 40_000);

  it('a CLOSE(buyer_stop) that cannot be broadcast is retried with backoff until the chain is back', async () => {
    const buyerOut = outage(100);
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', script: { steps: 100_000, stepMs: 50 } }],
      buyerWrapBackend: (b) => outageBackend(b, buyerOut),
      profile: { graceS: 6 },
    }));
    const rfqId = await startPaid(w, 120);
    buyerOut.on = true;
    const stopped = await w.buyer.stop(rfqId);
    // Payments stop at once; the CLOSE is kept as a persisted intent.
    expect(stopped.state).toBe('closed');
    expect(stopped.closeReason).toBe('buyer_stop');
    expect(stopped.closePending?.reason).toBe('buyer_stop');
    expect(stopped.closePending?.attempts).toBe(1);
    expect(stopped.error).toMatch(/CLOSE failed.*retrying/);
    // A retry while the chain is still down fails again and backs off further.
    await waitFor(() => (w.buyer.getRfq(rfqId).closePending?.attempts ?? 0) >= 2, 'second attempt', 8000);
    expect(w.buyer.record(rfqId)!.closeSent).toBeUndefined();
    buyerOut.on = false;
    await waitFor(() => w.buyer.record(rfqId)!.closeSent, 'CLOSE broadcast', 15_000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.closePending).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(w.buyer.record(rfqId)!.closeSent!.reason).toBe('buyer_stop');
    // The provider hears it and stops; no payment went out after the stop.
    await waitFor(() => w.providers[0]!.getJob(rfqId).state === 'stopped', 'provider stopped', 10_000);
    expect(w.providers[0]!.getJob(rfqId).stopReason).toBe('buyer_stop');
    expect(w.buyer.getRfq(rfqId).payments.length).toBe(stopped.payments.length);
  }, 40_000);

  it('heartbeats stop but the result is already on the relay: fetched and verified, closed done (not no_heartbeat)', async () => {
    const provOut = outage(100);
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', script: { steps: 8, stepMs: 50 }, wrapBackend: (b) => outageBackend(b, provOut) }],
      profile: { intervalS: 2, closeWaitS: 8 },
    }));
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 4, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 } });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'running', 'running', 10_000);
    // From here the buyer sees no heartbeats at all (not even the final one), and the provider
    // cannot reach the chain, so its CLOSE(done) cannot tell the buyer the job finished.
    const ch = await buyerChannel(w, rfqId);
    w.relay.readFilter = (mailbox) => mailbox !== ch.mailboxes.heartbeat;
    provOut.on = true;
    await waitFor(() => w.providers[0]!.getJob(rfqId).state === 'done', 'job done on the provider', 6000);
    await waitFor(() => w.providers[0]!.getJob(rfqId).closePending, "provider's CLOSE kept for retry", 4000);
    // The heartbeat timeout fires; the buyer looks at the relay first and finds the result.
    await waitFor(() => w.buyer.getRfq(rfqId).result, 'result fetched after the heartbeat timeout', 8000);
    const mid = w.buyer.getRfq(rfqId);
    expect(mid.closeReason).toBe('done');
    expect(mid.state).toBe('closing'); // waiting for the provider's CLOSE and its digest
    expect(w.buyer.listLeaks({ rfqId }).some((o) => o.event === 'watchdog' && /already on the relay/.test(o.summary))).toBe(true);
    // The chain comes back: the provider's CLOSE(done) carries the digest and the deal settles.
    provOut.on = false;
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'closed', 15_000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('done');
    expect(r.resultVerified).toBe(true);
    expect(r.error).toBeUndefined();
    expect(unbundle(await w.buyer.resultBytes(rfqId))['result.txt']).toMatch(/steps=8/);
  }, 40_000);

  it('a provider CLOSE(done) arriving after a no_heartbeat close marks the deal done and fetches the result', async () => {
    const provOut = outage(100);
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', script: { steps: 8, stepMs: 50 }, wrapBackend: (b) => outageBackend(b, provOut) }],
      profile: { intervalS: 2, closeWaitS: 8 },
    }));
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 4, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 } });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'running', 'running', 10_000);
    // The buyer is blind to the relay (as it was while its loops were stuck) and the provider to the chain.
    w.relay.readFilter = () => false;
    provOut.on = true;
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'closed for silence', 8000);
    expect(w.buyer.getRfq(rfqId).closeReason).toBe('no_heartbeat');
    expect(w.buyer.getRfq(rfqId).result).toBeUndefined();
    await waitFor(() => w.providers[0]!.getJob(rfqId).state === 'done', 'job done on the provider', 6000);
    // Everything comes back: the provider's CLOSE(done) lands, the buyer takes the result it is owed.
    w.relay.readFilter = undefined;
    provOut.on = false;
    await waitFor(() => w.buyer.getRfq(rfqId).closeReason === 'done', 'verdict flipped to done', 15_000);
    await waitFor(() => w.buyer.getRfq(rfqId).resultVerified === true, 'late result fetched and verified', 8000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.state).toBe('closed');
    expect(r.closePending).toBeUndefined();
    expect(w.buyer.listLeaks({ rfqId }).some((o) => o.event === 'watchdog' && /Late CLOSE from the provider/.test(o.summary))).toBe(true);
    // Our own CLOSE(no_heartbeat) went out before the provider's arrived (the buyer's chain was fine).
    expect(w.buyer.record(rfqId)!.closeSent?.reason).toBe('no_heartbeat');
  }, 40_000);

  it('CLOSE retry backoff doubles from the profile and caps at five minutes', () => {
    expect(closeRetryDelayMs(1, 30)).toBe(2000);
    expect(closeRetryDelayMs(2, 30)).toBe(4000);
    expect(closeRetryDelayMs(1, 5000)).toBe(20_000);
    expect(closeRetryDelayMs(5, 5000)).toBe(CLOSE_RETRY_MAX_MS);
    expect(closeRetryDelayMs(50, 5000)).toBe(CLOSE_RETRY_MAX_MS);
  });
});
