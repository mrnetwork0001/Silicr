// Guards: what a buyer may ship (L5), how big a result it accepts (L6), and a demo that must
// never wipe another live stack's data.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { checkJobPath } from '../src/jobpath.ts';
import { EngineError } from '../src/errors.ts';
import { startLocalStack } from '../src/stack.ts';
import { makeWorld, tempDir, waitFor, type World } from './helpers.ts';

let world: World | null = null;
const cleanup: string[] = [];
afterEach(async () => {
  await world?.close();
  world = null;
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

async function expectPrivacy(p: Promise<unknown>, re: RegExp): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EngineError);
  expect((e as EngineError).code).toBe('privacy');
  expect((e as Error).message).toMatch(re);
}

describe('job.path privacy checks (L5)', () => {
  it('refuses the filesystem root, $HOME, key dirs (inside or containing) and wallet data', async () => {
    const home = await tempDir('silicr-home-');
    cleanup.push(home);
    for (const d of ['.ssh/keys', '.gnupg', '.aws', '.config/gcloud', 'work/job', 'proj/.silicr', 'deep/a/b/.silicr', 'seedy']) await mkdir(join(home, d), { recursive: true });
    await writeFile(join(home, 'seedy', 'master.seed'), new Uint8Array(32));
    await writeFile(join(home, 'work', 'job', 'train.py'), 'print(1)\n');

    await expectPrivacy(checkJobPath('/', home), /whole filesystem/);
    await expectPrivacy(checkJobPath(home, home), /whole home directory/);
    await expectPrivacy(checkJobPath(join(home, '.ssh'), home), /inside ~\/\.ssh/);
    await expectPrivacy(checkJobPath(join(home, '.ssh', 'keys'), home), /inside ~\/\.ssh/);
    await expectPrivacy(checkJobPath(join(home, '.gnupg'), home), /inside ~\/\.gnupg/);
    await expectPrivacy(checkJobPath(join(home, '.aws'), home), /inside ~\/\.aws/);
    await expectPrivacy(checkJobPath(join(home, '.config'), home), /contains ~\/\.config\/gcloud/);
    await expectPrivacy(checkJobPath(join(home, 'proj'), home), /\.silicr, a Silicr data dir/);
    await expectPrivacy(checkJobPath(join(home, 'deep'), home), /a\/b\/\.silicr/);
    await expectPrivacy(checkJobPath(join(home, 'seedy'), home), /master\.seed/);
    // a symlink doesn't get around it
    await symlink(join(home, '.aws'), join(home, 'innocent'));
    await expectPrivacy(checkJobPath(join(home, 'innocent'), home), /inside ~\/\.aws/);
    // an ordinary job directory is fine
    expect(await checkJobPath(join(home, 'work', 'job'), home)).toMatch(/work\/job$/);
  });

  it('createRfq answers code "privacy" before anything is packed or sent', async () => {
    const w = (world = await makeWorld());
    await mkdir(join(w.jobDir, '.silicr', 'wallets'), { recursive: true });
    await expectPrivacy(
      w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: { path: w.jobDir, command: ['python3', 'train.py'] } }),
      /refusing to send .* to a provider/,
    );
    expect(w.buyer.listRfqs()).toHaveLength(0);
    expect(w.buyerBackend.sends).toHaveLength(0);
  });
});

describe('result size cap (L6)', () => {
  it('refuses a result larger than the buyer accepts', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 5, stepMs: 100 } }], buyerOpts: { maxResultBytes: 16 } }));
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: { path: w.jobDir, command: ['python3', 'train.py'] }, autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'failed', 'refusal', 20_000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.error).toMatch(/result refused: payload is \d+ bytes; at most 16 are accepted/);
    expect(r.result).toBeUndefined();
    expect(typeof r.closedAt).toBe('number');
  }, 30_000);
});

describe('local stack guards', () => {
  it('a busy port fails before the data dir is touched', async () => {
    const root = await tempDir('silicr-stack-');
    cleanup.push(root);
    await writeFile(join(root, 'keep.me'), 'live demo data');
    const busy: Server = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const port = (busy.address() as { port: number }).port;
    try {
      await expect(startLocalStack({ rootDir: root, fresh: true, ports: { relay: port, buyer: 0, provider: 0 }, runnerMode: 'process' })).rejects.toMatchObject({ code: 'EADDRINUSE', port });
      expect(existsSync(join(root, 'keep.me'))).toBe(true);
    } finally {
      await new Promise<void>((r) => busy.close(() => r()));
    }
  });

  it('refuses to wipe a data dir another live stack holds', async () => {
    const root = await tempDir('silicr-stack-');
    cleanup.push(root);
    await writeFile(join(root, 'stack.pid'), `${process.ppid}\n`); // a live process that isn't us
    await writeFile(join(root, 'keep.me'), 'live demo data');
    await expect(startLocalStack({ rootDir: root, fresh: true, ports: { relay: 0, buyer: 0, provider: 0 }, runnerMode: 'process' })).rejects.toThrow(/another Silicr stack/);
    expect(existsSync(join(root, 'keep.me'))).toBe(true);
  });
});
