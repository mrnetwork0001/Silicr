/**
 * Live testnet checks that need no funds: a throwaway wallet against testnet.zec.rocks.
 * Opt-in (they touch the network and need the Rust sidecar built):
 *
 *   cd zec-sidecar && cargo build --release
 *   SILICR_TESTNET_LIVE=1 pnpm --filter @silicr/zec exec vitest run test/testnet-live.test.ts
 */
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InsufficientFundsError, MEMO_SIZE, PrivacyError, isOrchardOnly, toOrchardOnly } from '../src/index.ts';
import { TxNotKnownError, createTestnetBackend, defaultSidecarPath, type TestnetBackend } from '../src/testnet/index.ts';
import type { Sidecar } from '../src/testnet/sidecar.ts';

const LIVE = process.env['SILICR_TESTNET_LIVE'] === '1' && existsSync(process.env['SILICR_ZEC_SIDECAR'] ?? defaultSidecarPath());
const dataDir = fileURLToPath(new URL(`../../../.silicr/wallets/test-live-${process.pid}-${Date.now()}`, import.meta.url));
const PROVIDER = 'utest1due6gq77zyyt85k0w6fdrwh3aaytc2pmvzfdszlvtp9dn8ap6xk98r2vjszuf27ec40memtv3m8zfvk6ad9r23ts5akp5c93mgvnnqx9';
const PUBLIC_TX = '3229fe47ebc9b381914dc964bc9603ec998bd86680e9097aaa4c0a847a01ccab';

describe.skipIf(!LIVE)('testnet backend (live, no funds)', () => {
  let b: TestnetBackend;

  beforeAll(async () => {
    b = await createTestnetBackend({ kind: 'testnet', dataDir, create: true });
  }, 120_000);

  afterAll(async () => {
    await b?.close();
    // A throwaway wallet that never held funds.
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates and syncs a fresh wallet quickly', () => {
    expect(b.startup.network).toBe('test');
    expect(b.startup.tip).toBeGreaterThan(4_427_000);
    expect(b.startup.syncMs).toBeLessThan(30_000);
  });

  it('hands out Orchard-only UAs, fresh ones on newAddress()', async () => {
    const a = await b.address();
    expect(isOrchardOnly(a)).toBe(true);
    expect(toOrchardOnly(a, 'test')).toBe(a);
    expect(await b.address()).toBe(a);
    const d1 = await b.newAddress();
    const d2 = await b.newAddress();
    for (const d of [d1, d2]) {
      expect(isOrchardOnly(d)).toBe(true);
      expect(d.startsWith('utest1')).toBe(true);
    }
    expect(new Set([a, d1, d2]).size).toBe(3);
  });

  it('reports height, an empty balance and no notes', async () => {
    expect(await b.height()).toBeGreaterThan(4_427_000);
    expect(await b.balance()).toMatchObject({ spendable: 0n, pending: 0n });
    expect(await b.poll(0)).toEqual([]);
    const info = await b.info();
    expect(info['network']).toBe('test');
  });

  it('refuses to inspect a transaction it holds no data about, instead of asking the server', async () => {
    // A real public v6 Ironwood tx this throwaway wallet never touched. Looking it up remotely would
    // tell the light-wallet server that this IP cares about it, so the backend must refuse.
    const t0 = Date.now();
    await expect(b.inspectTx(PUBLIC_TX)).rejects.toBeInstanceOf(TxNotKnownError);
    await expect(b.inspectTx(PUBLIC_TX)).rejects.toThrow(/never asks the light-wallet server/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('refuses non-Orchard recipients (TS guard) and reports insufficient funds (sidecar)', async () => {
    const memo = new Uint8Array(MEMO_SIZE);
    await expect(b.send([{ to: 'tmWK81GXyxz8D259FJPkmfpdLXD32F741co', zats: 1000n, memo }])).rejects.toBeInstanceOf(PrivacyError);
    await expect(b.send([{ to: PROVIDER, zats: 1000n, memo }])).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('the sidecar refuses non-Orchard recipients on its own (defence in depth)', async () => {
    const s = (b as unknown as { sidecar: Sidecar }).sidecar;
    const memoHex = '00'.repeat(MEMO_SIZE);
    for (const to of ['tmWK81GXyxz8D259FJPkmfpdLXD32F741co', 'ztestsapling1v6wh0dawepflf7yx5722fr77yatrl22hmg0ffd2tdxfl9rr356fper8gznajnl6ww3tuj67zv60']) {
      await expect(s.request('send', { outputs: [{ to, zats: '1000', memoHex }] })).rejects.toBeInstanceOf(PrivacyError);
    }
  });
});
