/**
 * Docker-mode tests. They run only when `docker info` answers within 3 s, and skip
 * themselves otherwise. Job dirs live under this package (inside the home directory),
 * because Colima only shares the home directory with containers.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRunner, probeDocker } from '../src/index.ts';
import type { RunHandle, SilicrRunner } from '../src/index.ts';

const EXAMPLE = fileURLToPath(new URL('../../../examples/tiny-train', import.meta.url));
const SCRATCH = fileURLToPath(new URL('../.silicr/', import.meta.url));
const info = await probeDocker(3000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collect(h: RunHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const l of h.logs()) out.push(l);
  return out;
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe.skipIf(!info)('docker mode', () => {
  let workDir = '';
  let runner: SilicrRunner;

  beforeAll(async () => {
    await mkdir(SCRATCH, { recursive: true });
    workDir = await mkdtemp(join(SCRATCH, `docker-test-${randomBytes(3).toString('hex')}-`));
    runner = await createRunner({ mode: 'docker', workDir, killGraceMs: 3000 });
  });
  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
    await rmdir(SCRATCH).catch(() => undefined); // only if empty
  });

  it("'auto' picks docker when the daemon answers", async () => {
    const auto = await createRunner({ mode: 'auto', workDir });
    expect(auto.mode).toBe('docker');
    expect(auto.sandboxed).toBe(true);
  });

  it('runs the example job in python:3.12-slim', async () => {
    const h = await runner.start({
      bundleDir: EXAMPLE,
      command: ['python', 'train.py'],
      env: { SILICR_STEPS: '30', SILICR_STEP_DELAY_MS: '0', SILICR_CHECKPOINT_EVERY: '10' },
      limits: { cpus: 1, memoryMb: 256 },
    });
    expect(h.mode).toBe('docker');
    expect(h.sandboxed).toBe(true);
    const exit = await h.wait();
    const logs = await collect(h);
    expect(exit.exitCode).toBe(0);
    expect(exit.stoppedBy).toBeUndefined();
    expect(logs.filter((l) => /^step\s+\d+\/30\s+loss/.test(l))).toHaveLength(30);
    expect(logs.some((l) => l.includes('SILICR_PROGRESS'))).toBe(false);
    expect((await h.progress()).step).toBe(30);
    expect((await h.progress()).checkpointDigest).not.toEqual(new Uint8Array(32));
    expect((await readdir(exit.outputDir)).sort()).toEqual(['metrics.json', 'model.json', 'sample.txt']);
    const metrics = JSON.parse(await readFile(join(exit.outputDir, 'metrics.json'), 'utf8')) as { completed: boolean; python: string };
    expect(metrics.completed).toBe(true);
    expect(metrics.python).toMatch(/^3\.12\./); // ran in the container, not on the host
    await h.cleanup!();
  }, 120_000);

  it('isolates the job: no network, read-only bundle and root fs, writable output dirs', async () => {
    const src = join(workDir, 'probe-src');
    await mkdir(src);
    await writeFile(join(src, 'probe.py'), PROBE);
    const h = await runner.start({ bundleDir: src, command: ['python', 'probe.py'], env: { FOO: 'bar' } });
    const exit = await h.wait();
    const logs = await collect(h);
    expect(exit.exitCode).toBe(0);
    const report = JSON.parse(logs.find((l) => l.startsWith('{'))!) as Record<string, unknown>;
    expect(report).toMatchObject({
      network: 'blocked',
      job_dir: 'read-only',
      root_fs: 'read-only',
      tmp: 'writable',
      output_dir: '/silicr/output',
      checkpoint_dir: '/silicr/checkpoints',
      cwd: '/job',
      foo: 'bar',
    });
    expect(await readFile(join(exit.outputDir, 'out.txt'), 'utf8')).toBe('from the container');
    await h.cleanup!();
  }, 120_000);

  it('pauses (progress stops), resumes and stops via docker pause/unpause/stop', async () => {
    const h = await runner.start({
      bundleDir: EXAMPLE,
      command: ['python', 'train.py'],
      env: { SILICR_STEPS: '100000', SILICR_STEP_DELAY_MS: '10', SILICR_CHECKPOINT_EVERY: '25' },
    });
    await waitFor(async () => (await h.progress()).step >= 5, 60_000, 'first progress');
    await h.pause();
    await sleep(400);
    const s1 = (await h.progress()).step;
    await sleep(1000);
    expect((await h.progress()).step).toBe(s1);
    await h.resume();
    await waitFor(async () => (await h.progress()).step > s1 + 3, 30_000, 'progress after resume');
    await h.stop('buyer_stop');
    const exit = await h.wait();
    expect(exit).toMatchObject({ exitCode: 143, stoppedBy: 'buyer_stop' });
    expect((await collect(h)).some((l) => l.startsWith('SIGTERM received'))).toBe(true);
    const metrics = JSON.parse(await readFile(join(exit.outputDir, 'metrics.json'), 'utf8')) as { completed: boolean };
    expect(metrics.completed).toBe(false);
    await h.cleanup!();
  }, 120_000);

  it('enforces limits.timeoutS', async () => {
    const src = join(workDir, 'sleep-src');
    await mkdir(src, { recursive: true });
    const t0 = Date.now();
    const h = await runner.start({ bundleDir: src, command: ['sh', '-c', 'sleep 60'], limits: { timeoutS: 2 } });
    const exit = await h.wait();
    expect(exit.stoppedBy).toBe('timeout');
    expect([137, 143]).toContain(exit.exitCode);
    expect(Date.now() - t0).toBeLessThan(20_000);
    await h.cleanup!();
  }, 60_000);

  it.skipIf(info?.nvidia)('runs on CPU and says so when GPUs are requested but there is no NVIDIA runtime', async () => {
    const src = join(workDir, 'gpu-src');
    await mkdir(src, { recursive: true });
    const h = await runner.start({ bundleDir: src, command: ['sh', '-c', 'echo cpu ok'], gpu: { model: 'a100', count: 2 } });
    expect(h.notice).toMatch(/no NVIDIA runtime/);
    expect((await h.wait()).exitCode).toBe(0);
    const logs = await collect(h);
    expect(logs[0]).toMatch(/^\[silicr-runner\] GPU requested \(a100 x2\)/);
    expect(logs).toContain('cpu ok');
    await h.cleanup!();
  }, 60_000);
});

const PROBE = String.raw`
import json, os, socket
r = {}
try:
    socket.create_connection(("1.1.1.1", 53), timeout=2)
    r["network"] = "open"
except OSError:
    r["network"] = "blocked"
def writable(path):
    try:
        with open(path, "w") as f:
            f.write("x")
        return "writable"
    except OSError:
        return "read-only"
r["job_dir"] = writable("/job/should-fail")
r["root_fs"] = writable("/should-fail")
r["tmp"] = writable("/tmp/ok")
r["output_dir"] = os.environ.get("SILICR_OUTPUT_DIR")
r["checkpoint_dir"] = os.environ.get("SILICR_CHECKPOINT_DIR")
r["cwd"] = os.getcwd()
r["foo"] = os.environ.get("FOO")
with open(os.path.join(os.environ["SILICR_OUTPUT_DIR"], "out.txt"), "w") as f:
    f.write("from the container")
print(json.dumps(r))
`;
