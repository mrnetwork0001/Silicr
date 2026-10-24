/**
 * The RunHandle shared by both modes. A mode supplies a JobDriver (how to pause,
 * resume and terminate) and feeds output lines and the exit code in; this class
 * owns logs, progress, the timeout clock and the pause/resume/stop state machine.
 */
import { rm } from 'node:fs/promises';
import { checkpointDigest } from './digest.ts';
import { LogBuffer, parseProgress } from './logs.ts';
import type { JobExit, JobProgress, RunHandle, RunnerMode } from './index.ts';

export interface JobDriver {
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Ask the job to exit: SIGTERM now, SIGKILL after graceMs. `paused` says whether it is frozen. */
  terminate(graceMs: number, paused: boolean): Promise<void>;
}

export interface JobInit {
  id: string;
  mode: RunnerMode;
  sandboxed: boolean;
  notice?: string;
  jobDir: string;
  outputDir: string;
  checkpointDir: string;
  /** False when the caller supplied checkpointDir (cleanup() then keeps it). */
  ownsCheckpointDir: boolean;
  timeoutS?: number;
  killGraceMs: number;
}

export type JobState = 'running' | 'paused' | 'stopping' | 'exited';

export class JobHandle implements RunHandle {
  readonly id: string;
  readonly mode: RunnerMode;
  readonly sandboxed: boolean;
  readonly notice: string | undefined;
  readonly jobDir: string;
  readonly outputDir: string;
  readonly checkpointDir: string;
  private readonly ownsCheckpointDir: boolean;
  private readonly killGraceMs: number;
  private readonly logBuf = new LogBuffer();
  private readonly digestCache = new Map<string, { stamp: string; size: number; sha: Buffer }>();
  private readonly exited: Promise<JobExit>;
  private resolveExit!: (e: JobExit) => void;
  private driver: JobDriver | undefined;
  private step = 0;
  private paused = false;
  private stopping = false;
  private stoppedBy: string | undefined;
  private exitInfo: JobExit | undefined;
  private ops: Promise<unknown> = Promise.resolve();
  private timeoutLeftMs: number | undefined;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private runningSince = 0;

  constructor(init: JobInit) {
    this.id = init.id;
    this.mode = init.mode;
    this.sandboxed = init.sandboxed;
    this.notice = init.notice;
    this.jobDir = init.jobDir;
    this.outputDir = init.outputDir;
    this.checkpointDir = init.checkpointDir;
    this.ownsCheckpointDir = init.ownsCheckpointDir;
    this.killGraceMs = init.killGraceMs;
    if (init.timeoutS !== undefined && init.timeoutS > 0) this.timeoutLeftMs = init.timeoutS * 1000;
    this.exited = new Promise((r) => {
      this.resolveExit = r;
    });
  }

  /** Called by the mode right after the job was spawned. Starts the timeout clock. */
  attach(driver: JobDriver): void {
    this.driver = driver;
    this.armTimeout();
  }

  /** One line of job output (stdout or stderr). Progress lines update progress(); the rest is logged. */
  line(line: string): void {
    const step = parseProgress(line);
    if (step !== null) {
      this.step = step;
      return;
    }
    this.logBuf.push(line);
  }

  /** A runner-generated log line, prefixed so it cannot be mistaken for job output. */
  note(message: string): void {
    this.logBuf.push(`[silicr-runner] ${message}`);
  }

  /** Called by the mode once the job has exited and its output is drained. Idempotent. */
  finish(exitCode: number): void {
    if (this.exitInfo) return;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.exitInfo = { exitCode, outputDir: this.outputDir, ...(this.stoppedBy !== undefined ? { stoppedBy: this.stoppedBy } : {}) };
    this.logBuf.close();
    this.resolveExit(this.exitInfo);
  }

  get state(): JobState {
    if (this.exitInfo) return 'exited';
    if (this.stopping) return 'stopping';
    return this.paused ? 'paused' : 'running';
  }

  /** The most recent log lines (for status displays). */
  logTail(n = 50): string[] {
    return this.logBuf.tail(n);
  }

  logs(): AsyncIterable<string> {
    const buf = this.logBuf;
    return { [Symbol.asyncIterator]: () => buf.read() };
  }

  async progress(): Promise<JobProgress> {
    const step = this.step;
    return { step, checkpointDigest: await checkpointDigest(this.checkpointDir, this.digestCache) };
  }

  pause(): Promise<void> {
    return this.serial(async () => {
      if (this.exitInfo || this.paused || this.stopping) return;
      await this.driver!.pause();
      this.paused = true;
      this.disarmTimeout();
    });
  }

  resume(): Promise<void> {
    return this.serial(async () => {
      if (this.exitInfo || !this.paused || this.stopping) return;
      await this.driver!.resume();
      this.paused = false;
      this.armTimeout();
    });
  }

  /** SIGTERM, then SIGKILL after the grace period (5 s by default). Resolves once the job has exited. */
  async stop(reason: string): Promise<void> {
    await this.serial(async () => {
      if (this.exitInfo || this.stopping) return;
      this.stopping = true;
      this.stoppedBy = reason;
      this.disarmTimeout();
      const wasPaused = this.paused;
      this.paused = false;
      await this.driver!.terminate(this.killGraceMs, wasPaused);
    });
    await this.exited;
  }

  wait(): Promise<JobExit> {
    return this.exited;
  }

  /** Remove the job's scratch directory (bundle copy, outputs and, unless caller-supplied, checkpoints). */
  async cleanup(): Promise<void> {
    await this.exited;
    await rm(this.jobDir, { recursive: true, force: true });
    if (this.ownsCheckpointDir) await rm(this.checkpointDir, { recursive: true, force: true });
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.ops.then(fn);
    this.ops = run.catch(() => undefined);
    return run;
  }

  private armTimeout(): void {
    if (this.timeoutLeftMs === undefined || this.exitInfo || this.timeoutTimer) return;
    this.runningSince = Date.now();
    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = undefined;
      this.timeoutLeftMs = 0;
      if (!this.exitInfo) this.note(`time limit reached; stopping the job`);
      this.stop('timeout').catch(() => undefined);
    }, Math.max(0, this.timeoutLeftMs));
  }

  private disarmTimeout(): void {
    if (!this.timeoutTimer || this.timeoutLeftMs === undefined) return;
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
    this.timeoutLeftMs = Math.max(0, this.timeoutLeftMs - (Date.now() - this.runningSince));
  }
}
