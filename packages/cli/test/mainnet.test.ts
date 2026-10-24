// Mainnet mode in the CLI: `init --network main` needs the caps and writes them, `daemon` refuses
// mainnet without them, `run` / `accept` need a go-ahead (or --yes) before real funds move, and
// `status` / `provide` label mainnet. The wallet backend is mocked out and the daemon is a stub
// HTTP server: nothing here touches a real network.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RfqDto, StatusDto } from '@silicr/api';
import { buildProgram } from '../src/program.ts';
import { defaultDataDir } from '../src/config.ts';
import { resolveCaps } from '../src/commands/node.ts';

vi.mock('@silicr/zec', async (importOriginal) => {
  const real = await importOriginal<typeof import('@silicr/zec')>();
  return { ...real, openBackend: vi.fn(async () => Promise.reject(new Error('no wallet backend in tests'))) };
});

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const TINY = join(REPO, 'examples', 'tiny-train');
const RFQ_ID = 'ab'.repeat(16);
const PROVIDER_ID = 'cd'.repeat(32);

let tmp: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'silicr-cli-main-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterAll(async () => {
  exitSpy.mockRestore();
  await rm(tmp, { recursive: true, force: true });
});

/** Run one `silicr …` invocation and capture what it prints. */
async function silicr(...args: string[]): Promise<string> {
  const out: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  try {
    await buildProgram().exitOverride().parseAsync(args, { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  // eslint-disable-next-line no-control-regex
  return out.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

/** Run, expecting `fail()`; returns what was printed (the error line included). */
async function failing(...args: string[]): Promise<string> {
  const out: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  try {
    await expect(buildProgram().exitOverride().parseAsync(args, { from: 'user' })).rejects.toThrow(/exit 1/);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  // eslint-disable-next-line no-control-regex
  return out.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

/** Pretend there is (no) terminal while fn runs. */
async function withTty<T>(tty: boolean, fn: () => Promise<T>): Promise<T> {
  const streams = [process.stdin, process.stdout] as const;
  const prev = streams.map((s) => Object.getOwnPropertyDescriptor(s, 'isTTY'));
  for (const s of streams) Object.defineProperty(s, 'isTTY', { value: tty, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    streams.forEach((s, i) => {
      if (prev[i]) Object.defineProperty(s, 'isTTY', prev[i]!);
      else delete (s as unknown as Record<string, unknown>)['isTTY'];
    });
  }
}

const CAP = { perRfqZats: '1000000', totalZats: '5000000', spentZats: '0' };

/** A stub daemon answering the few endpoints these commands touch. */
async function stubDaemon(status: Partial<StatusDto>): Promise<{ url: string; posts: number; accepts: number; close(): Promise<void> }> {
  const st: StatusDto = {
    role: 'buyer',
    network: 'main',
    height: 3_500_000,
    address: 'u1stub',
    balance: { spendable: '10000000', pending: '0' },
    relayUrl: 'http://127.0.0.1:7700',
    version: '0.1.0',
    demoMode: false,
    blockTimeS: 75,
    spendCap: CAP,
    ...status,
  };
  const rfq: RfqDto = {
    rfqId: RFQ_ID,
    state: 'collecting',
    createdAt: Date.now(),
    request: { gpu: 'a100', count: 1, durationS: 360, maxPricePerHourZats: '1000000' },
    providersAsked: 1,
    paddedOutputs: 4,
    expiresHeight: 3_500_003,
    bids: [
      {
        providerId: PROVIDER_ID,
        alias: 'teal-egret-95',
        pricePerIntervalZats: '100000',
        intervalS: 600,
        pricePerHourZats: '600000',
        startWithinS: 900,
        receivedAt: Date.now(),
        txid: 'ef'.repeat(32),
        height: 3_500_001,
        signatureValid: true,
      },
    ],
    payments: [],
    heartbeats: [],
    logTail: [],
    spentZats: '0',
    feesZats: '0',
  };
  const stub = { url: '', posts: 0, accepts: 0, close: async () => undefined as void };
  const server: Server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = req.url ?? '/';
    if (req.method === 'GET' && path === '/api/status') return send(200, st);
    if (req.method === 'POST' && path === '/api/rfqs') {
      stub.posts += 1;
      return send(201, { rfqId: RFQ_ID });
    }
    if (req.method === 'GET' && path === '/api/rfqs') return send(200, [rfq]);
    if (req.method === 'GET' && path === `/api/rfqs/${RFQ_ID}`) return send(200, rfq);
    if (req.method === 'POST' && path === `/api/rfqs/${RFQ_ID}/accept`) {
      stub.accepts += 1;
      return send(200, { ...rfq, state: 'accepted', accepted: { providerId: PROVIDER_ID, alias: 'teal-egret-95', pricePerIntervalZats: '100000', intervalS: 600, intervals: 1 } });
    }
    if (req.method === 'PUT' && path === '/api/policy') {
      return send(200, { autoBid: true, minPricePerHourZats: '600000', intervalS: 600, graceS: 300, gpus: [{ model: 'a100', count: 1, vramGb: 80 }] });
    }
    return send(404, { error: `no route ${req.method} ${path}`, code: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  stub.url = `http://127.0.0.1:${port}`;
  stub.close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return stub;
}

describe('silicr init / daemon on mainnet', () => {
  it('init --network main needs the caps, and checks them', async () => {
    const dir = join(tmp, 'b-nocap');
    let text = await failing('init', '--role', 'buyer', '--network', 'main', '--data', dir);
    expect(text).toMatch(/Zcash mainnet needs spend caps: add --cap-total <zec> and --cap-per-request <zec>/);
    text = await failing('init', '--role', 'buyer', '--network', 'main', '--data', dir, '--cap-total', '0.05');
    expect(text).toMatch(/--cap-total needs --cap-per-request too/);
    text = await failing('init', '--role', 'buyer', '--network', 'main', '--data', dir, '--cap-per-request', '0.1', '--cap-total', '0.05');
    expect(text).toMatch(/--cap-per-request cannot exceed --cap-total/);
    text = await failing('init', '--role', 'buyer', '--network', 'main', '--data', dir, '--cap-per-request', 'lots', '--cap-total', '0.05');
    expect(text).toMatch(/--cap-per-request: not a ZEC amount/);
    expect(await readFile(join(dir, 'config.json'), 'utf8').catch(() => null)).toBeNull(); // nothing written
    expect(() => resolveCaps('main', 'buyer', undefined, undefined, undefined)).toThrow(/exit 1/);
    expect(resolveCaps('test', 'buyer', undefined, undefined, undefined)).toBeNull();
    expect(resolveCaps('main', 'provider', undefined, '0.02', undefined)).toEqual({ perRfqZats: 2_000_000n, totalZats: 2_000_000n });
    expect(resolveCaps('main', 'buyer', undefined, undefined, { perRfqZats: '1000000', totalZats: '5000000' })).toEqual({ perRfqZats: 1_000_000n, totalZats: 5_000_000n });
  });

  it('init --network main writes the network and the caps (zatoshi strings) and labels real ZEC', async () => {
    const dir = join(tmp, 'b-main');
    const text = await silicr('init', '--role', 'buyer', '--network', 'main', '--data', dir, '--cap-per-request', '0.01', '--cap-total', '0.05');
    expect(text).toMatch(/initialised buyer/);
    expect(text).toMatch(/network +Zcash mainnet · REAL ZEC/);
    expect(text).toMatch(/spend cap +per request ≤ 0\.01 ZEC · total 0\.05 ZEC/);
    expect(text).toMatch(/wallet +not created yet: no wallet backend in tests/); // the (mocked) sidecar, never a real one
    expect(text).toMatch(/spendable after 10 confirmations/);
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toMatchObject({
      role: 'buyer',
      network: 'main',
      port: 7701,
      spendCap: { perRfqZats: '1000000', totalZats: '5000000' },
    });
    expect((await readFile(join(dir, 'master.seed'))).length).toBe(32);
    // a provider only spends fees: --cap-total alone is enough, and becomes its per-request cap too
    const pdir = join(tmp, 'p-main');
    const ptext = await silicr('init', '--role', 'provider', '--network', 'main', '--data', pdir, '--cap-total', '0.002');
    expect(ptext).toMatch(/Zcash mainnet · REAL ZEC/);
    expect(JSON.parse(await readFile(join(pdir, 'config.json'), 'utf8'))).toMatchObject({ role: 'provider', network: 'main', spendCap: { perRfqZats: '200000', totalZats: '200000' } });
    // testnet and memory stay cap-free unless asked
    const tdir = join(tmp, 'b-memory-nocap');
    await silicr('init', '--role', 'buyer', '--network', 'memory', '--data', tdir);
    expect(JSON.parse(await readFile(join(tdir, 'config.json'), 'utf8'))).not.toHaveProperty('spendCap');
  });

  it('default data dirs: .silicr/wallets/main-<role> on mainnet', () => {
    expect(defaultDataDir('buyer', 'main').split(sep).slice(-3)).toEqual(['.silicr', 'wallets', 'main-buyer']);
    expect(defaultDataDir('provider', 'main').split(sep).slice(-3)).toEqual(['.silicr', 'wallets', 'main-provider']);
    expect(defaultDataDir('buyer', 'test').split(sep).slice(-3)).toEqual(['.silicr', 'wallets', 'buyer']);
    expect(defaultDataDir('provider').split(sep).slice(-3)).toEqual(['.silicr', 'wallets', 'provider']); // default network: testnet
  });

  it('daemon --network main refuses to start without caps, before any wallet is opened', async () => {
    const text = await failing('daemon', '--data', join(tmp, 'd-nocap'), '--role', 'buyer', '--network', 'main');
    expect(text).toMatch(/Zcash mainnet needs spend caps/);
    expect(text).not.toMatch(/backend is not available/);
    // with caps it gets as far as the (mocked) wallet, i.e. past the cap check
    const text2 = await failing('daemon', '--data', join(tmp, 'd-cap'), '--role', 'buyer', '--network', 'main', '--cap-per-request', '0.01', '--cap-total', '0.05');
    expect(text2).toMatch(/the Zcash mainnet backend is not available: no wallet backend in tests/);
  });
});

describe('silicr run / accept / status / provide on mainnet', () => {
  let buyer: Awaited<ReturnType<typeof stubDaemon>>;
  let provider: Awaited<ReturnType<typeof stubDaemon>>;
  beforeAll(async () => {
    buyer = await stubDaemon({});
    provider = await stubDaemon({ role: 'provider', alias: 'teal-egret-95', providerId: PROVIDER_ID, spendCap: { perRfqZats: '200000', totalZats: '200000', spentZats: '20000' } });
  });
  afterAll(async () => {
    await buyer.close();
    await provider.close();
  });
  afterEach(() => {
    buyer.posts = 0;
    buyer.accepts = 0;
  });

  it('run prints what it commits and the cap, and needs --yes when there is no terminal', async () => {
    const pre = ['run', '--daemon', buyer.url, '--gpu', 'a100', '--hours', '0.1', '--max', '0.01', '--no-follow'];
    const post = [TINY, '--', 'python3', 'train.py']; // flags go before `--`: after it, everything is the job's command
    const text = await withTty(false, () => failing(...pre, ...post));
    expect(text).toMatch(/Zcash mainnet · REAL ZEC +This commits up to 0\.001 ZEC of real funds \(0\.01 ZEC\/h for 6 min\) plus ~0\.0001 ZEC per transaction in fees \(cap: spent 0 ZEC of 0\.05 ZEC \(per request ≤ 0\.01 ZEC\)\)\./);
    expect(text).toMatch(/re-run with --yes/);
    expect(buyer.posts).toBe(0); // nothing was sent

    const ok = await withTty(false, () => silicr(...pre, '--yes', ...post));
    expect(ok).toMatch(/This commits up to 0\.001 ZEC of real funds/);
    expect(ok).toMatch(/--yes given: continuing/);
    expect(ok).toMatch(/Follow it with: silicr bids/);
    expect(buyer.posts).toBe(1);
  });

  it('accept says what the ACCEPT pays now and what the deal could cost, and needs --yes off a terminal', async () => {
    const text = await withTty(false, () => failing('accept', RFQ_ID, 'teal-egret-95', '--daemon', buyer.url, '--no-follow'));
    expect(text).toMatch(/This pays teal-egret-95 0\.001 ZEC now \(interval 0\) and commits up to 0\.001 ZEC of real funds in all \(1 × 600 s intervals\) plus fees \(cap: spent 0 ZEC of 0\.05 ZEC/);
    expect(buyer.accepts).toBe(0);
    const ok = await withTty(false, () => silicr('accept', RFQ_ID, 'teal-egret-95', '--daemon', buyer.url, '--no-follow', '--yes'));
    expect(ok).toMatch(/accepted teal-egret-95/);
    expect(buyer.accepts).toBe(1);
  });

  it('status shows "Zcash mainnet · REAL ZEC" and the cap line for both roles', async () => {
    const text = await silicr('status', '--buyer', buyer.url, '--provider', provider.url);
    expect(text).toMatch(/buyer[\s\S]*network +Zcash mainnet · REAL ZEC/);
    expect(text).toMatch(/spend cap +spent 0 ZEC of 0\.05 ZEC \(per request ≤ 0\.01 ZEC\)/);
    expect(text).toMatch(/provider[\s\S]*spend cap +spent 0\.0002 ZEC of 0\.002 ZEC \(per request ≤ 0\.002 ZEC\)/);
    expect(text).toMatch(/~75 s blocks/);
  });

  it('provide prints a one-line mainnet notice', async () => {
    const text = await silicr('provide', '--daemon', provider.url, '--gpu', 'a100', '--min', '0.006', '--vram', '80');
    expect(text).toMatch(/Zcash mainnet · REAL ZEC +each BID and CLOSE costs this wallet ~0\.0001 ZEC in fees; earnings arrive shielded \(cap: spent 0\.0002 ZEC of 0\.002 ZEC/);
    expect(text).toMatch(/directory entry published/);
  });
});
