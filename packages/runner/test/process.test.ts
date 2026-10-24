import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkpointDigest, createRunner, probeDocker } from '../src/index.ts';
import type { RunHandle } from '../src/index.ts';

const EXAMPLE = fileURLToPath(new URL('../../../examples/tiny-train', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function collect(h: RunHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const l of h.logs()) out.push(l);
  return out;
}

function findOnPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

let workDir = '';
const extra: string[] = [];
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'silicr-runner-test-'));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  while (extra.length) await rm(extra.pop()!, { recursive: true, force: true });
});

async function tempBundle(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'silicr-bundle-src-'));
  extra.push(d);
  for (const [name, content] of Object.entries(files)) await writeFile(join(d, name), content);
  return d;
}

describe('process mode', () => {
  it('runs the example job: logs, progress, checkpoints and outputs', async () => {
    const runner = await createRunner({ mode: 'process', workDir });
    expect(runner.mode).toBe('process');
    expect(runner.sandboxed).toBe(false);
    expect(runner.notice).toMatch(/NOT a sandbox/);

    const h = await runner.start({
      bundleDir: EXAMPLE,
      command: ['python3', 'train.py'],
      env: { SILICR_STEPS: '40', SILICR_STEP_DELAY_MS: '0', SILICR_CHECKPOINT_EVERY: '10' },
    });
    expect(h.mode).toBe('process');
    expect(h.sandboxed).toBe(false);
    expect(h.notice).toMatch(/NOT a sandbox/);
    const logsDone = collect(h);
    const exit = await h.wait();
    const logs = await logsDone;

    expect(exit).toEqual({ exitCode: 0, outputDir: h.outputDir });
    expect(logs[0]).toMatch(/^tiny-train: char bigram LM/);
    expect(logs.filter((l) => /^step\s+\d+\/40\s+loss \d+\.\d+$/.test(l))).toHaveLength(40);
    expect(logs.some((l) => l.includes('SILICR_PROGRESS'))).toBe(false);
    expect(logs.at(-1)).toMatch(/^done: 40 steps/);

    const p = await h.progress();
    expect(p.step).toBe(40);
    expect(p.checkpointDigest).not.toEqual(new Uint8Array(32));
    expect(Buffer.from(p.checkpointDigest).equals(Buffer.from(await checkpointDigest(h.checkpointDir!)))).toBe(true);
    expect((await readdir(h.checkpointDir!)).sort()).toEqual(['ckpt-000020.json', 'ckpt-000030.json', 'ckpt-000040.json']);

    expect((await readdir(exit.outputDir)).sort()).toEqual(['metrics.json', 'model.json', 'sample.txt']);
    const metrics = JSON.parse(await readFile(join(exit.outputDir, 'metrics.json'), 'utf8')) as Record<string, number | boolean>;
    expect(metrics).toMatchObject({ completed: true, steps_completed: 40, resumed_from_step: 0 });
    expect(metrics.eval_loss_final as number).toBeLessThan(metrics.eval_loss_initial as number);
    expect((await readFile(join(exit.outputDir, 'sample.txt'), 'utf8')).length).toBeGreaterThan(100);

    // Every reader gets the whole log from the start.
    expect(await collect(h)).toEqual(logs);
    // The source bundle is untouched (the job ran in a copy).
    expect(existsSync(join(EXAMPLE, 'output'))).toBe(false);
    expect(existsSync(join(EXAMPLE, 'checkpoints'))).toBe(false);
  }, 60_000);

  it('pauses (progress stops), resumes, stops, and resumes from the checkpoint in a new run', async () => {
    const runner = await createRunner({ mode: 'process', workDir, killGraceMs: 3000 });
    const h = await runner.start({
      bundleDir: EXAMPLE,
      command: ['python3', 'train.py'],
      env: { SILICR_STEPS: '100000', SILICR_STEP_DELAY_MS: '10', SILICR_CHECKPOINT_EVERY: '25' },
    });
    await waitFor(async () => (await h.progress()).step >= 5, 15_000, 'first progress');

    await h.pause();
    expect((h as unknown as { state: string }).state).toBe('paused');
    await sleep(300); // let lines already in the pipe drain
    const s1 = (await h.progress()).step;
    await sleep(800);
    expect((await h.progress()).step).toBe(s1);

    await h.resume();
    await waitFor(async () => (await h.progress()).step > s1 + 3, 15_000, 'progress after resume');

    const t0 = Date.now();
    await h.stop('buyer_stop');
    expect(Date.now() - t0).toBeLessThan(2500); // exits on SIGTERM, long before SIGKILL
    const exit = await h.wait();
    expect(exit.stoppedBy).toBe('buyer_stop');
    expect(exit.exitCode).toBe(143);
    const logs = await collect(h);
    expect(logs.some((l) => l.startsWith('SIGTERM received: checkpoint and partial outputs saved'))).toBe(true);
    const metrics = JSON.parse(await readFile(join(exit.outputDir, 'metrics.json'), 'utf8')) as { completed: boolean; steps_completed: number };
    expect(metrics.completed).toBe(false);
    const stoppedAt = metrics.steps_completed;
    expect(stoppedAt).toBeGreaterThan(s1);
    expect(await readdir(h.checkpointDir!)).toContain(`ckpt-${String(stoppedAt).padStart(6, '0')}.json`);
    // Stopping again is a no-op.
    await h.stop('again');
    expect((await h.wait()).stoppedBy).toBe('buyer_stop');

    const h2 = await runner.start({
      bundleDir: EXAMPLE,
      command: ['python3', 'train.py'],
      checkpointDir: h.checkpointDir!,
      env: { SILICR_STEPS: String(stoppedAt + 10), SILICR_STEP_DELAY_MS: '0' },
    });
    const exit2 = await h2.wait();
    expect(exit2.exitCode).toBe(0);
    expect((await collect(h2))[0]).toContain(`resuming from checkpoint at step ${stoppedAt}`);
    expect((await h2.progress()).step).toBe(stoppedAt + 10);
    const m2 = JSON.parse(await readFile(join(exit2.outputDir, 'metrics.json'), 'utf8')) as { completed: boolean; resumed_from_step: number };
    expect(m2).toMatchObject({ completed: true, resumed_from_step: stoppedAt });

    // cleanup() removes the scratch dir but keeps a caller-supplied checkpoint dir.
    const jobDir2 = join(exit2.outputDir, '..');
    await h2.cleanup!();
    expect(existsSync(jobDir2)).toBe(false);
    expect(existsSync(h.checkpointDir!)).toBe(true);
  }, 90_000);

  it('stops a paused job promptly', async () => {
    const runner = await createRunner({ mode: 'process', workDir, killGraceMs: 3000 });
    const h = await runner.start({ bundleDir: EXAMPLE, command: ['python3', 'train.py'], env: { SILICR_STEPS: '100000', SILICR_STEP_DELAY_MS: '10' } });
    await waitFor(async () => (await h.progress()).step >= 2, 15_000);
    await h.pause();
    const t0 = Date.now();
    await h.stop('unpaid');
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(await h.wait()).toMatchObject({ exitCode: 143, stoppedBy: 'unpaid' });
  }, 30_000);

  it('enforces limits.timeoutS', async () => {
    const runner = await createRunner({ mode: 'process', workDir, killGraceMs: 1000 });
    const t0 = Date.now();
    const h = await runner.start({ bundleDir: await tempBundle({ 'x.txt': 'x' }), command: ['sh', '-c', 'echo started; sleep 30'], limits: { timeoutS: 1 } });
    const exit = await h.wait();
    const elapsed = Date.now() - t0;
    expect(exit.stoppedBy).toBe('timeout');
    expect(exit.exitCode).toBe(143);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
    const logs = await collect(h);
    expect(logs[0]).toBe('started');
    expect(logs).toContain('[silicr-runner] time limit reached; stopping the job');
  }, 20_000);

  it('does not count paused time against the timeout', async () => {
    const runner = await createRunner({ mode: 'process', workDir, killGraceMs: 1000 });
    const t0 = Date.now();
    const h = await runner.start({ bundleDir: await tempBundle({ 'x.txt': 'x' }), command: ['sh', '-c', 'sleep 30'], limits: { timeoutS: 1 } });
    await h.pause();
    await sleep(1600);
    expect((h as unknown as { state: string }).state).toBe('paused');
    await h.resume();
    const exit = await h.wait();
    expect(exit.stoppedBy).toBe('timeout');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2400);
  }, 20_000);

  it('escalates to SIGKILL when the job ignores SIGTERM', async () => {
    const runner = await createRunner({ mode: 'process', workDir, killGraceMs: 500 });
    const h = await runner.start({ bundleDir: await tempBundle({ 'x.txt': 'x' }), command: ['sh', '-c', 'trap "" TERM; echo ready; sleep 30'] });
    await waitFor(() => (h as unknown as { logTail(): string[] }).logTail().includes('ready'), 5000);
    const t0 = Date.now();
    await h.stop('provider_stop');
    const exit = await h.wait();
    expect(exit).toMatchObject({ exitCode: 137, stoppedBy: 'provider_stop' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 20_000);

  it('gives the job a minimal environment and its own copy of the bundle', async () => {
    process.env.SILICR_TEST_PROVIDER_SECRET = 'hunter2';
    try {
      const runner = await createRunner({ mode: 'process', workDir });
      const src = await tempBundle({ 'job.py': 'x' });
      const script = [
        'import json, os',
        'keys = ["SILICR_TEST_PROVIDER_SECRET", "FOO", "SILICR_OUTPUT_DIR", "SILICR_CHECKPOINT_DIR", "HOME", "PYTHONUNBUFFERED"]',
        'print(json.dumps({k: os.environ.get(k) for k in keys}))',
        'print(json.dumps({"cwd": os.getcwd()}))',
        'open("written-by-job", "w").write("x")',
      ].join('\n');
      const h = await runner.start({ bundleDir: src, command: ['python3', '-c', script], env: { FOO: 'bar', SILICR_OUTPUT_DIR: '/not/allowed' } });
      const exit = await h.wait();
      expect(exit.exitCode).toBe(0);
      const [envLine, cwdLine] = await collect(h);
      const env = JSON.parse(envLine!) as Record<string, string | null>;
      expect(env.SILICR_TEST_PROVIDER_SECRET).toBeNull();
      expect(env.FOO).toBe('bar');
      expect(env.SILICR_OUTPUT_DIR).toBe(exit.outputDir);
      expect(env.SILICR_CHECKPOINT_DIR).toBe(h.checkpointDir);
      expect(env.PYTHONUNBUFFERED).toBe('1');
      const jobDir = join(exit.outputDir, '..');
      expect(env.HOME!.startsWith(jobDir)).toBe(true);
      const cwd = (JSON.parse(cwdLine!) as { cwd: string }).cwd;
      expect(existsSync(join(src, 'written-by-job'))).toBe(false);
      expect(existsSync(join(cwd, 'written-by-job'))).toBe(true);
      expect((await stat(jobDir)).mode & 0o777).toBe(0o700);
    } finally {
      delete process.env.SILICR_TEST_PROVIDER_SECRET;
    }
  }, 20_000);

  it("falls back from 'python' to 'python3' when only python3 is installed", async () => {
    const real = findOnPath('python3');
    expect(real).not.toBeNull();
    const bin = await mkdtemp(join(tmpdir(), 'silicr-bin-'));
    extra.push(bin);
    await symlink(real!, join(bin, 'python3'));
    const runner = await createRunner({ mode: 'process', workDir });
    const h = await runner.start({ bundleDir: await tempBundle({ 'x.txt': 'x' }), command: ['python', '-c', 'print("fallback ok")'], env: { PATH: bin } });
    expect((await h.wait()).exitCode).toBe(0);
    const logs = await collect(h);
    expect(logs).toContain("[silicr-runner] 'python' is not installed on this provider; running 'python3' instead");
    expect(logs).toContain('fallback ok');
  }, 20_000);

  it('reports a command that cannot start as exit 127', async () => {
    const runner = await createRunner({ mode: 'process', workDir });
    const h = await runner.start({ bundleDir: await tempBundle({ 'x.txt': 'x' }), command: ['definitely-not-a-real-command-xyz'] });
    expect((await h.wait()).exitCode).toBe(127);
    expect((await collect(h)).some((l) => l.startsWith('[silicr-runner] could not start'))).toBe(true);
    // pause/resume/stop after exit are harmless no-ops.
    await h.pause();
    await h.resume();
    await h.stop('late');
    expect((await h.wait()).stoppedBy).toBeUndefined();
  });

  it('rejects invalid specs', async () => {
    const runner = await createRunner({ mode: 'process', workDir });
    const bundleDir = await tempBundle({ 'x.txt': 'x' });
    await expect(runner.start({ bundleDir, command: [] })).rejects.toThrow(/command/);
    await expect(runner.start({ bundleDir: join(bundleDir, 'missing'), command: ['true'] })).rejects.toThrow(/bundleDir/);
    await expect(runner.start({ bundleDir, command: ['true'], env: { 'BAD-NAME': 'x' } })).rejects.toThrow(/environment/);
    await expect(runner.start({ bundleDir, command: ['true'], env: { OK: 'two\nlines' } })).rejects.toThrow(/single-line/);
    await expect(runner.start({ bundleDir, command: ['true'], limits: { timeoutS: -1 } })).rejects.toThrow(/timeoutS/);
  });

  it('skips symlinks when copying the bundle', async () => {
    const src = await tempBundle({ 'ok.txt': 'ok' });
    await symlink('/etc/passwd', join(src, 'leak'));
    await mkdir(join(src, 'sub'));
    const runner = await createRunner({ mode: 'process', workDir });
    const h = await runner.start({ bundleDir: src, command: ['sh', '-c', 'ls -A'] });
    await h.wait();
    expect(await collect(h)).toEqual(['ok.txt', 'sub']);
  });
});

describe('createRunner', () => {
  it("'auto' falls back to process mode when docker is unreachable; 'docker' then fails", async () => {
    const auto = await createRunner({ mode: 'auto', workDir, dockerBin: '/nonexistent/docker' });
    expect(auto.mode).toBe('process');
    await expect(createRunner({ mode: 'docker', workDir, dockerBin: '/nonexistent/docker' })).rejects.toThrow(/not reachable/);
  });

  it('under Colima, refuses docker mode for a workDir outside the home directory', async (ctx) => {
    const info = await probeDocker();
    if (!info || process.platform !== 'darwin' || !/colima/i.test(info.name)) ctx.skip();
    const auto = await createRunner({ mode: 'auto', workDir });
    expect(auto.mode).toBe('process');
    expect(auto.notice).toMatch(/Colima/);
    await expect(createRunner({ mode: 'docker', workDir })).rejects.toThrow(/home directory/);
  });
});
