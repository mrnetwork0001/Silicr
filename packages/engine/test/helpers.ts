// Small fakes for unit tests: an in-memory relay, a scriptable runner and trivial bundles.
// The chain is the real @silicr/zec memory network and the crypto is the real @silicr/protocol.
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { JobExit, JobProgress, JobSpec, RunHandle, Runner } from '@silicr/runner';
import type { RelayClient } from '@silicr/relay';
import { createMemoryNetwork, type MemoryNetwork, type MemoryNetworkOptions, type ZecBackend, type Output } from '@silicr/zec';
import { sha256 } from '@silicr/protocol';
import { BuyerNode } from '../src/buyer.ts';
import { ProviderNode, type ProviderPolicy } from '../src/provider.ts';
import { withOverrides, FAST_PROFILE, type TimingProfile } from '../src/profile.ts';
import type { EngineDeps } from '../src/deps.ts';
import type { SpendCap } from '../src/base.ts';

export const TEST_PROFILE: TimingProfile = withOverrides(FAST_PROFILE, {
  name: 'test',
  blockTimeS: 0.1,
  pollMs: 30,
  bidWindowBlocks: 50, // 5 s at 100 ms blocks: generous under CPU load (auto-accept fires once everyone bid)
  acceptWindowBlocks: 200,
  intervalS: 1,
  heartbeatS: 0.1,
  heartbeatTimeoutS: 1,
  graceS: 1.5,
  startWithinS: 5,
  relayWaitS: 0.5,
  closeWaitS: 5,
  jobFetchTimeoutS: 5,
  sendRetryS: 3,
});

export async function tempDir(prefix = 'silicr-engine-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 10_000, everyMs = 20): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
      last = undefined; // a stale error from an earlier attempt must not explain this timeout
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// ---------------------------------------------------------------------------- relay

export class FakeRelay implements RelayClient {
  readonly baseUrl = 'http://fake-relay.invalid';
  readonly boxes = new Map<string, Uint8Array[]>();
  readonly directory = new Map<string, unknown>();
  private waiters = new Set<() => void>();
  /** Everything the relay was ever handed, for privacy assertions. */
  readonly stored: { mailbox: string; data: Uint8Array }[] = [];

  async append(mailbox: string, data: Uint8Array): Promise<number> {
    if (!/^[0-9a-f]{32}$/.test(mailbox)) throw new Error('bad mailbox');
    const box = this.boxes.get(mailbox) ?? [];
    box.push(new Uint8Array(data));
    this.boxes.set(mailbox, box);
    this.stored.push({ mailbox, data: new Uint8Array(data) });
    for (const w of this.waiters) w();
    this.waiters.clear();
    return box.length;
  }

  async read(mailbox: string, afterSeq: number, waitS = 0): Promise<{ seq: number; data: Uint8Array }[]> {
    const deadline = Date.now() + waitS * 1000;
    for (;;) {
      const box = this.boxes.get(mailbox) ?? [];
      const out = box.slice(afterSeq).map((data, i) => ({ seq: afterSeq + i + 1, data: new Uint8Array(data) }));
      const remaining = deadline - Date.now();
      if (out.length || remaining <= 0) return out;
      await new Promise<void>((r) => {
        const t = setTimeout(r, remaining);
        this.waiters.add(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async listDirectory(): Promise<unknown[]> {
    return [...this.directory.values()].map((e) => structuredClone(e));
  }

  async publishDirectory(entry: unknown): Promise<void> {
    const e = entry as { providerId: string };
    this.directory.set(e.providerId, structuredClone(entry));
  }

  /** What an operator could see: mailbox ids and ciphertext only. */
  operatorView(): string {
    return JSON.stringify(this.stored.map((s) => ({ mailbox: s.mailbox, size: s.data.length, head: Buffer.from(s.data.subarray(0, 64)).toString('hex') })));
  }

  /** Plaintext search across every stored byte (should never find anything). */
  containsUtf8(needle: string): boolean {
    const n = Buffer.from(needle, 'utf8');
    return this.stored.some((s) => Buffer.from(s.data).includes(n));
  }
}

// ---------------------------------------------------------------------------- runner

export interface FakeJobScript {
  steps: number;
  stepMs: number;
  exitCode?: number;
  /** Write a checkpoint file (ckpt-<step>.json) every this many steps; 0 = none. Default 0. */
  checkpointEvery?: number;
}

export class FakeHandle implements RunHandle {
  readonly id: string;
  readonly mode = 'process' as const;
  readonly spec: JobSpec;
  step = 0;
  paused = false;
  pauses = 0;
  stoppedBy: string | undefined;
  private outputDir: string;
  private lines: string[] = [];
  private lineWaiters: (() => void)[] = [];
  private exited: JobExit | null = null;
  private exitWaiters: ((e: JobExit) => void)[] = [];
  private timer: NodeJS.Timeout;
  /** Like the real runner: SILICR_CHECKPOINT_DIR, pre-populated when spec.checkpointDir is given. */
  readonly checkpointDir: string;
  /** Step the job resumed from (0 = fresh), like tiny-train's resumed_from_step. */
  resumedFrom = 0;

  constructor(id: string, spec: JobSpec, outputDir: string, script: FakeJobScript, checkpointDir: string) {
    this.id = id;
    this.spec = spec;
    this.outputDir = outputDir;
    this.checkpointDir = checkpointDir;
    this.push(`starting ${spec.command.join(' ')}`);
    const every = script.checkpointEvery ?? 0;
    const ready = (async () => {
      await mkdir(checkpointDir, { recursive: true });
      // Resume from the newest checkpoint in the dir, if any (what tiny-train does).
      const steps = (await readdir(checkpointDir)).map((n) => /^ckpt-(\d+)\.json$/.exec(n)?.[1]).filter((x): x is string => !!x).map(Number);
      if (steps.length) {
        this.step = this.resumedFrom = Math.max(...steps);
        this.push(`resuming from checkpoint at step ${this.step}`);
      }
    })();
    this.timer = setInterval(() => {
      if (this.paused || this.exited) return;
      void ready.then(async () => {
        if (this.paused || this.exited) return;
        this.step += 1;
        this.push(`step ${this.step} loss ${(1 / this.step).toFixed(3)}`);
        if (every > 0 && this.step % every === 0) {
          await writeFile(join(checkpointDir, `ckpt-${String(this.step).padStart(6, '0')}.json`), JSON.stringify({ step: this.step }));
        }
        if (this.step >= script.steps) void this.finish(script.exitCode ?? 0);
      });
    }, script.stepMs);
  }

  private push(line: string): void {
    this.lines.push(line);
    for (const w of this.lineWaiters.splice(0)) w();
  }

  private async finish(code: number, stoppedBy?: string): Promise<void> {
    if (this.exited) return;
    clearInterval(this.timer);
    await mkdir(this.outputDir, { recursive: true });
    await writeFile(join(this.outputDir, 'result.txt'), `steps=${this.step}\nenv=${this.spec.env?.FAKE_MARK ?? ''}\n`);
    await writeFile(join(this.outputDir, 'metrics.json'), JSON.stringify({ steps_completed: this.step, resumed_from_step: this.resumedFrom }));
    this.exited = { exitCode: code, outputDir: this.outputDir };
    if (stoppedBy) this.exited.stoppedBy = stoppedBy;
    for (const w of this.lineWaiters.splice(0)) w();
    for (const w of this.exitWaiters.splice(0)) w(this.exited);
  }

  async *logs(): AsyncIterable<string> {
    let i = 0;
    for (;;) {
      while (i < this.lines.length) yield this.lines[i++]!;
      if (this.exited) return;
      await new Promise<void>((r) => this.lineWaiters.push(r));
    }
  }

  async progress(): Promise<JobProgress> {
    return { step: this.step, checkpointDigest: sha256(new TextEncoder().encode(`ckpt-${this.step}`)) };
  }

  async pause(): Promise<void> {
    if (!this.paused) this.pauses += 1;
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
  }

  async stop(reason: string): Promise<void> {
    this.stoppedBy = reason;
    await this.finish(143, reason);
  }

  wait(): Promise<JobExit> {
    if (this.exited) return Promise.resolve(this.exited);
    return new Promise((r) => this.exitWaiters.push(r));
  }
}

export class FakeRunner implements Runner {
  readonly mode = 'process' as const;
  readonly handles: FakeHandle[] = [];
  script: FakeJobScript;
  private n = 0;
  private readonly root: string;

  constructor(root: string, script: FakeJobScript) {
    this.root = root;
    this.script = script;
  }

  async start(spec: JobSpec): Promise<RunHandle> {
    this.n += 1;
    const h = new FakeHandle(`fake-${this.n}`, spec, join(this.root, `out-${this.n}`), this.script, spec.checkpointDir ?? join(this.root, `ckpt-${this.n}`));
    this.handles.push(h);
    return h;
  }
}

// ---------------------------------------------------------------------------- bundles

async function walk(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await walk(p, base));
    else if (e.isFile()) out[p.slice(base.length + 1)] = (await readFile(p)).toString('base64');
  }
  return out;
}

export const fakeBundles: Pick<EngineDeps, 'packBundle' | 'unpackBundle'> = {
  async packBundle(dir: string) {
    const files = await walk(dir);
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
    return new TextEncoder().encode(JSON.stringify(sorted));
  },
  async unpackBundle(bytes: Uint8Array, into: string) {
    const files = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
    for (const [name, b64] of Object.entries(files)) {
      if (name.includes('..') || name.startsWith('/')) throw new Error('unsafe path');
      await mkdir(dirname(join(into, name)), { recursive: true });
      await writeFile(join(into, name), Buffer.from(b64, 'base64'));
    }
  },
};

export function unbundle(bytes: Uint8Array): Record<string, string> {
  const files = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')]));
}

// ---------------------------------------------------------------------------- world

/** Wraps a backend so tests can see exactly which outputs each successful send() carried. */
export function recordingBackend(inner: ZecBackend): ZecBackend & { sends: Output[][] } {
  const sends: Output[][] = [];
  const wrapped = Object.create(inner) as ZecBackend & { sends: Output[][] };
  Object.defineProperty(wrapped, 'sends', { value: sends });
  wrapped.send = async (outputs: Output[]) => {
    const r = await inner.send(outputs);
    sends.push(outputs.map((o) => ({ ...o })));
    return r;
  };
  return wrapped;
}

export interface WorldProvider {
  name: string;
  policy?: Partial<ProviderPolicy>;
  script?: FakeJobScript;
  /** Wrap the provider's wallet backend (e.g. to fake a chain that never confirms a payment). */
  wrapBackend?: (inner: ZecBackend) => ZecBackend;
}

export interface World {
  network: MemoryNetwork;
  relay: FakeRelay;
  buyer: BuyerNode;
  buyerBackend: ZecBackend & { sends: Output[][] };
  providers: ProviderNode[];
  runners: FakeRunner[];
  jobDir: string;
  root: string;
  close(): Promise<void>;
}

export async function makeWorld(o: {
  providers?: WorldProvider[];
  profile?: Partial<TimingProfile>;
  memory?: Omit<MemoryNetworkOptions, 'blockTimeMs'>;
  blockTimeMs?: number;
  buyerFund?: bigint;
  buyerOpts?: { maxResultBytes?: number; homeDir?: string; spendCap?: SpendCap };
} = {}): Promise<World> {
  const root = await tempDir();
  const profile = withOverrides(TEST_PROFILE, o.profile ?? {});
  const network = createMemoryNetwork({ ...(o.memory ?? {}), blockTimeMs: o.blockTimeMs ?? 100 });
  const relay = new FakeRelay();
  const deps = { ...fakeBundles };
  const providers: ProviderNode[] = [];
  const runners: FakeRunner[] = [];
  for (const p of o.providers ?? [{ name: 'p1' }]) {
    const runner = new FakeRunner(join(root, `${p.name}-runner`), p.script ?? { steps: 30, stepMs: 100 });
    const wallet = network.wallet(p.name, { fundZats: 100_000_000n });
    const node = new ProviderNode({
      backend: p.wrapBackend ? p.wrapBackend(wallet) : wallet,
      relay,
      dataDir: join(root, p.name),
      profile,
      runner,
      deps,
      policy: { gpus: [{ model: 'a100', count: 2, vramGb: 80 }], minPricePerHourZats: 36_000_000n, ...(p.policy ?? {}) },
      jobEnv: { FAKE_MARK: p.name },
      log: (m: string) => { if (process.env.ENGINE_DEBUG) console.error(`[${p.name}] ${m}`); },
    });
    await node.start();
    providers.push(node);
    runners.push(runner);
  }
  const buyerBackend = recordingBackend(network.wallet('buyer', { fundZats: o.buyerFund ?? 1_000_000_000n }));
  const buyer = new BuyerNode({ backend: buyerBackend, relay, dataDir: join(root, 'buyer'), profile, deps, ...(o.buyerOpts ?? {}) });
  await buyer.start();
  const jobDir = join(root, 'job');
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, 'train.py'), 'print("SECRET-WORKLOAD-MARKER")\n');
  return {
    network,
    relay,
    buyer,
    buyerBackend,
    providers,
    runners,
    jobDir,
    root,
    async close() {
      await buyer.close();
      for (const p of providers) await p.close();
      network.stop();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
