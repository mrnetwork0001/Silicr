import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLE_MTIME, BundleError, packBundle, unpackBundle } from '../src/index.ts';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
});

async function tempDir(prefix = 'silicr-bundle-test-'): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

/** A sample job directory with nesting, an empty dir, binary data, an executable and long/unicode names. */
async function sampleTree(root: string): Promise<void> {
  await mkdir(join(root, 'src', 'pkg'), { recursive: true });
  await mkdir(join(root, 'empty'));
  await writeFile(join(root, 'train.py'), 'print("hello")\n');
  await writeFile(join(root, 'src', 'pkg', 'data.bin'), randomBytes(70_000));
  await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho run\n');
  await chmod(join(root, 'run.sh'), 0o775);
  await writeFile(join(root, 'zero.txt'), '');
  const long = 'd'.repeat(90);
  await mkdir(join(root, long, long), { recursive: true });
  await writeFile(join(root, long, long, `${'f'.repeat(60)}.txt`), 'deep');
  await writeFile(join(root, 'naïve-ünïcode.txt'), 'utf8 name');
}

async function readTree(root: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(join(root, rel))).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = await stat(join(root, r));
    if (st.isDirectory()) {
      out[`${r}/`] = 'dir';
      Object.assign(out, await readTree(root, r));
    } else {
      // Bundles normalise modes to 0644 / 0755 (any exec bit).
      out[r] = `${st.mode & 0o111 ? '755' : '644'} ${(await readFile(join(root, r))).toString('base64')}`;
    }
  }
  return out;
}

// ---- minimal raw tar writer, so tests can build archives node-tar would never produce ----
function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}
function rawEntry(name: string, o: { type?: string; data?: Buffer; size?: number; linkname?: string; mode?: number } = {}): Buffer {
  const data = o.data ?? Buffer.alloc(0);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(o.mode ?? 0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(o.size ?? data.length, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.fill(' ', 148, 156);
  h.write(o.type ?? '0', 156, 'ascii');
  if (o.linkname) h.write(o.linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}
function paxEntry(records: Record<string, string>): Buffer {
  let body = '';
  for (const [k, v] of Object.entries(records)) {
    const rec = ` ${k}=${v}\n`;
    let len = rec.length + 1;
    while (`${len}${rec}`.length !== len) len++;
    body += `${len}${rec}`;
  }
  return rawEntry('PaxHeader/x', { type: 'x', data: Buffer.from(body) });
}
const tgz = (...entries: Buffer[]) => new Uint8Array(gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));

describe('packBundle', () => {
  it('round-trips files, dirs, empty dirs, modes, binary data, long and unicode names', async () => {
    const src = await tempDir();
    await sampleTree(src);
    const bytes = await packBundle(src);
    const dst = join(await tempDir(), 'out');
    await unpackBundle(bytes, dst);
    expect(await readTree(dst)).toEqual(await readTree(src));
    expect((await stat(join(dst, 'run.sh'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(dst, 'train.py'))).mode & 0o777).toBe(0o644);
  });

  it('is deterministic: same dir, same bytes, regardless of mtimes, umask bits or creation order', async () => {
    const a = await tempDir();
    await sampleTree(a);
    const first = await packBundle(a);
    const second = await packBundle(a);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);

    // A copy made in a different order, with different mtimes and group-write bits.
    const b = await tempDir();
    const files = await readTree(a);
    const names = Object.keys(files).reverse();
    for (const n of names) {
      if (n.endsWith('/')) await mkdir(join(b, n), { recursive: true });
    }
    for (const n of names) {
      if (n.endsWith('/')) continue;
      const [mode, b64] = files[n]!.split(' ') as [string, string];
      await writeFile(join(b, n), Buffer.from(b64, 'base64'));
      await chmod(join(b, n), mode === '755' ? 0o775 : 0o664);
      await utimes(join(b, n), new Date(2020, 1, 1), new Date(2021, 5, 5));
    }
    expect(Buffer.from(await packBundle(b)).equals(Buffer.from(first))).toBe(true);
  });

  it('writes a canonical archive: fixed mtime, no owner names, sorted entries, no gzip timestamp', async () => {
    const src = await tempDir();
    await writeFile(join(src, 'b.txt'), 'b');
    await writeFile(join(src, 'a.txt'), 'a');
    await mkdir(join(src, 'c'));
    await writeFile(join(src, 'c', 'x'), 'x');
    const bytes = Buffer.from(await packBundle(src));
    expect([...bytes.subarray(0, 4)]).toEqual([0x1f, 0x8b, 0x08, 0x00]);
    expect([...bytes.subarray(4, 8)]).toEqual([0, 0, 0, 0]); // gzip MTIME
    expect(bytes[9]).toBe(0xff); // gzip OS: unknown
    const tar = gunzipSync(bytes);
    const names: string[] = [];
    for (let off = 0; off + 512 <= tar.length; ) {
      const h = tar.subarray(off, off + 512);
      if (h.every((x) => x === 0)) break;
      const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      names.push(name);
      expect(Number.parseInt(h.subarray(136, 148).toString('ascii'), 8)).toBe(BUNDLE_MTIME.getTime() / 1000);
      expect(Number.parseInt(h.subarray(108, 116).toString('ascii'), 8)).toBe(0); // uid
      expect(Number.parseInt(h.subarray(116, 124).toString('ascii'), 8)).toBe(0); // gid
      expect(h.subarray(265, 297).toString('utf8').replace(/\0.*$/s, '')).toBe(''); // uname
      expect(h.subarray(297, 329).toString('utf8').replace(/\0.*$/s, '')).toBe(''); // gname
      const size = Number.parseInt(h.subarray(124, 136).toString('ascii'), 8);
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual(['a.txt', 'b.txt', 'c/', 'c/x']);
  });

  it('packs an empty directory into a bundle that unpacks', async () => {
    const src = await tempDir();
    const bytes = await packBundle(src);
    const dst = join(await tempDir(), 'out');
    await unpackBundle(bytes, dst);
    expect(await readdir(dst)).toEqual([]);
  });

  it('refuses symlinks and special files by default, and skips them on request', async () => {
    const src = await tempDir();
    await writeFile(join(src, 'real.txt'), 'real');
    await symlink('/etc/passwd', join(src, 'passwd-link'));
    await expect(packBundle(src)).rejects.toThrow(/symlink/);
    const skipped = await packBundle(src, { special: 'skip' });
    const dst = join(await tempDir(), 'out');
    await unpackBundle(skipped, dst);
    expect(await readdir(dst)).toEqual(['real.txt']);
  });

  it('packs hard-linked files as plain copies', async () => {
    const src = await tempDir();
    await writeFile(join(src, 'a.txt'), 'shared');
    await link(join(src, 'a.txt'), join(src, 'b.txt'));
    const dst = join(await tempDir(), 'out');
    await unpackBundle(await packBundle(src), dst);
    expect(await readFile(join(dst, 'b.txt'), 'utf8')).toBe('shared');
  });

  it('enforces maxBytes', async () => {
    const src = await tempDir();
    await writeFile(join(src, 'big.bin'), Buffer.alloc(5000));
    await expect(packBundle(src, { maxBytes: 4000 })).rejects.toThrow(BundleError);
  });
});

describe('unpackBundle rejects unsafe archives', () => {
  const cases: [string, () => Uint8Array, RegExp][] = [
    ['.. traversal', () => tgz(rawEntry('../evil.txt', { data: Buffer.from('x') })), /traversal/],
    ['nested .. traversal', () => tgz(rawEntry('a/../../evil.txt', { data: Buffer.from('x') })), /traversal/],
    ['absolute path', () => tgz(rawEntry('/tmp/silicr-evil.txt', { data: Buffer.from('x') })), /absolute/],
    ['windows drive path', () => tgz(rawEntry('C:/evil.txt', { data: Buffer.from('x') })), /absolute/],
    ['backslash path', () => tgz(rawEntry('a\\..\\..\\evil.txt', { data: Buffer.from('x') })), /backslash/],
    ['symlink', () => tgz(rawEntry('link', { type: '2', linkname: '/etc/passwd' })), /symlink/],
    ['symlink then write through it', () => tgz(rawEntry('d', { type: '2', linkname: '/tmp' }), rawEntry('d/evil.txt', { data: Buffer.from('x') })), /symlink/],
    ['hard link', () => tgz(rawEntry('a.txt', { data: Buffer.from('a') }), rawEntry('hl', { type: '1', linkname: 'a.txt' })), /hard link/],
    ['character device', () => tgz(rawEntry('tty', { type: '3' })), /device/],
    ['block device', () => tgz(rawEntry('disk', { type: '4' })), /device/],
    ['FIFO', () => tgz(rawEntry('pipe', { type: '6' })), /FIFO/],
    ['sparse file (unsupported type)', () => tgz(rawEntry('sparse', { type: 'S' })), /unsupported/],
    ['PAX path override to ..', () => tgz(paxEntry({ path: '../pax-evil.txt' }), rawEntry('innocent.txt', { data: Buffer.from('x') })), /traversal/],
    ['GNU long name to ..', () => tgz(rawEntry('././@LongLink', { type: 'L', data: Buffer.from('../../gnu-evil.txt\0') }), rawEntry('innocent.txt', { data: Buffer.from('x') })), /traversal/],
    ['duplicate entries', () => tgz(rawEntry('a.txt', { data: Buffer.from('1') }), rawEntry('a.txt', { data: Buffer.from('2') })), /duplicate/],
    ['file under a file', () => tgz(rawEntry('a', { data: Buffer.from('1') }), rawEntry('a/b', { data: Buffer.from('2') })), /inside the file/],
    ['not gzip', () => new Uint8Array(Buffer.concat([rawEntry('a.txt', { data: Buffer.from('x') }), Buffer.alloc(1024)])), /gzip/],
    ['bad checksum', () => {
      const e = rawEntry('a.txt', { data: Buffer.from('x') });
      e[0] = 'b'.charCodeAt(0);
      return tgz(e);
    }, /invalid bundle/],
    ['truncated', () => {
      const full = gzipSync(Buffer.concat([rawEntry('a.txt', { data: randomBytes(5000) }), Buffer.alloc(1024)]));
      return new Uint8Array(full.subarray(0, full.length - 40));
    }, /invalid bundle/],
  ];

  for (const [name, make, why] of cases) {
    it(name, async () => {
      const parent = await tempDir();
      const into = join(parent, 'into');
      const err = await unpackBundle(make(), into).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BundleError);
      expect((err as Error).message).toMatch(why);
      // Validation happens before extraction: nothing was written anywhere.
      const left = await readdir(into).catch(() => []);
      expect(left).toEqual([]);
      expect((await readdir(parent)).filter((n) => n !== 'into')).toEqual([]);
    });
  }

  it('never writes through a symlink that already exists in the target', async () => {
    const outside = await tempDir();
    const into = await tempDir();
    await symlink(outside, join(into, 'sub'));
    const bytes = tgz(rawEntry('sub/evil.txt', { data: Buffer.from('x') }));
    await expect(unpackBundle(bytes, into)).rejects.toThrow(/symlink/);
    expect(await readdir(outside)).toEqual([]);
    const fileLink = tgz(rawEntry('victim.txt', { data: Buffer.from('x') }));
    await writeFile(join(outside, 'target.txt'), 'original');
    await symlink(join(outside, 'target.txt'), join(into, 'victim.txt'));
    await expect(unpackBundle(fileLink, into)).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('original');
  });

  it('caps the unpacked size, also against highly compressible data', async () => {
    const into = join(await tempDir(), 'into');
    await expect(unpackBundle(tgz(rawEntry('big.bin', { data: Buffer.alloc(2000) })), into, { maxBytes: 1000 })).rejects.toThrow(/exceeds 1000 bytes/);
    const t0 = Date.now();
    const bomb = tgz(rawEntry('zeros.bin', { data: Buffer.alloc(64 * 1024 * 1024) }));
    expect(bomb.byteLength).toBeLessThan(200 * 1024);
    await expect(unpackBundle(bomb, into, { maxBytes: 1024 * 1024 })).rejects.toThrow(/exceeds/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await readdir(into).catch(() => [])).toEqual([]);
  });

  it('caps the number of entries', async () => {
    const into = join(await tempDir(), 'into');
    const many = tgz(...Array.from({ length: 5 }, (_, i) => rawEntry(`f${i}.txt`, { data: Buffer.from('x') })));
    await expect(unpackBundle(many, into, { maxEntries: 3 })).rejects.toThrow(/more than 3 entries/);
  });

  it('accepts archives made by other tools ("./" prefixes, root entry)', async () => {
    const into = join(await tempDir(), 'into');
    const bytes = tgz(
      rawEntry('./', { type: '5', mode: 0o755 }),
      rawEntry('./dir/', { type: '5', mode: 0o755 }),
      rawEntry('./dir/a.txt', { data: Buffer.from('hello') }),
      rawEntry('./x.sh', { data: Buffer.from('#!/bin/sh\n'), mode: 0o4755 }),
    );
    await unpackBundle(bytes, into);
    expect(await readFile(join(into, 'dir', 'a.txt'), 'utf8')).toBe('hello');
    // setuid and other special bits are stripped.
    expect((await stat(join(into, 'x.sh'))).mode & 0o7777).toBe(0o755);
  });
});
