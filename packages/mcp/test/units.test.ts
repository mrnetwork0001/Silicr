// Pure logic: money parsing, the session cap, CLI args, result-path guard and the leak matrix.
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeakObservation, PublicTxViewDto, RfqDto } from '@silicr/api';
import { parseCliArgs } from '../src/args.ts';
import { SpendingCap } from '../src/cap.ts';
import { buildLeakReport, chainObservation, classifyField, computeMatrix, classifyObservation } from '../src/leaks.ts';
import { resultTarget } from '../src/tools.ts';
import { trimRfq } from '../src/trim.ts';
import { formatZec, parseZec, perInterval } from '../src/zec.ts';

describe('zec', () => {
  it('parses decimals, suffixes and numbers; formats back', () => {
    expect(parseZec('0.8')).toBe(80_000_000n);
    expect(parseZec('0.8 ZEC/h')).toBe(80_000_000n);
    expect(parseZec(0.05)).toBe(5_000_000n);
    expect(parseZec('125000zats')).toBe(125_000n);
    expect(formatZec(123_456_789n)).toBe('1.23456789');
    expect(formatZec(80_000_000n)).toBe('0.8');
    expect(() => parseZec('abc')).toThrow(/not a ZEC amount/);
    expect(() => parseZec(-1)).toThrow();
    expect(() => parseZec('0.123456789')).toThrow(/decimal/);
    expect(perInterval(80_000_000n, 4)).toBe(88_889n);
  });
});

describe('spending cap', () => {
  it('reserves the worst case, then counts what finished requests actually cost', () => {
    const cap = new SpendingCap(50_000_000n);
    cap.reserve('a', 8_000_000n);
    cap.reserve('b', 4_000_000n);
    const states: Record<string, { state: string; spentZats: string; feesZats: string }> = {
      a: { state: 'closed', spentZats: '400000', feesZats: '95000' },
      b: { state: 'running', spentZats: '200000', feesZats: '45000' },
    };
    const u = cap.usage((id) => states[id]);
    expect(u.committedZats).toBe(495_000n + 4_000_000n);
    expect(u.spentZats).toBe(740_000n);
    expect(u.remainingZats).toBe(50_000_000n - 4_495_000n);
    expect(u.requests).toBe(2);
    // an unknown request keeps its reservation; a live one that overspent its reservation counts its spend
    cap.reserve('c', 1_000_000n);
    states.b = { state: 'running', spentZats: '5000000', feesZats: '0' };
    expect(cap.usage((id) => states[id]).committedZats).toBe(495_000n + 5_000_000n + 1_000_000n);
    expect(cap.isReserved('A')).toBe(true);
  });

  it('never goes negative', () => {
    const cap = new SpendingCap(1_000n);
    cap.reserve('x', 5_000n);
    expect(cap.remaining(() => undefined)).toBe(0n);
  });
});

describe('cli args', () => {
  it('defaults to the demo ports, a 0.05 ZEC cap and .silicr/mcp-results', () => {
    const o = parseCliArgs([], {}, '/work');
    expect(o).toMatchObject({ buyerUrl: 'http://127.0.0.1:7701', providerUrl: 'http://127.0.0.1:7702', relayUrl: null, maxTotalZats: 5_000_000n, outDir: '/work/.silicr/mcp-results', help: false });
  });

  it('reads flags and env, and accepts "none"', () => {
    const o = parseCliArgs(['--buyer', 'http://127.0.0.1:9001/', '--provider', 'none', '--relay', 'http://127.0.0.1:9000', '--max-total-zec', '0.5', '--out-dir', '/tmp/r'], {}, '/work');
    expect(o).toMatchObject({ buyerUrl: 'http://127.0.0.1:9001', providerUrl: null, relayUrl: 'http://127.0.0.1:9000', maxTotalZats: 50_000_000n, outDir: '/tmp/r' });
    expect(parseCliArgs([], { SILICR_MCP_MAX_TOTAL_ZEC: '1.5', SILICR_BUYER_URL: 'http://localhost:7801' }, '/w').maxTotalZats).toBe(150_000_000n);
    expect(() => parseCliArgs(['--max-total-zec', 'lots'])).toThrow(/max-total-zec/);
    expect(() => parseCliArgs(['--buyer', 'ftp://x'])).toThrow(/http/);
    expect(() => parseCliArgs(['--bogus'])).toThrow();
  });
});

describe('result path guard', () => {
  it('keeps results inside the out dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'silicr-mcp-out-'));
    const out = join(root, 'results');
    expect(await resultTarget(out, 'a.tar.gz')).toBe(join(out, 'a.tar.gz'));
    expect(await resultTarget(out, 'sub/b.tar.gz')).toBe(join(out, 'sub', 'b.tar.gz'));
    await expect(resultTarget(out, '../escape.tar.gz')).rejects.toThrow(/outside/);
    await expect(resultTarget(out, '/tmp/escape.tar.gz')).rejects.toThrow(/outside/);
    await expect(resultTarget(out, '.')).rejects.toThrow(/outside/);
    await expect(resultTarget(out, 'sub/../../x.tar.gz')).rejects.toThrow(/outside/);
    // a symlinked subdirectory pointing outside is refused too
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(out, 'link'));
    await expect(resultTarget(out, 'link/c.tar.gz')).rejects.toThrow(/outside/);
  });
});

const f = (label: string, value: string, readable: boolean, sensitive: boolean, facts?: string[]) => ({ label, value, readable, sensitive, ...(facts ? { facts } : {}) });
const obs = (party: LeakObservation['party'], event: string, fields: ReturnType<typeof f>[], at = 1_000_000, extra: Partial<LeakObservation> = {}): LeakObservation =>
  ({ id: `${party}-${event}-${at}`, party, at, event, summary: event, fields, ...extra }) as LeakObservation;

describe('leak matrix', () => {
  it('uses facts tags when present, labels otherwise, and never counts unreadable fields as known', () => {
    expect(classifyField(f('Buyer key (this RFQ only)', '68e7…', true, false) as never, 'provider')).toContain('buyer_identity');
    expect(classifyField(f('client ip', '127.0.0.1', true, true) as never, 'relay')).toEqual(['buyer_ip']);
    expect(classifyField(f('Client IP', '198.51.100.23', true, true, []) as never, 'relay')).toEqual([]);
    expect(classifyField(f('Anything', 'x', true, true, ['price']) as never, 'chain')).toEqual(['price']);
    expect(classifyField(f('first 24 bytes', 'a1b2…', false, true) as never, 'relay')).toContain('workload');
    expect(classifyField(f('Note', 'uregtest1abcdefghijklmnopqrstuvwxyz0123456789', true, false, []) as never, 'relay', { buyerAddress: 'uregtest1abcdefghijklmnopqrstuvwxyz0123456789' })).toEqual(['buyer_identity']);
  });

  it('computes knows / hidden / no / na and self-knowledge', () => {
    const provider = classifyObservation(obs('provider', 'memo-received', [f('GPU', '1× a100', true, true, ['workload']), f('Buyer identity', 'not present in any message', false, true, ['buyer_identity'])]));
    const m = computeMatrix({
      chain: { available: true, fields: [] },
      relay: { available: false, fields: [] },
      provider: { available: true, fields: provider },
      buyer: { available: true, fields: [] },
    });
    expect(m.workload.provider).toMatchObject({ state: 'knows', evidence: ['GPU'], knownLimit: 1 });
    expect(m.buyer_identity.provider).toMatchObject({ state: 'hidden', evidence: ['Buyer identity'] });
    expect(m.provider_identity.provider).toMatchObject({ state: 'knows', self: true });
    expect(m.workload.chain.state).toBe('no');
    expect(m.workload.relay.state).toBe('na');
    expect(m.buyer_identity.buyer).toMatchObject({ state: 'knows', self: true });
  });

  it('synthesizes a chain observation from a public view and builds a private verdict', () => {
    const view: PublicTxViewDto = {
      txid: 'ab'.repeat(32),
      height: 12,
      time: 1_000,
      version: 6,
      sizeBytes: 9000,
      feeZats: '10000',
      transparent: { inputs: 0, outputs: 0 },
      sapling: { spends: 0, outputs: 0, valueBalanceZats: '0' },
      orchard: { actions: 0, valueBalanceZats: '0', ciphertextSamples: [] },
      ironwood: { actions: 2, valueBalanceZats: '10000', ciphertextSamples: ['deadbeef'.repeat(6), 'cafebabe'.repeat(6)] },
      source: 'simulated',
    };
    const chain = chainObservation(view, 1_000_000);
    expect(chain.party).toBe('chain');
    expect(chain.fields.find((x) => x.label === 'Sender')).toMatchObject({ readable: false, sensitive: true, facts: ['buyer_identity'] });

    const rfq = {
      rfqId: 'cd'.repeat(16),
      state: 'closed',
      createdAt: 1_000_000,
      closedAt: 1_010_000,
      request: { gpu: 'a100', count: 1, durationS: 360, maxPricePerHourZats: '80000000' },
      rfqTxid: view.txid,
      providersAsked: 1,
      paddedOutputs: 4,
      expiresHeight: 20,
      bids: [],
      payments: [{ seq: 0, kind: 'accept', zats: '88889', feeZats: '10000', txid: view.txid, height: 12, at: 1_001_000 }],
      heartbeats: [],
      logTail: [],
      spentZats: '88889',
      feesZats: '35000',
      closeReason: 'done',
    } as unknown as RfqDto;
    const report = buildLeakReport({
      rfq,
      buyerAddress: 'uregtest1buyerbuyerbuyerbuyerbuyer',
      buyer: {
        available: true,
        source: 'buyer',
        observations: [
          obs('buyer', 'tx-broadcast', [f('GPU', '1× a100', true, true, ['workload']), f('Max price', '0.8 ZEC/h', true, true, ['price']), f('Providers asked', 'p1', true, true, ['provider_identity']), f('Paid now', '0.00088889 ZEC', true, true, ['amount'])], 1_000_500, { rfqId: rfq.rfqId }),
        ],
      },
      provider: {
        available: true,
        source: 'provider',
        observations: [obs('provider', 'memo-received', [f('GPU', '1× a100', true, true, ['workload']), f('Buyer identity', 'not present in any message', false, true, ['buyer_identity'])], 1_000_600, { rfqId: rfq.rfqId })],
      },
      relay: {
        available: true,
        source: 'relay',
        observations: [
          obs('relay', 'blob-stored', [f('size', '1234 bytes', true, false), f('first 24 bytes', 'a1b2c3', false, true), f('client ip', '127.0.0.1', true, true)], 1_000_700),
          obs('relay', 'blob-stored', [f('client ip', '127.0.0.1', true, true)], 5_000_000), // outside the window: ignored
        ],
      },
      chain: { available: true, source: 'chain', daemonObservations: [], views: [view] },
      now: 1_020_000,
    });
    expect(report.verdict).toBe('private');
    expect(report.unexpected).toEqual([]);
    expect(report.counts.chain.knows).toBe(0);
    expect(report.counts.relay).toMatchObject({ knows: 1, dealFactsKnown: 0 });
    expect(report.matrix.buyer_ip.relay).toMatchObject({ state: 'knows', knownLimit: 2 });
    expect(report.matrix.workload.relay).toMatchObject({ state: 'hidden' });
    expect(report.matrix.buyer_identity.provider.state).toBe('hidden');
    expect(report.matrix.buyer_identity.chain).toMatchObject({ state: 'hidden', ciphertext: false });
    expect(report.counts.buyer.knows).toBe(6);
    expect(report.parties.relay.observations).toBe(1);
    expect(report.chain).toMatchObject({ transactions: 1, shieldedActions: 2, transparentParts: 0, saplingParts: 0, feesZec: '0.0001' });
    expect(report.knownLimits.map((k) => `${k.party}:${k.fact}`).sort()).toEqual(['provider:workload', 'relay:buyer_ip']);
    expect(report.summary).toMatch(/No unexpected leaks/);

    // a readable, sensitive buyer address on the relay would be an unexpected leak
    const leaky = buildLeakReport({
      rfq,
      buyer: { available: true, source: 'b', observations: [] },
      provider: { available: false, source: 'p', reason: 'off', observations: [] },
      relay: { available: true, source: 'r', observations: [obs('relay', 'blob-stored', [f('sender wallet', 'uregtest1xyz', true, true)], 1_000_700)] },
      chain: { available: true, source: 'c', daemonObservations: [chain], views: [view] },
      now: 1_020_000,
    });
    expect(leaky.verdict).toBe('leak');
    expect(leaky.unexpected).toEqual([{ fact: 'buyer_identity', party: 'relay', evidence: ['sender wallet'] }]);
    expect(leaky.matrix.workload.provider.state).toBe('na');
  });

  it('trims a request DTO into ZEC decimals and ISO times', () => {
    const r = {
      rfqId: 'ef'.repeat(16),
      state: 'running',
      createdAt: 1_700_000_000_000,
      request: { gpu: 'a100', count: 1, durationS: 360, maxPricePerHourZats: '80000000' },
      providersAsked: 1,
      paddedOutputs: 4,
      expiresHeight: 20,
      bids: [{ providerId: '00'.repeat(32), alias: 'p1', pricePerIntervalZats: '66667', intervalS: 4, pricePerHourZats: '60000300', startWithinS: 15, receivedAt: 1_700_000_001_000, txid: 'aa', height: 3, signatureValid: true }],
      accepted: { providerId: '00'.repeat(32), alias: 'p1', pricePerIntervalZats: '66667', intervalS: 4, intervals: 90 },
      payments: [{ seq: 0, kind: 'accept', zats: '66667', feeZats: '10000', txid: 'bb', height: 4, at: 1_700_000_002_000 }],
      heartbeats: [{ seq: 3, at: 1_700_000_003_000, step: 7, status: 'running', servingSeq: 1, checkpointDigest: 'cc' }],
      logTail: ['a', 'b'],
      spentZats: '66667',
      feesZats: '35000',
    } as unknown as RfqDto;
    const t = trimRfq(r);
    expect(t).toMatchObject({ state: 'running', terminal: false, request: { hours: 0.1, maxZecPerHour: '0.8' }, accepted: { zecPerInterval: '0.00066667', maxZec: '0.0600003' }, payments: { count: 1, paidThroughSeq: 0, spentZec: '0.00066667', feesZec: '0.00035' } });
    expect(t.createdAt).toBe('2023-11-14T22:13:20.000Z');
    expect(t.bids[0]).toMatchObject({ alias: 'p1', zecPerHour: '0.600003', signatureValid: true });
    expect(t.heartbeats.latest).toMatchObject({ status: 'running', step: 7 });
  });
});

describe('daemon spend cap', () => {
  const status = (spendCap?: { perRfqZats: string; totalZats: string; spentZats: string }) =>
    ({ role: 'buyer', network: 'main', height: 1, address: 'u1x', balance: { spendable: '0', pending: '0' }, relayUrl: '', version: '0', demoMode: false, blockTimeS: 75, ...(spendCap ? { spendCap } : {}) }) as import('@silicr/api').StatusDto;

  it('is the session cap when the daemon has none', async () => {
    const { limitsFor } = await import('../src/tools.ts');
    expect(limitsFor(status(), 5_000_000n)).toMatchObject({ perRequestZats: 5_000_000n, limitedBy: 'session', daemon: null });
  });

  it('takes the stricter of the session cap, the daemon per-request cap and the daemon total left', async () => {
    const { limitsFor } = await import('../src/tools.ts');
    expect(limitsFor(status({ perRfqZats: '2000000', totalZats: '10000000', spentZats: '0' }), 5_000_000n)).toMatchObject({ perRequestZats: 2_000_000n, limitedBy: 'daemon_per_rfq' });
    expect(limitsFor(status({ perRfqZats: '20000000', totalZats: '10000000', spentZats: '9000000' }), 5_000_000n)).toMatchObject({ perRequestZats: 1_000_000n, limitedBy: 'daemon_total', daemon: { remainingZats: 1_000_000n } });
    expect(limitsFor(status({ perRfqZats: '20000000', totalZats: '10000000', spentZats: '12000000' }), 5_000_000n)).toMatchObject({ perRequestZats: 0n, limitedBy: 'daemon_total' });
    expect(limitsFor(status({ perRfqZats: '20000000', totalZats: '100000000', spentZats: '0' }), 5_000_000n)).toMatchObject({ perRequestZats: 5_000_000n, limitedBy: 'session' });
  });
});
