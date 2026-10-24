/**
 * Mailbox storage: one file per message under <root>/<mailbox>/<seq>.bin, plus an
 * in-memory index rebuilt from disk on start. Message bytes are never kept in
 * memory beyond a single request, never parsed and never logged.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAILBOX_ID_RE = /^[0-9a-f]{32}$/;
const SEQ_FILE_RE = /^([1-9][0-9]{0,15})\.bin$/;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface StoreLimits {
  maxMessageBytes: number;
  maxMessagesPerMailbox: number;
  maxTotalBytes: number;
}

export interface MessageMeta {
  seq: number;
  size: number;
}

interface Waiter {
  after: number;
  wake(): void;
}

interface Mailbox {
  readonly id: string;
  /** Ascending by seq. */
  msgs: MessageMeta[];
  lastSeq: number;
  /** Last append, listing or fetch (unix ms). */
  touched: number;
  /** Serialises appends so seqs are committed in order. */
  queue: Promise<unknown>;
  writing: number;
  waiters: Set<Waiter>;
}

export class MailboxStore {
  readonly root: string;
  private readonly ttlMs: number;
  private readonly limits: StoreLimits;
  private readonly boxes = new Map<string, Mailbox>();
  /** Mailbox dirs being removed; a new mailbox with the same id waits for this first. */
  private readonly deleting = new Map<string, Promise<void>>();
  private totalBytes = 0;
  private reservedBytes = 0;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(root: string, ttlMs: number, limits: StoreLimits) {
    this.root = root;
    this.ttlMs = ttlMs;
    this.limits = limits;
  }

  /** Rebuild the index from disk and start the TTL sweeper. */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root)) {
      const dir = join(this.root, name);
      if (name.startsWith('.trash-')) {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      if (!MAILBOX_ID_RE.test(name)) continue;
      let dirStat;
      try {
        dirStat = await stat(dir);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;
      const msgs: MessageMeta[] = [];
      let touched = dirStat.mtimeMs;
      for (const file of await readdir(dir)) {
        const m = SEQ_FILE_RE.exec(file);
        if (!m) {
          // Leftover from an interrupted write.
          if (file.endsWith('.tmp')) await rm(join(dir, file), { force: true });
          continue;
        }
        try {
          const st = await stat(join(dir, file));
          if (!st.isFile()) continue;
          msgs.push({ seq: Number(m[1]), size: st.size });
          touched = Math.max(touched, st.mtimeMs);
        } catch {
          // vanished; ignore
        }
      }
      if (msgs.length === 0) {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      msgs.sort((a, b) => a.seq - b.seq);
      const mb = this.newMailbox(name);
      mb.msgs = msgs;
      mb.lastSeq = msgs[msgs.length - 1]!.seq;
      mb.touched = touched;
      this.boxes.set(name, mb);
      for (const m of msgs) this.totalBytes += m.size;
    }
    this.sweep();
    const every = Math.min(60_000, Math.max(25, Math.floor(this.ttlMs / 4)));
    this.sweeper = setInterval(() => this.sweep(), every);
    this.sweeper.unref();
  }

  /** Append one message; resolves with its 1-based seq once it is on disk. */
  async append(id: string, data: Uint8Array): Promise<number> {
    if (data.byteLength > this.limits.maxMessageBytes) {
      throw new HttpError(413, 'too_large', `message exceeds ${this.limits.maxMessageBytes} bytes`);
    }
    const mb = this.ensure(id);
    if (mb.msgs.length + mb.writing >= this.limits.maxMessagesPerMailbox) {
      throw new HttpError(507, 'mailbox_full', `mailbox holds the maximum of ${this.limits.maxMessagesPerMailbox} messages`);
    }
    if (this.totalBytes + this.reservedBytes + data.byteLength > this.limits.maxTotalBytes) {
      throw new HttpError(507, 'storage_full', 'relay storage is full');
    }
    mb.writing++;
    this.reservedBytes += data.byteLength;
    const run = mb.queue.then(async () => {
      const seq = mb.lastSeq + 1;
      const dir = join(this.root, id);
      await mkdir(dir, { recursive: true });
      const final = join(dir, `${seq}.bin`);
      const tmp = `${final}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, final);
      mb.lastSeq = seq;
      mb.msgs.push({ seq, size: data.byteLength });
      this.totalBytes += data.byteLength;
      mb.touched = Date.now();
      for (const w of [...mb.waiters]) if (w.after < seq) w.wake();
      return seq;
    });
    mb.queue = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      mb.writing--;
      this.reservedBytes -= data.byteLength;
    }
  }

  /** Messages with seq > after, oldest first. */
  list(id: string, after: number, limit: number): MessageMeta[] {
    const mb = this.live(id);
    if (!mb) return [];
    mb.touched = Date.now();
    const start = firstAfter(mb.msgs, after);
    return mb.msgs.slice(start, start + limit);
  }

  /** Wait until a message with seq > after exists, the timeout passes, or the signal aborts. */
  async waitFor(id: string, after: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    const mb = this.ensure(id);
    if (mb.lastSeq > after || timeoutMs <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        after,
        wake: () => {
          if (timer) clearTimeout(timer);
          signal.removeEventListener('abort', waiter.wake);
          mb.waiters.delete(waiter);
          mb.touched = Date.now();
          resolve();
        },
      };
      timer = setTimeout(waiter.wake, timeoutMs);
      signal.addEventListener('abort', waiter.wake);
      mb.waiters.add(waiter);
    });
  }

  /** The exact stored bytes, or null if there is no such message. */
  async read(id: string, seq: number): Promise<Buffer | null> {
    const mb = this.live(id);
    if (!mb) return null;
    const i = firstAfter(mb.msgs, seq - 1);
    if (mb.msgs[i]?.seq !== seq) return null;
    mb.touched = Date.now();
    try {
      return await readFile(join(this.root, id, `${seq}.bin`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  stats(): { mailboxes: number; bytes: number } {
    return { mailboxes: this.boxes.size, bytes: this.totalBytes };
  }

  /** Stop the sweeper, release long-pollers and wait for in-flight writes. */
  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    const pending: Promise<unknown>[] = [];
    for (const mb of this.boxes.values()) {
      for (const w of [...mb.waiters]) w.wake();
      pending.push(mb.queue);
    }
    await Promise.all([...pending, ...this.deleting.values()]);
  }

  /** Drop mailboxes untouched for longer than the TTL. */
  sweep(now = Date.now()): void {
    for (const mb of [...this.boxes.values()]) {
      if (this.isExpired(mb, now)) this.drop(mb);
      else if (mb.msgs.length === 0 && mb.writing === 0 && mb.waiters.size === 0 && now - mb.touched > 60_000) {
        // In-memory placeholder left by a long-poll on a mailbox nobody wrote to.
        this.boxes.delete(mb.id);
      }
    }
  }

  private isExpired(mb: Mailbox, now: number): boolean {
    return now - mb.touched > this.ttlMs && mb.writing === 0 && mb.waiters.size === 0;
  }

  private live(id: string): Mailbox | undefined {
    const mb = this.boxes.get(id);
    if (mb && this.isExpired(mb, Date.now())) {
      this.drop(mb);
      return undefined;
    }
    return mb;
  }

  private ensure(id: string): Mailbox {
    const existing = this.live(id);
    if (existing) return existing;
    const mb = this.newMailbox(id);
    this.boxes.set(id, mb);
    return mb;
  }

  private newMailbox(id: string): Mailbox {
    return {
      id,
      msgs: [],
      lastSeq: 0,
      touched: Date.now(),
      queue: this.deleting.get(id) ?? Promise.resolve(),
      writing: 0,
      waiters: new Set(),
    };
  }

  private drop(mb: Mailbox): void {
    this.boxes.delete(mb.id);
    for (const m of mb.msgs) this.totalBytes -= m.size;
    if (mb.msgs.length === 0) return;
    const dir = join(this.root, mb.id);
    const trash = join(this.root, `.trash-${mb.id}-${randomBytes(4).toString('hex')}`);
    const prior = this.deleting.get(mb.id) ?? Promise.resolve();
    const done: Promise<void> = prior
      .then(async () => {
        try {
          await rename(dir, trash);
        } catch {
          return;
        }
        await rm(trash, { recursive: true, force: true });
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.deleting.get(mb.id) === done) this.deleting.delete(mb.id);
      });
    this.deleting.set(mb.id, done);
  }
}

/** Index of the first message with seq > after (msgs ascending). */
function firstAfter(msgs: MessageMeta[], after: number): number {
  let lo = 0;
  let hi = msgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (msgs[mid]!.seq <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
