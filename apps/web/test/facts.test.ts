import type { LeakField, Party } from '@silicr/api';
import { describe, expect, it } from 'vitest';
import { classifyField, computeMatrix, type ClassifiedField } from '../lib/facts';
import { chainObservation, extractTokens, tokensMatch, viewProvenance } from '../lib/inspector';
import { mergeLogTail } from '../lib/store';

const f = (label: string, value: string, readable: boolean, sensitive: boolean): LeakField => ({ label, value, readable, sensitive });

describe('classifyField (labels as the real daemons send them)', () => {
  it('maps buyer-side fields', () => {
    expect(classifyField(f('Max price', '0.8 ZEC/h', true, true), 'buyer')).toContain('price');
    expect(classifyField(f('Job command', 'python3 train.py', true, true), 'buyer')).toContain('workload');
    expect(classifyField(f('Providers asked', 'solar-walrus-56', true, true), 'buyer')).toContain('provider_identity');
    expect(classifyField(f('Paid now', '0.00066667 ZEC', true, true), 'buyer')).toContain('amount');
    expect(classifyField(f('Reply address (one-time)', 'uregtest1…', true, true), 'buyer')).toContain('buyer_identity');
  });

  it('keeps the provider from "knowing" the buyer through unlinkable keys', () => {
    const facts = classifyField(f('Buyer key (this RFQ only)', '68e7…', true, false), 'provider');
    expect(facts).toContain('buyer_identity'); // classified, but readable && !sensitive does not count as knowing
    expect(classifyField(f('Your IP (seen by relay)', '198.51.100.23', true, true), 'provider')).toEqual([]);
  });

  it('treats any client IP the relay sees as possibly the buyer (conservative)', () => {
    expect(classifyField(f('client ip', '127.0.0.1', true, true), 'relay')).toEqual(['buyer_ip']);
    expect(classifyField(f('first 24 bytes', '02b5fe34…', false, true), 'relay')).toContain('workload');
  });

  it('honours explicit fact tags, including an explicit empty list', () => {
    expect(classifyField({ ...f('Client IP', '198.51.100.23', true, true), facts: [] } as LeakField, 'relay')).toEqual([]);
    expect(classifyField({ ...f('Anything', 'x', true, true), facts: ['price'] } as LeakField, 'chain')).toEqual(['price']);
  });

  it("flags the buyer's real wallet address wherever it appears", () => {
    const addr = 'uregtest1xzff9cjzpzvmv5tvttflrz8ptwj4qqrle7720kc3nrl67thrnte5zew82echuqhwdju0was455ukew3zzt2yu7xxrfzr02yp7ywlqdaw';
    expect(classifyField(f('note', `sent by ${addr}`, true, true), 'relay', { buyerAddress: addr })).toContain('buyer_identity');
  });
});

describe('computeMatrix', () => {
  const cf = (key: string, field: LeakField, facts: ClassifiedField['facts']): ClassifiedField => ({ key, field, facts });
  const cols = (fields: Partial<Record<Party, ClassifiedField[]>>, unavailable: Party[] = []) =>
    computeMatrix({
      chain: { available: !unavailable.includes('chain'), fields: fields.chain ?? [] },
      relay: { available: !unavailable.includes('relay'), fields: fields.relay ?? [] },
      provider: { available: !unavailable.includes('provider'), fields: fields.provider ?? [] },
      buyer: { available: !unavailable.includes('buyer'), fields: fields.buyer ?? [] },
    });

  it('knows = readable && sensitive; hidden = only unreadable copies; otherwise no', () => {
    const m = cols({
      provider: [cf('p#0', f('Price', '0.6 ZEC/h', true, true), ['price'])],
      chain: [cf('c#0', f('Amounts', 'hidden: encrypted inside each note', false, true), ['amount'])],
      relay: [cf('r#0', f('size', '5704 bytes', true, false), ['workload'])],
    });
    expect(m.price.provider.state).toBe('knows');
    expect(m.amount.chain.state).toBe('hidden');
    expect(m.amount.chain.ciphertext).toBe(true);
    expect(m.workload.relay.state).toBe('no');
  });

  it('marks unavailable columns as no data, never as "doesn\'t know"', () => {
    const m = cols({}, ['relay']);
    expect(m.buyer_ip.relay.state).toBe('na');
  });

  it("knows facts about itself by definition (and says so)", () => {
    const m = cols({});
    expect(m.buyer_identity.buyer).toMatchObject({ state: 'knows', self: true });
    expect(m.provider_identity.provider).toMatchObject({ state: 'knows', self: true });
    expect(m.buyer_identity.provider.state).toBe('no');
  });
});

describe('chain views', () => {
  const view = {
    txid: 'aa'.repeat(32),
    height: 12,
    time: 1_790_000_000,
    version: 6,
    sizeBytes: 9165,
    feeZats: null,
    transparent: { inputs: 0, outputs: 0 },
    sapling: { spends: 0, outputs: 0, valueBalanceZats: '0' },
    orchard: { actions: 0, valueBalanceZats: '0', ciphertextSamples: [] },
    ironwood: { actions: 2, valueBalanceZats: '0', ciphertextSamples: ['ab'.repeat(32), 'cd'.repeat(32)] },
    source: 'compact-block' as const,
    complete: false,
    estimated: ['feeZats', 'valueBalances', 'sizeBytes'],
  };

  it('labels provenance honestly', () => {
    expect(viewProvenance(view)?.label).toBe('compact block (partial)');
    expect(viewProvenance({ ...view, source: 'broadcast', complete: true })?.label).toBe('exact (own broadcast)');
  });

  it('renders estimated fields as unknown or ≈, never as zero', () => {
    const o = chainObservation(view, 1);
    const val = (label: string) => o.fields.find((x) => x.label === label)?.value;
    expect(val('Ironwood (shielded)')).toBe('2 actions');
    expect(val('Fee')).toBe('unknown');
    expect(val('Value leaving the pool')).toBe('unknown');
    expect(val('Size')).toMatch(/^≈ /);
    expect(val('Legacy Orchard actions')).toBe('0');
    expect(val('Transparent in / out')).toBe('0 / 0');
  });
});

describe('cross-highlight tokens', () => {
  it('matches full and daemon-truncated hex', () => {
    const full = '6fcd84411c942aaa26a6c2e4ae8bfbe2c821f9405349b0aae6b613cf35f5c087';
    const [t] = extractTokens(`digest ${full}`);
    expect(t).toBe(full);
    expect(tokensMatch('6fcd8441…f5c087', full)).toBe(true);
    expect(extractTokens('Total paid 0.00466669 ZEC to solar-walrus-56')).toEqual(expect.arrayContaining(['solar-walrus-56', '0.00466669 zec']));
  });
});

describe('mergeLogTail', () => {
  it('appends only the new part of an overlapping snapshot', () => {
    expect(mergeLogTail(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
    expect(mergeLogTail(['a', 'b', 'c'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(mergeLogTail(undefined, ['x'])).toEqual(['x']);
    expect(mergeLogTail(['a'], ['z'])).toEqual(['a', 'z']);
  });
});
