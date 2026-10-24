import { describe, expect, it } from 'vitest';
import { type CborValue, decodeCbor, encodeCbor } from '../src/cbor.ts';
import {
  type Heartbeat,
  ProtocolError,
  decodeHeartbeat,
  deriveChannel,
  encodeHeartbeat,
  generateSigner,
  generateX25519,
  newRfqId,
  sha256,
} from '../src/index.ts';
import { U32_MAX } from './helpers.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));

const { signer } = generateSigner();
const other = generateSigner().signer;
const hb: Heartbeat = {
  rfqId: newRfqId(),
  seq: 12,
  ts: 1_790_000_000_123,
  step: 4200,
  checkpointDigest: sha256(utf8('checkpoint')),
  status: 'running',
  servingSeq: 3,
};

/** Re-sign a hand-edited body the way the protocol does. */
const resign = (body: CborValue[]) => {
  const bytes = encodeCbor(body);
  return cat(bytes, signer.sign(cat(utf8('silicr/v1/heartbeat'), bytes)));
};

describe('heartbeats', () => {
  it('round-trip without and with a note', () => {
    expect(decodeHeartbeat(encodeHeartbeat(hb, signer), signer.publicKey)).toStrictEqual(hb);
    const noted = { ...hb, note: 'epoch 3/10, loss 0.412 \u{1f680}' };
    expect(decodeHeartbeat(encodeHeartbeat(noted, signer), signer.publicKey)).toStrictEqual(noted);
  });

  it('round-trip every status and the extreme values', () => {
    for (const status of ['starting', 'running', 'paused', 'finished', 'failed'] as const) {
      const extreme: Heartbeat = {
        ...hb,
        status,
        seq: Number.MAX_SAFE_INTEGER,
        ts: Number.MAX_SAFE_INTEGER,
        step: Number.MAX_SAFE_INTEGER,
        servingSeq: U32_MAX,
        checkpointDigest: new Uint8Array(32),
        note: 'é'.repeat(512), // exactly 1024 UTF-8 bytes
      };
      expect(decodeHeartbeat(encodeHeartbeat(extreme, signer), signer.publicKey)).toStrictEqual(extreme);
    }
  });

  it('are deterministic', () => {
    expect(encodeHeartbeat(hb, signer)).toEqual(encodeHeartbeat(hb, signer));
  });

  it('verify only under the provider key', () => {
    const bytes = encodeHeartbeat(hb, signer);
    expect(decodeHeartbeat(bytes, other.publicKey)).toBeNull();
    for (const key of [new Uint8Array(32), new Uint8Array(31), null, 'key']) {
      expect(decodeHeartbeat(bytes, key as Uint8Array)).toBeNull();
    }
  });

  it('detect tampering with any byte', () => {
    const bytes = encodeHeartbeat({ ...hb, note: 'n' }, signer);
    for (let i = 0; i < bytes.length; i++) {
      for (const mask of [0x01, 0xff]) {
        const t = bytes.slice();
        t[i] = t[i]! ^ mask;
        expect(decodeHeartbeat(t, signer.publicKey)).toBeNull();
      }
    }
  });

  it('reject truncated, extended and junk input', () => {
    const bytes = encodeHeartbeat(hb, signer);
    expect(decodeHeartbeat(bytes.subarray(0, bytes.length - 1), signer.publicKey)).toBeNull();
    expect(decodeHeartbeat(cat(bytes, Uint8Array.of(0)), signer.publicKey)).toBeNull();
    expect(decodeHeartbeat(new Uint8Array(), signer.publicKey)).toBeNull();
    expect(decodeHeartbeat(crypto.getRandomValues(new Uint8Array(200)), signer.publicKey)).toBeNull();
    for (const junk of [null, undefined, 'hb', 7, {}]) expect(decodeHeartbeat(junk as Uint8Array, signer.publicKey)).toBeNull();
  });

  it('bind the heartbeat domain into the signature', () => {
    const bytes = encodeHeartbeat(hb, signer);
    const { end } = decodeCbor(bytes);
    const body = bytes.subarray(0, end);
    expect(decodeHeartbeat(cat(body, signer.sign(body)), signer.publicKey)).toBeNull();
    expect(decodeHeartbeat(cat(body, signer.sign(cat(utf8('silicr/v1/memo'), body))), signer.publicKey)).toBeNull();
  });

  it('reject properly signed heartbeats with fields out of bounds', () => {
    const fields = decodeCbor(encodeHeartbeat(hb, signer)).value as CborValue[];
    expect(decodeHeartbeat(resign(fields), signer.publicKey)).toStrictEqual(hb); // control
    for (const bad of [
      fields.with(0, new Uint8Array(15)),
      fields.with(4, new Uint8Array(31)),
      fields.with(5, 5n),
      fields.with(5, 'running'),
      fields.with(6, 2n ** 32n),
      fields.with(2, 2n ** 53n),
      fields.with(7, 'x'.repeat(1025)),
      fields.slice(0, 7),
      [...fields, null],
    ]) {
      expect(decodeHeartbeat(resign(bad), signer.publicKey)).toBeNull();
    }
  });

  it.each<[string, Partial<Record<keyof Heartbeat, unknown>>]>([
    ['a 15-byte rfqId', { rfqId: new Uint8Array(15) }],
    ['a negative seq', { seq: -1 }],
    ['a fractional ts', { ts: 1.5 }],
    ['an unsafe step', { step: 2 ** 53 }],
    ['a 31-byte checkpointDigest', { checkpointDigest: new Uint8Array(31) }],
    ['an unknown status', { status: 'zombie' }],
    ['servingSeq past u32', { servingSeq: U32_MAX + 1 }],
    ['a note over 1024 bytes', { note: 'x'.repeat(1025) }],
    ['a note with a lone surrogate', { note: '\ud800' }],
    ['a non-string note', { note: 42 }],
  ])('refuse to encode %s', (_label, patch) => {
    expect(() => encodeHeartbeat({ ...hb, ...patch } as Heartbeat, signer)).toThrow(ProtocolError);
  });

  it('travel sealed on the channel', () => {
    const buyerEph = generateX25519();
    const providerEph = generateX25519();
    const provider = deriveChannel(providerEph.secretKey, buyerEph.publicKey, hb.rfqId);
    const buyer = deriveChannel(buyerEph.secretKey, providerEph.publicKey, hb.rfqId);
    const sealed = provider.seal('heartbeat', encodeHeartbeat(hb, signer));
    expect(decodeHeartbeat(buyer.open('heartbeat', sealed), signer.publicKey)).toStrictEqual(hb);
  });
});
