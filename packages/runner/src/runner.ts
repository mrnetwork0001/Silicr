/**
 * createRunner(): picks docker or process mode and prepares each job's scratch
 * directory:
 *
 *   <workDir>/job-<id>/          mode 0700
 *     job/                       copy of spec.bundleDir (cwd; mounted read-only at /job in docker)
 *     output/                    SILICR_OUTPUT_DIR (docker: /silicr/output)
 *     checkpoints/               SILICR_CHECKPOINT_DIR (docker: /silicr/checkpoints), unless spec.checkpointDir
 *     home/, tmp/                HOME and TMPDIR (process mode)
 *     env                        docker --env-file (0600)
 */
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { constants as fsc } from 'node:fs';
import { cpus as hostCpus } from 'node:os';
import { join, resolve } from 'node:path';
import { walkTree } from './bundle.ts';
import { dockerSharesPath, ensureImage, launchDocker, probeDocker } from './docker.ts';
import type { DockerInfo } from './docker.ts';
import { JobHandle } from './job.ts';
import { PROCESS_MODE_NOTICE, launchProcess } from './process.ts';
import type { JobSpec, RunHandle, Runner, RunnerMode } from './index.ts';

export const DEFAULT_IMAGE = 'python:3.12-slim';
export const DEFAULT_KILL_GRACE_MS = 5000;

export interface CreateRunnerOptions {
  /** 'auto' (default) = docker if `docker info` answers within 3 s, else process. */
  mode?: RunnerMode | 'auto';
  /**
   * Scratch space for job dirs. Default ".silicr/runner" under the current directory.
   * In docker mode it must be visible to the Docker daemon (Colima and Docker Desktop
   * share your home directory by default; the system temp dir on macOS is NOT shared with Colima).
   */
  workDir?: string;
  /** Time between SIGTERM and SIGKILL on stop/timeout. Default 5000 ms. */
  killGraceMs?: number;
  /** Docker CLI to use. Default 'docker'. */
  dockerBin?: string;
}

export interface SilicrRunner extends Runner {
  readonly sandboxed: boolean;
  readonly notice: string | undefined;
  readonly workDir: string;
  /** Present in docker mode. */
  readonly docker: DockerInfo | undefined;
  start(spec: JobSpec): Promise<RunHandle & JobHandle>;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

/** 'auto' = docker if the daemon is reachable, else process. */
export async function createRunner(opts: CreateRunnerOptions = {}): Promise<SilicrRunner> {
  const mode = opts.mode ?? 'auto';
  const workDir = resolve(opts.workDir ?? join('.silicr', 'runner'));
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const bin = opts.dockerBin ?? 'docker';
  if (mode !== 'process' && mode !== 'docker' && mode !== 'auto') throw new Error(`unknown runner mode ${String(mode)}`);
  let info: DockerInfo | null = null;
  if (mode !== 'process') {
    info = await probeDocker(3000, bin);
    if (!info && mode === 'docker') {
      throw new Error('runner: docker mode requested but the Docker daemon is not reachable (is Docker or Colima running?)');
    }
  }
  if (info && !dockerSharesPath(info, workDir)) {
    const why = `Docker runs inside the Colima VM, which only shares your home directory, and workDir ${workDir} is outside it`;
    if (mode === 'docker') throw new Error(`runner: ${why}; pass a workDir under your home directory`);
    return processRunner(workDir, killGraceMs, `${why}, so jobs run in process mode. ${PROCESS_MODE_NOTICE}`);
  }
  return info ? dockerRunner(info, workDir, killGraceMs, bin) : processRunner(workDir, killGraceMs);
}

function processRunner(workDir: string, killGraceMs: number, notice = PROCESS_MODE_NOTICE): SilicrRunner {
  return {
    mode: 'process',
    sandboxed: false,
    notice,
    workDir,
    docker: undefined,
    async start(spec) {
      const job = await prepareJob(spec, workDir);
      const handle = new JobHandle({
        id: job.id,
        mode: 'process',
        sandboxed: false,
        notice: PROCESS_MODE_NOTICE,
        jobDir: job.jobDir,
        outputDir: job.outputDir,
        checkpointDir: job.checkpointDir,
        ownsCheckpointDir: !spec.checkpointDir,
        ...(spec.limits?.timeoutS !== undefined ? { timeoutS: spec.limits.timeoutS } : {}),
        killGraceMs,
      });
      const home = join(job.jobDir, 'home');
      const tmp = join(job.jobDir, 'tmp');
      await mkdir(home);
      await mkdir(tmp);
      // A minimal environment: the provider's own variables (tokens, wallet passwords...) are not passed on.
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: home,
        TMPDIR: tmp,
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      };
      for (const k of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
      Object.assign(env, spec.env ?? {});
      env.SILICR_OUTPUT_DIR = job.outputDir;
      env.SILICR_CHECKPOINT_DIR = job.checkpointDir;
      await launchProcess(handle, { command: spec.command, cwd: job.bundleDir, env });
      return handle;
    },
  };
}

function dockerRunner(info: DockerInfo, workDir: string, killGraceMs: number, bin: string): SilicrRunner {
  return {
    mode: 'docker',
    sandboxed: true,
    notice: info.nvidia ? undefined : 'no NVIDIA container runtime found: jobs that request GPUs run on CPU only',
    workDir,
    docker: info,
    async start(spec) {
      const image = spec.image ?? DEFAULT_IMAGE;
      if (!IMAGE_RE.test(image)) throw new Error(`runner: invalid image name ${JSON.stringify(image)}`);
      const job = await prepareJob(spec, workDir);
      const wantGpus = spec.gpu && spec.gpu.count > 0 && spec.gpu.model.toLowerCase() !== 'cpu' ? spec.gpu.count : 0;
      const gpus = wantGpus > 0 && info.nvidia ? wantGpus : 0;
      const notice =
        wantGpus > 0 && gpus === 0
          ? `GPU requested (${spec.gpu?.model} x${wantGpus}) but this Docker host has no NVIDIA runtime; running on CPU only`
          : undefined;

      const maxCpus = Math.max(1, info.ncpu || hostCpus().length);
      const cpus = clamp(spec.limits?.cpus ?? Math.min(maxCpus, 4), 0.1, maxCpus);
      const totalMb = info.memTotal > 0 ? Math.floor(info.memTotal / (1024 * 1024)) : 4096;
      const memoryMb = Math.round(clamp(spec.limits?.memoryMb ?? Math.min(4096, Math.floor(totalMb * 0.75)), 64, totalMb));

      const env: Record<string, string> = {
        HOME: '/tmp',
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        ...(spec.env ?? {}),
        SILICR_OUTPUT_DIR: '/silicr/output',
        SILICR_CHECKPOINT_DIR: '/silicr/checkpoints',
      };
      const envFile = join(job.jobDir, 'env');
      await writeFile(
        envFile,
        Object.entries(env)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(''),
        { mode: 0o600 },
      );

      await ensureImage(image, bin);
      const handle = new JobHandle({
        id: job.id,
        mode: 'docker',
        sandboxed: true,
        ...(notice ? { notice } : {}),
        jobDir: job.jobDir,
        outputDir: job.outputDir,
        checkpointDir: job.checkpointDir,
        ownsCheckpointDir: !spec.checkpointDir,
        ...(spec.limits?.timeoutS !== undefined ? { timeoutS: spec.limits.timeoutS } : {}),
        killGraceMs,
      });
      if (notice) handle.note(notice);
      launchDocker(handle, {
        bin,
        name: `silicr-${job.id}`,
        image,
        command: spec.command,
        bundleDir: job.bundleDir,
        outputDir: job.outputDir,
        checkpointDir: job.checkpointDir,
        envFile,
        cpus,
        memoryMb,
        gpus,
      });
      return handle;
    },
  };
}

interface PreparedJob {
  id: string;
  jobDir: string;
  bundleDir: string;
  outputDir: string;
  checkpointDir: string;
}

async function prepareJob(spec: JobSpec, workDir: string): Promise<PreparedJob> {
  validateSpec(spec);
  const src = resolve(spec.bundleDir);
  const st = await stat(src).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`runner: bundleDir is not a directory: ${src}`);

  const id = randomBytes(6).toString('hex');
  await mkdir(workDir, { recursive: true });
  const jobDir = join(workDir, `job-${id}`);
  await mkdir(jobDir, { mode: 0o700 });
  const bundleDir = join(jobDir, 'job');
  const outputDir = join(jobDir, 'output');
  const checkpointDir = spec.checkpointDir ? resolve(spec.checkpointDir) : join(jobDir, 'checkpoints');
  await copyTree(src, bundleDir);
  await mkdir(outputDir);
  await mkdir(checkpointDir, { recursive: true });
  return { id, jobDir, bundleDir, outputDir, checkpointDir };
}

/** Copy regular files and directories only (symlinks and special files are skipped). */
async function copyTree(src: string, dst: string): Promise<void> {
  await mkdir(dst);
  for (const e of await walkTree(src, { special: 'skip' })) {
    const target = join(dst, e.rel);
    if (e.type === 'dir') {
      await mkdir(target);
    } else {
      await copyFile(e.abs, target, fsc.COPYFILE_FICLONE);
      await chmod(target, e.mode);
    }
  }
}

function validateSpec(spec: JobSpec): void {
  if (!Array.isArray(spec.command) || spec.command.length === 0 || spec.command.some((c) => typeof c !== 'string' || c.includes('\0'))) {
    throw new Error('runner: command must be a non-empty array of strings');
  }
  if (spec.command[0] === '') throw new Error('runner: command[0] is empty');
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`runner: invalid environment variable name ${JSON.stringify(k)}`);
    if (typeof v !== 'string' || /[\0\r\n]/.test(v)) throw new Error(`runner: environment variable ${k} must be a single-line string`);
  }
  const t = spec.limits?.timeoutS;
  if (t !== undefined && !(Number.isFinite(t) && t > 0)) throw new Error('runner: limits.timeoutS must be a positive number');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
