/**
 * 'docker' mode: `docker run --rm --network none` with CPU/memory/pid limits, all
 * capabilities dropped, a read-only root filesystem, the bundle mounted read-only
 * at /job and the output/checkpoint dirs mounted read-write. GPUs are passed through
 * only when requested and the NVIDIA runtime is present.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, constants as osc } from 'node:os';
import { LineSplitter } from './logs.ts';
import type { JobHandle } from './job.ts';

export interface DockerInfo {
  serverVersion: string;
  /** Daemon host name, e.g. "colima". */
  name: string;
  operatingSystem: string;
  ncpu: number;
  /** Bytes. */
  memTotal: number;
  /** The NVIDIA container runtime is registered with the daemon. */
  nvidia: boolean;
}

export interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a short command, capturing (bounded) output. Never rejects; ENOENT → code null. */
export function runCmd(bin: string, args: string[], timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout, stderr: String(e), timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += c.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
    });
  });
}

/** `docker info`, or null if the CLI is missing or the daemon does not answer within timeoutMs. */
export async function probeDocker(timeoutMs = 3000, bin = 'docker'): Promise<DockerInfo | null> {
  const r = await runCmd(bin, ['info', '--format', '{{json .}}'], timeoutMs);
  if (r.code !== 0) return null;
  try {
    const info = JSON.parse(r.stdout) as {
      ServerVersion?: string;
      Name?: string;
      OperatingSystem?: string;
      NCPU?: number;
      MemTotal?: number;
      Runtimes?: Record<string, unknown>;
      ServerErrors?: unknown[];
    };
    if (!info.ServerVersion || (info.ServerErrors && info.ServerErrors.length > 0)) return null;
    return {
      serverVersion: info.ServerVersion,
      name: info.Name ?? '',
      operatingSystem: info.OperatingSystem ?? '',
      ncpu: info.NCPU ?? 1,
      memTotal: info.MemTotal ?? 0,
      nvidia: Object.keys(info.Runtimes ?? {}).some((k) => k.includes('nvidia')) || hasNvidiaToolkit(),
    };
  } catch {
    return null;
  }
}

/** NVIDIA Container Toolkit installed as a hook only (no registered runtime) still serves --gpus. */
function hasNvidiaToolkit(): boolean {
  if (process.platform !== 'linux') return false;
  const dirs = (process.env.PATH ?? '').split(':').concat(['/usr/bin', '/usr/local/bin']);
  return dirs.some((d) => d && existsSync(`${d}/nvidia-container-cli`));
}

/**
 * Whether the Docker daemon can bind-mount `path` from this machine. Only Colima on macOS
 * is known to be restrictive (it shares the home directory and /tmp/colima by default);
 * native Linux docker and Docker Desktop's default file sharing cover the usual paths.
 */
export function dockerSharesPath(info: DockerInfo, path: string, platform = process.platform, home = homedir()): boolean {
  if (platform !== 'darwin' || !/colima/i.test(info.name)) return true;
  const under = (root: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
  return under(home) || under('/tmp/colima') || under('/private/tmp/colima');
}

/** Make sure the image is present locally (pull it if not). Throws with docker's error. */
export async function ensureImage(image: string, bin = 'docker'): Promise<void> {
  const have = await runCmd(bin, ['image', 'inspect', '--format', '{{.Id}}', image], 30_000);
  if (have.code === 0) return;
  const pulled = await runCmd(bin, ['pull', '--quiet', image], 15 * 60_000);
  if (pulled.code !== 0) {
    throw new Error(`docker: could not pull image ${image}: ${lastLine(pulled.stderr) || 'unknown error'}`);
  }
}

export interface DockerLaunch {
  bin: string;
  name: string;
  image: string;
  command: string[];
  bundleDir: string;
  outputDir: string;
  checkpointDir: string;
  envFile: string;
  cpus: number;
  memoryMb: number;
  gpus: number;
}

/** The full `docker run` argv (exported for tests). */
export function dockerRunArgs(l: DockerLaunch): string[] {
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    l.name,
    '--label',
    'org.silicr.runner=1',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=1g',
    '--pids-limit',
    '1024',
    '--cpus',
    String(l.cpus),
    '--memory',
    `${l.memoryMb}m`,
    '--memory-swap',
    `${l.memoryMb}m`,
    '--mount',
    bindMount(l.bundleDir, '/job', true),
    '--mount',
    bindMount(l.outputDir, '/silicr/output', false),
    '--mount',
    bindMount(l.checkpointDir, '/silicr/checkpoints', false),
    '-w',
    '/job',
    '--env-file',
    l.envFile,
  ];
  // Native Linux docker: run as the provider's uid so outputs are not root-owned.
  // (Docker Desktop / Colima map file ownership themselves.)
  if (process.platform === 'linux' && typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }
  if (l.gpus > 0) args.push('--gpus', String(l.gpus));
  args.push(l.image, ...l.command);
  return args;
}

function bindMount(src: string, dst: string, readonly: boolean): string {
  const field = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [`type=bind`, field(`source=${src}`), field(`target=${dst}`), ...(readonly ? ['readonly'] : [])].join(',');
}

/** Containers still running, so they can be removed if the provider exits. */
const liveContainers = new Map<string, string>();
let exitHookInstalled = false;
function trackContainer(name: string, bin: string): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const [n, b] of liveContainers) spawnSync(b, ['rm', '-f', n], { stdio: 'ignore', timeout: 5000 });
    });
  }
  liveContainers.set(name, bin);
}

export function launchDocker(handle: JobHandle, l: DockerLaunch): void {
  const child = spawn(l.bin, dockerRunArgs(l), { stdio: ['ignore', 'pipe', 'pipe'] });
  trackContainer(l.name, l.bin);
  const out = new LineSplitter((line) => handle.line(line));
  const err = new LineSplitter((line) => handle.line(line));
  child.stdout.on('data', (c: Buffer) => out.write(c));
  child.stderr.on('data', (c: Buffer) => err.write(c));
  let exited = false;

  child.on('error', (e: NodeJS.ErrnoException) => {
    if (exited) return;
    exited = true;
    handle.note(`could not run docker: ${e.code ?? e.message}`);
    liveContainers.delete(l.name);
    handle.finish(125);
  });
  child.on('close', (code, signal) => {
    if (exited) return;
    exited = true;
    out.end();
    err.end();
    // --rm normally removes the container; make sure if the CLI itself was killed.
    void runCmd(l.bin, ['rm', '-f', l.name], 30_000).finally(() => liveContainers.delete(l.name));
    handle.finish(code ?? 128 + (signal ? (osc.signals[signal] ?? 0) : 0));
  });

  /** Run a docker subcommand against the container, retrying while it is still being created. */
  const control = async (args: string[], waitMs: number): Promise<void> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const r = await runCmd(l.bin, args, 30_000);
      if (r.code === 0 || exited) return;
      const transient = /No such container|is not running|not found/i.test(r.stderr);
      if (!transient || Date.now() > deadline) throw new Error(`docker ${args[0]} failed: ${lastLine(r.stderr) || `exit ${r.code}`}`);
      await new Promise((res) => setTimeout(res, 200));
    }
  };

  handle.attach({
    pause: () => control(['pause', l.name], 10_000),
    resume: () => control(['unpause', l.name], 10_000),
    async terminate(graceMs, paused) {
      if (paused) await control(['unpause', l.name], 5_000).catch(() => undefined);
      const graceS = Math.max(1, Math.ceil(graceMs / 1000));
      try {
        await control(['stop', '-t', String(graceS), l.name], 15_000);
      } catch {
        // Last resort: kill the attached CLI and the container.
        child.kill('SIGKILL');
        await runCmd(l.bin, ['rm', '-f', l.name], 30_000);
      }
    },
  });
}

function lastLine(s: string): string {
  const lines = s.trim().split('\n');
  return (lines[lines.length - 1] ?? '').trim();
}
