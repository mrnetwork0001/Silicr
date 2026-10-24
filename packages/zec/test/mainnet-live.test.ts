/**
 * Read-only mainnet checks: a throwaway, never-funded wallet in a temp dir against the public
 * mainnet lightwalletd. NOTHING here can spend: the wallet holds no funds, no `send` is ever
 * called, and the only server calls are GetLightdInfo, the tree state at the birthday, compact
 * blocks and the mempool stream. Opt-in, like every live test (CLAUDE.md: tests never touch
 * mainnet unless you ask for exactly this):
 *
 *   cd zec-sidecar && cargo build --release
 *   SILICR_MAINNET_LIVE=1 pnpm --filter @silicr/zec exec vitest run test/mainnet-live.test.ts
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrivacyError, MEMO_SIZE, isOrchardOnly, toOrchardOnly } from '../src/index.ts';
import { DEFAULT_MAINNET_SERVER, TxNotKnownError, createSidecarBackend, defaultSidecarPath, type SidecarBackend } from '../src/testnet/index.ts';

const BIN = process.env['SILICR_ZEC_SIDECAR'] ?? defaultSidecarPath();
const LIVE = process.env['SILICR_MAINNET_LIVE'] === '1' && existsSync(BIN);
const run = promisify(execFile);

/** NU6.3 (Ironwood) on mainnet: height 3,428,143 (2026-07-28); its consensus branch id. */
const MAINNET_NU6_3_HEIGHT = 3_428_143;
const NU6_3_BRANCH = '37a5165b';
/** A public mainnet v6 (Ironwood, 1 action, fully shielded) transaction at height 3,525,783, listed with `zec-sidecar find-txs --network main` on 2026-10-21. */
const PUBLIC_MAINNET_V6_TX = process.env['SILICR_MAINNET_PUBLIC_TXID'] ?? '1970d5300134f94c325c7a41aae7ffbf18c7a58720f815e4a753fd784373fef0';
const TESTNET_ADDR = 'utest1due6gq77zyyt85k0w6fdrwh3aaytc2pmvzfdszlvtp9dn8ap6xk98r2vjszuf27ec40memtv3m8zfvk6ad9r23ts5akp5c93mgvnnqx9';

describe.skipIf(!LIVE)('mainnet backend (live, read-only, no funds)', () => {
  let b: SidecarBackend;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'silicr-mainnet-live-'));
  });

  afterAll(async () => {
    await b?.close();
    // A throwaway wallet that never held funds.
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('`info --network main` reports chain main on the Ironwood branch', async () => {
    const t = Date.now();
    const { stdout } = await run(BIN, ['info', '--network', 'main', '--server', DEFAULT_MAINNET_SERVER], { env: { ...process.env, SILICR_PROXY: '' } });
    const info = JSON.parse(stdout) as Record<string, unknown>;
    console.log(`mainnet info: ${Date.now() - t} ms, tip ${String(info['blockHeight'])}, ${String(info['vendor'])} ${String(info['version'])}`);
    expect(info['network']).toBe('main');
    expect(info['chainName']).toBe('main');
    expect(info['consensusBranchId']).toBe(NU6_3_BRANCH);
    expect(info['blockHeight']).toBeGreaterThan(MAINNET_NU6_3_HEIGHT);
  }, 60_000);

  it('refuses a testnet server for a mainnet wallet (chain mismatch), before any wallet is created', async () => {
    const r = await run(BIN, ['info', '--network', 'main', '--server', 'testnet.zec.rocks:443'], { env: { ...process.env, SILICR_PROXY: '' } }).catch((e: { stderr: string; code: number }) => e);
    expect((r as { code?: number }).code).not.toBe(0);
    expect((r as { stderr: string }).stderr).toMatch(/reports chain "test" but this sidecar was started with --network main/);
  }, 60_000);

  it('creates and syncs a throwaway mainnet wallet (about 100 blocks)', async () => {
    const t = Date.now();
    b = await createSidecarBackend({ kind: 'sidecar', network: 'main', dataDir: join(dir, 'wallet'), create: true, logFile: null });
    console.log(`mainnet wallet ready: ${Date.now() - t} ms total, initial sync ${b.startup.syncMs} ms (${b.startup.scannedBlocks} blocks), tip ${b.startup.tip}, birthday ${b.startup.birthday}`);
    expect(b.network).toBe('main');
    expect(b.startup.network).toBe('main');
    expect(b.startup.tip).toBeGreaterThan(MAINNET_NU6_3_HEIGHT);
    expect(b.startup.birthday).toBeGreaterThan(MAINNET_NU6_3_HEIGHT);
    expect(await b.height()).toBeGreaterThan(MAINNET_NU6_3_HEIGHT);
    const info = await b.info();
    expect(info['network']).toBe('main');
    expect(info['consensusBranchId']).toBe(NU6_3_BRANCH);
  }, 180_000);

  it('hands out u1… Orchard-only addresses, byte-identical to toOrchardOnly', async () => {
    const a = await b.address();
    expect(a.startsWith('u1')).toBe(true);
    expect(isOrchardOnly(a)).toBe(true);
    expect(toOrchardOnly(a, 'main')).toBe(a);
    const d1 = await b.newAddress();
    const d2 = await b.newAddress();
    for (const d of [d1, d2]) {
      expect(d.startsWith('u1')).toBe(true);
      expect(toOrchardOnly(d, 'main')).toBe(d);
    }
    expect(new Set([a, d1, d2]).size).toBe(3);
    // A testnet address can never be paid from here (the guard refuses before the sidecar is asked).
    await expect(b.send([{ to: TESTNET_ADDR, zats: 1n, memo: new Uint8Array(MEMO_SIZE) }])).rejects.toBeInstanceOf(PrivacyError);
  });

  it('holds nothing, and never asks the server about a transaction it did not touch', async () => {
    expect(await b.balance()).toMatchObject({ spendable: 0n, pending: 0n });
    expect(await b.poll(0)).toEqual([]);
    if (/^[0-9a-f]{64}$/.test(PUBLIC_MAINNET_V6_TX)) {
      // Local data only: this public transaction never paid this wallet, so there is no view of it.
      await expect(b.inspectTx(PUBLIC_MAINNET_V6_TX)).rejects.toBeInstanceOf(TxNotKnownError);
    }
  });
});
