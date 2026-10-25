// The mainnet public demo (`--public-demo --allow-mainnet`) on the memory chain (nothing here touches
// a real network): refused without the flag or without caps; the 0.001 ZEC/h price ceiling and the
// 15 min duration ceiling; the spend cap as a hard ceiling on every request's worst case
// (400 `spend_cap`); `demoExhausted` once the wallet or the cap cannot afford the cheapest preset;
// the provider's fee reserve (no bid, and `bidding` in its status, below 0.0003 ZEC).
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ErrorDto, StatusDto } from '@silicr/api';
import { createMemoryNetwork, type MemoryNetwork, type ZecBackend } from '@silicr/zec';
import { BuyerNode } from '../src/buyer.ts';
import { ProviderNode } from '../src/provider.ts';
import { MAINNET_DEMO_MAX_DURATION_S, MAINNET_DEMO_MAX_PRICE_ZATS, demoWorstCaseZats, startDaemon, type RunningDaemon } from '../src/daemon.ts';
import type { JobPreset } from '../src/presets.ts';
import { FakeRelay, FakeRunner, fakeBundles, makeWorld, TEST_PROFILE, tempDir, waitFor, type World } from './helpers.ts';

const presets: JobPreset[] = [
  { id: 'quick', title: 'Quick', description: 'd', command: ['python3', 'train.py'], gpu: 'a100', durationS: 60, path: '/nowhere/quick' },
  { id: 'long', title: 'Long', description: 'd', command: ['python3', 'train.py'], gpu: 'a100', durationS: 300, path: '/nowhere/long' },
];
/** The memory chain's wallets carry regtest addresses: skip the network check the real guard makes. */
const mainnetDeps = { ...fakeBundles, toOrchardOnly: (a: string) => a };
const INTERVAL_S = 60;
/** 1 interval at 0.001 ZEC/h (1667 zats) + RFQ fee 20000 + (1 + 1) × 10000 = 41667 zats. */
const QUICK_WORST = demoWorstCaseZats({ durationS: 60, maxPricePerHourZats: MAINNET_DEMO_MAX_PRICE_ZATS }, INTERVAL_S);
/** 5 intervals (8335) + 20000 + 6 × 10000 = 88335 zats. */
const LONG_WORST = demoWorstCaseZats({ durationS: 300, maxPricePerHourZats: MAINNET_DEMO_MAX_PRICE_ZATS }, INTERVAL_S);

const nets: MemoryNetwork[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const n of nets.splice(0)) n.stop();
});

/** A memory-chain wallet that claims to be on mainnet (the start-up checks look at network only). */
function mainnetBackend(fundZats: bigint): ZecBackend {
  const net = createMemoryNetwork({ blockTimeMs: 0 });
  nets.push(net);
  const inner = net.wallet(`w${nets.length}`, { fundZats });
  return Object.create(inner, { network: { value: 'main', enumerable: true } }) as ZecBackend;
}

async function mainnetBuyer(fundZats: bigint, spendCap?: { perRfqZats: bigint; totalZats: bigint }): Promise<BuyerNode> {
  const node = new BuyerNode({ backend: mainnetBackend(fundZats), relay: new FakeRelay(), dataDir: join(await tempDir(), 'b'), profile: TEST_PROFILE, deps: mainnetDeps, ...(spendCap ? { spendCap } : {}) });
  await node.start();
  closers.push(() => node.close());
  return node;
}

async function demoDaemon(node: BuyerNode | ProviderNode, extra: Record<string, unknown> = {}): Promise<RunningDaemon> {
  const d = await startDaemon({ node, port: 0, publicDemo: { presets, allowMainnet: true, ...extra } });
  closers.push(() => d.close());
  return d;
}

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
}

const rfq = (preset: string, extra: Record<string, unknown> = {}) => ({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: MAINNET_DEMO_MAX_PRICE_ZATS.toString(), job: { preset }, ...extra });

describe('worst case', () => {
  it('counts every interval at the max price plus the RFQ, ACCEPT/PAY and CLOSE fees', () => {
    expect(QUICK_WORST).toBe(1_667n + 20_000n + 2n * 10_000n);
    expect(LONG_WORST).toBe(5n * 1_667n + 20_000n + 6n * 10_000n);
    // Shorter intervals: more payments (rounded up each) and more fees for the same duration.
    expect(demoWorstCaseZats({ durationS: 300, maxPricePerHourZats: MAINNET_DEMO_MAX_PRICE_ZATS }, 600)).toBeLessThan(LONG_WORST);
  });
});

describe('mainnet public demo: start-up', () => {
  it('is refused without allowMainnet, and with it but without a spend cap', async () => {
    const uncapped = new BuyerNode({ backend: mainnetBackend(1_000_000n), relay: new FakeRelay(), dataDir: join(await tempDir(), 'u'), profile: TEST_PROFILE, deps: mainnetDeps });
    await expect(startDaemon({ node: uncapped, port: 0, publicDemo: { presets } })).rejects.toThrow(/refused on Zcash mainnet.*--allow-mainnet/);
    // The node itself refuses to start without caps on mainnet; the daemon's own check guards a node built elsewhere.
    await expect(startDaemon({ node: uncapped, port: 0, publicDemo: { presets, allowMainnet: true } })).rejects.toThrow(/needs spend caps/);
    const capped = await mainnetBuyer(1_000_000n, { perRfqZats: 100_000n, totalZats: 500_000n });
    const d = await demoDaemon(capped);
    expect((await call<StatusDto>(d.url, 'GET', '/api/status')).body.publicDemo).toBe(true);
  });

  it('status: allowMainnet, the clamped price and duration ceilings, the cheapest worst case, the cap and demoExhausted false while funded', async () => {
    const buyer = await mainnetBuyer(1_000_000n, { perRfqZats: 100_000n, totalZats: 500_000n });
    // Asked for the testnet defaults (0.5 ZEC/h, 30 min): mainnet clamps both.
    const d = await demoDaemon(buyer, { maxPricePerHourZats: 50_000_000n, maxDurationS: 1800 });
    const s = (await call<StatusDto>(d.url, 'GET', '/api/status')).body;
    expect(s.network).toBe('main');
    expect(s.publicDemo).toBe(true);
    expect(s.publicDemoLimits).toEqual({
      maxDurationS: MAINNET_DEMO_MAX_DURATION_S,
      maxCount: 1,
      maxActive: 1,
      perIpPerHour: 3,
      maxPricePerHourZats: MAINNET_DEMO_MAX_PRICE_ZATS.toString(),
      allowMainnet: true,
      minWorstCaseZats: QUICK_WORST.toString(),
    });
    expect(s.spendCap).toEqual({ perRfqZats: '100000', totalZats: '500000', spentZats: '0' });
    expect(s.demoExhausted).toBe(false);
    expect(s.presets?.map((p) => p.id)).toEqual(['quick', 'long']);
  });

  it('a testnet public demo reports neither allowMainnet nor a clamp, but still the cheapest worst case', async () => {
    const w = await makeWorld();
    closers.push(() => w.close());
    const d = await startDaemon({ node: w.buyer, port: 0, publicDemo: { presets } });
    closers.push(() => d.close());
    const s = (await call<StatusDto>(d.url, 'GET', '/api/status')).body;
    expect(s.publicDemoLimits?.allowMainnet).toBeUndefined();
    expect(s.publicDemoLimits?.maxPricePerHourZats).toBe('50000000');
    expect(s.publicDemoLimits?.minWorstCaseZats).toBe(demoWorstCaseZats({ durationS: 60, maxPricePerHourZats: 50_000_000n }, INTERVAL_S).toString());
    expect(s.demoExhausted).toBe(false);
  });
});

describe('mainnet public demo: POST /api/rfqs', () => {
  it('refuses a max price over 0.001 ZEC/h and a duration over 15 min', async () => {
    const buyer = await mainnetBuyer(1_000_000n, { perRfqZats: 100_000n, totalZats: 500_000n });
    const d = await demoDaemon(buyer);
    const over = await call<ErrorDto>(d.url, 'POST', '/api/rfqs', rfq('quick', { maxPricePerHourZats: (MAINNET_DEMO_MAX_PRICE_ZATS + 1n).toString() }));
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('bad_request');
    expect(over.body.error).toMatch(/maxPricePerHourZats.*100000 \(0\.001 ZEC\/h\)/);
    const long = await call<ErrorDto>(d.url, 'POST', '/api/rfqs', rfq('long', { durationS: 901 }));
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/durationS must be an integer 1\.\.900/);
    expect(buyer.listRfqs()).toHaveLength(0);
  });

  it('the spend cap is a hard ceiling: worst case over the per-request cap, or over what is left of the total, is 400 spend_cap', async () => {
    // Per-request cap below the cheapest preset's worst case: nothing may run.
    const tight = await mainnetBuyer(1_000_000n, { perRfqZats: QUICK_WORST - 1n, totalZats: 500_000n });
    const d1 = await demoDaemon(tight);
    const r1 = await call<ErrorDto>(d1.url, 'POST', '/api/rfqs', rfq('quick'));
    expect(r1.status).toBe(400);
    expect(r1.body.code).toBe('spend_cap');
    expect(r1.body.error).toMatch(/above the per-request cap/);
    expect((await call<StatusDto>(d1.url, 'GET', '/api/status')).body.demoExhausted).toBe(true); // the cap cannot afford it either

    // Per-request cap fine, but the total has less left than the long preset needs.
    const total = await mainnetBuyer(1_000_000n, { perRfqZats: 100_000n, totalZats: LONG_WORST - 1n });
    const d2 = await demoDaemon(total);
    const r2 = await call<ErrorDto>(d2.url, 'POST', '/api/rfqs', rfq('long', { durationS: 300 }));
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe('spend_cap');
    expect(r2.body.error).toMatch(/left of the demo's .* budget/);
    expect(total.listRfqs()).toHaveLength(0);
    // The quick preset still fits, so the demo is not exhausted.
    expect((await call<StatusDto>(d2.url, 'GET', '/api/status')).body.demoExhausted).toBe(false);
  });

  it('demoExhausted once the wallet cannot afford the cheapest preset; such a request is 402 insufficient_funds', async () => {
    const poor = await mainnetBuyer(QUICK_WORST - 1n, { perRfqZats: 100_000n, totalZats: 500_000n });
    const d = await demoDaemon(poor);
    const s = (await call<StatusDto>(d.url, 'GET', '/api/status')).body;
    expect(s.demoExhausted).toBe(true);
    expect(BigInt(s.balance.spendable)).toBeLessThan(QUICK_WORST);
    const r = await call<ErrorDto>(d.url, 'POST', '/api/rfqs', rfq('quick'));
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('insufficient_funds');
    expect(r.body.error).toMatch(/shared wallet has/);
    expect(poor.listRfqs()).toHaveLength(0);
  });
});

describe('provider fee reserve (minBidBalanceZats)', () => {
  let w: World | null = null;
  afterEach(async () => {
    await w?.close();
    w = null;
  });

  it('a provider below the reserve reports bidding inactive and does not bid; one above it does', async () => {
    w = await makeWorld({ providers: [{ name: 'p1' }] });
    const root = await tempDir();
    const mk = async (name: string, fundZats: bigint, minBidBalanceZats: bigint) => {
      const node = new ProviderNode({
        backend: w!.network.wallet(name, { fundZats }),
        relay: w!.relay,
        dataDir: join(root, name),
        profile: TEST_PROFILE,
        runner: new FakeRunner(join(root, `${name}-runner`), { steps: 1, stepMs: 10 }),
        deps: { ...fakeBundles },
        policy: { gpus: [{ model: 'a100', count: 1, vramGb: 80 }], minPricePerHourZats: 36_000_000n },
        minBidBalanceZats,
      });
      await node.start();
      closers.push(() => node.close());
      return node;
    };
    const poor = await mk('poor', 20_000n, 30_000n);
    const rich = await mk('rich', 100_000_000n, 30_000n);
    const poorStatus = await poor.status();
    expect(poorStatus.bidding).toEqual({ active: false, reason: expect.stringMatching(/wallet balance too low to bid: 0\.0002 ZEC spendable.*0\.0003 ZEC/) });
    expect((await rich.status()).bidding).toEqual({ active: true });
    // The default (no reserve) stays as before: active whenever auto-bid is on.
    expect((await w.providers[0]!.status()).bidding).toEqual({ active: true });

    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100',
      count: 1,
      durationS: 60,
      maxPricePerHourZats: '50000000',
      providerIds: [poor.providerId, rich.providerId],
      job: { path: w.jobDir, command: ['python3', 'train.py'] },
      autoAccept: null,
    });
    await waitFor(() => rich.listJobs().find((j) => j.rfqId === rfqId), 'the funded provider to bid', 10_000, 50);
    const refusal = await waitFor(() => poor.listLeaks({ rfqId }).find((o) => o.event === 'no-bid'), 'the poor provider to refuse', 10_000, 50);
    expect(refusal.summary).toMatch(/wallet balance too low to bid/);
    expect(poor.listJobs()).toHaveLength(0);
    await w.buyer.stop(rfqId).catch(() => undefined);
  });
});
