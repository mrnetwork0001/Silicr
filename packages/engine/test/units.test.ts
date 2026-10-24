import { describe, expect, it } from 'vitest';
import { decodeMemo, generateSigner, signDirectoryEntry } from '@silicr/protocol';
import { createMemoryNetwork, toOrchardOnly } from '@silicr/zec';
import { formatZec, parseZec, perHour, perInterval, withinHourly } from '../src/zats.ts';
import { dummyMemo, padBucket } from '../src/chain.ts';
import { decodeJobBlob, encodeJobBlob, sanitizeEnv } from '../src/jobblob.ts';
import { LeakRecorder, chainFields, publicTxViewDto } from '../src/leaks.ts';
import { DirectoryClient, matchProviders } from '../src/directory.ts';
import { realDeps } from '../src/deps.ts';
import { aliasFor } from '../src/alias.ts';
import { rankBids, type BuyerBid } from '../src/buyer.ts';
import { FakeRelay } from './helpers.ts';

describe('ZEC amounts', () => {
  it('parses decimals and suffixes into zats', () => {
    expect(parseZec('0.8')).toBe(80_000_000n);
    expect(parseZec('0.8zec/h')).toBe(80_000_000n);
    expect(parseZec('1.25 ZEC')).toBe(125_000_000n);
    expect(parseZec('.5')).toBe(50_000_000n);
    expect(parseZec('3')).toBe(300_000_000n);
    expect(parseZec('0.00000001')).toBe(1n);
    expect(parseZec('1500zats')).toBe(1500n);
  });
  it('rejects garbage, negatives and too many decimals', () => {
    for (const bad of ['', 'abc', '-1', '0.000000001', '1.2.3', '1e5']) expect(() => parseZec(bad)).toThrow();
  });
  it('formats zats as trimmed decimals', () => {
    expect(formatZec(80_000_000n)).toBe('0.8');
    expect(formatZec(125_000_000n)).toBe('1.25');
    expect(formatZec(1n)).toBe('0.00000001');
    expect(formatZec(0n)).toBe('0');
    expect(formatZec(300_000_000n)).toBe('3');
  });
  it('converts between hourly and per-interval prices without overcharging', () => {
    expect(perInterval(36_000_000n, 300)).toBe(3_000_000n);
    expect(perHour(3_000_000n, 300)).toBe(36_000_000n);
    expect(perInterval(1n, 1)).toBe(1n);
    expect(withinHourly(3_000_000n, 300, 36_000_000n)).toBe(true);
    expect(withinHourly(3_000_001n, 300, 36_000_000n)).toBe(false);
  });
});

describe('RFQ padding', () => {
  it('pads output counts to buckets of 4, 8, 16', () => {
    expect([1, 2, 3, 4].map(padBucket)).toEqual([4, 4, 4, 4]);
    expect([5, 8].map(padBucket)).toEqual([8, 8]);
    expect([9, 16].map(padBucket)).toEqual([16, 16]);
    expect(padBucket(17)).toBe(32);
  });
  it('dummy memos are 512 bytes and decode to null in both transports', () => {
    for (const t of ['binary', 'text'] as const) {
      const m = dummyMemo(t);
      expect(m.length).toBe(512);
      expect(decodeMemo(m)).toBeNull();
    }
    expect(dummyMemo('binary')[0]).toBe(0xff);
    expect(dummyMemo('text')[0]).toBeLessThan(0xf5);
  });
});

describe('job blobs', () => {
  it('round-trips manifest and bundle', () => {
    const bundle = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = encodeJobBlob({ v: 1, command: ['python3', 'train.py'], bundleSize: 5, bundleSha256: 'ab' }, bundle);
    const { manifest, bundle: b } = decodeJobBlob(blob);
    expect(manifest.command).toEqual(['python3', 'train.py']);
    expect([...b]).toEqual([1, 2, 3, 4, 5]);
  });
  it('rejects truncated or foreign blobs', () => {
    expect(() => decodeJobBlob(new Uint8Array(3))).toThrow();
    expect(() => decodeJobBlob(new TextEncoder().encode('XXXX\0\0\0\0'))).toThrow();
    const blob = encodeJobBlob({ v: 1, command: ['x'], bundleSize: 9, bundleSha256: '' }, new Uint8Array(3));
    expect(() => decodeJobBlob(blob)).toThrow(/size/);
  });
  it('drops reserved environment names', () => {
    expect(sanitizeEnv({ SILICR_STEP_DELAY_MS: '5', PATH: '/evil', LD_PRELOAD: 'x', SILICR_OUTPUT_DIR: '/', bad_name: 'x', N: 3 })).toEqual({
      SILICR_STEP_DELAY_MS: '5',
    });
  });
});

describe('leak recorder', () => {
  it('assigns ids and filters by rfq and cursor (either id form)', () => {
    const seen: string[] = [];
    const r = new LeakRecorder('buyer', (o) => seen.push(o.id));
    r.record({ party: 'buyer', event: 'a', summary: 'a', fields: [], rfqId: 'x' });
    r.record({ party: 'chain', event: 'b', summary: 'b', fields: [], rfqId: 'y' });
    r.record({ party: 'buyer', event: 'c', summary: 'c', fields: [], rfqId: 'x' });
    expect(seen).toEqual(['buyer-1', 'buyer-2', 'buyer-3']);
    expect(r.list({ rfqId: 'x' }).map((o) => o.event)).toEqual(['a', 'c']);
    expect(r.list({ after: 'buyer-1' }).map((o) => o.event)).toEqual(['b', 'c']);
    expect(r.list({ after: '2' }).map((o) => o.event)).toEqual(['c']);
  });
});

describe('directory client', () => {
  it('keeps verified Orchard-only entries and drops forged or transparent ones', async () => {
    const net = createMemoryNetwork({ blockTimeMs: 0 });
    const relay = new FakeRelay();
    const good = generateSigner();
    const addr = await net.wallet('good').address();
    const base = { v: 1 as const, alias: 'x', gpus: [{ model: 'a100', count: 4, vramGb: 80 }], minPricePerHourZats: '60000000', updatedAt: 1 };
    await relay.publishDirectory(signDirectoryEntry({ ...base, providerId: Buffer.from(good.signer.publicKey).toString('hex'), address: addr }, good.signer));
    // forged: signed by a different key than providerId claims
    const evil = generateSigner();
    const victim = generateSigner();
    const forged = signDirectoryEntry({ ...base, providerId: Buffer.from(evil.signer.publicKey).toString('hex'), address: addr }, evil.signer);
    await relay.publishDirectory({ ...forged, providerId: Buffer.from(victim.signer.publicKey).toString('hex') });
    // transparent address, properly signed
    const t = generateSigner();
    await relay.publishDirectory(
      signDirectoryEntry({ ...base, providerId: Buffer.from(t.signer.publicKey).toString('hex'), address: 'tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd' }, t.signer),
    );
    await relay.publishDirectory({ junk: true, providerId: 'nope' });

    const dir = new DirectoryClient(relay, 'memory', realDeps);
    const listing = await dir.list();
    expect(listing.verified.map((v) => v.providerId)).toEqual([Buffer.from(good.signer.publicKey).toString('hex')]);
    expect(listing.verified[0]!.address).toBe(toOrchardOnly(addr, 'memory'));
    expect(listing.all.filter((p) => !p.verified)).toHaveLength(2);
    expect(listing.rejected).toHaveLength(3);
    expect(matchProviders(listing.verified, { gpu: 'a100', count: 4, maxPricePerHourZats: 60_000_000n })).toHaveLength(1);
    expect(matchProviders(listing.verified, { gpu: 'a100', count: 5, maxPricePerHourZats: 60_000_000n })).toHaveLength(0);
    expect(matchProviders(listing.verified, { gpu: 'a100', count: 1, maxPricePerHourZats: 59_999_999n })).toHaveLength(0);
    expect(matchProviders(listing.verified, { gpu: 'h100', count: 1, maxPricePerHourZats: 1n << 40n })).toHaveLength(0);
    net.stop();
  });
});

describe('bid ranking and aliases', () => {
  it('ranks by hourly price, then bond, then arrival', () => {
    const mk = (id: string, price: bigint, intervalS: number, at: number, bond?: bigint): BuyerBid => {
      const b: BuyerBid = { key: id, providerId: id, alias: id, pricePerIntervalZats: price, intervalS, startWithinS: 0, providerEph: '', payTo: '', receivedAt: at, txid: id, height: 1 };
      if (bond !== undefined) b.bondZats = bond;
      return b;
    };
    const ranked = rankBids([mk('a', 100n, 60, 1), mk('b', 40n, 30, 2), mk('c', 80n, 60, 3, 5n), mk('d', 80n, 60, 0)]);
    expect(ranked.map((b) => b.key)).toEqual(['c', 'd', 'b', 'a']);
  });
  it('aliases are stable pseudonyms', () => {
    const k = new Uint8Array(32).fill(7);
    expect(aliasFor(k)).toBe(aliasFor(k));
    expect(aliasFor(k)).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
  });
});

describe('chain views', () => {
  const base = {
    txid: 'ab'.repeat(32),
    height: 100,
    time: 1,
    version: 6,
    sizeBytes: 9000,
    feeZats: 15_000n as bigint | null,
    transparent: { inputs: 0, outputs: 0 },
    sapling: { spends: 0, outputs: 0, valueBalanceZats: 0n },
    orchard: { actions: 0, valueBalanceZats: 0n, ciphertextSamples: [] as string[] },
    ironwood: { actions: 5, valueBalanceZats: 15_000n, ciphertextSamples: ['cd'.repeat(32)] },
  };

  it('reports Ironwood actions separately from legacy Orchard and passes source fields through', () => {
    const f = chainFields({ ...base, source: 'broadcast' });
    expect(f.find((x) => x.label === 'Shielded (Ironwood) actions')?.value).toBe('5');
    expect(f.find((x) => x.label === 'Legacy Orchard actions')?.value).toBe('0');
    expect(f.find((x) => x.label === 'Fee')?.value).toBe('15000 zats');
    expect(f.find((x) => x.label === 'View built from')?.value).toMatch(/broadcast/);
    const dto = publicTxViewDto({ ...base, source: 'compact-block', complete: false, estimated: ['feeZats', 'valueBalances'] });
    expect(dto).toMatchObject({ source: 'compact-block', complete: false, estimated: ['feeZats', 'valueBalances'], ironwood: { actions: 5, valueBalanceZats: '15000' } });
  });

  it('renders estimated fields as unknown, never as zero', () => {
    const f = chainFields({
      ...base,
      feeZats: null,
      ironwood: { actions: 5, valueBalanceZats: 0n, ciphertextSamples: [] },
      source: 'compact-block',
      complete: false,
      estimated: ['feeZats', 'valueBalances', 'sizeBytes', 'transparent'],
    });
    expect(f.find((x) => x.label === 'Fee')?.value).toBe('unknown');
    expect(f.find((x) => x.label === 'Ironwood value balance')?.value).toBe('unknown');
    expect(f.find((x) => x.label === 'Size')?.value).toBe('≈ 9000 bytes');
    expect(f.find((x) => x.label === 'Transparent inputs / outputs')?.value).toBe('unknown');
    expect(f.find((x) => x.label === 'Completeness')?.value).toMatch(/partial/);
    expect(f.some((x) => x.value === '0 zats')).toBe(false);
  });
});
