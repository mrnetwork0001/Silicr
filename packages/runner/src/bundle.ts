/**
 * Job bundles: deterministic tar.gz packing and safe unpacking.
 *
 * Packing is canonical: entries in byte-wise sorted pre-order, fixed mtime,
 * uid/gid 0, no user/group names, modes normalised to 0644/0755 (dirs 0755),
 * PAX headers only where a path does not fit ustar, and a gzip header with no
 * timestamp and OS byte 0xff. The same directory always packs to the same bytes
 * (with the same Node/zlib build).
 *
 * Unpacking validates the whole archive before writing anything, then extracts:
 * only regular files and directories, relative paths without '..', no symlinks,
 * hard links, devices or FIFOs, and a cap on total unpacked size and entry count.
 * It never follows a symlink that already exists under the target directory.
 */
import { once } from 'node:events';
import { constants as fsc } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { Header, Parser, Pax } from 'tar';
import type { ReadEntry } from 'tar';

/** Default cap on unpacked (and packed) content, in bytes. */
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
/** Default cap on the number of entries in a bundle. */
export const MAX_BUNDLE_ENTRIES = 100_000;
/** Fixed mtime written for every entry: 2000-01-01T00:00:00Z. */
export const BUNDLE_MTIME = new Date(946_684_800_000);

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

export interface PackOptions {
  /** Refuse to pack more than this many bytes of file content. Default 512 MiB. */
  maxBytes?: number;
  /**
   * What to do with symlinks, sockets, FIFOs and devices: 'error' (default) or 'skip'.
   * Symlinks are never followed either way. Use 'skip' when packing job outputs.
   */
  special?: 'error' | 'skip';
}

export interface UnpackOptions {
  /** Max total bytes of file content. Default 512 MiB. */
  maxBytes?: number;
  /** Max number of entries. Default 100,000. */
  maxEntries?: number;
}

export interface TreeEntry {
  /** POSIX relative path, no leading './', no trailing '/'. */
  rel: string;
  abs: string;
  type: 'file' | 'dir';
  size: number;
  /** Normalised: 0o755 for dirs and executables, else 0o644. */
  mode: number;
}

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Walk a directory: byte-wise sorted pre-order, regular files and dirs only,
 * never following symlinks. Missing root → [] when allowMissing.
 */
export async function walkTree(root: string, opts: { special?: 'error' | 'skip'; allowMissing?: boolean } = {}): Promise<TreeEntry[]> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (err) {
    if (opts.allowMissing && (err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (!rootStat.isDirectory()) throw new BundleError(`not a directory: ${root}`);
  const out: TreeEntry[] = [];
  const visit = async (absDir: string, relDir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(absDir);
    } catch (err) {
      if (opts.allowMissing && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    names.sort(byteOrder);
    for (const name of names) {
      const abs = join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      let st;
      try {
        st = await lstat(abs);
      } catch (err) {
        if (opts.allowMissing && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (st.isDirectory()) {
        out.push({ rel, abs, type: 'dir', size: 0, mode: 0o755 });
        await visit(abs, rel);
      } else if (st.isFile()) {
        out.push({ rel, abs, type: 'file', size: st.size, mode: st.mode & 0o111 ? 0o755 : 0o644 });
      } else if (opts.special !== 'skip') {
        throw new BundleError(`${quote(rel)} is a ${describe(st)}; bundles may only contain regular files and directories`);
      }
    }
  };
  await visit(root, '');
  return out;
}

/** Deterministic tar.gz of a directory (sorted entries, fixed mtimes) so digests are stable. */
export async function packBundle(dir: string, opts: PackOptions = {}): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? MAX_BUNDLE_BYTES;
  const entries = await walkTree(dir, { special: opts.special ?? 'error' });
  let total = 0;
  for (const e of entries) {
    if (e.rel.includes('\\')) throw new BundleError(`${quote(e.rel)}: backslashes are not allowed in bundle paths`);
    total += e.size;
    if (total > maxBytes) throw new BundleError(`bundle exceeds ${maxBytes} bytes`);
  }

  const gz = createGzip({ level: 6 });
  const chunks: Buffer[] = [];
  gz.on('data', (c: Buffer) => chunks.push(c));
  const ended = once(gz, 'end');
  const write = async (buf: Buffer) => {
    if (!gz.write(buf)) await once(gz, 'drain');
  };

  for (const e of entries) {
    if (e.type === 'dir') {
      await write(headerBlocks(`${e.rel}/`, 'Directory', 0, 0o755));
      continue;
    }
    await write(headerBlocks(e.rel, 'File', e.size, e.mode));
    const fh = await open(e.abs, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    try {
      let left = e.size;
      while (left > 0) {
        // A fresh buffer per chunk: gzip may still hold the previous one.
        const buf = Buffer.allocUnsafe(Math.min(1024 * 1024, left));
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (bytesRead === 0) throw new BundleError(`${quote(e.rel)} changed while packing`);
        await write(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
        left -= bytesRead;
      }
      const { bytesRead: extra } = await fh.read(Buffer.alloc(1), 0, 1, null);
      if (extra !== 0) throw new BundleError(`${quote(e.rel)} changed while packing`);
    } finally {
      await fh.close();
    }
    const pad = (512 - (e.size % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad));
  }
  gz.end(Buffer.alloc(1024)); // end-of-archive marker
  await ended;

  const out = concat(chunks);
  // Gzip header: MTIME = 0 (zlib already leaves it 0) and OS = 255 ("unknown"), so the
  // header does not depend on the build platform.
  out[4] = 0;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  out[9] = 0xff;
  return out;
}

function headerBlocks(path: string, type: 'File' | 'Directory', size: number, mode: number): Buffer {
  const block = Buffer.alloc(512);
  const header = new Header({
    path,
    mode,
    uid: 0,
    gid: 0,
    size,
    mtime: BUNDLE_MTIME,
    type,
    uname: '',
    gname: '',
    devmaj: 0,
    devmin: 0,
  });
  if (!header.encode(block, 0)) return block;
  const pax = new Pax({ path, mtime: BUNDLE_MTIME, uid: 0, gid: 0, size }).encode();
  return Buffer.concat([pax, block]);
}

interface PlanEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
  mode: number;
}

/** Rejects absolute paths, '..' traversal, symlinks and device files. */
export async function unpackBundle(bytes: Uint8Array, intoDir: string, opts: UnpackOptions = {}): Promise<void> {
  const limits = { maxBytes: opts.maxBytes ?? MAX_BUNDLE_BYTES, maxEntries: opts.maxEntries ?? MAX_BUNDLE_ENTRIES };
  if (bytes.byteLength < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new BundleError('bundle is not a gzip-compressed tar');
  // Pass 1: validate everything; nothing touches the disk.
  const plan = await scan(bytes, limits, null);
  // Pass 2: extract, re-checking each entry against the plan.
  await mkdir(intoDir, { recursive: true });
  const root = await realpath(intoDir);
  await scan(bytes, limits, new Extractor(root, plan));
}

class Extractor {
  readonly root: string;
  readonly plan: PlanEntry[];
  private readonly dirs = new Set<string>();
  private index = 0;

  constructor(root: string, plan: PlanEntry[]) {
    this.root = root;
    this.plan = plan;
  }

  expect(e: PlanEntry): void {
    const p = this.plan[this.index++];
    if (!p || p.path !== e.path || p.type !== e.type || p.size !== e.size) throw new BundleError('bundle changed between validation and extraction');
  }

  /** mkdir -p inside root, refusing any existing component that is not a real directory. */
  async ensureDir(rel: string): Promise<string> {
    let cur = this.root;
    for (const seg of rel.split('/')) {
      cur = join(cur, seg);
      if (this.dirs.has(cur)) continue;
      try {
        const st = await lstat(cur);
        if (!st.isDirectory()) throw new BundleError(`refusing to extract through ${quote(rel)}: an existing ${describe(st)} is in the way`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        await mkdir(cur, { mode: 0o755 });
      }
      this.dirs.add(cur);
    }
    return cur;
  }

  async writeFile(e: PlanEntry, data: AsyncIterable<Buffer>): Promise<void> {
    const slash = e.path.lastIndexOf('/');
    const parent = slash < 0 ? this.root : await this.ensureDir(e.path.slice(0, slash));
    const abs = join(parent, e.path.slice(slash + 1));
    try {
      const st = await lstat(abs);
      if (!st.isFile()) throw new BundleError(`refusing to overwrite ${quote(e.path)}: an existing ${describe(st)} is in the way`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const fh = await open(abs, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_NOFOLLOW, e.mode);
    try {
      let written = 0;
      for await (const chunk of data) {
        await fh.write(chunk);
        written += chunk.byteLength;
      }
      if (written !== e.size) throw new BundleError(`${quote(e.path)}: truncated entry`);
      await fh.chmod(e.mode);
    } finally {
      await fh.close();
    }
  }
}

function scan(bytes: Uint8Array, limits: { maxBytes: number; maxEntries: number }, extractor: Extractor | null): Promise<PlanEntry[]> {
  return new Promise<PlanEntry[]>((resolve, reject) => {
    const plan: PlanEntry[] = [];
    const seen = new Set<string>();
    const files = new Set<string>();
    const dirs = new Set<string>();
    let total = 0;
    let failed = false;
    let allZero = true;
    let ops: Promise<void> = Promise.resolve();

    const gunzip = createGunzip();
    const parser = new Parser({ strict: false, zstd: false, brotli: false, maxDecompressionRatio: Number.POSITIVE_INFINITY, maxMetaEntrySize: 64 * 1024 });

    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      gunzip.destroy();
      reject(err instanceof BundleError ? err : new BundleError(`invalid bundle: ${err instanceof Error ? err.message : String(err)}`));
    };

    parser.on('entry', (entry: ReadEntry) => {
      if (failed) {
        entry.resume();
        return;
      }
      let e: PlanEntry | null;
      try {
        e = checkEntry(entry);
        if (e) {
          if (seen.has(e.path)) throw new BundleError(`duplicate entry ${quote(e.path)}`);
          seen.add(e.path);
          const parts = e.path.split('/');
          for (let i = 1; i < parts.length; i++) {
            const anc = parts.slice(0, i).join('/');
            if (files.has(anc)) throw new BundleError(`${quote(e.path)} is inside the file ${quote(anc)}`);
            dirs.add(anc);
          }
          if (e.type === 'file') {
            if (dirs.has(e.path)) throw new BundleError(`${quote(e.path)} is both a file and a directory`);
            files.add(e.path);
          } else {
            dirs.add(e.path);
          }
          if (plan.length >= limits.maxEntries) throw new BundleError(`bundle has more than ${limits.maxEntries} entries`);
          total += e.size;
          if (total > limits.maxBytes) throw new BundleError(`bundle exceeds ${limits.maxBytes} bytes unpacked`);
          plan.push(e);
          extractor?.expect(e);
        }
      } catch (err) {
        entry.resume();
        fail(err);
        return;
      }
      if (!extractor || !e) {
        entry.resume();
        return;
      }
      const planned = e;
      if (planned.type === 'dir') {
        entry.resume();
        ops = ops.then(() => extractor.ensureDir(planned.path).then(() => undefined));
      } else {
        ops = ops.then(() => extractor.writeFile(planned, entry));
      }
      ops.catch(fail);
    });
    parser.on('ignoredEntry', (entry: ReadEntry) => fail(new BundleError(`unsupported entry type ${entry.type} for ${quote(entry.path)}`)));
    parser.on('warn', (code: string, message: string) => {
      // An archive holding only end-of-archive blocks (an empty bundle) is fine.
      if (code === 'TAR_BAD_ARCHIVE' && allZero && plan.length === 0 && /Unrecognized archive format/.test(message)) return;
      fail(new BundleError(`invalid bundle: ${message}`));
    });
    parser.on('error', fail);
    parser.on('end', () => {
      if (failed) return;
      ops.then(() => {
        if (!failed) resolve(plan);
      }, fail);
    });

    // Decompress ourselves so the decompressed size is capped (a gzip bomb stops early).
    const maxRaw = limits.maxBytes + (limits.maxEntries + 64) * 1536 + 1024 * 1024;
    let raw = 0;
    gunzip.on('data', (chunk: Buffer) => {
      if (failed) return;
      raw += chunk.byteLength;
      if (raw > maxRaw) return fail(new BundleError(`bundle exceeds ${limits.maxBytes} bytes unpacked`));
      if (allZero && !chunk.every((b) => b === 0)) allZero = false;
      let more: boolean;
      try {
        more = parser.write(chunk);
      } catch (err) {
        return fail(err);
      }
      if (!more) {
        gunzip.pause();
        parser.once('drain', () => gunzip.resume());
      }
    });
    gunzip.on('end', () => {
      if (!failed) parser.end();
    });
    gunzip.on('error', (err) => fail(new BundleError(`invalid bundle: ${err.message}`)));
    gunzip.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}

function checkEntry(entry: ReadEntry): PlanEntry | null {
  const type = entry.type;
  let kind: 'file' | 'dir';
  if (type === 'Directory') kind = 'dir';
  else if (type === 'File' || type === 'ContiguousFile') kind = 'file';
  else if (type === 'OldFile') kind = entry.path.endsWith('/') ? 'dir' : 'file';
  else if (type === 'SymbolicLink') throw new BundleError(`symlinks are not allowed: ${quote(entry.path)}`);
  else if (type === 'Link') throw new BundleError(`hard links are not allowed: ${quote(entry.path)}`);
  else if (type === 'CharacterDevice' || type === 'BlockDevice') throw new BundleError(`device files are not allowed: ${quote(entry.path)}`);
  else if (type === 'FIFO') throw new BundleError(`FIFOs are not allowed: ${quote(entry.path)}`);
  else throw new BundleError(`unsupported entry type ${type} for ${quote(entry.path)}`);

  const path = normalizePath(entry.path);
  if (path === null) {
    if (kind !== 'dir') throw new BundleError(`invalid file path ${quote(entry.path)}`);
    return null; // the bundle root ("./")
  }
  const size = kind === 'file' ? entry.size : 0;
  if (kind === 'dir' && entry.size !== 0) throw new BundleError(`directory entry with data: ${quote(entry.path)}`);
  const mode = kind === 'dir' || (entry.mode ?? 0) & 0o111 ? 0o755 : 0o644;
  return { path, type: kind, size, mode };
}

/** Canonical relative path, null for the root, or throws for anything unsafe. */
export function normalizePath(raw: string): string | null {
  if (raw.length === 0 || Buffer.byteLength(raw) > 4096) throw new BundleError(`invalid path length: ${quote(raw)}`);
  if (raw.includes('\0')) throw new BundleError('path contains a NUL byte');
  if (raw.includes('\\')) throw new BundleError(`backslashes are not allowed in paths: ${quote(raw)}`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new BundleError(`absolute paths are not allowed: ${quote(raw)}`);
  let p = raw;
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/+$/, '');
  if (p === '' || p === '.') return null;
  for (const seg of p.split('/')) {
    if (seg === '..') throw new BundleError(`path traversal is not allowed: ${quote(raw)}`);
    if (seg === '' || seg === '.') throw new BundleError(`non-canonical path: ${quote(raw)}`);
    if (Buffer.byteLength(seg) > 255) throw new BundleError(`path segment too long: ${quote(raw)}`);
  }
  return p;
}

function describe(st: { isSymbolicLink(): boolean; isFIFO(): boolean; isSocket(): boolean; isCharacterDevice(): boolean; isBlockDevice(): boolean; isFile(): boolean }): string {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFIFO()) return 'FIFO';
  if (st.isSocket()) return 'socket';
  if (st.isCharacterDevice() || st.isBlockDevice()) return 'device';
  if (st.isFile()) return 'file';
  return 'special file';
}

function quote(p: string): string {
  return JSON.stringify(p.length > 200 ? `${p.slice(0, 200)}…` : p);
}

function concat(chunks: Buffer[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
