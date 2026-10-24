import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Bytes } from './contract.ts';

/**
 * Thrown by encoders, key constructors and channels on invalid input.
 * Messages name the field and the expected shape but never echo values, so
 * logging one cannot leak memo plaintext or key material.
 */
export class ProtocolError extends Error {
  override name = 'ProtocolError';
}

const encoder = new TextEncoder();
// fatal: reject malformed UTF-8. ignoreBOM: keep a leading U+FEFF instead of
// silently dropping it, so decoding stays injective.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const utf8 = (s: string): Bytes => encoder.encode(s);
export const fromUtf8 = (b: Bytes): string => decoder.decode(b);

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Type and size of a value, for error messages. Never the value itself. */
export function describe(v: unknown): string {
  if (v instanceof Uint8Array) return `${v.length} bytes`;
  if (typeof v === 'string') return `a string of length ${v.length}`;
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

export function assertBytes(v: unknown, length: number, what: string): asserts v is Bytes {
  if (!(v instanceof Uint8Array) || v.length !== length) {
    throw new ProtocolError(`${what} must be ${length} bytes (got ${describe(v)})`);
  }
}

export function toHex(b: Bytes): string {
  return bytesToHex(b);
}

/** Strict: an even number of hex digits (either case), nothing else. */
export function fromHex(s: string): Bytes {
  if (typeof s !== 'string' || s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) {
    throw new ProtocolError(`fromHex expects an even-length hex string (got ${describe(s)})`);
  }
  return hexToBytes(s);
}

export function sha256(b: Bytes): Bytes {
  return nobleSha256(b);
}
