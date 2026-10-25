// `silicr daemon --gpu <model> --count <n> --vram <gb>`: the GPUs a provider advertises, seeded into
// the policy on start and persisted (the hosted demo provider has no policy.json copied over and
// PUT /api/policy is disabled, so this is how it stops advertising "1× cpu").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRelay } from '@silicr/relay';
import { buildProgram } from '../src/program.ts';
import { resolveGpuFlags, startParty } from '../src/commands/node.ts';

let tmp: string;
let errors: string[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'silicr-cli-gpu-'));
  errors = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

const run = (...args: string[]) => buildProgram().exitOverride().parseAsync(args, { from: 'user' });
// eslint-disable-next-line no-control-regex
const errText = () => errors.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

describe('resolveGpuFlags', () => {
  it('no --gpu: null, the persisted policy stays', () => {
    expect(resolveGpuFlags('provider', undefined, undefined, undefined)).toBeNull();
    expect(resolveGpuFlags('buyer', undefined, undefined, undefined)).toBeNull();
  });

  it('--gpu a100 --count 1 --vram 80 (the hosted demo) and the defaults count 1, vram 0', () => {
    expect(resolveGpuFlags('provider', 'a100', '1', '80')).toEqual([{ model: 'a100', count: 1, vramGb: 80 }]);
    expect(resolveGpuFlags('provider', 'h100', undefined, undefined)).toEqual([{ model: 'h100', count: 1, vramGb: 0 }]);
    expect(resolveGpuFlags('provider', ' A100 ', '8', '40.5')).toEqual([{ model: 'a100', count: 8, vramGb: 40.5 }]);
  });

  it('refuses --count or --vram without --gpu, a buyer, a bad slug, a bad count and a bad vram', () => {
    const bad = (role: 'buyer' | 'provider', gpu?: string, count?: string, vram?: string, re?: RegExp) => {
      errors = [];
      expect(() => resolveGpuFlags(role, gpu, count, vram)).toThrow(/exit 1/);
      expect(errText()).toMatch(re!);
    };
    bad('provider', undefined, '2', undefined, /--count and --vram go with --gpu/);
    bad('provider', undefined, undefined, '80', /--count and --vram go with --gpu/);
    bad('buyer', 'a100', undefined, undefined, /provider flags/);
    bad('provider', 'A100 80GB', undefined, undefined, /--gpu must be a slug/);
    bad('provider', 'a-very-long-gpu-model-name', undefined, undefined, /--gpu must be a slug/);
    bad('provider', 'a100', '0', undefined, /--count must be an integer 1\.\.64/);
    bad('provider', 'a100', '1.5', undefined, /--count must be an integer 1\.\.64/);
    bad('provider', 'a100', '65', undefined, /--count must be an integer 1\.\.64/);
    bad('provider', 'a100', undefined, '-1', /--vram must be a number of GB/);
    bad('provider', 'a100', undefined, '80GB', /--vram must be a number of GB/);
  });
});

describe('silicr daemon --gpu', () => {
  it('--help documents --gpu, --count and --vram', () => {
    const help = buildProgram().commands.find((c) => c.name() === 'daemon')!.helpInformation();
    expect(help).toMatch(/--gpu <model>/);
    expect(help).toMatch(/--count <n>/);
    expect(help).toMatch(/--vram <gb>/);
    expect(help).toMatch(/policy\.json/);
  });

  it('a buyer daemon refuses --gpu, and --count needs --gpu, before any wallet is opened', async () => {
    await expect(run('daemon', '--role', 'buyer', '--network', 'test', '--data', join(tmp, 'b'), '--gpu', 'a100')).rejects.toThrow(/exit 1/);
    expect(errText()).toMatch(/provider flags/);
    expect(errText()).not.toMatch(/backend is not available/);
    errors = [];
    await expect(run('daemon', '--role', 'provider', '--network', 'test', '--data', join(tmp, 'p'), '--count', '2')).rejects.toThrow(/exit 1/);
    expect(errText()).toMatch(/--count and --vram go with --gpu/);
    expect(errText()).not.toMatch(/backend is not available/);
  });

  it('seeds the policy on start and persists it: a restart without --gpu keeps the GPUs', async () => {
    const relay = await startRelay({ port: 0, dataDir: join(tmp, 'relay') });
    const dataDir = join(tmp, 'provider');
    const common = { role: 'provider' as const, network: 'memory' as const, dataDir, relayUrl: relay.url, port: 0, proxy: null, spendCap: null, blobTransport: 'relay' as const, runner: 'process' as const, demoMode: false, log: () => undefined };
    try {
      const first = await startParty({ ...common, policy: { gpus: resolveGpuFlags('provider', 'a100', '1', '80')! } });
      try {
        const node = first.node as import('@silicr/engine').ProviderNode;
        expect(node.getPolicy().gpus).toEqual([{ model: 'a100', count: 1, vramGb: 80 }]);
        const saved = JSON.parse(await readFile(join(dataDir, 'policy.json'), 'utf8')) as { gpus: unknown };
        expect(saved.gpus).toEqual([{ model: 'a100', count: 1, vramGb: 80 }]);
        // The directory entry says so too.
        const entries = (await fetch(`${relay.url}/directory`).then((r) => r.json())) as { gpus: unknown }[];
        expect(entries.length).toBe(1);
        expect(entries[0]!.gpus).toEqual([{ model: 'a100', count: 1, vramGb: 80 }]);
      } finally {
        await first.close();
      }
      const second = await startParty(common);
      try {
        expect((second.node as import('@silicr/engine').ProviderNode).getPolicy().gpus).toEqual([{ model: 'a100', count: 1, vramGb: 80 }]);
      } finally {
        await second.close();
      }
    } finally {
      await relay.close();
    }
  }, 30_000);
});
