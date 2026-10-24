/**
 * The public provider directory: the latest entry per providerId (by updatedAt),
 * persisted to <dataDir>/directory.json.
 *
 * Writes are authenticated: an entry is accepted only if verifyDirectoryEntry()
 * (from @silicr/protocol) says it is a well-formed entry signed by the key in its
 * own providerId, and its updatedAt (Unix seconds) is a non-negative safe integer
 * no more than 24 h in the future. So nobody but the key holder can replace a
 * provider's entry, and nobody can pin it with an absurd timestamp. Entries are
 * stored and served exactly as received. Errors never echo body contents.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifyDirectoryEntry } from '@silicr/protocol';
import type { DirectoryEntry } from '@silicr/protocol';
import { MAX_DIRECTORY_FUTURE_S } from './limits.ts';
import { HttpError } from './store.ts';

const PROVIDER_ID_RE = /^[0-9a-f]{64}$/;

/** A rejected directory write. `providerId` is set only when it was well-formed hex. */
export class EntryRejected extends HttpError {
  readonly providerId: string | undefined;
  constructor(status: number, code: string, message: string, providerId?: string) {
    super(status, code, message);
    this.providerId = providerId;
  }
}

export interface CheckedEntry {
  providerId: string;
  /** Unix seconds. */
  updatedAt: number;
  sig: string;
  entry: Record<string, unknown>;
}

/** Shape, timestamp and signature checks. Throws EntryRejected (400) on failure. */
export function checkEntry(body: Buffer, nowMs = Date.now()): CheckedEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new EntryRejected(400, 'bad_request', 'body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EntryRejected(400, 'bad_request', 'entry must be a JSON object');
  }
  const entry = parsed as Record<string, unknown>;
  const { providerId, updatedAt, sig } = entry;
  if (typeof providerId !== 'string' || !PROVIDER_ID_RE.test(providerId)) {
    throw new EntryRejected(400, 'bad_entry', 'providerId must be 64 lowercase hex chars');
  }
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new EntryRejected(400, 'bad_entry', 'updatedAt must be a non-negative safe integer (Unix seconds)', providerId);
  }
  if (updatedAt > Math.floor(nowMs / 1000) + MAX_DIRECTORY_FUTURE_S) {
    throw new EntryRejected(400, 'bad_entry', 'updatedAt is more than 24 h in the future', providerId);
  }
  if (!verifyDirectoryEntry(entry as unknown as DirectoryEntry)) {
    throw new EntryRejected(400, 'bad_signature', 'not a well-formed directory entry signed by its providerId', providerId);
  }
  return { providerId, updatedAt, sig: sig as string, entry };
}

export class DirectoryStore {
  readonly file: string;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CheckedEntry>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, maxEntries: number) {
    this.file = join(dataDir, 'directory.json');
    this.maxEntries = maxEntries;
  }

  /**
   * Load directory.json, re-checking every entry (so rows written by an older,
   * unauthenticated relay are dropped). Returns how many rows were dropped.
   */
  async load(nowMs = Date.now()): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch {
      throw new Error(`relay: ${this.file} is not valid JSON; move it aside to start with an empty directory`);
    }
    if (!Array.isArray(list)) return 0;
    let dropped = 0;
    for (const item of list) {
      try {
        const checked = checkEntry(Buffer.from(JSON.stringify(item)), nowMs);
        const cur = this.entries.get(checked.providerId);
        if (!cur || checked.updatedAt > cur.updatedAt) this.entries.set(checked.providerId, checked);
        else dropped++;
      } catch {
        dropped++;
      }
    }
    if (dropped > 0) await this.persist();
    return dropped;
  }

  /**
   * Latest updatedAt wins. An older entry, or a different entry with the same
   * updatedAt, is refused with 409; re-publishing the identical entry is a no-op.
   */
  async publish(checked: CheckedEntry): Promise<void> {
    const cur = this.entries.get(checked.providerId);
    if (cur && checked.updatedAt < cur.updatedAt) {
      throw new EntryRejected(409, 'stale', 'a newer entry for this providerId is already stored', checked.providerId);
    }
    if (cur && checked.updatedAt === cur.updatedAt) {
      if (checked.sig === cur.sig) return; // identical (Ed25519 signatures are deterministic)
      throw new EntryRejected(409, 'stale', 'an entry with this updatedAt is already stored; publish with a later updatedAt', checked.providerId);
    }
    if (!cur && this.entries.size >= this.maxEntries) {
      throw new EntryRejected(507, 'directory_full', 'directory is full', checked.providerId);
    }
    this.entries.set(checked.providerId, checked);
    await this.persist();
  }

  /** Latest entry per providerId, sorted by providerId. */
  list(): Record<string, unknown>[] {
    return [...this.entries.values()]
      .sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0))
      .map((e) => e.entry);
  }

  get size(): number {
    return this.entries.size;
  }

  async close(): Promise<void> {
    await this.writes;
  }

  private persist(): Promise<void> {
    const run = this.writes.then(async () => {
      const data = JSON.stringify(this.list(), null, 2) + '\n';
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, this.file);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
}
