import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  decodeUnifiedAddress,
  encodeUnifiedAddress,
  isOrchardOnly,
  PrivacyError,
  randomOrchardAddress,
  toOrchardOnly,
  type Network,
  type Receiver,
} from '../src/index.ts';
import { isValidOrchardReceiver, PALLAS_P, randomOrchardReceiver } from '../src/pallas.ts';

type UaVector = [string | null, string | null, string | null, string | null, number | null, string | null, string];
const UA_VECTORS = (
  JSON.parse(readFileSync(new URL('./vectors/unified_address.json', import.meta.url), 'utf8')) as UaVector[]
).slice(2);
const vector = (has: { p2pkh?: boolean; sapling?: boolean; orchard?: boolean; unknown?: boolean }) =>
  UA_VECTORS.find(
    (v) =>
      (v[0] !== null) === !!has.p2pkh &&
      (v[2] !== null) === !!has.sapling &&
      (v[3] !== null) === !!has.orchard &&
      (v[4] !== null) === !!has.unknown,
  )!;

const b58 = createBase58check(sha256);
const base58 = (prefix: number[], length: number) => b58.encode(Uint8Array.from([...prefix, ...new Array<number>(length).fill(7)]));
const hash20 = new Uint8Array(20).fill(0x42);
const saplingRaw = hexToBytes(vector({ sapling: true })[2]!);

const FIXTURES = {
  t1: base58([0x1c, 0xb8], 20),
  t3: base58([0x1c, 0xbd], 20),
  tm: base58([0x1d, 0x25], 20),
  t2: base58([0x1c, 0xba], 20),
  zc: base58([0x16, 0x9a], 64),
  zt: base58([0x16, 0xb6], 64),
  tex: bech32m.encode('tex', bech32m.toWords(hash20)),
  textest: bech32m.encode('textest', bech32m.toWords(hash20)),
  texregtest: bech32m.encode('texregtest', bech32m.toWords(hash20)),
  zs: bech32.encode('zs', bech32.toWords(saplingRaw), false),
  ztestsapling: bech32.encode('ztestsapling', bech32.toWords(saplingRaw), false),
  zregtestsapling: bech32.encode('zregtestsapling', bech32.toWords(saplingRaw), false),
};

const orchard = (data: Uint8Array): Receiver => ({ typecode: 3, kind: 'orchard', data });
const sapling: Receiver = { typecode: 2, kind: 'sapling', data: saplingRaw };
const p2pkh: Receiver = { typecode: 0, kind: 'p2pkh', data: hash20 };

function refusal(address: unknown, network: Network): PrivacyError {
  try {
    toOrchardOnly(address as string, network);
  } catch (err) {
    expect(err).toBeInstanceOf(PrivacyError);
    return err as PrivacyError;
  }
  throw new Error('expected toOrchardOnly to refuse');
}

describe('toOrchardOnly refuses', () => {
  it('fixtures have the well-known prefixes', () => {
    for (const [prefix, address] of Object.entries(FIXTURES)) expect(address.startsWith(prefix)).toBe(true);
  });

  it.each([
    ['t1', 'main'],
    ['t3', 'main'],
    ['tm', 'test'],
    ['t2', 'test'],
    ['tm', 'memory'],
  ] as const)('transparent %s… addresses (on %s)', (prefix, network) => {
    const err = refusal(FIXTURES[prefix], network);
    expect(err.message).toMatch(/^Refusing transparent address/);
    expect(err.message).toContain('transparent payments publish sender, recipient and amount');
  });

  it.each(['tex', 'textest', 'texregtest'] as const)('TEX %s1… addresses', (prefix) => {
    expect(refusal(FIXTURES[prefix], 'test').message).toMatch(/^Refusing TEX address \(.*\): .*ZIP 320.*transparent/);
  });

  it.each(['zs', 'ztestsapling', 'zregtestsapling'] as const)('Sapling %s1… addresses', (prefix) => {
    expect(refusal(FIXTURES[prefix], 'memory').message).toMatch(/^Refusing Sapling address .*Ironwood pool.*crosses pools.*amount/);
  });

  it.each(['zc', 'zt'] as const)('Sprout %s… addresses', (prefix) => {
    expect(refusal(FIXTURES[prefix], 'test').message).toMatch(/^Refusing Sprout address .*ZIP 211/);
  });

  it('unified addresses without an Orchard receiver, naming what they hold', () => {
    const tz = refusal(vector({ p2pkh: true, sapling: true })[6], 'main').message;
    expect(tz).toMatch(/^Refusing unified address without an Orchard receiver \(it has only: transparent P2PKH, Sapling\)/);
    expect(tz).toMatch(/crosses pools/);
    expect(tz).toMatch(/transparent payments publish/);
    const z = refusal(vector({ sapling: true })[6], 'main').message;
    expect(z).toMatch(/it has only: Sapling\)/);
    expect(z).not.toMatch(/transparent/);
    expect(refusal(vector({ sapling: true, unknown: true })[6], 'main').message).toMatch(/Sapling, unrecognised/);
    expect(refusal(encodeUnifiedAddress('regtest', [p2pkh, sapling]), 'memory').message).toMatch(/without an Orchard receiver/);
  });

  it('addresses for another network', () => {
    const mainnet = vector({ p2pkh: true, sapling: true, orchard: true })[6];
    expect(refusal(mainnet, 'test').message).toBe(
      'Refusing mainnet address: this wallet is on testnet, so a payment to it could never arrive.',
    );
    expect(refusal(mainnet, 'memory').message).toMatch(/^Refusing mainnet address: this wallet is on the in-memory simulated chain/);
    const testnet = randomOrchardAddress('test');
    expect(refusal(testnet, 'memory').message).toMatch(/^Refusing testnet address/);
    expect(refusal(testnet, 'regtest').message).toMatch(/^Refusing testnet address: this wallet is on regtest/);
    expect(refusal(randomOrchardAddress('memory'), 'test').message).toMatch(/^Refusing regtest address/);
  });

  it('an Orchard receiver that is not a valid Pallas point', () => {
    const identity = new Uint8Array(43); // pk_d = 0: the identity
    const offCurve = new Uint8Array(43);
    for (let x = 1; ; x++) {
      offCurve[11] = x;
      if (!isValidOrchardReceiver(offCurve)) break;
    }
    const nonCanonical = new Uint8Array(43); // x = p, not reduced
    let p = PALLAS_P;
    for (let i = 11; i < 43; i++, p >>= 8n) nonCanonical[i] = Number(p & 0xffn);
    for (const data of [identity, offCurve, nonCanonical]) {
      const ua = encodeUnifiedAddress('regtest', [orchard(data)]);
      expect(refusal(ua, 'memory').message).toMatch(/Orchard receiver is invalid \(pk_d is not a point on the Pallas curve\)/);
      expect(isOrchardOnly(ua)).toBe(false);
    }
  });

  it('ZIP 316 Revision 2 addresses, viewing keys and spending keys', () => {
    const words = bech32m.toWords(new Uint8Array(70).fill(1));
    expect(refusal(bech32m.encode('zutest', words, false), 'test').message).toMatch(/Revision 2/);
    expect(refusal(bech32m.encode('tutest', words, false), 'test').message).toMatch(/transparent/);
    for (const hrp of ['uview', 'uviewtest', 'uivkregtest', 'uvftest']) {
      expect(refusal(bech32m.encode(hrp, words, false), 'test').message).toMatch(/^Refusing viewing key/);
    }
    expect(refusal(bech32.encode('zxviewtestsapling', bech32.toWords(new Uint8Array(169)), false), 'test').message).toMatch(
      /viewing key/,
    );
    expect(refusal(bech32.encode('secret-extended-key-test', bech32.toWords(new Uint8Array(169)), false), 'test').message).toMatch(
      /^Refusing spending key/,
    );
    expect(refusal(b58.encode(Uint8Array.from([0xef, ...new Array<number>(32).fill(3), 1])), 'test').message).toMatch(
      /spending key/,
    );
  });

  it('garbage, with a hint where one helps', () => {
    const ua = randomOrchardAddress('test');
    const cases: Array<[unknown, RegExp]> = [
      ['', /it is empty/],
      ['   ', /it is empty/],
      ['hello', /not a recognised Zcash address/],
      ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', /unknown Bech32 prefix/],
      [bech32m.encode('constructor', bech32m.toWords(hash20)), /unknown Bech32m prefix/],
      [bech32.encode('__proto__', bech32.toWords(hash20)), /unknown Bech32 prefix/],
      ['0x52908400098527886E0F7030069857D2E4169EE7', /not a recognised Zcash address/],
      [ua.slice(0, -1), /looks like a unified address, but its checksum is wrong/],
      [ua.slice(0, 30) + (ua[30] === 'x' ? 'y' : 'x') + ua.slice(31), /checksum is wrong/],
      [`zcash:${ua}?amount=1`, /payment URI/],
      [FIXTURES.t1.slice(0, -1) + (FIXTURES.t1.endsWith('z') ? 'y' : 'z'), /transparent-looking/],
      [null, /expected the address as a string/],
      [42, /expected the address as a string/],
      [undefined, /expected the address as a string/],
    ];
    for (const [input, pattern] of cases) expect(refusal(input, 'test').message).toMatch(pattern);
  });

  it('never echoes the refused input', () => {
    const inputs = [...Object.values(FIXTURES), vector({ p2pkh: true, sapling: true })[6], 'not-an-address-but-long-enough'];
    for (const input of inputs) expect(refusal(input, 'test').message).not.toContain(input);
  });

  it('rejects an unknown expected network as a programming error', () => {
    expect(() => toOrchardOnly(randomOrchardAddress('test'), 'testnet' as Network)).toThrow(TypeError);
  });
});

describe('toOrchardOnly accepts', () => {
  it('strips every other receiver from valid unified addresses', () => {
    for (const v of UA_VECTORS.filter((row) => row[3] !== null)) {
      const result = toOrchardOnly(v[6], 'main');
      expect(result.startsWith('u1')).toBe(true);
      const decoded = decodeUnifiedAddress(result);
      expect(decoded.network).toBe('main');
      expect(decoded.receivers).toEqual([{ typecode: 3, kind: 'orchard', data: hexToBytes(v[3]!) }]);
      expect(isOrchardOnly(result)).toBe(true);
      expect(toOrchardOnly(result, 'main')).toBe(result); // idempotent
    }
  });

  it("uses regtest encoding for 'memory', and accepts every network's own addresses", () => {
    const receiver = randomOrchardReceiver();
    const full = (network: 'main' | 'test' | 'regtest') =>
      encodeUnifiedAddress(network, [p2pkh, sapling, orchard(receiver), { typecode: 0xfffa, kind: 'unknown', data: new Uint8Array(5) }]);
    const only = (network: 'main' | 'test' | 'regtest') => encodeUnifiedAddress(network, [orchard(receiver)]);
    expect(toOrchardOnly(full('regtest'), 'memory')).toBe(only('regtest'));
    expect(toOrchardOnly(full('regtest'), 'regtest')).toBe(only('regtest'));
    expect(toOrchardOnly(full('test'), 'test')).toBe(only('test'));
    expect(toOrchardOnly(full('main'), 'main')).toBe(only('main'));
    expect(only('regtest').startsWith('uregtest1')).toBe(true);
  });

  it('normalises case and surrounding whitespace', () => {
    const ua = randomOrchardAddress('memory');
    expect(toOrchardOnly(` ${ua.toUpperCase()}\n`, 'memory')).toBe(ua);
  });
});

describe('isOrchardOnly', () => {
  it('is true only for a unified address whose single item is a valid Orchard receiver', () => {
    expect(isOrchardOnly(randomOrchardAddress('main'))).toBe(true);
    expect(isOrchardOnly(randomOrchardAddress('test'))).toBe(true);
    expect(isOrchardOnly(randomOrchardAddress('memory'))).toBe(true);
    expect(isOrchardOnly(vector({ orchard: true })[6])).toBe(true);
    expect(isOrchardOnly(vector({ orchard: true, unknown: true })[6])).toBe(false);
    expect(isOrchardOnly(vector({ sapling: true, orchard: true })[6])).toBe(false);
    expect(isOrchardOnly(vector({ p2pkh: true, orchard: true })[6])).toBe(false);
    for (const fixture of Object.values(FIXTURES)) expect(isOrchardOnly(fixture)).toBe(false);
    for (const junk of ['', 'u1', 'garbage', null, 7]) expect(isOrchardOnly(junk as string)).toBe(false);
  });
});

describe('randomOrchardAddress', () => {
  it('makes valid, distinct Orchard-only addresses for each network', () => {
    const prefixes: Record<Network, string> = { main: 'u1', test: 'utest1', regtest: 'uregtest1', memory: 'uregtest1' };
    for (const network of Object.keys(prefixes) as Network[]) {
      const a = randomOrchardAddress(network);
      expect(a.startsWith(prefixes[network])).toBe(true);
      expect(toOrchardOnly(a, network)).toBe(a);
      expect(randomOrchardAddress(network)).not.toBe(a);
    }
  });
});
