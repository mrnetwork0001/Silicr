import { readFileSync } from 'node:fs';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { bech32, bech32m } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { F4JUMBLE_MAX_LENGTH, F4JUMBLE_MIN_LENGTH, f4jumble, f4jumbleInv } from '../src/f4jumble.ts';
import { decodeUnifiedAddress, encodeUnifiedAddress, UnifiedAddressError, type Receiver } from '../src/index.ts';
import { randomOrchardReceiver } from '../src/pallas.ts';

/** Upstream JSON vectors: two header rows, then one vector per row. */
function vectors<T>(file: string): T[] {
  return (JSON.parse(readFileSync(new URL(`./vectors/${file}`, import.meta.url), 'utf8')) as T[]).slice(2);
}

type UaVector = [
  p2pkh: string | null,
  p2sh: string | null,
  sapling: string | null,
  orchard: string | null,
  unknownTypecode: number | null,
  unknownBytes: string | null,
  ua: string,
  seed: string,
  account: number,
  diversifierIndex: number,
];

const UA_VECTORS = vectors<UaVector>('unified_address.json');

function expectedReceivers(v: UaVector): Receiver[] {
  const [p2pkh, p2sh, sapling, orchard, unknownTypecode, unknownBytes] = v;
  const receivers: Receiver[] = [];
  if (p2pkh !== null) receivers.push({ typecode: 0, kind: 'p2pkh', data: hexToBytes(p2pkh) });
  if (p2sh !== null) receivers.push({ typecode: 1, kind: 'p2sh', data: hexToBytes(p2sh) });
  if (sapling !== null) receivers.push({ typecode: 2, kind: 'sapling', data: hexToBytes(sapling) });
  if (orchard !== null) receivers.push({ typecode: 3, kind: 'orchard', data: hexToBytes(orchard) });
  if (unknownTypecode !== null && unknownBytes !== null) {
    receivers.push({ typecode: unknownTypecode, kind: 'unknown', data: hexToBytes(unknownBytes) });
  }
  return receivers;
}

const asHex = (receivers: readonly Receiver[]) =>
  receivers.map((r) => ({ typecode: r.typecode, kind: r.kind, data: bytesToHex(r.data) }));

// --- helpers to build raw encodings the codec itself would refuse to produce ---------------

function compactSize(n: number): number[] {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 0xff, n >>> 8];
  return [0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24];
}

function item(typecode: number, data: Uint8Array): number[] {
  return [...compactSize(typecode), ...compactSize(data.length), ...data];
}

/** Jumble raw item bytes with the padding for `paddingHrp`, then Bech32m-encode under `hrp`. */
function rawToUa(hrp: string, body: number[], paddingHrp = hrp): string {
  const padding = new Array<number>(16).fill(0);
  for (let i = 0; i < paddingHrp.length; i++) padding[i] = paddingHrp.charCodeAt(i);
  return bech32m.encode(hrp, bech32m.toWords(f4jumble(Uint8Array.from([...body, ...padding]))), false);
}

const ORCHARD = hexToBytes(UA_VECTORS.find((v) => v[3] !== null)![3]!);
const SAPLING = hexToBytes(UA_VECTORS.find((v) => v[2] !== null)![2]!);
const P2PKH = hexToBytes(UA_VECTORS.find((v) => v[0] !== null)![0]!);
const P2SH = new Uint8Array(20).fill(0x5a);

describe('ZIP 316 unified address vectors (zcash-test-vectors)', () => {
  it('vendors a useful subset', () => {
    expect(UA_VECTORS.length).toBe(26);
    expect(UA_VECTORS.filter((v) => v[4] !== null).length).toBeGreaterThanOrEqual(5);
  });

  it.each(UA_VECTORS.map((v) => [v[6].slice(0, 24), v] as const))('decodes %s…', (_label, v) => {
    const decoded = decodeUnifiedAddress(v[6]);
    expect(decoded.network).toBe('main');
    expect(asHex(decoded.receivers)).toEqual(asHex(expectedReceivers(v)));
  });

  it.each(UA_VECTORS.map((v) => [v[6].slice(0, 24), v] as const))('encodes %s… (from receivers in any order)', (_label, v) => {
    const receivers = expectedReceivers(v);
    expect(encodeUnifiedAddress('main', receivers)).toBe(v[6]);
    expect(encodeUnifiedAddress('main', [...receivers].reverse())).toBe(v[6]);
  });

  it('round-trips every vector, and accepts the all-uppercase form (Bech32m allows it)', () => {
    for (const v of UA_VECTORS) {
      const decoded = decodeUnifiedAddress(v[6]);
      expect(encodeUnifiedAddress(decoded.network, decoded.receivers)).toBe(v[6]);
      const upper = decodeUnifiedAddress(v[6].toUpperCase());
      expect(asHex(upper.receivers)).toEqual(asHex(decoded.receivers));
    }
  });

  it('preserves unknown (experimental) typecodes, including 3-byte compactSize ones', () => {
    const withUnknown = UA_VECTORS.filter((v) => v[4] !== null);
    for (const v of withUnknown) {
      const unknown = decodeUnifiedAddress(v[6]).receivers.find((r) => r.kind === 'unknown');
      expect(unknown?.typecode).toBe(v[4]);
      expect(unknown!.typecode).toBeGreaterThan(0xfc);
      expect(bytesToHex(unknown!.data)).toBe(v[5]);
    }
  });
});

describe('unified address codec', () => {
  it('encodes and decodes testnet ("utest") and regtest ("uregtest") addresses', () => {
    for (const [network, prefix] of [['test', 'utest1'], ['regtest', 'uregtest1'], ['main', 'u1']] as const) {
      const receivers: Receiver[] = [
        { typecode: 2, kind: 'sapling', data: SAPLING },
        { typecode: 3, kind: 'orchard', data: randomOrchardReceiver() },
      ];
      const ua = encodeUnifiedAddress(network, receivers);
      expect(ua.startsWith(prefix)).toBe(true);
      const decoded = decodeUnifiedAddress(ua);
      expect(decoded.network).toBe(network);
      expect(asHex(decoded.receivers)).toEqual(asHex(receivers));
    }
  });

  it('accepts P2SH + Orchard (upstream has no P2SH vector)', () => {
    const ua = encodeUnifiedAddress('test', [
      { typecode: 3, kind: 'orchard', data: ORCHARD },
      { typecode: 1, kind: 'p2sh', data: P2SH },
    ]);
    expect(decodeUnifiedAddress(ua).receivers.map((r) => r.kind)).toEqual(['p2sh', 'orchard']);
  });

  it('accepts and preserves non-MUST-understand metadata (0xC0..0xDF)', () => {
    const ua = rawToUa('u', [...item(3, ORCHARD), ...item(0xc0, Uint8Array.of(1, 2, 3))]);
    const decoded = decodeUnifiedAddress(ua);
    expect(decoded.receivers.map((r) => [r.typecode, r.kind])).toEqual([[3, 'orchard'], [0xc0, 'unknown']]);
    expect(encodeUnifiedAddress('main', decoded.receivers)).toBe(ua);
  });

  it('matches the codec output byte for byte when built by hand', () => {
    const byHand = rawToUa('uregtest', item(3, ORCHARD));
    expect(encodeUnifiedAddress('regtest', [{ typecode: 3, kind: 'orchard', data: ORCHARD }])).toBe(byHand);
  });

  const reject = (ua: string, pattern: RegExp) => {
    expect(() => decodeUnifiedAddress(ua)).toThrow(UnifiedAddressError);
    expect(() => decodeUnifiedAddress(ua)).toThrow(pattern);
  };

  it('rejects a bad checksum', () => {
    const ua = UA_VECTORS[0]![6];
    const i = 20;
    const flipped = ua.slice(0, i) + (ua[i] === 'q' ? 'p' : 'q') + ua.slice(i + 1);
    reject(flipped, /Bech32m/);
    reject(ua.slice(0, -1), /Bech32m/);
  });

  it('rejects a Bech32 (not Bech32m) checksum', () => {
    const words = bech32m.decode(UA_VECTORS[0]![6], false).words;
    reject(bech32.encode('u', words, false), /Bech32m/);
  });

  it('rejects mixed case', () => {
    const ua = UA_VECTORS[0]![6];
    reject(ua.slice(0, 10) + ua.slice(10).toUpperCase(), /Bech32m/);
  });

  it('rejects a changed prefix: the HRP is bound by the 16-byte padding', () => {
    // Re-encode a valid mainnet payload under "utest": the checksum is fine, the padding is not.
    const { words } = bech32m.decode(UA_VECTORS[0]![6], false);
    reject(bech32m.encode('utest', words, false), /padding/);
    reject(rawToUa('utest', item(3, ORCHARD), 'u'), /padding/);
    reject(rawToUa('uregtest', item(3, ORCHARD), 'uregtes'), /padding/);
  });

  it('rejects unknown prefixes', () => {
    reject(rawToUa('uxyz', item(3, ORCHARD)), /unknown unified address prefix "uxyz"/);
    reject(rawToUa('zutest', item(3, ORCHARD)), /unknown unified address prefix/);
  });

  it('rejects non-zero Bech32m padding bits', () => {
    const jumbled = f4jumble(Uint8Array.from([...item(3, ORCHARD), 0x75, ...new Array<number>(15).fill(0)]));
    const words = bech32m.toWords(jumbled); // 61 bytes = 488 bits → 98 words, 2 padding bits
    words[words.length - 1]! |= 1;
    reject(bech32m.encode('u', words, false), /padding/);
  });

  it('rejects encodings outside the F4Jumble length range', () => {
    reject(bech32m.encode('u', bech32m.toWords(new Uint8Array(F4JUMBLE_MIN_LENGTH - 1)), false), /outside 38/);
  });

  it('rejects receivers out of ascending typecode order', () => {
    reject(rawToUa('u', [...item(3, ORCHARD), ...item(2, SAPLING)]), /ascending typecode order/);
  });

  it('rejects duplicate typecodes', () => {
    reject(rawToUa('u', [...item(3, ORCHARD), ...item(3, ORCHARD)]), /duplicate typecode 0x03/);
  });

  it('rejects P2PKH and P2SH together', () => {
    reject(rawToUa('u', [...item(0, P2PKH), ...item(1, P2SH), ...item(3, ORCHARD)]), /both P2PKH and P2SH/);
  });

  it('rejects a transparent-only Revision 0 address', () => {
    reject(rawToUa('u', item(0, P2PKH)), /at least one shielded receiver/);
    reject(rawToUa('u', item(1, P2SH)), /at least one shielded receiver/);
  });

  it('rejects metadata-only addresses', () => {
    reject(rawToUa('u', item(0xc0, new Uint8Array(30))), /at least one non-metadata item/);
  });

  it('rejects MUST-understand metadata (0xE0..0xFC) in a Revision 0 address', () => {
    reject(rawToUa('u', [...item(3, ORCHARD), ...item(0xe0, new Uint8Array(4))]), /MUST-understand/);
    reject(rawToUa('u', [...item(3, ORCHARD), ...item(0xfc, new Uint8Array(4))]), /MUST-understand/);
  });

  it('rejects known receivers with the wrong length', () => {
    reject(rawToUa('u', item(3, new Uint8Array(42))), /orchard receiver must be 43 bytes, got 42/);
    reject(rawToUa('u', item(2, new Uint8Array(44))), /sapling receiver must be 43 bytes, got 44/);
    reject(rawToUa('u', [...item(0, new Uint8Array(21)), ...item(3, ORCHARD)]), /p2pkh receiver must be 20 bytes/);
  });

  it('rejects trailing bytes and truncated items', () => {
    reject(rawToUa('u', [...item(3, ORCHARD), 0x05]), /truncated/);
    reject(rawToUa('u', [3, 43, ...ORCHARD.subarray(0, 40)]), /truncated item/);
  });

  it('rejects non-canonical and oversized compactSize values', () => {
    reject(rawToUa('u', [0xfd, 0x03, 0x00, 43, ...ORCHARD]), /non-canonical compactSize typecode/);
    reject(rawToUa('u', [3, 0xfd, 43, 0x00, ...ORCHARD]), /non-canonical compactSize length/);
    reject(rawToUa('u', [0xfe, 0xff, 0xff, 0x00, 0x00, 1, 0, ...item(3, ORCHARD)]), /non-canonical compactSize typecode/);
    reject(rawToUa('u', [...item(3, ORCHARD), 0xfe, 0x01, 0x00, 0x00, 0x02, 1, 0]), /exceeds 0x2000000/);
    reject(rawToUa('u', [...item(3, ORCHARD), 0xff, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]), /exceeds 0x2000000/);
  });

  it('accepts the largest typecode, 0x2000000', () => {
    const ua = rawToUa('u', [...item(3, ORCHARD), ...item(0x2000000, Uint8Array.of(9))]);
    expect(decodeUnifiedAddress(ua).receivers[1]).toMatchObject({ typecode: 0x2000000, kind: 'unknown' });
  });

  it('rejects non-strings', () => {
    expect(() => decodeUnifiedAddress(42 as unknown as string)).toThrow(UnifiedAddressError);
  });

  describe('encodeUnifiedAddress input checks', () => {
    const orchard: Receiver = { typecode: 3, kind: 'orchard', data: ORCHARD };
    const fail = (network: string, receivers: Receiver[], pattern: RegExp) =>
      expect(() => encodeUnifiedAddress(network as 'main', receivers)).toThrow(pattern);

    it('refuses what a Consumer would reject', () => {
      fail('main', [], /at least one receiver/);
      fail('main', [orchard, orchard], /duplicate typecode/);
      fail('main', [{ typecode: 0, kind: 'p2pkh', data: P2PKH }], /at least one shielded receiver/);
      fail('main', [{ typecode: 0, kind: 'p2pkh', data: P2PKH }, { typecode: 1, kind: 'p2sh', data: P2SH }, orchard], /both P2PKH and P2SH/);
      fail('main', [orchard, { typecode: 0xe1, kind: 'unknown', data: new Uint8Array(8) }], /MUST-understand/);
      fail('main', [{ typecode: 3, kind: 'orchard', data: new Uint8Array(42) }], /43 bytes/);
      fail('main', [{ typecode: 0x2000001, kind: 'unknown', data: new Uint8Array(1) }, orchard], /out of range/);
    });

    it('refuses inconsistent kinds and bad networks', () => {
      fail('main', [{ typecode: 3, kind: 'sapling', data: ORCHARD }], /kind "sapling" but typecode 0x03 is "orchard"/);
      fail('main', [{ typecode: 0xfffa, kind: 'orchard', data: ORCHARD }], /is "unknown"/);
      fail('memory', [orchard], /unknown address network "memory"/);
      fail('constructor', [orchard], /unknown address network/);
    });

    it('does not reorder the caller’s array', () => {
      const receivers: Receiver[] = [orchard, { typecode: 2, kind: 'sapling', data: SAPLING }];
      encodeUnifiedAddress('main', receivers);
      expect(receivers.map((r) => r.typecode)).toEqual([3, 2]);
    });

    it('round-trips random receivers of every kind', () => {
      for (let i = 0; i < 20; i++) {
        const receivers: Receiver[] = [
          { typecode: 0, kind: 'p2pkh', data: randomBytes(20) },
          { typecode: 2, kind: 'sapling', data: randomBytes(43) },
          { typecode: 3, kind: 'orchard', data: randomBytes(43) },
          { typecode: 0xfffa + (i % 6), kind: 'unknown', data: randomBytes(i * 13) },
        ];
        const decoded = decodeUnifiedAddress(encodeUnifiedAddress('regtest', receivers));
        expect(asHex(decoded.receivers)).toEqual(asHex(receivers));
      }
    });
  });
});

describe('F4Jumble (zcash-test-vectors)', () => {
  const short = vectors<[normal: string, jumbled: string]>('f4jumble.json');
  const long = vectors<[length: number, jumbledHash: string]>('f4jumble_long.json');

  it.each(short.map(([n, j]) => [n.length / 2, n, j] as const))('matches the %i-byte vector both ways', (_len, normal, jumbled) => {
    expect(bytesToHex(f4jumble(hexToBytes(normal)))).toBe(jumbled);
    expect(bytesToHex(f4jumbleInv(hexToBytes(jumbled)))).toBe(normal);
  });

  it.each(long.map(([length, hash]) => [length, hash] as const))(
    'matches the long %i-byte vector (BLAKE2b-512 of the output) and inverts it',
    (length, hash) => {
      const message = new Uint8Array(length);
      for (let i = 0; i < length; i++) message[i] = i & 0xff;
      const jumbled = f4jumble(message);
      expect(bytesToHex(blake2b(jumbled))).toBe(hash);
      // Buffer.equals rather than toEqual: deep-equality over 4 MB takes seconds.
      expect(Buffer.from(f4jumbleInv(jumbled)).equals(Buffer.from(message))).toBe(true);
    },
    60_000,
  );

  it('enforces the 38..4194368 byte input range', () => {
    expect(() => f4jumble(new Uint8Array(F4JUMBLE_MIN_LENGTH - 1))).toThrow(RangeError);
    expect(() => f4jumbleInv(new Uint8Array(F4JUMBLE_MIN_LENGTH - 1))).toThrow(RangeError);
    expect(f4jumbleInv(f4jumble(new Uint8Array(F4JUMBLE_MIN_LENGTH)))).toEqual(new Uint8Array(F4JUMBLE_MIN_LENGTH));
    expect(F4JUMBLE_MAX_LENGTH).toBe(4194368);
    expect(() => f4jumble(new Uint8Array(F4JUMBLE_MAX_LENGTH + 1))).toThrow(RangeError);
  });
});
