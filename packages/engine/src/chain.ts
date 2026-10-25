// Wallet plumbing shared by both nodes: a deduping note watcher and a serialised sender.
import { InsufficientFundsError } from '@silicr/zec';
import type { MemoBytes, Output, ReceivedNote, SendResult, ZecBackend } from '@silicr/zec';
import type { DecodedMemo, Transport } from '@silicr/protocol';
import { Mutex, errMsg, randomBytes, randomInt, sleep } from './util.ts';

export interface NoteEvent {
  note: ReceivedNote;
  /** null for anything that isn't a Silicr v1 memo (dummy outputs, change, funding). */
  decoded: DecodedMemo | null;
  /** false when this is the same note coming back mined after we first saw it unconfirmed. */
  firstSeen: boolean;
}

export interface NoteWatcherOptions {
  backend: ZecBackend;
  decode: (memo: MemoBytes) => DecodedMemo | null;
  pollMs: number;
  /** Start scanning at this height. */
  since: number;
  onNote: (e: NoteEvent) => Promise<void> | void;
  /** Called after every poll with the current tip. */
  onTick?: (height: number) => Promise<void> | void;
  /** Called after every poll with everything it returned (e.g. to notice a payment that vanished). */
  onPolled?: (notes: ReceivedNote[], height: number) => void;
  onError?: (e: unknown) => void;
}

/**
 * Polls the wallet and delivers each (txid, index) once, plus once more when an
 * unconfirmed note gets mined. Only Orchard notes are delivered.
 */
export class NoteWatcher {
  private readonly o: NoteWatcherOptions;
  private seen = new Map<string, number | null>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  since: number;
  height = 0;

  constructor(o: NoteWatcherOptions) {
    this.o = o;
    this.since = o.since;
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => this.schedule(this.o.pollMs));
    }, ms);
  }

  /**
   * One poll. A chain error degrades instead of stopping anything: a failed height() keeps the
   * last known tip and still polls, a failed poll() still runs onTick, and both are reported to
   * onError. Notes the wallet already holds (a CLOSE in the mempool, say) are delivered even while
   * the light-wallet server is unreachable.
   */
  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let tip = this.height;
      try {
        tip = await this.o.backend.height();
        this.height = tip;
      } catch (e) {
        this.o.onError?.(e);
        if (tip === 0) return; // nothing known yet: wait for the first height
      }
      let notes: ReceivedNote[];
      try {
        notes = await this.o.backend.poll(this.since);
      } catch (e) {
        this.o.onError?.(e);
        if (this.o.onTick && !this.stopped) await this.o.onTick(tip);
        return;
      }
      for (const note of notes) {
        if (this.stopped) return;
        if (note.pool !== 'orchard') continue; // never act on transparent or Sapling traffic
        const key = `${note.txid}:${note.index}`;
        const prev = this.seen.get(key);
        let firstSeen: boolean;
        if (prev === undefined) firstSeen = true;
        else if (prev === null && note.height !== null) firstSeen = false;
        else continue;
        this.seen.set(key, note.height);
        let decoded: DecodedMemo | null = null;
        try {
          decoded = this.o.decode(note.memo);
        } catch {
          decoded = null;
        }
        try {
          await this.o.onNote({ note, decoded, firstSeen });
        } catch (e) {
          this.o.onError?.(e);
        }
      }
      if (!this.stopped) {
        try {
          this.o.onPolled?.(notes, tip);
        } catch (e) {
          this.o.onError?.(e);
        }
      }
      this.since = Math.max(this.since, tip - 10);
      if (this.seen.size > 5000) {
        for (const [k, h] of this.seen) if (h !== null && h < this.since - 50) this.seen.delete(k);
      }
      if (this.o.onTick && !this.stopped) await this.o.onTick(tip);
    } catch (e) {
      this.o.onError?.(e);
    } finally {
      this.running = false;
    }
  }
}

export function isInsufficientFunds(e: unknown): boolean {
  return e instanceof InsufficientFundsError || (e instanceof Error && e.name === 'InsufficientFundsError');
}

export function isPrivacyError(e: unknown): boolean {
  return e instanceof Error && e.name === 'PrivacyError';
}

/**
 * One wallet, one transaction at a time. Retries for a while when the only problem
 * is change that hasn't confirmed yet (common right after a previous send).
 */
export class TxSender {
  private readonly backend: ZecBackend;
  private readonly mutex = new Mutex();
  private readonly retryMs: number;
  private readonly onSent: (r: SendResult, outputs: Output[]) => void;
  closed = false;

  constructor(backend: ZecBackend, retryMs: number, onSent: (r: SendResult, outputs: Output[]) => void) {
    this.backend = backend;
    this.retryMs = retryMs;
    this.onSent = onSent;
  }

  send(outputs: Output[], opts: { retryMs?: number } = {}): Promise<SendResult> {
    return this.mutex.run(async () => {
      const deadline = Date.now() + (opts.retryMs ?? this.retryMs);
      for (;;) {
        if (this.closed) throw new Error('node is shutting down');
        try {
          const r = await this.backend.send(outputs);
          this.onSent(r, outputs);
          return r;
        } catch (e) {
          if (!isInsufficientFunds(e) || Date.now() >= deadline) throw e;
          let pending = 0n;
          try {
            pending = (await this.backend.balance()).pending;
          } catch {
            pending = 0n;
          }
          if (pending <= 0n) throw e;
          await sleep(250);
        }
      }
    });
  }
}

/** Smallest output bucket (4, 8, 16, then multiples of 16) that holds n outputs. */
export function padBucket(n: number): number {
  if (n <= 4) return 4;
  if (n <= 8) return 8;
  if (n <= 16) return 16;
  return Math.ceil(n / 16) * 16;
}

/** A memo that decodes to null: 0xFF + random bytes (binary), or random text (text-only backends). */
export function dummyMemo(transport: Transport): Uint8Array {
  const m = new Uint8Array(512);
  if (transport === 'binary') {
    m[0] = 0xff;
    m.set(randomBytes(511), 1);
    return m;
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const len = 400 + randomInt(100);
  const r = randomBytes(len);
  for (let i = 0; i < len; i++) m[i] = alphabet.charCodeAt(r[i]! & 63);
  return m;
}

export function describeError(e: unknown): { code: string; message: string } {
  if (isPrivacyError(e)) return { code: 'privacy', message: errMsg(e) };
  if (isInsufficientFunds(e)) return { code: 'insufficient_funds', message: errMsg(e) };
  return { code: 'error', message: errMsg(e) };
}
