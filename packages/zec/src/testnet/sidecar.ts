/**
 * zec-sidecar process manager: spawns one sidecar per wallet, speaks JSON lines over its
 * stdin/stdout, enforces per-request timeouts and shuts it down cleanly. The sidecar exits on
 * its own when stdin closes, so a crashed parent never leaves a wallet process behind.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, appendFileSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { toError, type SidecarErrorBody } from './parse.ts';

export type SidecarNetwork = 'main' | 'test';

/** The public testnet lightwalletd run by zec.rocks. */
export const DEFAULT_SERVER = 'testnet.zec.rocks:443';
/** The public mainnet lightwalletd run by zec.rocks (probed on 2026-10-21; alternatives in docs/ZCASH_SETUP.md). */
export const DEFAULT_MAINNET_SERVER = 'zec.rocks:443';
export const DEFAULT_SERVERS: Readonly<Record<SidecarNetwork, string>> = Object.freeze({ main: DEFAULT_MAINNET_SERVER, test: DEFAULT_SERVER });

/** <repo>/zec-sidecar/target/release/zec-sidecar, resolved relative to this file. */
export function defaultSidecarPath(): string {
  return fileURLToPath(new URL('../../../../zec-sidecar/target/release/zec-sidecar', import.meta.url));
}

export class SidecarMissingError extends Error {
  override name = 'SidecarMissingError';
}

export class SidecarExitedError extends Error {
  override name = 'SidecarExitedError';
}

export class SidecarTimeoutError extends Error {
  override name = 'SidecarTimeoutError';
}

export interface ReadyEvent {
  event: 'ready';
  /** The chain the sidecar runs on, as checked against the server's reported chain. */
  network: SidecarNetwork;
  server: string;
  /** The SOCKS5 proxy every connection to the server goes through (credentials stripped), or null. */
  proxy?: string | null;
  address: string;
  /** True for a watch-only wallet (created from a viewing key, or opened with --view-only). */
  viewOnly?: boolean;
  birthday: number;
  tip: number;
  syncMs: number;
  scannedBlocks: number;
  version: string;
}

export interface SidecarOptions {
  binary: string;
  /** 'main' or 'test'. The sidecar refuses a server (or an existing wallet) on the other chain. */
  network: SidecarNetwork;
  dataDir: string;
  server: string;
  /**
   * SOCKS5 proxy (socks5h://host:port, e.g. Tor on 127.0.0.1:9050) for every connection to the
   * server. The sidecar resolves names through the proxy and never falls back to a direct
   * connection; start() refuses to continue unless the sidecar confirms it is using the proxy.
   */
  proxy?: string;
  create: boolean;
  /** Watch-only: create the wallet from this UFVK (`--view-only --ufvk`); every send is refused. */
  viewingKey?: string;
  birthday?: number;
  syncIntervalMs?: number;
  trustedConfirmations?: number;
  untrustedConfirmations?: number;
  targetNoteCount?: number;
  minSplitZats?: bigint;
  startupTimeoutMs: number;
  /** Receives each stderr line (logs; never secrets or memo contents). */
  onLog?: (line: string) => void;
  /** Also append stderr to this file (inside the wallet's own data dir by default). */
  logFile?: string | null;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function assertExecutable(path: string): void {
  try {
    accessSync(path, fsConstants.X_OK);
  } catch {
    throw new SidecarMissingError(
      `zec-sidecar not found or not executable at ${path}. Build it with:\n` +
        `  cd zec-sidecar && cargo build --release\n` +
        `or point SILICR_ZEC_SIDECAR / the 'sidecarPath' option at a built binary. See docs/ZCASH_SETUP.md.`,
    );
  }
}

export class Sidecar {
  readonly ready: ReadyEvent;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exitInfo: string | null = null;
  private readonly stderrTail: string[] = [];
  private readonly exited: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams, ready: ReadyEvent, exited: Promise<void>) {
    this.child = child;
    this.ready = ready;
    this.exited = exited;
  }

  get alive(): boolean {
    return this.exitInfo === null;
  }

  static async start(opts: SidecarOptions): Promise<Sidecar> {
    assertExecutable(opts.binary);
    mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    const args = ['serve', '--data-dir', opts.dataDir, '--server', opts.server, '--network', opts.network];
    if (opts.create) args.push('--create');
    if (opts.birthday !== undefined) args.push('--birthday', String(opts.birthday));
    if (opts.syncIntervalMs !== undefined) args.push('--sync-interval-ms', String(opts.syncIntervalMs));
    if (opts.trustedConfirmations !== undefined) args.push('--trusted-confirmations', String(opts.trustedConfirmations));
    if (opts.untrustedConfirmations !== undefined) args.push('--untrusted-confirmations', String(opts.untrustedConfirmations));
    if (opts.targetNoteCount !== undefined) args.push('--target-note-count', String(opts.targetNoteCount));
    if (opts.minSplitZats !== undefined) args.push('--min-split-zats', opts.minSplitZats.toString());
    if (opts.proxy !== undefined) args.push('--proxy', opts.proxy);
    if (opts.viewingKey !== undefined) args.push('--view-only', '--ufvk', opts.viewingKey);

    // This layer is the single source of the proxy setting (it already folded $SILICR_PROXY in),
    // so the sidecar must not read the variable on its own.
    const env = { ...process.env };
    delete env['SILICR_PROXY'];
    const child = spawn(opts.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const logFile = opts.logFile === undefined ? join(opts.dataDir, 'sidecar.log') : opts.logFile;
    if (logFile) mkdirSync(dirname(logFile), { recursive: true });

    let instance: Sidecar | null = null;
    const stderrTail: string[] = [];
    let resolveReady!: (r: ReadyEvent) => void;
    let rejectReady!: (e: Error) => void;
    const readyP = new Promise<ReadyEvent>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    createInterface({ input: child.stderr }).on('line', (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
      if (logFile) {
        try {
          appendFileSync(logFile, line + '\n', { mode: 0o600 });
        } catch {
          /* logging must never break the wallet */
        }
      }
      opts.onLog?.(line);
    });

    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        stderrTail.push(`[non-JSON stdout] ${line.slice(0, 200)}`);
        return;
      }
      if (msg['event'] === 'ready') {
        resolveReady(msg as unknown as ReadyEvent);
        return;
      }
      if (msg['event'] === 'fatal') {
        rejectReady(new Error(`zec-sidecar failed to start: ${String(msg['error'])}`));
        return;
      }
      if (instance) instance.onResponse(msg);
    });

    const exited = new Promise<void>((resolve) => {
      child.on('exit', (code, signal) => {
        const info = `zec-sidecar exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`;
        rejectReady(new SidecarExitedError(`${info}\n${stderrTail.slice(-10).join('\n')}`));
        if (instance) instance.onExit(info);
        resolve();
      });
      child.on('error', (err) => {
        rejectReady(new SidecarMissingError(`could not start zec-sidecar (${opts.binary}): ${err.message}`));
        resolve();
      });
    });

    const timer = setTimeout(
      () => rejectReady(new SidecarTimeoutError(`zec-sidecar did not become ready within ${opts.startupTimeoutMs} ms\n${stderrTail.slice(-10).join('\n')}`)),
      opts.startupTimeoutMs,
    );
    try {
      const ready = await readyP;
      // Refuse to run unproxied if we asked for a proxy and the sidecar did not confirm it (an old
      // binary would have rejected the flag, but never trust a silent downgrade).
      if (opts.proxy !== undefined && !isLoopbackHost(serverHost(opts.server)) && !(typeof ready.proxy === 'string' && ready.proxy !== '')) {
        throw new Error(`zec-sidecar did not confirm the SOCKS5 proxy ${opts.proxy}; refusing to run with a direct connection to ${opts.server}`);
      }
      instance = new Sidecar(child, ready, exited);
      instance.stderrTail.push(...stderrTail);
      return instance;
    } catch (e) {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private onResponse(msg: Record<string, unknown>): void {
    const id = msg['id'];
    if (typeof id !== 'number') return;
    const p = this.pending.get(id);
    if (!p) return; // timed out earlier; late answer ignored
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg['ok'] === true) p.resolve(msg['result']);
    else p.reject(toError(p.method, (msg['error'] ?? { code: 'Internal', message: 'unknown error' }) as SidecarErrorBody));
  }

  private onExit(info: string): void {
    this.exitInfo = info;
    const detail = this.stderrTail.slice(-10).join('\n');
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new SidecarExitedError(`${info} during ${p.method}\n${detail}`));
      this.pending.delete(id);
    }
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    if (this.exitInfo) return Promise.reject(new SidecarExitedError(this.exitInfo));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SidecarTimeoutError(`zec-sidecar ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (err) => {
        if (err && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new SidecarExitedError(`writing to zec-sidecar failed: ${err.message}`));
        }
      });
    });
  }

  /** Asks the sidecar to stop, then escalates to SIGTERM and SIGKILL. */
  async close(graceMs = 5000): Promise<void> {
    if (this.exitInfo) return;
    const done = this.exited;
    try {
      await Promise.race([this.request('shutdown', {}, graceMs), done]);
    } catch {
      /* fall through to signals */
    }
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    const waited = await Promise.race([done.then(() => true), sleep(graceMs).then(() => false)]);
    if (!waited && this.alive) {
      this.child.kill('SIGTERM');
      const termed = await Promise.race([done.then(() => true), sleep(2000).then(() => false)]);
      if (!termed && this.alive) this.child.kill('SIGKILL');
      await Promise.race([done, sleep(1000)]);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

/** The host part of a `host:port` / `https://host:port` server string. */
export function serverHost(server: string): string {
  return server
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
}

/** Servers on this machine (localhost, 127/8, ::1) are reached directly: nothing leaves the host. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
