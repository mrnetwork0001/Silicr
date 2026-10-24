import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkpointDigest, dockerRunArgs, parseProgress } from '../src/index.ts';
import { dockerSharesPath } from '../src/docker.ts';
import type { DockerInfo } from '../src/docker.ts';
import { LineSplitter, LogBuffer } from '../src/logs.ts';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
});

describe('progress lines', () => {
  it('parses SILICR_PROGRESS step=<n> and nothing else', () => {
    expect(parseProgress('SILICR_PROGRESS step=42')).toBe(42);
    expect(parseProgress('  SILICR_PROGRESS step=7  ')).toBe(7);
    expect(parseProgress('SILICR_PROGRESS step=8 loss=1.2')).toBe(8);
    expect(parseProgress('SILICR_PROGRESS step=abc')).toBeNull();
    expect(parseProgress('step 1 SILICR_PROGRESS step=1')).toBeNull();
    expect(parseProgress('SILICR_PROGRESS step=')).toBeNull();
    expect(parseProgress('SILICR_PROGRESSstep=1')).toBeNull();
  });

  it('splits chunks into lines, handling CRLF, carriage-return bars and split UTF-8', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l), 16);
    s.write(Buffer.from('one\ntw'));
    s.write(Buffer.from('o\r\n10%\r50%\r100%\n'));
    const euro = Buffer.from('€\n');
    s.write(euro.subarray(0, 1));
    s.write(euro.subarray(1));
    s.write(Buffer.from('x'.repeat(40)));
    s.write(Buffer.from('tail'));
    s.end();
    expect(lines).toEqual(['one', 'two', '100%', '€', 'x'.repeat(16), 'x'.repeat(16), 'xxxxxxxxtail']);
  });

  it('lets every reader replay the log from the start and ends on close', async () => {
    const buf = new LogBuffer();
    buf.push('a');
    buf.push('b');
    const early: string[] = [];
    const reading = (async () => {
      for await (const l of buf.read()) early.push(l);
    })();
    buf.push('c');
    await new Promise((r) => setTimeout(r, 10));
    buf.push('d');
    buf.close();
    await reading;
    const late: string[] = [];
    for await (const l of buf.read()) late.push(l);
    expect(early).toEqual(['a', 'b', 'c', 'd']);
    expect(late).toEqual(['a', 'b', 'c', 'd']);
  });

  it('bounds memory by dropping the oldest lines', async () => {
    const buf = new LogBuffer(3);
    for (const l of ['1', '2', '3', '4', '5']) buf.push(l);
    buf.close();
    const got: string[] = [];
    for await (const l of buf.read()) got.push(l);
    expect(got).toEqual(['3', '4', '5']);
  });
});

describe('checkpointDigest', () => {
  it('is 32 zero bytes for a missing or empty directory', async () => {
    const d = await mkdtemp(join(tmpdir(), 'silicr-digest-'));
    cleanups.push(d);
    expect(await checkpointDigest(join(d, 'missing'))).toEqual(new Uint8Array(32));
    await mkdir(join(d, 'only-dirs', 'nested'), { recursive: true });
    expect(await checkpointDigest(join(d, 'only-dirs'))).toEqual(new Uint8Array(32));
  });

  it('hashes sorted (path, size, sha256(content)) and ignores symlinks', async () => {
    const d = await mkdtemp(join(tmpdir(), 'silicr-digest-'));
    cleanups.push(d);
    await mkdir(join(d, 'sub'));
    await writeFile(join(d, 'b.json'), 'bbbb');
    await writeFile(join(d, 'sub', 'a.bin'), 'a');
    await symlink('/etc/passwd', join(d, 'z-link'));

    const sha = (s: string | Buffer) => createHash('sha256').update(s).digest();
    const rec = (path: string, content: string) => {
      const p = Buffer.from(path);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(p.length);
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(Buffer.byteLength(content)));
      return Buffer.concat([len, p, size, sha(content)]);
    };
    const expected = sha(Buffer.concat([rec('b.json', 'bbbb'), rec('sub/a.bin', 'a')]));
    const cache = new Map();
    expect(Buffer.from(await checkpointDigest(d, cache)).equals(expected)).toBe(true);
    // Cached second call agrees; a change is picked up.
    expect(Buffer.from(await checkpointDigest(d, cache)).equals(expected)).toBe(true);
    await writeFile(join(d, 'b.json'), 'changed');
    expect(Buffer.from(await checkpointDigest(d, cache)).equals(expected)).toBe(false);
  });
});

describe('docker argv', () => {
  const launch = {
    bin: 'docker',
    name: 'silicr-abc',
    image: 'python:3.12-slim',
    command: ['python', 'train.py', '--flag'],
    bundleDir: '/w/job-1/job',
    outputDir: '/w/job-1/output',
    checkpointDir: '/w/job-1/checkpoints',
    envFile: '/w/job-1/env',
    cpus: 2,
    memoryMb: 1024,
    gpus: 0,
  };

  it('isolates the job: no network, limits, read-only bundle, dropped caps', () => {
    const args = dockerRunArgs(launch);
    const joined = args.join(' ');
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(joined).toContain('--network none');
    expect(joined).toContain('--cpus 2');
    expect(joined).toContain('--memory 1024m');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--mount type=bind,source=/w/job-1/job,target=/job,readonly');
    expect(joined).toContain('--mount type=bind,source=/w/job-1/output,target=/silicr/output');
    expect(joined).toContain('--mount type=bind,source=/w/job-1/checkpoints,target=/silicr/checkpoints');
    expect(joined).toContain('-w /job');
    expect(joined).toContain('--name silicr-abc');
    expect(args).not.toContain('--gpus');
    expect(args.slice(-4)).toEqual(['python:3.12-slim', 'python', 'train.py', '--flag']);
  });

  it('passes GPUs only when asked to', () => {
    const args = dockerRunArgs({ ...launch, gpus: 4 });
    expect(args[args.indexOf('--gpus') + 1]).toBe('4');
  });

  it('quotes mount paths containing commas', () => {
    const args = dockerRunArgs({ ...launch, bundleDir: '/w/a,b/job' });
    expect(args).toContain('type=bind,"source=/w/a,b/job",target=/job,readonly');
  });

  it('knows Colima only shares the home directory', () => {
    const colima: DockerInfo = { serverVersion: '29', name: 'colima', operatingSystem: 'Ubuntu', ncpu: 4, memTotal: 1, nvidia: false };
    expect(dockerSharesPath(colima, '/Users/me/Silicr/.silicr/runner', 'darwin', '/Users/me')).toBe(true);
    expect(dockerSharesPath(colima, '/var/folders/xy/T/silicr', 'darwin', '/Users/me')).toBe(false);
    expect(dockerSharesPath(colima, '/Users/meagain/x', 'darwin', '/Users/me')).toBe(false);
    expect(dockerSharesPath(colima, '/tmp/colima/x', 'darwin', '/Users/me')).toBe(true);
    expect(dockerSharesPath({ ...colima, name: 'docker-desktop' }, '/var/folders/xy/T', 'darwin', '/Users/me')).toBe(true);
    expect(dockerSharesPath(colima, '/tmp/x', 'linux', '/home/me')).toBe(true);
  });
});
