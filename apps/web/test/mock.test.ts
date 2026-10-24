import { describe, expect, it } from 'vitest';
import { looksLikeAddress } from '../lib/format';
import { extractTokens } from '../lib/inspector';
import { Rng } from '../lib/mock/rng';

describe('mock identifiers', () => {
  it('makes mainnet-shaped Orchard-only unified addresses (u1 + 104 chars)', () => {
    const rng = new Rng(7);
    const ua = rng.ua();
    expect(ua).toMatch(/^u1[02-9ac-hj-np-z]{104}$/);
    expect(ua).toHaveLength(106);
    expect(looksLikeAddress(ua)).toBe(true);
    expect(extractTokens(`Paid from ${ua}`)).toContain(ua);
    expect(rng.ua()).not.toBe(ua);
  });

  it('is deterministic for a seed', () => {
    expect(new Rng(42).txid()).toBe(new Rng(42).txid());
  });
});
