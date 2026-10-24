// Mainnet mode on the memory chain (nothing here touches a real network): the timing profile and
// its settlement arithmetic, the spend caps (RFQ, ACCEPT and PAY gates, accounting across a
// restart, the daemon's error code) and the refusal to start on mainnet without caps.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ErrorDto, StatusDto } from '@silicr/api';
import { createMemoryNetwork, type ZecBackend } from '@silicr/zec';
import { checkSpendCap } from '../src/base.ts';
import { BuyerNode } from '../src/buyer.ts';
import { ProviderNode } from '../src/provider.ts';
import { startDaemon, type RunningDaemon } from '../src/daemon.ts';
import { EngineError } from '../src/errors.ts';
import { MAINNET_PROFILE, PROFILES, TESTNET_PROFILE, defaultProfile, maxExposureIntervals, payLeadFor, payMiningWindowS } from '../src/profile.ts';
import { FakeRelay, FakeRunner, fakeBundles, makeWorld, TEST_PROFILE, tempDir, waitFor, type World } from './helpers.ts';

const job = (w: World) => ({ path: w.jobDir, command: ['python3', 'train.py'] });
/** 36 ZEC/h: 0.01 ZEC per 1 s TEST_PROFILE interval, so prices dwarf the 0.0001 ZEC memory-chain fees. */
const PRICE_PER_HOUR = 3_600_000_000n;
const ZEC = 100_000_000n;

describe('mainnet timing profile', () => {
  it('has the agreed numbers and is the default for network main', () => {
    expect(MAINNET_PROFILE).toMatchObject({
      name: 'mainnet',
      blockTimeS: 75,
      intervalS: 600,
      payLeadS: 120,
      heartbeatS: 15,
      heartbeatTimeoutS: 90,
      graceS: 300,
      bidWindowBlocks: 8,
      changeConfirmations: 3,
      prepareNotes: 6,
    });
    expect(MAINNET_PROFILE.startWithinS).toBeGreaterThanOrEqual(600);
    expect(defaultProfile('main')).toBe(MAINNET_PROFILE);
    expect(defaultProfile('test')).toBe(TESTNET_PROFILE);
    expect(defaultProfile('memory').name).toBe('memory');
    expect(PROFILES['mainnet']).toBe(MAINNET_PROFILE);
  });

  it('lead stays under the I/4 clamp and PAY k has ~9 blocks to be mined before interval k+1 needs it (§4 rule 3)', () => {
    const p = MAINNET_PROFILE;
    expect(payLeadFor(p, p.intervalS)).toBe(120); // 120 < 600 / 4: not clamped
    expect(maxExposureIntervals(p)).toBeCloseTo(1.2, 10);
    // PAY k goes out at the latest lead/2 = 60 s before interval k starts; the provider requires it
    // mined when interval k+1 starts, I = 600 s later: 660 s, 8.8 expected 75 s blocks.
    expect(payMiningWindowS(p)).toBe(660);
    expect(payMiningWindowS(p) / p.blockTimeS).toBeGreaterThanOrEqual(8);
    // If it still is not mined, the provider's grace window covers 4 more blocks before it stops.
    expect(p.graceS / p.blockTimeS).toBeGreaterThanOrEqual(4);
    // PAY k+1 only needs to reach the mempool by the boundary: it is sent at least 60 s before, many polls.
    expect((payLeadFor(p, p.intervalS) / 2) * 1000).toBeGreaterThanOrEqual(4 * p.pollMs);
    // Heartbeats: several may be missed before the buyer closes; one stays fresh for paying across 3 periods.
    expect(p.heartbeatTimeoutS).toBeGreaterThanOrEqual(5 * p.heartbeatS);
    expect(p.payFreshS).toBeGreaterThanOrEqual(3 * p.heartbeatS);
  });
});

/** A memory-chain wallet that claims to be on mainnet (the start-up checks look at network only). */
function mainnetBackend(name: string): ZecBackend {
  const net = createMemoryNetwork({ blockTimeMs: 0 });
  const inner = net.wallet(name, { fundZats: 1_000_000n });
  return Object.create(inner, { network: { value: 'main', enumerable: true } }) as ZecBackend;
}

describe('mainnet requires spend caps', () => {
  it('a buyer or provider whose wallet is on mainnet refuses to start without caps; the buyer starts with them', async () => {
    const root = await tempDir();
    const relay = new FakeRelay();
    const buyer = new BuyerNode({ backend: mainnetBackend('b'), relay, dataDir: join(root, 'buyer'), deps: { ...fakeBundles } });
    expect(buyer.profile).toBe(MAINNET_PROFILE); // picked from the backend's network
    const err = await buyer.start().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe('spend_cap');
    expect((err as Error).message).toMatch(/refusing to start a buyer on Zcash mainnet without spend caps/);
    expect((err as Error).message).toMatch(/--cap-per-request/);

    const provider = new ProviderNode({
      backend: mainnetBackend('p'),
      relay,
      dataDir: join(root, 'provider'),
      runner: new FakeRunner(join(root, 'runner'), { steps: 1, stepMs: 10 }),
      deps: { ...fakeBundles },
    });
    await expect(provider.start()).rejects.toThrow(/refusing to start a provider on Zcash mainnet without spend caps/);

    // bad caps are refused up front
    expect(() => checkSpendCap({ perRfqZats: 0n, totalZats: 1n })).toThrow(/positive/);
    expect(() => new BuyerNode({ backend: mainnetBackend('b3'), relay, dataDir: join(root, 'b3'), spendCap: { perRfqZats: 1n, totalZats: -1n } })).toThrow(/positive/);

    const capped = new BuyerNode({ backend: mainnetBackend('b2'), relay, dataDir: join(root, 'b2'), profile: TEST_PROFILE, spendCap: { perRfqZats: 1_000_000n, totalZats: 5_000_000n }, deps: { ...fakeBundles } });
    await capped.start();
    expect(capped.spendCap).toEqual({ perRfqZats: 1_000_000n, totalZats: 5_000_000n });
    expect(capped.capSpentZats()).toBe(0n);
    await capped.close();
  });
});

describe('spend caps (buyer)', () => {
  let world: World | null = null;
  let extra: BuyerNode | null = null;
  let daemon: RunningDaemon | null = null;
  afterEach(async () => {
    await daemon?.close();
    daemon = null;
    await extra?.close();
    extra = null;
    await world?.close();
    world = null;
  });

  it('refuses an RFQ over the per-request cap, counts payments and fees across a restart, then refuses one over the remaining total', async () => {
    const cap = { perRfqZats: 5n * ZEC / 100n, totalZats: 8n * ZEC / 100n }; // 0.05 per request, 0.08 total
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', policy: { minPricePerHourZats: PRICE_PER_HOUR }, script: { steps: 60, stepMs: 50 } }],
      buyerOpts: { spendCap: cap },
    }));
    // 10 s at 36 ZEC/h = 10 intervals × 0.01 ZEC: over the 0.05 ZEC per-request cap (nothing is stored for it)
    const big = w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 10, maxPricePerHourZats: PRICE_PER_HOUR.toString(), job: job(w) });
    await expect(big).rejects.toMatchObject({ code: 'spend_cap', status: 400 });
    await expect(big).rejects.toThrow(/could pay up to 0\.1 ZEC \(10 × 0\.01 ZEC per 1 s interval\), above the per-request cap of 0\.05 ZEC/);
    expect(w.buyer.listRfqs()).toHaveLength(0);
    expect(w.buyerBackend.sends).toHaveLength(0);

    // 4 s = 0.04 ZEC worst case: fits, runs to the end
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 4, maxPricePerHourZats: PRICE_PER_HOUR.toString(), job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'closed', 20_000);
    const done = w.buyer.getRfq(rfqId);
    expect(done.closeReason).toBe('done');
    const spent = w.buyer.capSpentZats();
    expect(spent).toBe(BigInt(done.spentZats) + BigInt(done.feesZats));
    expect(BigInt(done.spentZats)).toBe(BigInt(done.payments.length) * 1_000_000n);
    expect(BigInt(done.feesZats)).toBeGreaterThan(0n); // fees count towards the total
    expect(spent).toBeLessThanOrEqual(cap.totalZats);
    const status = await w.buyer.status();
    expect(status.spendCap).toEqual({ perRfqZats: '5000000', totalZats: '8000000', spentZats: spent.toString() });

    // restart on the same data dir: the count survives
    await w.buyer.close();
    const b2 = (extra = new BuyerNode({ backend: w.buyerBackend, relay: w.relay, dataDir: join(w.root, 'buyer'), profile: TEST_PROFILE, deps: { ...fakeBundles }, spendCap: cap }));
    await b2.start();
    expect(b2.capSpentZats()).toBe(spent);
    expect((await b2.status()).spendCap?.spentZats).toBe(spent.toString());

    // 5 s = 0.05 ZEC: within the per-request cap, but more than what is left of the 0.08 ZEC total
    const over = b2.createRfq({ gpu: 'a100', count: 1, durationS: 5, maxPricePerHourZats: PRICE_PER_HOUR.toString(), job: job(w) });
    await expect(over).rejects.toMatchObject({ code: 'spend_cap' });
    await expect(over).rejects.toThrow(new RegExp(`more than the ${esc(formatZec(cap.totalZats - spent))} ZEC left of the 0\\.08 ZEC total \\(${esc(formatZec(spent))} ZEC spent so far`));

    // the daemon maps it to HTTP 400, code spend_cap, and shows the cap in the status
    daemon = await startDaemon({ node: b2, port: 0 });
    const res = await fetch(`${daemon.url}/api/rfqs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gpu: 'a100', count: 1, durationS: 5, maxPricePerHourZats: PRICE_PER_HOUR.toString(), job: job(w) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorDto).code).toBe('spend_cap');
    const st = (await (await fetch(`${daemon.url}/api/status`)).json()) as StatusDto;
    expect(st.spendCap).toEqual({ perRfqZats: '5000000', totalZats: '8000000', spentZats: spent.toString() });
  }, 40_000);

  it('refuses to ACCEPT a bid whose intervals would overshoot the per-request cap', async () => {
    // The provider bills per 2 s; the buyer's profile assumes 1 s. 3 s at 36 ZEC/h passes the RFQ gate
    // (3 × 0.01 = 0.03 ≤ 0.035) but the bid means 2 intervals × 0.02 ZEC = 0.04 ZEC.
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', policy: { minPricePerHourZats: PRICE_PER_HOUR, intervalS: 2 } }],
      buyerOpts: { spendCap: { perRfqZats: 3_500_000n, totalZats: 1n * ZEC } },
    }));
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 3, maxPricePerHourZats: PRICE_PER_HOUR.toString(), job: job(w) });
    await waitFor(() => w.buyer.getRfq(rfqId).bids.length === 1, 'a bid');
    const err = await w.buyer.accept(rfqId, w.providers[0]!.providerId).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe('spend_cap');
    expect((err as Error).message).toMatch(/could pay 0\.04 ZEC \(2 × 0\.02 ZEC per 2 s\), above the per-request cap of 0\.035 ZEC/);
    expect(w.buyer.getRfq(rfqId).state).toBe('collecting'); // nothing was sent
    expect(w.buyer.getRfq(rfqId).payments).toHaveLength(0);
  }, 20_000);

  it('stops a running job (CLOSE buyer_stop) rather than let a PAY cross the total cap', async () => {
    // 4 s at 0.01 ZEC per interval: 0.04 ZEC of payments. The total leaves room for the RFQ's fee
    // (25,001 zats on the memory chain) plus 15,000 more, so the ACCEPT passes gate 2, but the fees
    // of the ACCEPT and PAYs 1–2 (10,000 each) use that up: PAY 3 would cross the cap, so the buyer
    // stops after PAY 2 instead.
    const total = 4_000_000n + 25_001n + 15_000n;
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', policy: { minPricePerHourZats: PRICE_PER_HOUR }, script: { steps: 1000, stepMs: 50 } }],
      buyerOpts: { spendCap: { perRfqZats: 1n * ZEC, totalZats: total } },
    }));
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 4, maxPricePerHourZats: PRICE_PER_HOUR.toString(), job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'closed', 25_000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('buyer_stop');
    expect(r.error).toMatch(/spend cap reached: paying interval 3/);
    expect(r.payments.map((p) => p.seq)).toEqual([0, 1, 2]);
    expect(w.buyer.capSpentZats()).toBeLessThanOrEqual(total); // the CLOSE's fee included
    expect(w.buyer.listLeaks({ rfqId }).some((o) => o.event === 'watchdog' && /spend cap reached/i.test(o.summary))).toBe(true);
    expect(w.providers[0]!.getJob(rfqId).earnedZats).toBe(r.spentZats);
  }, 40_000);
});

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatZec(zats: bigint): string {
  const whole = zats / ZEC;
  const frac = (zats % ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''}`;
}
