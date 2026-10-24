import type { MemoMessage, Signer } from '../src/index.ts';
import { sha256, signerFromSecret, x25519FromSecret } from '../src/index.ts';

export const U32_MAX = 0xffff_ffff;
export const U64_MAX = 2n ** 64n - 1n;

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** A string shaped like a unified address (`hrp` + "1" + Bech32 data), `length` chars long. */
export function fakeUa(length = 113, hrp = 'uregtest'): string {
  let data = '';
  for (let i = 0; data.length < length - hrp.length - 1; i++) data += BECH32[(i * 7 + 3) % 32];
  return `${hrp}1${data}`;
}

/** mulberry32: a tiny seeded PRNG, so fuzz failures can be replayed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    bytes: (n: number): Uint8Array => Uint8Array.from({ length: n }, () => int(256)),
    pick: <T>(xs: readonly T[]): T => xs[int(xs.length)] as T,
  };
}

const secureRandom = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/**
 * Typical messages of every type, all meant to be signed by `signer` (the RFQ names
 * it as buyerKey). Pass a seeded `random` for reproducible messages.
 */
export function sampleMessages(signer: Signer, random: (n: number) => Uint8Array = secureRandom): MemoMessage[] {
  const rfqId = random(16);
  const x25519Public = () => x25519FromSecret(random(32)).publicKey;
  return [
    {
      t: 'RFQ',
      rfqId,
      gpu: 'a100',
      count: 4,
      durationS: 12 * 3600,
      maxPricePerHourZats: 80_000_000n,
      replyTo: fakeUa(110, 'utest'),
      buyerKey: signer.publicKey,
      buyerEph: x25519Public(),
      expiresHeight: 3_100_000,
    },
    {
      t: 'BID',
      rfqId,
      providerId: signer.publicKey,
      pricePerIntervalZats: 12_500_000n,
      intervalS: 600,
      startWithinS: 0,
      providerEph: x25519Public(),
      payTo: fakeUa(110, 'utest'),
    },
    { t: 'ACCEPT', rfqId, providerId: signerFromSecret(random(32)).publicKey, intervals: 72, pricePerIntervalZats: 12_500_000n },
    { t: 'PAY', rfqId, seq: 1 },
    { t: 'CLOSE', rfqId, by: 'buyer', reason: 'buyer_stop', finalSeq: 7 },
    { t: 'CLOSE', rfqId, by: 'provider', reason: 'done', finalSeq: 71, resultDigest: sha256(new Uint8Array([1, 2, 3])) },
  ];
}

/**
 * Largest possible messages: 113-char addresses (Orchard-only regtest UA),
 * 16-char GPU slugs, u64-max prices and u32-max for every bounded number.
 */
export function worstCaseMessages(): MemoMessage[] {
  const rfqId = new Uint8Array(16).fill(0xff);
  const key = new Uint8Array(32).fill(0xff);
  const ua = fakeUa(113);
  return [
    {
      t: 'RFQ',
      rfqId,
      gpu: 'h100-sxm5-80gb-x',
      count: 64,
      durationS: U32_MAX,
      maxPricePerHourZats: U64_MAX,
      replyTo: ua,
      buyerKey: key,
      buyerEph: key,
      expiresHeight: U32_MAX,
    },
    {
      t: 'BID',
      rfqId,
      providerId: key,
      pricePerIntervalZats: U64_MAX,
      intervalS: U32_MAX,
      startWithinS: U32_MAX,
      providerEph: key,
      payTo: ua,
    },
    { t: 'ACCEPT', rfqId, providerId: key, intervals: U32_MAX, pricePerIntervalZats: U64_MAX },
    { t: 'PAY', rfqId, seq: U32_MAX },
    { t: 'CLOSE', rfqId, by: 'provider', reason: 'no_heartbeat', finalSeq: U32_MAX, resultDigest: key },
  ];
}

/** The key a receiver would check the message against, when the message names it. */
export function selfDeclaredKey(msg: MemoMessage): Uint8Array | undefined {
  if (msg.t === 'RFQ') return msg.buyerKey;
  if (msg.t === 'BID') return msg.providerId;
  return undefined;
}
