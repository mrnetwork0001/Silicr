import { describe, expect, it } from 'vitest';
import { destinationError, zip321With } from '../lib/wallet';

const UA_MAIN = 'u1' + 'q'.repeat(100);

describe('wallet helpers', () => {
  it('checks destinations client-side for the daemon network', () => {
    expect(destinationError('', 'main')).toBeNull();
    expect(destinationError(UA_MAIN, 'main')).toBeNull();
    expect(destinationError('t1abcdefghijklmnopqrstuvwxyz12345', 'main')).toMatch(/Transparent/);
    expect(destinationError('zs1' + 'a'.repeat(70), 'main')).toMatch(/Sapling/);
    expect(destinationError('uview1' + 'a'.repeat(70), 'main')).toMatch(/viewing key/);
    expect(destinationError('utest1' + 'q'.repeat(100), 'main')).toMatch(/starting with u1/);
    expect(destinationError(UA_MAIN, 'test')).toMatch(/utest1/);
    expect(destinationError('u1abc', 'main')).toMatch(/complete/);
  });

  it('builds ZIP 321 URIs with an optional amount', () => {
    expect(zip321With(`zcash:${UA_MAIN}`, null)).toBe(`zcash:${UA_MAIN}`);
    expect(zip321With(`zcash:${UA_MAIN}?amount=1`, 5_000_000n)).toBe(`zcash:${UA_MAIN}?amount=0.05`);
    expect(zip321With(`zcash:${UA_MAIN}`, 123_456_789_000n)).toBe(`zcash:${UA_MAIN}?amount=1234.56789`);
  });
});
