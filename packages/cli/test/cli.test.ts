// The `silicr` program against a real in-process stack (memory chain, relay, both daemons) on ephemeral ports.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_PROFILE, startLocalStack, withOverrides, type LocalStack } from '@silicr/engine';
import { unpackBundle } from '@silicr/runner';
import { buildProgram } from '../src/program.ts';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const TINY = join(REPO, 'examples', 'tiny-train');

let stack: LocalStack;
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'silicr-cli-'));
  stack = await startLocalStack({
    rootDir: join(tmp, 'stack'),
    fresh: true,
    blockTimeMs: 100,
    profile: withOverrides(FAST_PROFILE, { blockTimeS: 0.1, pollMs: 50, bidWindowBlocks: 50, intervalS: 1, heartbeatS: 0.2, heartbeatTimeoutS: 3, relayWaitS: 1 }),
    ports: { relay: 0, buyer: 0, provider: 0 },
    runnerMode: 'process',
    providerPolicy: { gpus: [{ model: 'a100', count: 1, vramGb: 80 }], minPricePerHourZats: 60_000_000n },
  });
}, 30_000);

afterAll(async () => {
  await stack?.close();
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

describe('silicr CLI', () => {
  it('has every command', () => {
    const names = buildProgram().commands.map((c) => c.name());
    for (const n of ['demo', 'init', 'daemon', 'relay', 'run', 'provide', 'status', 'rfqs', 'jobs', 'bids', 'accept', 'stop', 'result', 'fault', 'migrate', 'wallet', 'withdraw']) {
      expect(names).toContain(n);
    }
  });

  it('init writes a config and a provider identity', async () => {
    const dir = join(tmp, 'p-init');
    const text = await silicr('init', '--role', 'provider', '--network', 'memory', '--data', dir);
    expect(text).toMatch(/initialised provider/);
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toMatchObject({ role: 'provider', network: 'memory', port: 7702 });
    expect((await readFile(join(dir, 'identity.key'))).length).toBe(32);
    const b = join(tmp, 'b-init');
    await silicr('init', '--role', 'buyer', '--network', 'memory', '--data', b);
    expect((await readFile(join(b, 'master.seed'))).length).toBe(32);
  });

  it('status shows both daemons, labelled as a simulated chain', async () => {
    const text = await silicr('status', '--buyer', stack.buyerDaemon.url, '--provider', stack.providerDaemon!.url);
    expect(text).toMatch(/buyer/);
    expect(text).toMatch(/memory: SIMULATED chain/);
    expect(text).toContain(stack.provider!.alias);
    expect(text).toMatch(/NOT a sandbox/);
  });

  it('provide sets the policy and republishes the directory entry', async () => {
    const text = await silicr('provide', '--daemon', stack.providerDaemon!.url, '--gpu', 'a100', '--count', '2', '--min', '0.6zec/h', '--vram', '80');
    expect(text).toMatch(/directory entry published/);
    expect(text).toMatch(/2× a100 \(80 GB\)/);
    expect(text).toMatch(/0\.6 ZEC\/h/);
    expect(stack.provider!.getPolicy()).toMatchObject({ minPricePerHourZats: '60000000', gpus: [{ model: 'a100', count: 2, vramGb: 80 }] });
  });

  it('run --auto streams the deal to the end and saves the result', async () => {
    const out = join(tmp, 'result.tar.gz');
    const text = await silicr(
      'run', '--daemon', stack.buyerDaemon.url, '--gpu', 'a100', '--hours', '0.1', '--max', '0.8', '--auto',
      '--env', 'SILICR_STEPS=60', '--env', 'SILICR_STEP_DELAY_MS=30', '--out', out, TINY, '--', 'python3', 'train.py',
    );
    expect(text).toMatch(/budget undisclosed to providers/);
    expect(text).toMatch(/RFQ .*sealed to 1 provider\(s\) in 1 tx, 4 outputs after padding/);
    expect(text).toMatch(/CHAIN .*shielded \((Ironwood|Orchard)\) actions/);
    expect(text).toMatch(/BID .*signature valid/);
    expect(text).toMatch(/ACCEPT .*interval #0 paid/);
    expect(text).toMatch(/PAY +#1 /);
    expect(text).toMatch(/HB .*finished/);
    expect(text).toMatch(/digest matches the provider's signed CLOSE/);
    expect(text).toMatch(/CLOSE +done/);
    expect(existsSync(out)).toBe(true);
    const dir = join(tmp, 'unpacked');
    await unpackBundle(new Uint8Array(await readFile(out)), dir);
    expect(existsSync(join(dir, 'metrics.json'))).toBe(true);

    const id = stack.buyer.listRfqs()[0]!.rfqId;
    expect(await silicr('rfqs', '--daemon', stack.buyerDaemon.url)).toMatch(new RegExp(`${id.slice(0, 12)}.*closed`));
    const bids = await silicr('bids', id.slice(0, 8), '--daemon', stack.buyerDaemon.url);
    expect(bids).toContain(stack.provider!.alias);
    expect(bids).toMatch(/valid/);
    const res2 = join(tmp, 'again.tar.gz');
    expect(await silicr('result', id.slice(0, 10), '-o', res2, '--daemon', stack.buyerDaemon.url)).toMatch(/saved/);
    expect((await readFile(res2)).equals(await readFile(out))).toBe(true);
    expect(await silicr('jobs', '--daemon', stack.providerDaemon!.url)).toMatch(new RegExp(`${id.slice(0, 12)}.*done`));
  }, 60_000);

  it('migrate opens a new RFQ that resumes from the latest checkpoint and stops the old one', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      const { rfqId } = await stack.buyer.createRfq({
        gpu: 'a100',
        count: 1,
        durationS: 600,
        maxPricePerHourZats: '80000000',
        job: { path: TINY, command: ['python3', 'train.py'], env: { SILICR_STEPS: '100000', SILICR_STEP_DELAY_MS: '20', SILICR_CHECKPOINT_EVERY: '10' } },
        autoAccept: { rule: 'cheapest', waitBlocks: 1 },
      });
      // before any checkpoint: refused with a clear message
      const early = stack.buyer.getRfq(rfqId).checkpoint === undefined ? await silicr('migrate', rfqId.slice(0, 10), '--daemon', stack.buyerDaemon.url).catch((e: Error) => e.message) : 'exit 1';
      expect(early).toMatch(/exit 1/);
      const deadline = Date.now() + 20_000;
      while (stack.buyer.getRfq(rfqId).checkpoint === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const old = stack.buyer.getRfq(rfqId);
      expect(old.checkpoint).toBeDefined();
      const text = await silicr('migrate', rfqId.slice(0, 10), '--no-follow', '--daemon', stack.buyerDaemon.url);
      expect(text).toMatch(new RegExp(`migrating ${rfqId.slice(0, 12)}.*→ new RFQ .*resumes from the checkpoint of interval ${old.checkpoint!.seq}`));
      const newId = stack.buyer.getRfq(rfqId).migratedTo!;
      expect(newId).toBeDefined();
      expect(stack.buyer.getRfq(newId).migratedFrom).toEqual({ rfqId, seq: old.checkpoint!.seq });
      // the old RFQ was stopped; the new one runs and the provider resumed from the checkpoint
      const until = Date.now() + 30_000;
      while (!(stack.buyer.getRfq(rfqId).state === 'closed' && stack.buyer.getRfq(newId).state === 'running') && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(stack.buyer.getRfq(rfqId).closeReason).toBe('buyer_stop');
      expect(stack.buyer.getRfq(newId).state).toBe('running');
      expect(stack.provider!.getJob(newId).resumedFromSeq).toBe(old.checkpoint!.seq);
      expect(await silicr('rfqs', '--daemon', stack.buyerDaemon.url)).toMatch(new RegExp(`${newId.slice(0, 12)}.*running`));
      // a second migration is refused
      await expect(silicr('migrate', rfqId.slice(0, 10), '--daemon', stack.buyerDaemon.url)).rejects.toThrow(/exit 1/);
      await silicr('stop', newId.slice(0, 10), '--daemon', stack.buyerDaemon.url);
      const end = Date.now() + 20_000;
      while (stack.buyer.getRfq(newId).state !== 'closed' && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    } finally {
      exit.mockRestore();
    }
  }, 90_000);

  it('init --proxy stores the proxy and status shows the network posture', async () => {
    const dir = join(tmp, 'b-proxy');
    const text = await silicr('init', '--role', 'buyer', '--network', 'memory', '--data', dir, '--proxy', 'socks5h://127.0.0.1:9050');
    expect(text).toMatch(/proxy +socks5h:\/\/127\.0\.0\.1:9050 \(SOCKS5: IP hidden/);
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toMatchObject({ proxy: 'socks5h://127.0.0.1:9050' });
    // The demo stack runs without a proxy, and says so.
    const status = await silicr('status', '--buyer', stack.buyerDaemon.url, '--provider', stack.providerDaemon!.url);
    expect(status).toMatch(/proxy +none: direct connections, IP visible/);
  });

  it('refuses a proxy that is not SOCKS5 instead of ignoring it', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      await expect(silicr('init', '--role', 'buyer', '--network', 'memory', '--data', join(tmp, 'b-badproxy'), '--proxy', 'http://127.0.0.1:8118')).rejects.toThrow(/exit 1/);
      await expect(silicr('daemon', '--data', join(tmp, 'x'), '--role', 'buyer', '--network', 'memory', '--proxy', 'socks4://127.0.0.1:1080')).rejects.toThrow(/exit 1/);
    } finally {
      exit.mockRestore();
    }
  });

  it('rejects mainnet and bad fault names with clear errors', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      await expect(silicr('daemon', '--data', join(tmp, 'x'), '--role', 'buyer', '--network', 'main')).rejects.toThrow();
      await expect(silicr('fault', '0'.repeat(32), 'explode', '--daemon', stack.buyerDaemon.url)).rejects.toThrow(/exit 1/);
    } finally {
      exit.mockRestore();
    }
  });
});

describe('silicr wallet / withdraw', () => {
  it('wallet prints the deposit address, the ZIP 321 URI and a QR; withdraw sends to an Orchard address', async () => {
    const url = stack.providerDaemon!.url;
    const text = await silicr('wallet', '--daemon', url, '--amount', '0.05');
    const addr = (await stack.provider!.status()).address;
    expect(text).toContain(addr);
    expect(text).toContain(`zcash:${addr}?amount=0.05`);
    expect(text).toMatch(/[█▀▄]/); // the QR
    expect(text).toMatch(/spendable after 1 confirmation/);
    expect(text).toMatch(/memory: SIMULATED chain/);

    const dest = await stack.network.wallet('cli-dest').address();
    // The shared stack's provider may still be finishing an earlier test's job (409 busy) or hold
    // only unconfirmed change: neither is what this test is about.
    stack.network.mine();
    const sent = await silicr('withdraw', dest, '0.01', '--force', '--daemon', url);
    expect(sent).toMatch(/sent\s+0\.01 ZEC/);
    expect(sent).toMatch(/txid\s+[0-9a-f]{64}/);
    await expect(silicr('withdraw', 'tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd', '0.01', '--daemon', url)).rejects.toThrow(/Refusing transparent address/);
  });
});
