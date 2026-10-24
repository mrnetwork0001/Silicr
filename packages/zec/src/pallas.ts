/**
 * Just enough Pallas arithmetic to tell whether an Orchard receiver is real.
 *
 * An Orchard raw address is d (11 bytes) || repr_P(pk_d) (32 bytes). Every d is
 * a valid diversifier, but pk_d must decode to a non-identity point on Pallas
 * (y² = x³ + 5 over F_p), as orchard's `DiversifiedTransmissionKey::from_bytes`
 * requires. repr_P is the little-endian x-coordinate with the parity of y in
 * bit 255; the all-zero encoding is the identity. Pallas has odd prime order,
 * so no point has y = 0 and checking that x³ + 5 is a square mod p suffices.
 */
import { randomBytes } from '@noble/hashes/utils.js';

/** The Pallas base field modulus. */
export const PALLAS_P = 0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001n;
const LEGENDRE_EXPONENT = (PALLAS_P - 1n) >> 1n;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** True iff `repr` is the canonical encoding of a non-identity Pallas point. */
export function isNonIdentityPallasPoint(repr: Uint8Array): boolean {
  if (repr.length !== 32) return false;
  let x = BigInt(repr[31]! & 0x7f);
  for (let i = 30; i >= 0; i--) x = (x << 8n) | BigInt(repr[i]!);
  const ySign = repr[31]! >> 7;
  if (x >= PALLAS_P) return false; // non-canonical x
  if (x === 0n && ySign === 0) return false; // the identity
  const rhs = (((x * x) % PALLAS_P) * x + 5n) % PALLAS_P;
  return modPow(rhs, LEGENDRE_EXPONENT, PALLAS_P) === 1n; // Euler's criterion: rhs is a nonzero square
}

/** True iff `data` is a 43-byte Orchard raw address whose pk_d is a valid non-identity Pallas point. */
export function isValidOrchardReceiver(data: Uint8Array): boolean {
  return data instanceof Uint8Array && data.length === 43 && isNonIdentityPallasPoint(data.subarray(11));
}

/**
 * A random, valid 43-byte Orchard receiver: a random diversifier and a random
 * point. Nobody holds its keys, so it is only useful for simulation and tests.
 */
export function randomOrchardReceiver(random: (length: number) => Uint8Array = randomBytes): Uint8Array {
  for (;;) {
    const candidate = random(43);
    if (isValidOrchardReceiver(candidate)) return candidate;
  }
}
