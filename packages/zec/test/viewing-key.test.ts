/**
 * Viewing keys for auditors, against a fake zec-sidecar (a Node script speaking the same
 * JSON-lines protocol and the same `export-ufvk` one-shot). No network, no Rust build, no funds.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MEMO_SIZE, ReadOnlyError, openBackend, randomOrchardAddress } from '../src/index.ts';
import { createSidecarBackend, exportViewingKeyOffline, parseLedger, parseViewingKey, SidecarProtocolError } from '../src/testnet/index.ts';

const ADDR = randomOrchardAddress('test');
const KEY = 'uviewtest1' + 'q'.repeat(40);
const MAIN_KEY = 'uview1' + 'q'.repeat(40);

const dir = mkdtempSync(join(tmpdir(), 'silicr-fake-ufvk-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const rec = process.env.FAKE_RECORD;
const record = (m) => { if (rec) fs.appendFileSync(rec, JSON.stringify(m) + '\\n'); };
const argv = process.argv.slice(2);
record({ argv });
if (argv[0] === 'export-ufvk') {
  if (!argv.includes('--confirm')) { process.stderr.write('error: re-run with --confirm\\n'); process.exit(2); }
  const net = argv[argv.indexOf('--network') + 1];
  if (process.env.FAKE_MODE === 'export-fails') { process.stderr.write('2026-10-22T00:00:00Z  INFO noise\\nerror: no wallet in ' + argv[argv.indexOf('--data-dir') + 1] + '\\n'); process.exit(1); }
  process.stdout.write((net === 'main' ? '${MAIN_KEY}' : '${KEY}') + '\\n');
  process.exit(0);
}
const vi = argv.indexOf('--ufvk');
const viewOnly = argv.includes('--view-only');
const key = vi < 0 ? null : argv[vi + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (key !== null && !viewOnly) { out({ event: 'fatal', error: '--ufvk requires --view-only' }); process.exit(2); }
out({ event: 'ready', network: 'test', server: 'https://fake:443', proxy: null, address: '${ADDR}', viewOnly, birthday: 4427000, tip: 4427100, syncMs: 5, scannedBlocks: 100, version: 'fake' });
const pay = 'ff' + Buffer.from('SLC1\\x01\\x04', 'latin1').toString('hex') + '00'.repeat(505);
const text = Buffer.from('thanks').toString('hex') + '00'.repeat(506);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const req = JSON.parse(line);
    record({ method: req.method, params: req.params });
    const ok = (result) => out({ id: req.id, ok: true, result });
    const err = (code, message) => out({ id: req.id, ok: false, error: { code, message } });
    switch (req.method) {
      case 'exportViewingKey': ok({ ufvk: key || '${KEY}', network: 'test', orchardOnly: true }); break;
      case 'ledger': ok({ tip: 4427100, birthday: 4427000, viewOnly, entries: [
        { txid: 'ab'.repeat(32), index: 0, height: 4427050, time: 1760000000, direction: 'received', zats: '50000', address: '${ADDR}', memoType: 'PAY', memoHex: pay, feeZats: null, valuePool: 'ironwood' },
        { txid: 'cd'.repeat(32), index: 1, height: 4427060, time: null, direction: 'sent', zats: '1000', address: '${ADDR}', memoType: 'text', memoHex: text, feeZats: '10000', valuePool: 'ironwood' },
        { txid: 'cd'.repeat(32), index: 0, height: 4427060, time: null, direction: 'change', zats: '39000', address: '${ADDR}', memoType: 'none', memoHex: 'f6' + '00'.repeat(511), feeZats: '10000', valuePool: 'ironwood' },
      ] }); break;
      case 'send': if (viewOnly) err('ReadOnly', 'this wallet is watch-only'); else ok({ txid: 'ef'.repeat(32), feeZats: '15000', actions: 2, proposeMs: 1, proveMs: 2, broadcastMs: 3, expiryHeight: 1 }); break;
      case 'shutdown': ok({ bye: true }); process.exit(0);
      default: err('BadRequest', 'unknown method ' + req.method);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const bin = join(dir, 'zec-sidecar');
writeFileSync(bin, FAKE);
chmodSync(bin, 0o755);

function records(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let n = 0;
function rec(): string {
  const r = join(dir, `rec-${++n}.jsonl`);
  process.env['FAKE_RECORD'] = r;
  delete process.env['FAKE_MODE'];
  return r;
}

const base = () => ({ kind: 'sidecar' as const, network: 'test' as const, dataDir: join(dir, `w-${n}`), sidecarPath: bin, logFile: null, startupTimeoutMs: 5000, requestTimeoutMs: 3000, proxy: null });

describe('exportViewingKeyOffline (one-shot, no wallet process)', () => {
  it('runs export-ufvk --confirm for the wallet and returns the key', async () => {
    const r = rec();
    const key = await exportViewingKeyOffline({ dataDir: '/tmp/x', network: 'test', sidecarPath: bin });
    expect(key).toBe(KEY);
    expect(records(r)[0]!['argv']).toEqual(['export-ufvk', '--data-dir', '/tmp/x', '--network', 'test', '--confirm']);
    expect(await exportViewingKeyOffline({ dataDir: '/tmp/x', network: 'main', sidecarPath: bin })).toBe(MAIN_KEY);
  });

  it('surfaces the sidecar error (without log noise) and refuses a non-UFVK answer', async () => {
    rec();
    process.env['FAKE_MODE'] = 'export-fails';
    await expect(exportViewingKeyOffline({ dataDir: '/tmp/none', network: 'test', sidecarPath: bin })).rejects.toThrow(/no wallet in \/tmp\/none/);
    await expect(exportViewingKeyOffline({ dataDir: '/tmp/none', network: 'test', sidecarPath: bin })).rejects.not.toThrow(/INFO noise/);
    delete process.env['FAKE_MODE'];
    // A testnet key is not a mainnet key.
    await expect(exportViewingKeyOffline({ dataDir: '/tmp/x', network: 'main', sidecarPath: join(dir, 'missing') })).rejects.toThrow(/not found/);
  });
});

describe('spending wallet: exportViewingKey()', () => {
  it('asks the sidecar and checks the HRP and Orchard-only flag', async () => {
    const r = rec();
    const b = await createSidecarBackend(base());
    expect(b.readOnly).toBe(false);
    expect(await b.exportViewingKey()).toBe(KEY);
    expect(records(r).some((m) => m['method'] === 'exportViewingKey')).toBe(true);
    expect(records(r)[0]!['argv']).not.toContain('--view-only');
    await b.close();
  });

  it('parseViewingKey refuses the wrong network or a non-Orchard-only key', () => {
    expect(() => parseViewingKey({ ufvk: KEY, orchardOnly: true }, 'main')).toThrow(SidecarProtocolError);
    expect(() => parseViewingKey({ ufvk: MAIN_KEY, orchardOnly: true }, 'test')).toThrow(SidecarProtocolError);
    expect(() => parseViewingKey({ ufvk: KEY, orchardOnly: false }, 'test')).toThrow(/Orchard-only/);
    expect(() => parseViewingKey({ ufvk: 'secret-extended-key-test1abc', orchardOnly: true }, 'test')).toThrow(SidecarProtocolError);
    expect(parseViewingKey({ ufvk: KEY, orchardOnly: true }, 'test')).toBe(KEY);
  });
});

describe('watch-only wallet from a viewing key', () => {
  it('starts the sidecar with --view-only --ufvk, lists the ledger and refuses to send', async () => {
    const r = rec();
    const b = await openBackend({ ...base(), viewingKey: KEY });
    expect(records(r)[0]!['argv']).toEqual(expect.arrayContaining(['--view-only', '--ufvk', KEY]));
    const sb = b as Awaited<ReturnType<typeof createSidecarBackend>>;
    expect(sb.readOnly).toBe(true);
    expect(sb.startup.viewOnly).toBe(true);
    expect(await b.address()).toBe(ADDR);

    const ledger = await sb.ledger();
    expect(ledger.viewOnly).toBe(true);
    expect(ledger.entries).toHaveLength(3);
    const [recv, sent, change] = ledger.entries;
    expect(recv).toMatchObject({ direction: 'received', zats: 50000n, memoType: 'PAY', height: 4427050, time: 1760000000, feeZats: null });
    expect(recv!.memo).toHaveLength(MEMO_SIZE);
    expect(recv!.memo[0]).toBe(0xff);
    expect(sent).toMatchObject({ direction: 'sent', zats: 1000n, memoType: 'text', feeZats: 10000n, address: ADDR });
    expect(change).toMatchObject({ direction: 'change', zats: 39000n, memoType: 'none' });

    // send() is refused here, before the sidecar is even asked.
    const before = records(r).filter((m) => m['method'] === 'send').length;
    await expect(b.send([{ to: ADDR, zats: 1n, memo: new Uint8Array(MEMO_SIZE) }])).rejects.toBeInstanceOf(ReadOnlyError);
    expect(records(r).filter((m) => m['method'] === 'send').length).toBe(before);
    // The watch wallet can hand the same key on (an auditor may re-export it).
    expect(await b.exportViewingKey!()).toBe(KEY);
    await b.close();
  });

  it('refuses a key for the other network before any process starts', async () => {
    rec();
    await expect(openBackend({ ...base(), viewingKey: MAIN_KEY })).rejects.toThrow(/uviewtest1… unified full viewing key for testnet/);
    await expect(openBackend({ ...base(), network: 'main', viewingKey: KEY })).rejects.toThrow(/uview1… unified full viewing key for mainnet/);
    await expect(openBackend({ ...base(), viewingKey: 'abandon abandon abandon' })).rejects.toThrow(/never accepted/);
  });

  it('maps the sidecar\'s own ReadOnly refusal to ReadOnlyError (second line of defence)', async () => {
    rec();
    const b = await openBackend({ ...base(), viewingKey: KEY });
    // Bypass the TS guard and ask the sidecar directly, as a buggy caller might.
    const s = (b as unknown as { sidecar: { request: (m: string, p: Record<string, unknown>) => Promise<unknown> } }).sidecar;
    await expect(s.request('send', { outputs: [] })).rejects.toBeInstanceOf(ReadOnlyError);
    await b.close();
  });

  it('parseLedger validates every row', () => {
    expect(() => parseLedger({ entries: [{ txid: 'zz' }], tip: 1, birthday: 1 })).toThrow(SidecarProtocolError);
    expect(() => parseLedger({ entries: [{ txid: 'ab'.repeat(32), index: 0, height: 1, time: null, direction: 'up', zats: '1', address: null, memoType: 'none', memoHex: 'f6' + '00'.repeat(511), feeZats: null, valuePool: 'ironwood' }], tip: 1, birthday: 1 })).toThrow(/direction/);
    expect(() => parseLedger({ entries: [{ txid: 'ab'.repeat(32), index: 0, height: 1, time: null, direction: 'sent', zats: '1', address: null, memoType: 'weird', memoHex: 'f6' + '00'.repeat(511), feeZats: null, valuePool: 'ironwood' }], tip: 1, birthday: 1 })).toThrow(/memo type/);
    expect(parseLedger({ entries: [], tip: null, birthday: 7 })).toEqual({ entries: [], tip: null, birthday: 7, viewOnly: false });
  });
});
