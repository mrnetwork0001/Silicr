import { describe, expect, it } from 'vitest';
import { CborError, type CborInput, MAX_DEPTH, decodeCbor, decodeCborExact, encodeCbor } from '../src/cbor.ts';
import { fromHex, toHex } from '../src/index.ts';

const enc = (v: CborInput) => toHex(encodeCbor(v));
const dec = (hex: string) => decodeCborExact(fromHex(hex));

describe('CBOR encoder', () => {
  // Vectors from RFC 8949 Appendix A, restricted to the supported subset.
  it.each<[string, CborInput]>([
    ['00', 0],
    ['01', 1],
    ['0a', 10],
    ['17', 23],
    ['1818', 24],
    ['1819', 25],
    ['1864', 100],
    ['18ff', 255],
    ['190100', 256],
    ['1903e8', 1000],
    ['19ffff', 65535],
    ['1a00010000', 65536],
    ['1a000f4240', 1_000_000],
    ['1affffffff', 0xffff_ffff],
    ['1b0000000100000000', 2 ** 32],
    ['1b000000e8d4a51000', 1_000_000_000_000],
    ['1bffffffffffffffff', 2n ** 64n - 1n],
    ['f4', false],
    ['f5', true],
    ['f6', null],
    ['40', new Uint8Array()],
    ['4401020304', Uint8Array.of(1, 2, 3, 4)],
    ['60', ''],
    ['6161', 'a'],
    ['6449455446', 'IETF'],
    ['62c3bc', '\u00fc'],
    ['63e6b0b4', '\u6c34'],
    ['64f0908591', '\ud800\udd51'],
    ['80', []],
    ['83010203', [1, 2, 3]],
    ['8301820203820405', [1, [2, 3], [4, 5]]],
    ['98190102030405060708090a0b0c0d0e0f101112131415161718181819', Array.from({ length: 25 }, (_, i) => i + 1)],
  ])('encodes %s', (hex, value) => {
    expect(enc(value)).toBe(hex);
  });

  it('round-trips, returning integers as bigint', () => {
    const value = [0, 2n ** 64n - 1n, Uint8Array.of(9), 'slc1', [true, false, null, []]];
    expect(dec(enc(value))).toEqual([0n, 2n ** 64n - 1n, Uint8Array.of(9), 'slc1', [true, false, null, []]]);
  });

  it.each<[string, unknown]>([
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['an unsafe integer', 2 ** 53],
    ['a negative bigint', -1n],
    ['a bigint over 2^64-1', 2n ** 64n],
    ['a lone surrogate', '\ud800'],
    ['undefined', undefined],
    ['an object', { a: 1 }],
    ['nesting past the limit', [[[[[1]]]]]],
  ])('rejects %s', (_label, value) => {
    expect(() => encodeCbor(value as CborInput)).toThrow(CborError);
  });

  it(`allows exactly ${MAX_DEPTH} levels of nesting`, () => {
    expect(enc([[[[1]]]])).toBe('8181818101');
  });
});

describe('CBOR decoder', () => {
  it.each<[string, string]>([
    ['non-minimal 1-byte int', '1817'],
    ['non-minimal 2-byte int', '1900ff'],
    ['non-minimal 4-byte int', '1a0000ffff'],
    ['non-minimal 8-byte int', '1b00000000ffffffff'],
    ['non-minimal byte-string length', '580101'],
    ['non-minimal array length', '980101'],
    ['indefinite byte string', '5f4101ff'],
    ['indefinite text string', '7f6161ff'],
    ['indefinite array', '9f01ff'],
    ['indefinite map', 'bf0101ff'],
    ['break code', 'ff'],
    ['reserved additional info 28', '1c'],
    ['reserved additional info 30', '1e'],
    ['byte string past the end', '450102'],
    ['text string past the end', '781861'],
    ['array past the end', '8301'],
    ['huge array length', '9affffffff'],
    ['huge byte-string length', '5bffffffffffffffff'],
    ['truncated argument', '19ff'],
    ['empty input', ''],
    ['negative integer', '20'],
    ['map', 'a0'],
    ['tag', 'c000'],
    ['half float', 'f90000'],
    ['single float', 'fa00000000'],
    ['double float', 'fb0000000000000000'],
    ['undefined', 'f7'],
    ['simple value', 'f820'],
    ['small simple value', 'e0'],
    ['invalid UTF-8', '62c328'],
    ['overlong UTF-8', '62c0af'],
    ['UTF-8 surrogate', '63eda080'],
    ['nesting past the limit', '818181818100'],
    ['trailing bytes', '0000'],
  ])('rejects %s', (_label, hex) => {
    expect(() => dec(hex)).toThrow(CborError);
  });

  it('keeps a leading byte-order mark instead of dropping it', () => {
    expect(dec('63efbbbf')).toBe('﻿');
  });

  it('reports where an embedded item ends', () => {
    expect(decodeCbor(fromHex('aa820102bb'), 1)).toEqual({ value: [1n, 2n], end: 4 });
  });

  it('returns copies, not views of the input', () => {
    const input = fromHex('420102');
    const value = decodeCborExact(input) as Uint8Array;
    input[1] = 9;
    expect(value).toEqual(Uint8Array.of(1, 2));
  });
});
