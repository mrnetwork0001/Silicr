/**
 * F4Jumble and its inverse, as specified in ZIP 316 § "Jumbling"
 * (https://zips.z.cash/zip-0316#jumbling).
 *
 * A 4-round unkeyed Feistel construction over BLAKE2b that turns the raw
 * unified-address encoding into a pseudo-random-looking byte string, so that a
 * small edit to the string can't produce a "usefully" different valid address.
 *
 *   ℓ_L = min(ℓ_H, floor(ℓ_M / 2)),  ℓ_R = ℓ_M − ℓ_L,  M = a || b
 *   x = b ⊕ G₀(a);  y = a ⊕ H₀(x);  d = x ⊕ G₁(y);  c = y ⊕ H₁(d);  return c || d
 *
 *   H_i(u) = BLAKE2b-(8·ℓ_L)("UA_F4Jumble_H" || [i, 0, 0], u)
 *   G_i(u) = first ℓ_R bytes of  BLAKE2b-512("UA_F4Jumble_G" || [i] || I2LEOSP₁₆(j), u)
 *            for j = 0 .. ceil(ℓ_R / ℓ_H) − 1
 */
import { blake2b } from '@noble/hashes/blake2.js';

/** ℓ_H: the maximum BLAKE2b output length in bytes. */
const L_H = 64;

/**
 * Smallest input F4Jumble is defined for. ZIP 316 Revision 2 lowered this from
 * 48 to 38 bytes; the difference is unobservable for Revision 0 encodings
 * (the smallest valid one, a lone Sapling or Orchard receiver, is 61 bytes).
 */
export const F4JUMBLE_MIN_LENGTH = 38;

/** ℓ^MAX_M = (2^16 + 1) · ℓ_H = 4 194 368 bytes. */
export const F4JUMBLE_MAX_LENGTH = (2 ** 16 + 1) * L_H;

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
const H_PERSONALIZATION_PREFIX = ascii('UA_F4Jumble_H'); // 13 bytes, then [i, 0, 0]
const G_PERSONALIZATION_PREFIX = ascii('UA_F4Jumble_G'); // 13 bytes, then [i] || I2LEOSP16(j)

function checkLength(length: number): void {
  if (length < F4JUMBLE_MIN_LENGTH || length > F4JUMBLE_MAX_LENGTH) {
    throw new RangeError(
      `F4Jumble input must be ${F4JUMBLE_MIN_LENGTH}..${F4JUMBLE_MAX_LENGTH} bytes, got ${length}`,
    );
  }
}

/** H_i(u): BLAKE2b with an output length of exactly `outLen` (= ℓ_L) bytes. */
function hashH(i: number, u: Uint8Array, outLen: number): Uint8Array {
  const personalization = new Uint8Array(16);
  personalization.set(H_PERSONALIZATION_PREFIX, 0);
  personalization[13] = i; // bytes 14 and 15 stay 0
  return blake2b(u, { dkLen: outLen, personalization });
}

/** G_i(u): the first `outLen` (= ℓ_R) bytes of a BLAKE2b-512 stream keyed by a 16-bit LE counter. */
function hashG(i: number, u: Uint8Array, outLen: number): Uint8Array {
  const out = new Uint8Array(outLen);
  const personalization = new Uint8Array(16);
  personalization.set(G_PERSONALIZATION_PREFIX, 0);
  personalization[13] = i;
  const blocks = Math.ceil(outLen / L_H);
  for (let j = 0; j < blocks; j++) {
    personalization[14] = j & 0xff; // I2LEOSP_16(j), little-endian
    personalization[15] = j >>> 8;
    const block = blake2b(u, { dkLen: L_H, personalization });
    const offset = j * L_H;
    const take = Math.min(L_H, outLen - offset);
    out.set(take === L_H ? block : block.subarray(0, take), offset);
  }
  return out;
}

/** p ⊕ q, written into a fresh array (p and q have equal length). */
function xor(p: Uint8Array, q: Uint8Array): Uint8Array {
  const out = new Uint8Array(p.length);
  for (let k = 0; k < p.length; k++) out[k] = p[k]! ^ q[k]!;
  return out;
}

function split(length: number): { lL: number; lR: number } {
  const lL = Math.min(L_H, Math.floor(length / 2));
  return { lL, lR: length - lL };
}

function join(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

/** F4Jumble(M). Throws RangeError if M is outside 38..4194368 bytes. */
export function f4jumble(message: Uint8Array): Uint8Array {
  checkLength(message.length);
  const { lL, lR } = split(message.length);
  const a = message.subarray(0, lL);
  const b = message.subarray(lL);
  const x = xor(b, hashG(0, a, lR));
  const y = xor(a, hashH(0, x, lL));
  const d = xor(x, hashG(1, y, lR));
  const c = xor(y, hashH(1, d, lL));
  return join(c, d);
}

/** F4Jumble⁻¹(M). Throws RangeError if M is outside 38..4194368 bytes. */
export function f4jumbleInv(jumbled: Uint8Array): Uint8Array {
  checkLength(jumbled.length);
  const { lL, lR } = split(jumbled.length);
  const c = jumbled.subarray(0, lL);
  const d = jumbled.subarray(lL);
  const y = xor(c, hashH(1, d, lL));
  const x = xor(d, hashG(1, y, lR));
  const a = xor(y, hashH(0, x, lL));
  const b = xor(x, hashG(0, a, lR));
  return join(a, b);
}
