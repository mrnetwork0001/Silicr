/**
 * Checkpoint digest, sent in every heartbeat so the buyer can tell the job is advancing.
 *
 *   digest = SHA-256( for each regular file, sorted by relative POSIX path (byte order):
 *              u32be(len(path)) || path (UTF-8) || u64be(size) || SHA-256(content) )
 *
 * An empty or missing directory gives 32 zero bytes. Symlinks and special files are
 * ignored (never followed). Per-file hashes are cached by (path, size, mtime, inode),
 * so repeated calls only re-read files that changed.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { walkTree } from './bundle.ts';

export interface DigestCache {
  get(key: string): { stamp: string; size: number; sha: Buffer } | undefined;
  set(key: string, value: { stamp: string; size: number; sha: Buffer }): unknown;
}

export async function checkpointDigest(dir: string, cache: DigestCache = new Map()): Promise<Uint8Array> {
  const files = (await walkTree(dir, { special: 'skip', allowMissing: true })).filter((e) => e.type === 'file');
  const outer = createHash('sha256');
  let count = 0;
  for (const f of files) {
    let st;
    try {
      st = await stat(f.abs);
    } catch {
      continue; // deleted since the walk
    }
    if (!st.isFile()) continue;
    const stamp = `${st.size}:${st.mtimeMs}:${st.ino}`;
    let hit = cache.get(f.rel);
    if (!hit || hit.stamp !== stamp) {
      const hashed = await hashFile(f.abs);
      if (!hashed) continue;
      hit = { stamp, size: hashed.size, sha: hashed.sha };
      cache.set(f.rel, hit);
    }
    const path = Buffer.from(f.rel, 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(path.byteLength);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(hit.size));
    outer.update(head).update(path).update(size).update(hit.sha);
    count++;
  }
  if (count === 0) return new Uint8Array(32);
  return new Uint8Array(outer.digest());
}

async function hashFile(path: string): Promise<{ size: number; sha: Buffer } | null> {
  const h = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const b = chunk as Buffer;
      size += b.byteLength;
      h.update(b);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return { size, sha: h.digest() };
}
