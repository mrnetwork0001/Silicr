/** Seeded PRNG (mulberry32) and realistic-looking identifiers for the mock replay. */

const HEX = '0123456789abcdef';
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Lowercase hex of `bytes` random bytes. */
  hex(bytes: number): string {
    let s = '';
    for (let i = 0; i < bytes * 2; i++) s += HEX[Math.floor(this.next() * 16)];
    return s;
  }

  private bech32(len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) s += BECH32[Math.floor(this.next() * 32)];
    return s;
  }

  /**
   * An Orchard-only mainnet unified address: "u1" + 104 bech32m chars, 106 in all
   * (45-byte receiver + 16-byte padding, F4Jumbled, plus checksum).
   * Shape only; the checksum is not valid, so it can never receive funds.
   */
  ua(): string {
    return `u1${this.bech32(104)}`;
  }

  txid(): string {
    return this.hex(32);
  }
}
