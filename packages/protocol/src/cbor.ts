/**
 * Deterministic CBOR (RFC 8949 §4.2.1), limited to what Silicr uses: unsigned
 * integers up to 2^64-1, byte strings, text strings, definite-length arrays,
 * booleans and null. The decoder accepts only what this encoder produces:
 * shortest-form heads, no indefinite lengths, no maps, tags, floats or
 * negative integers, and at most MAX_DEPTH levels of array nesting.
 */
import type { Bytes } from './contract.ts';
import { fromUtf8, utf8 } from './bytes.ts';

/** Decoded values. Unsigned integers always come back as bigint. */
export type CborValue = bigint | Bytes | string | boolean | null | CborValue[];
/** Encoder input: as CborValue, but unsigned integers may also be safe-integer numbers. */
export type CborInput = number | bigint | Bytes | string | boolean | null | readonly CborInput[];

export const MAX_DEPTH = 4;
const U64_MAX = 2n ** 64n - 1n;

export class CborError extends Error {
  override name = 'CborError';
}

export function encodeCbor(value: CborInput): Bytes {
  const out: number[] = [];
  write(value, out, 0);
  return Uint8Array.from(out);
}

function writeHead(out: number[], major: number, n: bigint): void {
  const size = n < 24n ? 0 : n < 0x100n ? 1 : n < 0x1_0000n ? 2 : n < 0x1_0000_0000n ? 4 : 8;
  out.push((major << 5) | (size === 0 ? Number(n) : 24 + Math.log2(size)));
  for (let i = size - 1; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
}

function write(v: CborInput, out: number[], depth: number): void {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new CborError('numbers must be unsigned safe integers');
    writeHead(out, 0, BigInt(v));
  } else if (typeof v === 'bigint') {
    if (v < 0n || v > U64_MAX) throw new CborError('integers must be in 0..2^64-1');
    writeHead(out, 0, v);
  } else if (v instanceof Uint8Array) {
    writeHead(out, 2, BigInt(v.length));
    for (const b of v) out.push(b);
  } else if (typeof v === 'string') {
    const b = utf8(v);
    // TextEncoder replaces lone surrogates with U+FFFD; refuse rather than change the text.
    if (fromUtf8(b) !== v) throw new CborError('text is not well-formed Unicode');
    writeHead(out, 3, BigInt(b.length));
    for (const x of b) out.push(x);
  } else if (typeof v === 'boolean') {
    out.push(v ? 0xf5 : 0xf4);
  } else if (v === null) {
    out.push(0xf6);
  } else if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) throw new CborError(`arrays nest at most ${MAX_DEPTH} deep`);
    writeHead(out, 4, BigInt(v.length));
    for (const x of v as readonly CborInput[]) write(x, out, depth + 1);
  } else {
    throw new CborError('unsupported value type');
  }
}

interface Reader {
  buf: Bytes;
  pos: number;
}

/** Decodes one item starting at `offset`. Bytes after it are left for the caller. Throws CborError. */
export function decodeCbor(buf: Bytes, offset = 0): { value: CborValue; end: number } {
  const r: Reader = { buf, pos: offset };
  const value = read(r, 0);
  return { value, end: r.pos };
}

/** Decodes exactly one item that must span the whole buffer. */
export function decodeCborExact(buf: Bytes): CborValue {
  const { value, end } = decodeCbor(buf);
  if (end !== buf.length) throw new CborError('trailing bytes after CBOR item');
  return value;
}

function take(r: Reader, n: number): Bytes {
  if (n > r.buf.length - r.pos) throw new CborError('truncated input');
  const out = r.buf.slice(r.pos, r.pos + n);
  r.pos += n;
  return out;
}

function readArgument(r: Reader, ai: number): bigint {
  if (ai < 24) return BigInt(ai);
  if (ai === 31) throw new CborError('indefinite lengths are not allowed');
  if (ai > 27) throw new CborError('reserved additional-information value');
  const size = 1 << (ai - 24);
  let n = 0n;
  for (const b of take(r, size)) n = (n << 8n) | BigInt(b);
  // Shortest form only: 1 byte for 24..255, 2 for 256.., 4 for 2^16.., 8 for 2^32..
  const min = size === 1 ? 24n : 1n << BigInt(4 * size);
  if (n < min) throw new CborError('non-minimal integer encoding');
  return n;
}

function readLength(r: Reader, ai: number): number {
  const n = readArgument(r, ai);
  // Every byte, character or array item needs at least one input byte.
  if (n > BigInt(r.buf.length - r.pos)) throw new CborError('length runs past the end of input');
  return Number(n);
}

function read(r: Reader, depth: number): CborValue {
  const ib = r.buf[r.pos];
  if (ib === undefined) throw new CborError('truncated input');
  r.pos++;
  const major = ib >> 5;
  const ai = ib & 0x1f;
  switch (major) {
    case 0:
      return readArgument(r, ai);
    case 2:
      return take(r, readLength(r, ai));
    case 3:
      try {
        return fromUtf8(take(r, readLength(r, ai)));
      } catch (e) {
        throw e instanceof CborError ? e : new CborError('text is not valid UTF-8');
      }
    case 4: {
      if (depth >= MAX_DEPTH) throw new CborError(`arrays nest at most ${MAX_DEPTH} deep`);
      const n = readLength(r, ai);
      const items: CborValue[] = [];
      for (let i = 0; i < n; i++) items.push(read(r, depth + 1));
      return items;
    }
    case 7:
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      throw new CborError('floats and simple values other than false/true/null are not allowed');
    default:
      // 1 = negative integer, 5 = map, 6 = tag
      throw new CborError(`major type ${major} is not allowed`);
  }
}
