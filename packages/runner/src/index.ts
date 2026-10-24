/**
 * @silicr/runner: packs job bundles and runs them in a sandbox on the provider.
 *
 * Contract (owned by the lead; flag changes in your report).
 *
 * What a job sees (same in both modes):
 *   working dir         the unpacked bundle (read-only in docker mode)
 *   SILICR_OUTPUT_DIR   write results here; packed and returned to the buyer
 *   SILICR_CHECKPOINT_DIR  write checkpoints here; hashed into each heartbeat
 *   stdout line "SILICR_PROGRESS step=<n>"  reports progress (other lines are log output)
 *
 * 'docker' mode: no network, memory/CPU limits, GPUs passed through when requested and present.
 * 'process' mode: a plain child process in a temp dir. Dev and demo fallback ONLY: it is not
 *   a sandbox, and the provider daemon must say so in its status output.
 *
 * Implementation notes (additive to the contract above):
 *   - docker: `docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges
 *     --read-only --tmpfs /tmp --pids-limit 1024 --cpus/--memory`, bundle copy at /job (ro, -w /job),
 *     outputs at /silicr/output, checkpoints at /silicr/checkpoints, HOME=/tmp, a random container
 *     name, --gpus N only when a GPU is requested and the NVIDIA runtime exists (otherwise it runs
 *     on CPU and says so in handle.notice and in the log). pause/resume = docker pause/unpause,
 *     stop = docker stop -t 5.
 *   - process: cwd is a copy of the bundle, a minimal env (PATH, HOME/TMPDIR in the job dir, locale,
 *     PYTHONUNBUFFERED=1) so the provider's own variables are not passed on; its own process group;
 *     pause/resume = SIGSTOP/SIGCONT to the group, stop = SIGTERM then SIGKILL after 5 s.
 *     CPU/memory limits are NOT enforced. `python` falls back to `python3` if missing.
 *   - Both: PYTHONUNBUFFERED=1; SILICR_* vars always win over spec.env; limits.timeoutS counts
 *     running time only (time spent paused does not count) and stops with stoppedBy 'timeout';
 *     exit codes follow the shell convention (128 + signal when killed); runner messages appear in
 *     logs() prefixed "[silicr-runner] ".
 *   - progress().checkpointDigest = SHA-256 over, for each regular file in the checkpoint dir
 *     sorted by relative path: u32be(len(path)) || path || u64be(size) || SHA-256(content);
 *     32 zero bytes when there are none. See checkpointDigest().
 *   - Docker under Colima only shares your home directory, so workDir must live under it: with
 *     mode 'auto' a workDir outside it falls back to process mode (see Runner.notice); with
 *     mode 'docker' createRunner throws.
 */

export type RunnerMode = 'docker' | 'process';

export interface JobSpec {
  /** Directory holding the unpacked bundle. */
  bundleDir: string;
  command: string[];
  /** Container image (docker mode). Default 'python:3.12-slim'. */
  image?: string;
  gpu?: { model: string; count: number } | null;
  env?: Record<string, string>;
  limits?: { cpus?: number; memoryMb?: number; timeoutS?: number };
  /**
   * Host directory to use as SILICR_CHECKPOINT_DIR (created if missing). Pass the checkpoint
   * dir of an earlier run to resume from it. Default: a fresh dir inside the job's scratch dir.
   */
  checkpointDir?: string;
}

export interface JobProgress {
  step: number;
  /** SHA-256 over the checkpoint dir contents (32 zero bytes if empty). */
  checkpointDigest: Uint8Array;
}

export interface JobExit {
  exitCode: number;
  /** Absolute path of SILICR_OUTPUT_DIR on the host. */
  outputDir: string;
  stoppedBy?: string;
}

export interface RunHandle {
  readonly id: string;
  readonly mode: RunnerMode;
  /** Log lines (stdout + stderr, minus SILICR_PROGRESS lines) from the start; ends when the job exits. */
  logs(): AsyncIterable<string>;
  progress(): Promise<JobProgress>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(reason: string): Promise<void>;
  wait(): Promise<JobExit>;
  /** False in process mode: the job is NOT isolated from the provider's machine. */
  readonly sandboxed?: boolean;
  /** Human-readable caveat to surface in status output (process mode, GPU fallback). */
  readonly notice?: string;
  /** Absolute host path of SILICR_CHECKPOINT_DIR. */
  readonly checkpointDir?: string;
  /** Remove the job's scratch dir once it has exited (keeps a caller-supplied checkpointDir). */
  cleanup?(): Promise<void>;
}

export interface Runner {
  readonly mode: RunnerMode;
  start(spec: JobSpec): Promise<RunHandle>;
  /** False in process mode. */
  readonly sandboxed?: boolean;
  /** Caveat to surface in the provider's status output, if any. */
  readonly notice?: string;
}

export { createRunner, DEFAULT_IMAGE, DEFAULT_KILL_GRACE_MS } from './runner.ts';
export type { CreateRunnerOptions, SilicrRunner } from './runner.ts';
export { packBundle, unpackBundle, walkTree, BundleError, MAX_BUNDLE_BYTES, MAX_BUNDLE_ENTRIES, BUNDLE_MTIME } from './bundle.ts';
export type { PackOptions, UnpackOptions } from './bundle.ts';
export { checkpointDigest } from './digest.ts';
export { probeDocker, dockerRunArgs } from './docker.ts';
export type { DockerInfo } from './docker.ts';
export { JobHandle } from './job.ts';
export type { JobState } from './job.ts';
export { PROCESS_MODE_NOTICE } from './process.ts';
export { parseProgress } from './logs.ts';
