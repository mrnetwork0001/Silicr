import { describe, expect, it } from 'vitest';
import {
  type DirectoryEntry,
  canonicalDirectoryBytes,
  generateSigner,
  signDirectoryEntry,
  toHex,
  verifyDirectoryEntry,
} from '../src/index.ts';
import { fakeUa } from './helpers.ts';

type Unsigned = Omit<DirectoryEntry, 'sig'>;
const { signer } = generateSigner();
const other = generateSigner().signer;
const address = fakeUa(110, 'utest');
const base: Unsigned = {
  v: 1,
  providerId: toHex(signer.publicKey),
  alias: 'amber-otter-17',
  address,
  gpus: [
    { model: 'a100', count: 4, vramGb: 80 },
    { model: 'cpu', count: 1, vramGb: 0 },
  ],
  minPricePerHourZats: '60000000',
  updatedAt: 1_790_000_000,
};
const signed = signDirectoryEntry(base, signer);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** The same entry with every object's keys in reverse order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
  }
  return value;
}

describe('directory entries', () => {
  it('sign and verify', () => {
    expect(signed).toMatchObject(base);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyDirectoryEntry(signed)).toBe(true);
  });

  it('survive a JSON round trip', () => {
    expect(verifyDirectoryEntry(JSON.parse(JSON.stringify(signed)))).toBe(true);
  });

  it('use the documented canonical bytes', () => {
    expect(text(canonicalDirectoryBytes(base))).toBe(
      'silicr/v1/directory\n' +
        `{"address":"${address}","alias":"amber-otter-17",` +
        '"gpus":[{"count":4,"model":"a100","vramGb":80},{"count":1,"model":"cpu","vramGb":0}],' +
        `"minPricePerHourZats":"60000000","providerId":"${base.providerId}","updatedAt":1790000000,"v":1}`,
    );
  });

  it('do not depend on key order', () => {
    const shuffled = reversed(signed) as DirectoryEntry;
    expect(Object.keys(shuffled)[0]).toBe('sig');
    expect(Object.keys(shuffled.gpus[0]!)[0]).toBe('vramGb');
    expect(canonicalDirectoryBytes(shuffled)).toEqual(canonicalDirectoryBytes(base));
    expect(verifyDirectoryEntry(shuffled)).toBe(true);
    expect(signDirectoryEntry(reversed(base) as Unsigned, signer).sig).toBe(signed.sig);
  });

  it('cover the optional fields', () => {
    const full = signDirectoryEntry({ ...base, bondZats: '500000000', region: 'eu' }, signer);
    expect(verifyDirectoryEntry(full)).toBe(true);
    const { bondZats: _b, ...withoutBond } = full;
    expect(verifyDirectoryEntry(withoutBond)).toBe(false);
    expect(verifyDirectoryEntry({ ...full, region: 'na' })).toBe(false);
  });

  it('omit undefined fields', () => {
    const withUndefined = signDirectoryEntry({ ...base, region: undefined, bondZats: undefined }, signer);
    expect(withUndefined.sig).toBe(signed.sig);
    expect(verifyDirectoryEntry(withUndefined)).toBe(true);
    expect(verifyDirectoryEntry({ ...signed, region: undefined })).toBe(true);
  });

  it('ignore an existing sig when canonicalizing and re-signing', () => {
    expect(canonicalDirectoryBytes(signed)).toEqual(canonicalDirectoryBytes(base));
    const updated = signDirectoryEntry({ ...signed, updatedAt: base.updatedAt + 60 }, signer);
    expect(updated.sig).not.toBe(signed.sig);
    expect(verifyDirectoryEntry(updated)).toBe(true);
  });

  it.each<[string, Partial<DirectoryEntry>]>([
    ['alias', { alias: 'amber-otter-18' }],
    ['address', { address: fakeUa(106, 'u') }],
    ['gpu count', { gpus: [{ model: 'a100', count: 8, vramGb: 80 }, base.gpus[1]!] }],
    ['gpu list', { gpus: [base.gpus[0]!] }],
    ['price', { minPricePerHourZats: '1' }],
    ['updatedAt', { updatedAt: base.updatedAt + 1 }],
    ['providerId', { providerId: toHex(other.publicKey) }],
    ['signature', { sig: signDirectoryEntry(base, other).sig }],
    ['one signature character', { sig: `${signed.sig.slice(0, -1)}${signed.sig.endsWith('0') ? '1' : '0'}` }],
  ])('detect a changed %s', (_label, change) => {
    expect(verifyDirectoryEntry({ ...signed, ...change })).toBe(false);
  });

  it('reject an entry signed by a key other than its providerId', () => {
    expect(verifyDirectoryEntry(signDirectoryEntry({ ...base, providerId: toHex(other.publicKey) }, signer))).toBe(false);
  });

  // Each malformed entry is re-signed correctly, so only the shape check can reject it.
  const malformed: [string, (e: Record<string, unknown>) => void][] = [
    ['version 2', (e) => (e.v = 2)],
    ['a missing alias', (e) => delete e.alias],
    ['an unknown field', (e) => (e.buyer = 'nobody')],
    ['an uppercase providerId', (e) => (e.providerId = (e.providerId as string).toUpperCase())],
    ['a short providerId', (e) => (e.providerId = (e.providerId as string).slice(2))],
    ['an empty alias', (e) => (e.alias = '')],
    ['a 65-char alias', (e) => (e.alias = 'a'.repeat(65))],
    ['an alias with an escape code', (e) => (e.alias = 'otter\u001b[2J')],
    ['an alias with a bidi override', (e) => (e.alias = 'otter‮71')],
    ['a transparent address', (e) => (e.address = 'tmHqEMjvxe3ZRGYTWUZjHb6AoeUstpE7vEy')],
    ['no gpus', (e) => (e.gpus = [])],
    ['gpus as an object', (e) => (e.gpus = { model: 'a100', count: 1, vramGb: 80 })],
    ['a gpu without vramGb', (e) => (e.gpus = [{ model: 'a100', count: 1 }])],
    ['a gpu with an extra key', (e) => (e.gpus = [{ model: 'a100', count: 1, vramGb: 80, serial: 'X1' }])],
    ['an uppercase gpu model', (e) => (e.gpus = [{ model: 'A100', count: 1, vramGb: 80 }])],
    ['zero gpus of a model', (e) => (e.gpus = [{ model: 'a100', count: 0, vramGb: 80 }])],
    ['negative vram', (e) => (e.gpus = [{ model: 'a100', count: 1, vramGb: -1 }])],
    ['a price with a leading zero', (e) => (e.minPricePerHourZats = '060000000')],
    ['a negative price', (e) => (e.minPricePerHourZats = '-1')],
    ['a fractional price', (e) => (e.minPricePerHourZats = '1.5')],
    ['a price past u64', (e) => (e.minPricePerHourZats = (2n ** 64n).toString())],
    ['a numeric price', (e) => (e.minPricePerHourZats = 60000000)],
    ['an empty bond', (e) => (e.bondZats = '')],
    ['an empty region', (e) => (e.region = '')],
    ['a negative updatedAt', (e) => (e.updatedAt = -1)],
    ['a fractional updatedAt', (e) => (e.updatedAt = 1.5)],
    ['a string updatedAt', (e) => (e.updatedAt = '1790000000')],
  ];

  it.each(malformed)('reject %s', (_label, edit) => {
    const e = structuredClone(base) as unknown as Record<string, unknown>;
    edit(e);
    expect(verifyDirectoryEntry(signDirectoryEntry(e as unknown as Unsigned, signer))).toBe(false);
  });

  it('return false, never throw, on hostile input', () => {
    const throwing = new Proxy(signed, {
      get() {
        throw new Error('boom');
      },
    });
    const getter = Object.defineProperty({ ...signed }, 'alias', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const sigNotHex = { ...signed, sig: 'zz'.repeat(64) };
    for (const junk of [null, undefined, 42, 'entry', [], {}, [signed], throwing, getter, sigNotHex]) {
      expect(verifyDirectoryEntry(junk as DirectoryEntry)).toBe(false);
    }
  });

  it('sign never throws, even on input outside the type', () => {
    const cyclic: Record<string, unknown> = { ...base };
    cyclic.self = cyclic;
    for (const odd of [cyclic, { ...base, minPricePerHourZats: 60000000n }, { ...base, updatedAt: Number.NaN }, null]) {
      expect(() => signDirectoryEntry(odd as unknown as Unsigned, signer)).not.toThrow();
    }
  });
});
