/**
 * Sidecar lifecycle and the backend's RPC mapping, against a fake zec-sidecar (a small Node
 * script speaking the same JSON-lines protocol). No network, no Rust build, no funds.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { InsufficientFundsError, MEMO_SIZE, PrivacyError, randomOrchardAddress, toOrchardOnly } from '../src/index.ts';
import {
  SidecarExitedError,
  SidecarMissingError,
  SidecarTimeoutError,
  TxNotKnownError,
  createSidecarBackend,
  createTestnetBackend,
  type TestnetBackend,
} from '../src/testnet/index.ts';
import { Sidecar } from '../src/testnet/sidecar.ts';

const ADDR = 'utest1httsgu4zng6ywdzu9wahetvegs3f5lygju3m7qxu6qlht5k44gedr0cupnmg93hn4wkd202qjmlzf67n6rz3kytzxuqqqa2x4sxqvrj4';
const ADDR2 = 'utest16c6xwdea76wwprsn98v723xm9rmka8tgk6smps0vpw9l8lyg6x4tqpdn8q6pjdnhyp5exvzw95y9qep6fj899x8t4wddjz2xjynqu29y';
const PROVIDER = 'utest1due6gq77zyyt85k0w6fdrwh3aaytc2pmvzfdszlvtp9dn8ap6xk98r2vjszuf27ec40memtv3m8zfvk6ad9r23ts5akp5c93mgvnnqx9';

const dir = mkdtempSync(join(tmpdir(), 'silicr-fake-sidecar-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.env.FAKE_MODE || 'ok';
const rec = process.env.FAKE_RECORD;
const record = (m) => { if (rec) fs.appendFileSync(rec, JSON.stringify(m) + '\\n'); };
record({ argv: process.argv.slice(2), proxyEnv: process.env.SILICR_PROXY === undefined ? null : process.env.SILICR_PROXY });
const pi = process.argv.indexOf('--proxy');
const proxy = mode === 'ignore-proxy' || pi < 0 ? null : process.argv[pi + 1];
const ni = process.argv.indexOf('--network');
const network = mode === 'wrong-network' ? 'test' : ni < 0 ? 'test' : process.argv[ni + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stderr.write('fake sidecar starting\\n');
if (mode === 'fatal') { out({ event: 'fatal', error: 'lightwalletd at x reports chain "main"' }); process.exit(1); }
if (mode === 'exit') { process.exit(7); }
if (mode !== 'hang') out({ event: 'ready', network, server: 'https://fake:443', proxy, address: process.env.FAKE_ADDRESS, birthday: 4427000, tip: 4427100, syncMs: 5, scannedBlocks: 100, version: 'fake' });
process.on('SIGTERM', () => { record({ signal: 'SIGTERM' }); process.exit(0); });
if (mode === 'ignore-shutdown') setInterval(() => {}, 1000); // stay alive after stdin closes
const memo = 'ff' + '00'.repeat(511);
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
      case 'newAddress': ok({ address: process.env.FAKE_ADDRESS2, diversifierIndex: '01' }); break;
      case 'balance': ok({ spendable: '100000000', pending: '25000', mempoolIncoming: '0', ironwood: {}, legacyOrchard: { spendable: '0', changePending: '0', valuePending: '0' }, sapling: {}, synced: true }); break;
      case 'height': ok({ height: 4427101 }); break;
      case 'poll': ok({ tip: 4427101, notes: [
        { txid: 'ab'.repeat(32), index: 0, height: 4427050, toAddress: process.env.FAKE_ADDRESS, zats: '1000', memoHex: memo, pool: 'orchard', valuePool: 'ironwood', source: 'wallet' },
        { txid: 'cd'.repeat(32), index: 2, height: null, toAddress: process.env.FAKE_ADDRESS2, zats: '7', memoHex: memo, pool: 'orchard', valuePool: 'ironwood', source: 'mempool' },
      ] }); break;
      case 'send':
        if (req.params.outputs.some((o) => o.zats === '999999999999')) err('InsufficientFunds', 'insufficient spendable Ironwood funds');
        else ok({ txid: 'ef'.repeat(32), feeZats: '15000', actions: 3, proposeMs: 1, proveMs: 2, broadcastMs: 3, expiryHeight: 4427141 });
        break;
      case 'inspectTx':
        if (req.params.txid !== 'ab'.repeat(32)) { err('TxNotKnown', 'transaction ' + req.params.txid + ' is unknown to this wallet'); break; }
        ok({ txid: req.params.txid, height: null, time: null, version: 6, sizeBytes: 9000, feeZats: '10000',
        transparent: { inputs: 0, outputs: 0, coinbase: false }, sapling: { spends: 0, outputs: 0, valueBalanceZats: '0' },
        orchard: { actions: 0, valueBalanceZats: '0', ciphertextSamples: [] },
        ironwood: { actions: 2, valueBalanceZats: '10000', ciphertextSamples: ['11'.repeat(32), '22'.repeat(32)] },
        expiryHeight: 4427141, consensusBranchId: '37a5165b', fullyShieldedOrchardProtocol: true,
        source: 'broadcast', complete: true, estimated: [] }); break;
      case 'sleep': break;
      case 'crash': process.exit(3);
      case 'shutdown': ok({ bye: true }); if (mode !== 'ignore-shutdown') process.exit(0); break;
      default: err('BadRequest', 'unknown method ' + req.method);
    }
  }
});
process.stdin.on('end', () => { if (mode !== 'ignore-shutdown') process.exit(0); });
`;

const bin = join(dir, 'zec-sidecar');
writeFileSync(bin, FAKE);
chmodSync(bin, 0o755);

function env(mode: string, record: string): void {
  process.env['FAKE_MODE'] = mode;
  process.env['FAKE_RECORD'] = record;
  process.env['FAKE_ADDRESS'] = ADDR;
  process.env['FAKE_ADDRESS2'] = ADDR2;
}

function records(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let n = 0;
async function open(mode = 'ok', extra: Record<string, unknown> = {}): Promise<{ b: TestnetBackend; rec: string }> {
  const rec = join(dir, `rec-${++n}.jsonl`);
  env(mode, rec);
  const b = await createTestnetBackend({
    kind: 'testnet',
    dataDir: join(dir, `wallet-${n}`),
    sidecarPath: bin,
    logFile: null,
    startupTimeoutMs: 5000,
    requestTimeoutMs: 3000,
    ...extra,
  });
  return { b, rec };
}

const memo = (b: number) => new Uint8Array(MEMO_SIZE).fill(b);

describe('network selection', () => {
  const MAIN_ADDR = randomOrchardAddress('main');

  async function openMain(mode: string, extra: Record<string, unknown> = {}) {
    const rec = join(dir, `rec-main-${++n}.jsonl`);
    env(mode, rec);
    process.env['FAKE_ADDRESS'] = MAIN_ADDR;
    process.env['FAKE_ADDRESS2'] = randomOrchardAddress('main');
    const b = await createSidecarBackend({ kind: 'sidecar', network: 'main', dataDir: join(dir, `wallet-main-${n}`), sidecarPath: bin, logFile: null, startupTimeoutMs: 5000, requestTimeoutMs: 3000, proxy: null, ...extra });
    return { b, rec };
  }

  it('passes --network main, defaults to the mainnet server and guards addresses on mainnet', async () => {
    const { b, rec } = await openMain('ok');
    const argv = records(rec)[0]?.['argv'] as string[];
    expect(argv).toEqual(expect.arrayContaining(['--network', 'main', '--server', 'zec.rocks:443']));
    expect(b.network).toBe('main');
    expect(b.startup.network).toBe('main');
    expect(await b.address()).toBe(toOrchardOnly(MAIN_ADDR, 'main'));
    expect((await b.address()).startsWith('u1')).toBe(true);
    // A testnet recipient is refused on a mainnet wallet, by the guard, before the sidecar sees it.
    await expect(b.send([{ to: PROVIDER, zats: 1000n, memo: memo(1) }])).rejects.toBeInstanceOf(PrivacyError);
    await b.close();
  });

  it('refuses a sidecar that reports a different network than requested', async () => {
    await expect(openMain('wrong-network')).rejects.toThrow(/reports network "test" but main was requested/);
  });

  it('keeps the old kind on testnet', async () => {
    const { b } = await open('ok');
    expect(b.network).toBe('test');
    expect(b.startup.network).toBe('test');
    await b.close();
  });
});

describe('SOCKS5 proxy option', () => {
  const PROXY = 'socks5h://127.0.0.1:9050';

  it('passes --proxy to the sidecar, strips $SILICR_PROXY from its environment and reports the proxy in use', async () => {
    const { b, rec } = await open('ok', { proxy: PROXY });
    const first = records(rec)[0]!;
    expect(first['argv']).toEqual(expect.arrayContaining(['--proxy', PROXY]));
    expect(first['proxyEnv']).toBeNull();
    expect(b.proxy).toBe(PROXY);
    expect(b.startup.proxy).toBe(PROXY);
    await b.close();
  });

  it('refuses to run when the sidecar does not confirm the proxy (never a silent direct connection)', async () => {
    await expect(open('ignore-proxy', { proxy: PROXY })).rejects.toThrow(/did not confirm the SOCKS5 proxy .* refusing to run with a direct connection/);
  });

  it('lets a loopback server be reached directly even with a proxy configured', async () => {
    const { b } = await open('ignore-proxy', { proxy: PROXY, server: 'localhost:9067' });
    expect(b.proxy).toBeNull();
    await b.close();
  });

  it('defaults to $SILICR_PROXY, and proxy: null means direct even then', async () => {
    const before = process.env['SILICR_PROXY'];
    process.env['SILICR_PROXY'] = PROXY;
    try {
      const a = await open('ok');
      expect(records(a.rec)[0]!['argv']).toEqual(expect.arrayContaining(['--proxy', PROXY]));
      expect(a.b.proxy).toBe(PROXY);
      await a.b.close();
      const d = await open('ok', { proxy: null });
      expect(records(d.rec)[0]!['argv']).not.toContain('--proxy');
      expect(records(d.rec)[0]!['proxyEnv']).toBeNull();
      expect(d.b.proxy).toBeNull();
      await d.b.close();
    } finally {
      if (before === undefined) delete process.env['SILICR_PROXY'];
      else process.env['SILICR_PROXY'] = before;
    }
  });

  it('refuses anything that is not a SOCKS5 url before starting the sidecar', async () => {
    await expect(open('ok', { proxy: 'http://127.0.0.1:8118' })).rejects.toThrow(/SOCKS5 url like socks5h:\/\/127\.0\.0\.1:9050/);
    await expect(open('ok', { proxy: 42 })).rejects.toThrow(/proxy must be a string or null/);
  });
});

describe('sidecar lifecycle', () => {
  it('reports a missing binary clearly', async () => {
    await expect(
      createTestnetBackend({ kind: 'testnet', dataDir: join(dir, 'w-missing'), sidecarPath: join(dir, 'nope'), logFile: null }),
    ).rejects.toBeInstanceOf(SidecarMissingError);
    await expect(
      createTestnetBackend({ kind: 'testnet', dataDir: join(dir, 'w-missing'), sidecarPath: join(dir, 'nope'), logFile: null }),
    ).rejects.toThrow(/cargo build --release/);
  });

  it('passes testnet-only arguments and starts', async () => {
    const { b, rec } = await open('ok', { create: false, birthday: 4427000, untrustedConfirmations: 2 });
    const argv = records(rec)[0]?.['argv'] as string[];
    expect(argv.slice(0, 1)).toEqual(['serve']);
    expect(argv).toEqual(expect.arrayContaining(['--network', 'test', '--server', 'testnet.zec.rocks:443', '--birthday', '4427000', '--untrusted-confirmations', '2']));
    // Change splitting is on by default (4 notes) and configurable.
    expect(argv).toEqual(expect.arrayContaining(['--target-note-count', '4']));
    expect(argv).not.toContain('--create');
    expect(b.startup.tip).toBe(4427100);
    await b.close();
  });

  it('passes a custom targetNoteCount', async () => {
    const { b, rec } = await open('ok', { targetNoteCount: 1 });
    expect(records(rec)[0]?.['argv']).toEqual(expect.arrayContaining(['--target-note-count', '1']));
    await b.close();
  });

  it('surfaces a fatal startup error', async () => {
    await expect(open('fatal')).rejects.toThrow(/reports chain "main"/);
  });

  it('surfaces an early exit', async () => {
    await expect(open('exit')).rejects.toBeInstanceOf(SidecarExitedError);
  });

  it('times out a sidecar that never becomes ready', async () => {
    await expect(open('hang', { startupTimeoutMs: 300 })).rejects.toBeInstanceOf(SidecarTimeoutError);
  });

  it('times out a single request without killing the sidecar', async () => {
    const rec = join(dir, `rec-${++n}.jsonl`);
    env('ok', rec);
    const s = await Sidecar.start({ binary: bin, network: 'test', dataDir: join(dir, `w-${n}`), server: 'x:1', create: true, startupTimeoutMs: 5000, logFile: null });
    await expect(s.request('sleep', {}, 200)).rejects.toBeInstanceOf(SidecarTimeoutError);
    await expect(s.request('height', {}, 2000)).resolves.toEqual({ height: 4427101 });
    await s.close();
    expect(s.alive).toBe(false);
  });

  it('rejects in-flight requests when the sidecar dies, then restarts it', async () => {
    const { b, rec } = await open('ok');
    const s = (b as unknown as { sidecar: Sidecar }).sidecar;
    await expect(s.request('crash', {}, 2000)).rejects.toBeInstanceOf(SidecarExitedError);
    expect(s.alive).toBe(false);
    // Next call transparently restarts the sidecar (without --create).
    await expect(b.height()).resolves.toBe(4427101);
    const starts = records(rec).filter((r) => r['argv']);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.['argv']).not.toContain('--create');
    await b.close();
  });

  it('escalates to SIGTERM when the sidecar ignores shutdown', async () => {
    const { b, rec } = await open('ignore-shutdown');
    const t0 = Date.now();
    await (b as unknown as { sidecar: Sidecar }).sidecar.close(300);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(records(rec).some((r) => r['signal'] === 'SIGTERM')).toBe(true);
    await b.close();
  });
});

describe('backend over the sidecar', () => {
  it('maps every ZecBackend call', async () => {
    const { b, rec } = await open();
    expect(b.network).toBe('test');
    expect(await b.address()).toBe(ADDR);
    expect(await b.newAddress()).toBe(ADDR2);
    expect(await b.balance()).toMatchObject({ spendable: 100000000n, pending: 25000n });
    expect(await b.height()).toBe(4427101);

    const notes = await b.poll(4427000);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ index: 0, height: 4427050, toAddress: ADDR, zats: 1000n, pool: 'orchard', valuePool: 'ironwood' });
    expect(notes[1]).toMatchObject({ height: null, toAddress: ADDR2, source: 'mempool' });
    expect(notes.every((n) => n.valuePool === 'ironwood')).toBe(true);
    expect(notes[0]?.memo[0]).toBe(0xff);
    expect(records(rec).find((r) => r['method'] === 'poll')?.['params']).toEqual({ sinceHeight: 4427000 });

    const sent = await b.send([
      { to: PROVIDER, zats: 1000n, memo: memo(1) },
      { to: ADDR2, zats: 2000n, memo: memo(2) },
    ]);
    expect(sent).toMatchObject({ txid: 'ef'.repeat(32), feeZats: 15000n });
    const sendReq = records(rec).find((r) => r['method'] === 'send')?.['params'] as { outputs: { to: string; zats: string; memoHex: string }[] };
    expect(sendReq.outputs.map((o) => o.to)).toEqual([PROVIDER, ADDR2]);
    expect(sendReq.outputs.map((o) => o.zats)).toEqual(['1000', '2000']);
    expect(sendReq.outputs[1]?.memoHex).toBe('02'.repeat(MEMO_SIZE));

    const v = await b.inspectTx('AB'.repeat(32));
    expect(v.feeZats).toBe(10000n);
    expect(v.ironwood.actions).toBe(2);
    expect(v).toMatchObject({ source: 'broadcast', complete: true });
    await expect(b.inspectTx('nope')).rejects.toBeInstanceOf(RangeError);
    await expect(b.inspectTx('cd'.repeat(32))).rejects.toBeInstanceOf(TxNotKnownError);
    await b.close();
    await expect(b.height()).rejects.toThrow(/closed/);
  });

  it('refuses non-Orchard recipients before anything reaches the sidecar', async () => {
    const { b, rec } = await open();
    await expect(b.send([{ to: 'tmWK81GXyxz8D259FJPkmfpdLXD32F741co', zats: 1000n, memo: memo(0) }])).rejects.toBeInstanceOf(PrivacyError);
    await expect(
      b.send([
        { to: PROVIDER, zats: 1000n, memo: memo(0) },
        { to: 'ztestsapling1v6wh0dawepflf7yx5722fr77yatrl22hmg0ffd2tdxfl9rr356fper8gznajnl6ww3tuj67zv60', zats: 1000n, memo: memo(0) },
      ]),
    ).rejects.toBeInstanceOf(PrivacyError);
    expect(records(rec).some((r) => r['method'] === 'send')).toBe(false);
    await b.close();
  });

  it('maps InsufficientFunds', async () => {
    const { b } = await open();
    await expect(b.send([{ to: PROVIDER, zats: 999999999999n, memo: memo(0) }])).rejects.toBeInstanceOf(InsufficientFundsError);
    await b.close();
  });
});
