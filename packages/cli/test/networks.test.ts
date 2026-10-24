// What users can pick: Zcash testnet or mainnet. The simulated chain is test-only; the demo is testnet-only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/program.ts';

let tmp: string;
let errors: string[];
let saved: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'silicr-cli-net-'));
  errors = [];
  saved = process.env['SILICR_TEST_MEMORY_NETWORK'];
  delete process.env['SILICR_TEST_MEMORY_NETWORK'];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (saved !== undefined) process.env['SILICR_TEST_MEMORY_NETWORK'] = saved;
  await rm(tmp, { recursive: true, force: true });
});

const run = (...args: string[]) => buildProgram().exitOverride().parseAsync(args, { from: 'user' });
// eslint-disable-next-line no-control-regex
const errText = () => errors.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

describe('networks offered to users', () => {
  it('init and daemon help list test and main only; demo help says testnet', () => {
    const p = buildProgram();
    for (const name of ['init', 'daemon']) {
      const help = p.commands.find((c) => c.name() === name)!.helpInformation();
      expect(help).toMatch(/test = Zcash testnet/);
      expect(help).toMatch(/main = Zcash mainnet/);
      expect(help).not.toMatch(/memory|simulated/i);
    }
    const demo = p.commands.find((c) => c.name() === 'demo')!.helpInformation();
    expect(demo).toMatch(/Zcash testnet/);
    expect(demo).not.toMatch(/simulated|--fast/);
  });

  it('init refuses --network memory outside the test harness', async () => {
    await expect(run('init', '--role', 'buyer', '--network', 'memory', '--data', join(tmp, 'b'))).rejects.toThrow(/exit 1/);
    expect(errText()).toMatch(/--network must be test \(Zcash testnet\) or main/);
  });

  it('daemon refuses --network memory outside the test harness', async () => {
    await expect(run('daemon', '--role', 'buyer', '--network', 'memory', '--data', join(tmp, 'b'))).rejects.toThrow(/exit 1/);
    expect(errText()).toMatch(/--network must be test/);
  });

  it('daemon refuses --public-demo on mainnet before opening a wallet', async () => {
    await expect(run('daemon', '--role', 'buyer', '--network', 'main', '--data', join(tmp, 'm'), '--cap-per-request', '0.01', '--cap-total', '0.02', '--public-demo')).rejects.toThrow(/exit 1/);
    expect(errText()).toMatch(/--public-demo is refused on Zcash mainnet/);
  });

  it('daemon refuses a non-loopback --host without --public-origin', async () => {
    await expect(run('daemon', '--role', 'buyer', '--network', 'test', '--data', join(tmp, 't'), '--host', '0.0.0.0')).rejects.toThrow(/exit 1/);
    expect(errText()).toMatch(/needs --public-origin/);
  });

  it('demo refuses mainnet', async () => {
    await expect(run('demo', '--network', 'main')).rejects.toThrow(/exit 1/);
    expect(errText()).toMatch(/testnet only/);
    expect(errText()).toMatch(/mainnet \(real ZEC\) is refused/);
  });

  it('demo needs the testnet wallets and says how to create them', async () => {
    await expect(run('demo', '--buyer-data', join(tmp, 'nob'), '--provider-data', join(tmp, 'nop'), '--port-base', '7790')).rejects.toThrow(/exit 1/);
    expect(errText()).toMatch(/no testnet buyer wallet/);
    expect(errText()).toMatch(/silicr init --role buyer --network test/);
  });
});
