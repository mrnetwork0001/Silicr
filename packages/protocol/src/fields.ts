/**
 * Field codecs for the positional CBOR bodies. Each codec validates on the
 * way out (encode) and on the way in (decode), so bounds hold in both
 * directions. A Spec lists a message's fields in wire order.
 */
import type { Bytes } from './contract.ts';
import { ProtocolError, describe, fromUtf8, utf8 } from './bytes.ts';
import type { CborInput, CborValue } from './cbor.ts';

export interface Codec<T> {
  /** Validates a JS value and converts it for CBOR. Throws ProtocolError. */
  enc(v: unknown, field: string): CborInput;
  /** Validates a decoded CBOR value and converts it back. Throws ProtocolError. */
  dec(v: CborValue, field: string): T;
}

/** One codec per field. Property order is the wire order, so reordering keys changes the format. */
export type Spec<T> = { readonly [K in keyof T]-?: Codec<T[K]> };

export const U32_MAX = 0xffff_ffff;
export const U64_MAX = 2n ** 64n - 1n;

/**
 * Shape of a ZIP 316 unified address: HRP "u", "utest", "uregtest" (any "u…"),
 * separator, Bech32 data. Full parsing and the Orchard-only check belong to
 * @silicr/zec; this keeps transparent, Sapling and junk strings out of memos.
 */
export const UA_PATTERN = /^u[a-z]{0,15}1[02-9ac-hj-np-z]{6,238}$/;
export const GPU_SLUG_PATTERN = /^[a-z0-9-]{1,16}$/;

function invalid(field: string, expected: string, v: unknown): ProtocolError {
  return new ProtocolError(`${field} must be ${expected} (got ${describe(v)})`);
}

/** Codec whose JS and CBOR forms are the same value. */
function same<T extends CborInput>(expected: string, ok: (v: unknown) => v is T): Codec<T> {
  const check = (v: unknown, field: string): T => {
    if (!ok(v)) throw invalid(field, expected, v);
    return v;
  };
  return { enc: check, dec: check };
}

export const bytes = (length: number): Codec<Bytes> =>
  same(`${length} bytes`, (v): v is Bytes => v instanceof Uint8Array && v.length === length);

export const pattern = (re: RegExp, expected: string): Codec<string> =>
  same(expected, (v): v is string => typeof v === 'string' && re.test(v));

/** Well-formed Unicode text (no lone surrogates) of at most maxBytes UTF-8 bytes. */
export const text = (maxBytes: number): Codec<string> =>
  same(`well-formed text of at most ${maxBytes} UTF-8 bytes`, (v): v is string => {
    if (typeof v !== 'string') return false;
    const b = utf8(v);
    return b.length <= maxBytes && fromUtf8(b) === v;
  });

/** A JS number in [min, max]; max must not exceed Number.MAX_SAFE_INTEGER. */
export function uint(min: number, max: number): Codec<number> {
  const expected = `an integer in ${min}..${max}`;
  return {
    enc(v, field) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw invalid(field, expected, v);
      return v;
    },
    dec(v, field) {
      if (typeof v !== 'bigint' || v < BigInt(min) || v > BigInt(max)) throw invalid(field, expected, v);
      return Number(v);
    },
  };
}

export const u64: Codec<bigint> = {
  enc(v, field) {
    if (typeof v !== 'bigint' || v < 0n || v > U64_MAX) throw invalid(field, 'a bigint in 0..2^64-1', v);
    return v;
  },
  dec(v, field) {
    if (typeof v !== 'bigint') throw invalid(field, 'an unsigned integer', v);
    return v;
  },
};

/** String enum carried as a small integer code. */
export function enumCodes<V extends string>(codes: Readonly<Record<V, number>>): Codec<V> {
  const names = Object.keys(codes) as V[];
  const byCode = new Map(names.map((name) => [BigInt(codes[name]), name]));
  const expected = `one of ${names.join(', ')}`;
  return {
    enc(v, field) {
      if (typeof v !== 'string' || !Object.hasOwn(codes, v)) throw invalid(field, expected, v);
      return codes[v as V];
    },
    dec(v, field) {
      const name = typeof v === 'bigint' ? byCode.get(v) : undefined;
      if (name === undefined) throw invalid(field, expected, v);
      return name;
    },
  };
}

/** Absent (undefined) travels as CBOR null, keeping each message at a fixed arity. */
export function optional<T>(inner: Codec<T>): Codec<T | undefined> {
  return {
    enc: (v, field) => (v === undefined || v === null ? null : inner.enc(v, field)),
    dec: (v, field) => (v === null ? undefined : inner.dec(v, field)),
  };
}

type AnySpec = Readonly<Record<string, Codec<unknown>>>;

export function encodeFields(name: string, spec: AnySpec, obj: unknown): CborInput[] {
  if (typeof obj !== 'object' || obj === null) throw new ProtocolError(`${name} must be an object (got ${describe(obj)})`);
  const record = obj as Record<string, unknown>;
  return Object.entries(spec).map(([key, codec]) => codec.enc(record[key], `${name}.${key}`));
}

/** Inverse of encodeFields. Absent optional fields are left out of the result. */
export function decodeFields(name: string, spec: AnySpec, value: CborValue): Record<string, unknown> {
  const entries = Object.entries(spec);
  if (!Array.isArray(value) || value.length !== entries.length) {
    throw new ProtocolError(`${name} must be an array of ${entries.length} fields`);
  }
  const out: Record<string, unknown> = {};
  entries.forEach(([key, codec], i) => {
    const v = codec.dec(value[i] as CborValue, `${name}.${key}`);
    if (v !== undefined) out[key] = v;
  });
  return out;
}
