// Wallet connection: deposit info (GET /api/wallet) and withdraw (POST /api/wallet/withdraw), both roles,
// on the memory chain. The mainnet confirm flow runs on a memory wallet that claims to be on mainnet.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ErrorDto, StatusDto, WalletDto, WithdrawConfirmDto, WithdrawResultDto } from '@silicr/api';
import { createMemoryNetwork, toOrchardOnly, type ZecBackend } from '@silicr/zec';
import { BuyerNode } from '../src/buyer.ts';
import { startDaemon, type RunningDaemon } from '../src/daemon.ts';
import { zip321Uri } from '../src/base.ts';
import { FakeRelay, fakeBundles, makeWorld, TEST_PROFILE, tempDir, waitFor, type World } from './helpers.ts';

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
}

describe('wallet connection (memory chain)', () => {
  let w: World;
  let buyerD: RunningDaemon;
  let providerD: RunningDaemon;
  let alice: ZecBackend;
  let aliceAddr: string;

  beforeAll(async () => {
    w = await makeWorld({ providers: [{ name: 'p1', script: { steps: 40, stepMs: 100 } }] });
    buyerD = await startDaemon({ node: w.buyer, port: 0 });
    providerD = await startDaemon({ node: w.providers[0]!, port: 0 });
    alice = w.network.wallet('alice', { fundZats: 500_000_000n });
    aliceAddr = await alice.address();
  });
  afterAll(async () => {
    await buyerD?.close();
    await providerD?.close();
    await w?.close();
  });

  it('GET /api/wallet: Orchard-only address, ZIP 321 URI, balance, confirmations, and the incoming deposit', async () => {
    const st = (await call<StatusDto>(buyerD.url, 'GET', '/api/status')).body;
    const r = await call<WalletDto>(buyerD.url, 'GET', '/api/wallet');
    expect(r.status).toBe(200);
    expect(r.body.address).toBe(st.address);
    expect(r.body.address).toBe(toOrchardOnly(r.body.address, 'memory'));
    expect(r.body.zip321Uri).toBe(`zcash:${st.address}`);
    expect(r.body).toMatchObject({ role: 'buyer', network: 'memory', confirmationsRequired: { received: 1, change: 1 }, feeEstimateZats: '10000', busy: false });
    expect(BigInt(r.body.balance.spendable)).toBeGreaterThan(0n);

    const withAmount = await call<WalletDto>(buyerD.url, 'GET', '/api/wallet?amount=0.05');
    expect(withAmount.body.zip321Uri).toBe(`zcash:${st.address}?amount=0.05`);
    expect(zip321Uri('u1x', 125_000_000n)).toBe('zcash:u1x?amount=1.25');
    expect((await call<ErrorDto>(buyerD.url, 'GET', '/api/wallet?amount=-1')).body.code).toBe('bad_request');

    // a deposit from the user's own wallet
    const memo = new Uint8Array(512);
    memo[0] = 0xf6;
    const sent = await alice.send([{ to: st.address, zats: 20_000_000n, memo }]);
    const seen = await waitFor(async () => {
      const x = (await call<WalletDto>(buyerD.url, 'GET', '/api/wallet')).body;
      return x.lastIncoming?.txid === sent.txid.toLowerCase() && x.lastIncoming.confirmations >= 1 ? x : null;
    }, 'deposit confirmed');
    expect(seen.lastIncoming).toMatchObject({ txid: sent.txid.toLowerCase(), zats: '20000000' });
    expect(seen.lastIncoming!.height).not.toBeNull();

    // the provider daemon serves the same endpoint
    const p = await call<WalletDto>(providerD.url, 'GET', '/api/wallet');
    expect(p.body.role).toBe('provider');
  });

  it('withdraws to an Orchard address (no confirm off mainnet), records a leak observation, refuses transparent', async () => {
    const before = (await alice.balance()).spendable + (await alice.balance()).pending;
    const r = await call<WithdrawResultDto>(buyerD.url, 'POST', '/api/wallet/withdraw', { to: aliceAddr, amountZats: '1000000' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ zats: '1000000', network: 'memory' });
    expect(BigInt(r.body.feeZats)).toBeGreaterThan(0n);
    await waitFor(async () => {
      const b = await alice.balance();
      return b.spendable + b.pending === before + 1_000_000n;
    }, 'alice received');
    const obs = w.buyer.listLeaks({}).find((o) => o.event === 'withdraw');
    expect(obs).toMatchObject({ party: 'buyer', txid: r.body.txid });
    expect(obs!.fields.find((f) => f.label === 'Amount')!.value).toBe('0.01 ZEC');

    const t = await call<ErrorDto>(buyerD.url, 'POST', '/api/wallet/withdraw', { to: 'tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd', amountZats: '1000000' });
    expect(t.status).toBe(400);
    expect(t.body.code).toBe('privacy');
    expect(t.body.error).toMatch(/Refusing transparent address/);
    expect(t.body.error).not.toContain('tmBsTi2x');
    const bad = await call<ErrorDto>(buyerD.url, 'POST', '/api/wallet/withdraw', { to: aliceAddr, amountZats: 'lots' });
    expect(bad.body.code).toBe('bad_request');
    const tooMuch = await call<ErrorDto>(buyerD.url, 'POST', '/api/wallet/withdraw', { to: aliceAddr, amountZats: '999999999999' });
    expect(tooMuch.status).toBe(402);
    expect(tooMuch.body.code).toBe('insufficient_funds');
  });

  it('"all" sweeps the spendable balance minus the exact fee (provider)', async () => {
    const p = w.providers[0]!;
    await waitFor(async () => (await p.backend.balance()).pending === 0n, 'provider settled');
    // spread the balance over several notes so the sweep needs more than 2 actions
    const own = await p.backend.address();
    const memo = new Uint8Array(512);
    memo[0] = 0xf6;
    await p.backend.send([1, 2, 3].map(() => ({ to: own, zats: 1_000_000n, memo })));
    await waitFor(async () => (await p.backend.balance()).pending === 0n, 'notes confirmed');
    const spendable = (await p.backend.balance()).spendable;
    const r = await call<WithdrawResultDto>(providerD.url, 'POST', '/api/wallet/withdraw', { to: aliceAddr, amountZats: 'all' });
    expect(r.status).toBe(200);
    expect(BigInt(r.body.zats) + BigInt(r.body.feeZats)).toBe(spendable);
    const after = await p.backend.balance();
    expect(after.spendable + after.pending).toBe(0n);
    expect(p.listLeaks({}).some((o) => o.event === 'withdraw' && o.party === 'provider')).toBe(true);
  });

  it('refuses while a request is live (code busy) unless force', async () => {
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 2, maxPricePerHourZats: '360000000', job: { path: w.jobDir, command: ['python3', 'train.py'] } });
    expect((await call<WalletDto>(buyerD.url, 'GET', '/api/wallet')).body.busy).toBe(true);
    const r = await call<ErrorDto>(buyerD.url, 'POST', '/api/wallet/withdraw', { to: aliceAddr, amountZats: '1000' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('busy');
    const forced = await call<WithdrawResultDto>(buyerD.url, 'POST', '/api/wallet/withdraw', { to: aliceAddr, amountZats: '1000', force: true });
    expect(forced.status).toBe(200);
    await w.buyer.stop(rfqId).catch(() => undefined);
  });
});

/** A memory-chain wallet that claims to be on mainnet. */
function mainnetBackend(): { backend: ZecBackend; other: ZecBackend; stop: () => void } {
  const net = createMemoryNetwork({ blockTimeMs: 50 });
  const inner = net.wallet('b', { fundZats: 50_000_000n });
  const backend = Object.create(inner, { network: { value: 'main', enumerable: true } }) as ZecBackend;
  return { backend, other: net.wallet('dest'), stop: () => net.stop() };
}

describe('mainnet withdraw confirm flow', () => {
  let node: BuyerNode | null = null;
  let d: RunningDaemon | null = null;
  let stop: (() => void) | null = null;
  afterEach(async () => {
    await d?.close();
    await node?.close();
    stop?.();
  });

  it('first call returns 409 confirm_required with a token and summary; the echo sends; a wrong token does not', async () => {
    const m = mainnetBackend();
    stop = m.stop;
    // the memory chain uses regtest encoding: let the guard accept it while the node believes it is on mainnet
    const deps = { ...fakeBundles, toOrchardOnly: (a: string, n: Parameters<typeof toOrchardOnly>[1]) => toOrchardOnly(a, n === 'main' ? 'memory' : n) };
    node = new BuyerNode({ backend: m.backend, relay: new FakeRelay(), dataDir: join(await tempDir(), 'b'), profile: TEST_PROFILE, deps, spendCap: { perRfqZats: 1_000_000n, totalZats: 2_000_000n } });
    await node.start();
    d = await startDaemon({ node, port: 0 });
    const to = await m.other.address();
    const wal = (await call<WalletDto>(d.url, 'GET', '/api/wallet')).body;
    expect(wal.network).toBe('main');
    expect(wal.confirmationsRequired).toEqual({ received: 10, change: TEST_PROFILE.changeConfirmations });

    // 10_000_000 zats is over the 2_000_000 total cap: withdraws are the user's own money, not capped
    const first = await call<WithdrawConfirmDto>(d.url, 'POST', '/api/wallet/withdraw', { to, amountZats: '10000000' });
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('confirm_required');
    expect(first.body.confirm).toMatch(/^[0-9a-f]{32}$/);
    expect(first.body.summary).toMatchObject({ zats: '10000000', network: 'main', all: false });
    expect(first.body.expiresAt).toBeGreaterThan(Date.now());
    expect((await m.other.balance()).pending + (await m.other.balance()).spendable).toBe(0n);

    // a token for a different amount is refused (a fresh token comes back)
    const mismatch = await call<WithdrawConfirmDto>(d.url, 'POST', '/api/wallet/withdraw', { to, amountZats: '20000000', confirm: first.body.confirm });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.confirm).not.toBe(first.body.confirm);
    const wrong = await call<WithdrawConfirmDto>(d.url, 'POST', '/api/wallet/withdraw', { to, amountZats: '10000000', confirm: 'ab'.repeat(16) });
    expect(wrong.status).toBe(409);

    const ok = await call<WithdrawResultDto>(d.url, 'POST', '/api/wallet/withdraw', { to, amountZats: '10000000', confirm: first.body.confirm });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ zats: '10000000', network: 'main' });
    expect(node.capSpentZats()).toBe(0n);
    // tokens are single-use
    await waitFor(async () => (await m.backend.balance()).pending === 0n, 'change confirmed');
    const replay = await call<WithdrawConfirmDto>(d.url, 'POST', '/api/wallet/withdraw', { to, amountZats: '10000000', confirm: first.body.confirm });
    expect(replay.status).toBe(409);
  });
});
