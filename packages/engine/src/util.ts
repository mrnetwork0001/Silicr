// Small helpers shared by the nodes. No crypto here (that lives in @silicr/protocol).
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function unhex(s: string): Uint8Array {
  if (typeof s !== 'string' || s.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomInt(maxExclusive: number): number {
  const b = randomBytes(4);
  return (((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0) % maxExclusive;
}

/** Fisher-Yates with a CSPRNG. */
export function shuffle<T>(xs: T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function shortHex(s: string, n = 8): string {
  return s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-4)}`;
}

/** Serialise async work: run() calls execute one at a time, in order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** A tiny listener set. */
export class Emitter<E> {
  private listeners = new Set<(e: E) => void>();
  on(fn: (e: E) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(e: E): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a broken listener must not take the node down
      }
    }
  }
  get size(): number {
    return this.listeners.size;
  }
}

// JSON with bigint and Uint8Array support, for state files in a party's own data dir.
function replacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return { $big: v.toString() };
  if (v instanceof Uint8Array) return { $hex: hex(v) };
  return v;
}

function reviver(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.$big === 'string') return BigInt(o.$big);
    if (keys.length === 1 && typeof o.$hex === 'string') return unhex(o.$hex);
  }
  return v;
}

export function toStateJson(v: unknown): string {
  return JSON.stringify(v, replacer, 2);
}

export function fromStateJson<T>(s: string): T {
  return JSON.parse(s, reviver) as T;
}

/** Atomic write (tmp + rename), owner-only permissions: these files can hold secrets. */
export async function writePrivate(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomInt(1e9)}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Debounced, serialised JSON persistence of one state object. */
export class StateFile<T> {
  private readonly path: string;
  private readonly get: () => T;
  private readonly mutex = new Mutex();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  constructor(path: string, get: () => T) {
    this.path = path;
    this.get = get;
  }
  async load(): Promise<T | null> {
    const buf = await readIfExists(this.path);
    if (!buf) return null;
    try {
      return fromStateJson<T>(buf.toString('utf8'));
    } catch {
      return null; // best effort: a corrupt state file means a fresh start
    }
  }
  /** Schedule a write soon. */
  touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 50);
  }
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.mutex.run(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await writePrivate(this.path, toStateJson(this.get()));
    });
  }
}
