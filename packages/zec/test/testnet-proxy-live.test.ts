/**
 * Live check that the sidecar's connections to the real testnet lightwalletd go through a SOCKS5
 * proxy: an in-process SOCKS5 server (test/socks-server.ts) records every CONNECT and does the DNS
 * itself, so the destination must arrive as a hostname. Opt-in like the other live tests (network,
 * a built sidecar, a throwaway wallet in a temp dir, no funds):
 *
 *   cd zec-sidecar && cargo build --release
 *   SILICR_TESTNET_LIVE=1 pnpm --filter @silicr/zec exec vitest run test/testnet-proxy-live.test.ts
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SERVER, createTestnetBackend, defaultSidecarPath } from '../src/testnet/index.ts';
import { startSocksServer, type SocksTestServer } from './socks-server.ts';

const BIN = process.env['SILICR_ZEC_SIDECAR'] ?? defaultSidecarPath();
const LIVE = process.env['SILICR_TESTNET_LIVE'] === '1' && existsSync(BIN);
const HOST = DEFAULT_SERVER.replace(/:\d+$/, '');
const run = promisify(execFile);

describe.skipIf(!LIVE)('sidecar through a SOCKS5 proxy (live, no funds)', () => {
  let socks: SocksTestServer;
  let dir: string;

  beforeAll(async () => {
    // The proxy resolves names itself, as Tor would; the sidecar must never do that.
    socks = await startSocksServer({ resolve: (host, port) => ({ host, port }) });
    dir = await mkdtemp(join(tmpdir(), 'silicr-proxy-live-'));
  });

  afterAll(async () => {
    await socks?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('`info` reaches testnet through the proxy, sending the hostname', async () => {
    const before = socks.seen.length;
    const t = Date.now();
    const { stdout } = await run(BIN, ['info', '--server', DEFAULT_SERVER, '--proxy', socks.url], { env: { ...process.env, SILICR_PROXY: '' } });
    const info = JSON.parse(stdout) as Record<string, unknown>;
    console.log(`info via proxy: ${Date.now() - t} ms, tip ${String(info['blockHeight'])}`);
    expect(info['chainName']).toBe('test');
    expect(info['proxy']).toBe(socks.url);
    expect(info['blockHeight']).toBeGreaterThan(4_427_000);
    expect(socks.seen.slice(before)).toEqual([{ atyp: 'domain', host: HOST, port: 443 }]);
  }, 60_000);

  it('a wallet syncs and watches the mempool through the proxy; nothing connects directly', async () => {
    const before = socks.connections;
    const t = Date.now();
    const b = await createTestnetBackend({ kind: 'testnet', dataDir: join(dir, 'wallet'), create: true, proxy: socks.url, logFile: null });
    try {
      console.log(`wallet ready via proxy: ${Date.now() - t} ms, sync ${b.startup.syncMs} ms, tip ${b.startup.tip}`);
      expect(b.proxy).toBe(socks.url);
      expect(b.startup.proxy).toBe(socks.url);
      expect(b.startup.tip).toBeGreaterThan(4_427_000);
      expect(await b.height()).toBeGreaterThan(4_427_000);
      const info = await b.info();
      expect(info['proxy']).toBe(socks.url);
      // The main client plus the mempool stream: at least two tunnels, every one of them to the hostname.
      expect(socks.connections - before).toBeGreaterThanOrEqual(2);
      for (const c of socks.seen) expect(c).toEqual({ atyp: 'domain', host: HOST, port: 443 });
    } finally {
      await b.close();
    }
  }, 180_000);

  it('refuses to start when the proxy is unreachable, instead of connecting directly', async () => {
    const dead = await startSocksServer();
    const port = dead.port;
    await dead.close();
    const t = Date.now();
    await expect(createTestnetBackend({ kind: 'testnet', dataDir: join(dir, 'wallet-dead'), create: true, proxy: `socks5h://127.0.0.1:${port}`, logFile: null, startupTimeoutMs: 60_000 })).rejects.toThrow(
      /via SOCKS5 proxy socks5h:\/\/127\.0\.0\.1:\d+: SOCKS5 proxy .* is unreachable/,
    );
    expect(Date.now() - t).toBeLessThan(30_000);
  }, 90_000);
});
