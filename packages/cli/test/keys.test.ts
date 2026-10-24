// `silicr export-viewing-key` and `silicr watch`, with the wallet backend mocked: nothing here
// starts a sidecar or touches a network. Checks the warning, the --yes / prompt gate, that the key
// is the only thing on stdout, the network resolution, and the ledger table / JSON.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMO_SIZE, ReadOnlyError, type ZecBackend } from '@silicr/zec';
import { buildProgram } from '../src/program.ts';
import { exportViewingKey, watch, SCOPE_WARNING } from '../src/commands/keys.ts';

const KEY = 'uviewtest1' + 'q'.repeat(60);
const MAIN_KEY = 'uview1' + 'q'.repeat(60);
const ADDR = 'utest1httsgu4zng6ywdzu9wahetvegs3f5lygju3m7qxu6qlht5k44gedr0cupnmg93hn4wkd202qjmlzf67n6rz3kytzxuqqqa2x4sxqvrj4';

const exportMock = vi.fn(async (o: { dataDir: string; network: string }) => (o.network === 'main' ? MAIN_KEY : KEY));
const openMock = vi.fn(async (_cfg: unknown): Promise<ZecBackend> => Promise.reject(new Error('no wallet backend in tests')));

vi.mock('@silicr/zec', async (importOriginal) => {
  const real = await importOriginal<typeof import('@silicr/zec')>();
  return {
    ...real,
    exportViewingKeyOffline: (o: { dataDir: string; network: string }) => exportMock(o),
    openBackend: (cfg: unknown) => openMock(cfg),
  };
});

let tmp: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'silicr-cli-keys-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});
afterAll(async () => {
  exitSpy.mockRestore();
  await rm(tmp, { recursive: true, force: true });
});
afterEach(() => {
  exportMock.mockClear();
  openMock.mockClear();
});

/** Runs `silicr …`, returning stdout and stderr separately (ANSI stripped). */
async function silicr(...args: string[]): Promise<{ out: string; err: string; failed: boolean }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  let failed = false;
  try {
    await buildProgram().exitOverride().parseAsync(args, { from: 'user' });
  } catch (e) {
    if (!/exit 1/.test((e as Error).message)) throw e;
    failed = true;
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  // eslint-disable-next-line no-control-regex
  const strip = (l: string[]) => l.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  return { out: strip(out), err: strip(err), failed };
}

async function withTty<T>(tty: boolean, fn: () => Promise<T>): Promise<T> {
  const streams = [process.stdin, process.stdout] as const;
  const prev = streams.map((s) => Object.getOwnPropertyDescriptor(s, 'isTTY'));
  for (const s of streams) Object.defineProperty(s, 'isTTY', { value: tty, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    streams.forEach((s, i) => {
      if (prev[i]) Object.defineProperty(s, 'isTTY', prev[i]!);
      else delete (s as unknown as Record<string, unknown>)['isTTY'];
    });
  }
}

async function walletDir(name: string, meta: Record<string, unknown> | null, config?: Record<string, unknown>): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  if (meta) await writeFile(join(dir, 'wallet.json'), JSON.stringify(meta));
  if (config) await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

describe('silicr export-viewing-key', () => {
  it('with --yes: warns on stderr, prints only the key on stdout, and uses the offline export', async () => {
    const dir = await walletDir('w-test', { network: 'test', birthday: 1 });
    const r = await silicr('export-viewing-key', '--data', dir, '--yes');
    expect(r.failed).toBe(false);
    expect(r.out.trim()).toBe(KEY);
    expect(r.out.trim().split('\n')).toHaveLength(1);
    expect(r.err).toContain('VIEWING KEY EXPORT');
    expect(r.err).toContain('reveals the WHOLE wallet');
    expect(r.err).toContain('never includes spending authority');
    expect(r.err).toContain('one wallet per audit scope');
    expect(r.err).not.toContain(KEY);
    expect(exportMock).toHaveBeenCalledWith({ dataDir: dir, network: 'test' });
  });

  it('resolves the network from config.json, then wallet.json, and labels mainnet', async () => {
    const cfg = await walletDir('w-cfg', null, { v: 1, role: 'buyer', network: 'main', relayUrl: 'x', port: 1 });
    const r = await silicr('export-viewing-key', '--data', cfg, '--yes');
    expect(r.out.trim()).toBe(MAIN_KEY);
    expect(r.err).toContain('REAL ZEC');
    expect(exportMock).toHaveBeenLastCalledWith({ dataDir: cfg, network: 'main' });
    const meta = await walletDir('w-meta', { network: 'main' });
    expect((await silicr('export-viewing-key', '--data', meta, '--yes')).out.trim()).toBe(MAIN_KEY);
    // --network wins over both.
    expect((await silicr('export-viewing-key', '--data', meta, '--network', 'test', '--yes')).out.trim()).toBe(KEY);
  });

  it('refuses memory-network dirs and dirs with no wallet, printing nothing', async () => {
    const mem = await walletDir('w-mem', null, { v: 1, role: 'buyer', network: 'memory', relayUrl: 'x', port: 1 });
    const r = await silicr('export-viewing-key', '--data', mem, '--yes');
    expect(r.failed).toBe(true);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/memory-network/);
    const none = await walletDir('w-none', null);
    const r2 = await silicr('export-viewing-key', '--data', none, '--yes');
    expect(r2.failed).toBe(true);
    expect(r2.err).toMatch(/no wallet found/);
    expect(exportMock).not.toHaveBeenCalled();
  });

  it('without --yes: needs a terminal, and anything but yes prints nothing', async () => {
    const dir = await walletDir('w-tty', { network: 'test' });
    const r = await withTty(false, () => silicr('export-viewing-key', '--data', dir));
    expect(r.failed).toBe(true);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/re-run with --yes/);
    expect(exportMock).not.toHaveBeenCalled();

    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(exportViewingKey({ data: dir, ask: async () => 'n' })).rejects.toThrow(/exit 1/);
      expect(out).toEqual([]);
      expect(exportMock).not.toHaveBeenCalled();
      await exportViewingKey({ data: dir, ask: async () => 'y' });
      expect(out).toEqual([KEY]);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it('reports a failed export without inventing a key', async () => {
    const dir = await walletDir('w-fail', { network: 'test' });
    exportMock.mockRejectedValueOnce(new Error('wallet x is already open'));
    const r = await silicr('export-viewing-key', '--data', dir, '--yes');
    expect(r.failed).toBe(true);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/could not export the viewing key: wallet x is already open/);
  });
});

function fakeWatchBackend(entries: unknown[], readOnly = true) {
  const closed = { n: 0 };
  const b = {
    network: 'test' as const,
    capabilities: { binaryMemos: true, maxOutputsPerTx: 40, diversifiedAddresses: true, minOutputZats: 1n, mempoolNotes: true, inspectTx: true },
    readOnly,
    address: async () => ADDR,
    newAddress: async () => ADDR,
    balance: async () => ({ spendable: 0n, pending: 0n }),
    height: async () => 4427100,
    send: async () => {
      throw new ReadOnlyError('watch-only');
    },
    poll: async () => [],
    ledger: async () => ({ entries, tip: 4427100, birthday: 4427000, viewOnly: readOnly }),
    close: async () => void closed.n++,
  };
  return { b: b as unknown as ZecBackend, closed };
}

const memo = (first: number, text?: string) => {
  const m = new Uint8Array(MEMO_SIZE);
  m[0] = first;
  if (text) m.set(Buffer.from(text), 0);
  return m;
};

const ENTRIES = [
  { txid: 'ab'.repeat(32), index: 0, height: 4427050, time: 1760000000, direction: 'received', zats: 50000n, address: ADDR, memoType: 'PAY', memo: memo(0xff), feeZats: null, valuePool: 'ironwood' },
  { txid: 'cd'.repeat(32), index: 1, height: 4427060, time: 1760000100, direction: 'sent', zats: 1000n, address: ADDR, memoType: 'text', memo: memo(0, 'invoice 42'), feeZats: 10000n, valuePool: 'ironwood' },
  { txid: 'cd'.repeat(32), index: 0, height: 4427060, time: 1760000100, direction: 'change', zats: 39000n, address: ADDR, memoType: 'none', memo: memo(0xf6), feeZats: 10000n, valuePool: 'ironwood' },
  { txid: 'ef'.repeat(32), index: 0, height: 4427070, time: null, direction: 'sent', zats: 2000n, address: ADDR, memoType: 'RFQ', memo: memo(0xff), feeZats: 20000n, valuePool: 'ironwood' },
];

describe('silicr watch', () => {
  it('opens a watch-only backend from the key and prints the ledger table with totals and the scope warning', async () => {
    const { b, closed } = fakeWatchBackend(ENTRIES);
    openMock.mockResolvedValueOnce(b);
    const dir = join(tmp, 'watch-1');
    const r = await silicr('watch', '--network', 'test', '--data', dir, '--viewing-key', KEY);
    expect(r.failed).toBe(false);
    expect(openMock).toHaveBeenCalledWith({ kind: 'sidecar', network: 'test', dataDir: dir, proxy: null, viewingKey: KEY });
    expect(r.out).toContain('watch-only wallet');
    expect(r.out).toContain('no spending key');
    expect(r.out).toMatch(/received +0\.0005 ZEC in 1 notes/);
    expect(r.out).toMatch(/sent +0\.00003 ZEC in 2 payments, 0\.0003 ZEC fees/);
    expect(r.out).toMatch(/4427050 +2025-10-09 \d\d:\d\d +in +0\.0005 ZEC +PAY +abababababab…/);
    expect(r.out).toMatch(/4427060 .* out +0\.00001 ZEC +text "invoice 42"/);
    expect(r.out).toMatch(/4427060 .* change +0\.00039 ZEC +none/);
    expect(r.out).toMatch(/4427070 +- +out +0\.00002 ZEC +RFQ/);
    expect(r.out).toContain(SCOPE_WARNING);
    expect(closed.n).toBe(1);
  });

  it('--json prints every row with decimal zats and hex memos', async () => {
    openMock.mockResolvedValueOnce(fakeWatchBackend(ENTRIES).b);
    const r = await silicr('watch', '--network', 'test', '--data', join(tmp, 'watch-2'), '--viewing-key', KEY, '--json');
    const j = JSON.parse(r.out) as { network: string; address: string; viewOnly: boolean; entries: Record<string, unknown>[] };
    expect(j).toMatchObject({ network: 'test', address: ADDR, birthday: 4427000, tip: 4427100, viewOnly: true });
    expect(j.entries).toHaveLength(4);
    expect(j.entries[1]).toMatchObject({ txid: 'cd'.repeat(32), direction: 'sent', zats: '1000', feeZats: '10000', memoType: 'text', height: 4427060 });
    expect((j.entries[1]!['memoHex'] as string).startsWith(Buffer.from('invoice 42').toString('hex'))).toBe(true);
    expect(j.entries[0]).toMatchObject({ feeZats: null, time: 1760000000 });
  });

  it('says so when there is nothing yet', async () => {
    openMock.mockResolvedValueOnce(fakeWatchBackend([]).b);
    const r = await silicr('watch', '--network', 'test', '--data', join(tmp, 'watch-3'), '--viewing-key', KEY);
    expect(r.out).toMatch(/no payments yet/);
  });

  it('refuses a key for the wrong network, a seed phrase, and a missing key on a new dir, before opening anything', async () => {
    const r1 = await silicr('watch', '--network', 'main', '--data', join(tmp, 'watch-4'), '--viewing-key', KEY);
    expect(r1.failed).toBe(true);
    expect(r1.err).toMatch(/uview1… unified full viewing key for mainnet/);
    const r2 = await silicr('watch', '--network', 'test', '--data', join(tmp, 'watch-5'), '--viewing-key', 'abandon abandon ability');
    expect(r2.failed).toBe(true);
    expect(r2.err).toMatch(/seed phrases and spending keys are refused/);
    const r3 = await silicr('watch', '--network', 'test', '--data', join(tmp, 'watch-6'));
    expect(r3.failed).toBe(true);
    expect(r3.err).toMatch(/--viewing-key <uview…> is needed/);
    expect(openMock).not.toHaveBeenCalled();
  });

  it('re-opens an existing watch-only dir without the key (read back offline), and passes --server/--proxy/--birthday', async () => {
    const dir = await walletDir('watch-7', { network: 'test', viewOnly: true });
    openMock.mockResolvedValueOnce(fakeWatchBackend([]).b);
    const r = await silicr('watch', '--network', 'test', '--data', dir, '--server', 'localhost:9067', '--proxy', 'socks5h://127.0.0.1:9050', '--birthday', '4400000');
    expect(r.failed).toBe(false);
    expect(exportMock).toHaveBeenCalledWith({ dataDir: dir, network: 'test' });
    expect(openMock).toHaveBeenCalledWith({ kind: 'sidecar', network: 'test', dataDir: dir, proxy: 'socks5h://127.0.0.1:9050', server: 'localhost:9067', birthday: 4400000, viewingKey: KEY });
  });

  it('refuses a backend that is not watch-only (it would hold a spending key)', async () => {
    const { b, closed } = fakeWatchBackend(ENTRIES, false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(watch({ network: 'test', data: join(tmp, 'watch-8'), viewingKey: KEY, backend: b })).rejects.toThrow(/exit 1/);
    } finally {
      err.mockRestore();
    }
    expect(closed.n).toBe(1);
  });

  it('reports a backend that will not open', async () => {
    openMock.mockRejectedValueOnce(new Error('zec-sidecar failed to start: invalid unified full viewing key'));
    const r = await silicr('watch', '--network', 'test', '--data', join(tmp, 'watch-9'), '--viewing-key', KEY);
    expect(r.failed).toBe(true);
    expect(r.err).toMatch(/could not open the watch-only wallet: .*invalid unified full viewing key/);
  });
});
