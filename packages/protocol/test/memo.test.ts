import { ed25519 } from '@noble/curves/ed25519.js';
import { base64urlnopad } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { type CborInput, type CborValue, decodeCbor, encodeCbor } from '../src/cbor.ts';
import {
  type Accept,
  type Bid,
  type Close,
  MAX_FRAME_BYTES,
  type MemoMessage,
  type Pay,
  ProtocolError,
  type Rfq,
  type Signer,
  decodeMemo,
  deriveRfqKeys,
  encodeMemo,
  generateSigner,
  newRfqId,
  signerFromSecret,
} from '../src/index.ts';
import { UA_PATTERN } from '../src/fields.ts';
import { encodeFrame } from '../src/memo.ts';
import { U32_MAX, fakeUa, sampleMessages, worstCaseMessages } from './helpers.ts';

const transports = ['binary', 'text'] as const;
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: (Uint8Array | number[])[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const pad512 = (bytes: Uint8Array) => {
  const memo = new Uint8Array(512);
  memo.set(bytes);
  return memo;
};
const textMemo = (s: string) => pad512(utf8(s));

/** A binary memo around a hand-built frame, signed as the protocol specifies (or with a given raw signature). */
function craftMemo(code: number, body: Uint8Array, by: Signer | Uint8Array, version = 1): Uint8Array {
  const signed = cat(utf8('silicr/v1/memo'), [version, code], body);
  const sig = by instanceof Uint8Array ? by : by.sign(signed);
  return pad512(cat([0xff], utf8('SLC1'), [version, code], body, sig));
}

/** The positional CBOR body of a message, as decoded values. */
const bodyOf = (msg: MemoMessage, signer: Signer) =>
  decodeCbor(encodeMemo(msg, signer, 'binary'), 7).value as CborValue[];

const { signer } = generateSigner();
const other = generateSigner().signer;
const samples = sampleMessages(signer);
const [rfq, bid, accept, pay, close] = samples as [Rfq, Bid, Accept, Pay, Close];

describe('round trips', () => {
  for (const transport of transports) {
    for (const msg of samples) {
      const label = msg.t === 'CLOSE' ? `CLOSE (${msg.resultDigest ? 'with' : 'without'} resultDigest)` : msg.t;
      it(`${label} over ${transport}`, () => {
        const memo = encodeMemo(msg, signer, transport);
        expect(memo).toBeInstanceOf(Uint8Array);
        expect(memo).toHaveLength(512);
        const decoded = decodeMemo(memo);
        expect(decoded).not.toBeNull();
        expect(decoded!.transport).toBe(transport);
        expect(decoded!.msg).toStrictEqual(msg);
        expect(decoded!.verifiedBy(signer.publicKey)).toBe(true);
      });
    }
  }

  for (const transport of transports) {
    it(`RFQ with an undisclosed max (maxPricePerHourZats = 0) over ${transport}`, () => {
      const hidden: Rfq = { ...rfq, maxPricePerHourZats: 0n };
      const decoded = decodeMemo(encodeMemo(hidden, signer, transport));
      expect(decoded).not.toBeNull();
      expect(decoded!.msg).toStrictEqual(hidden);
      expect((decoded!.msg as Rfq).maxPricePerHourZats).toBe(0n);
      expect(decoded!.verifiedBy(signer.publicKey)).toBe(true);
    });
  }

  it('leaves an absent optional field absent, not undefined', () => {
    const decoded = decodeMemo(encodeMemo(close, signer, 'binary'))!;
    expect(Object.keys(decoded.msg)).toEqual(['t', 'rfqId', 'by', 'reason', 'finalSeq']);
  });

  it('carries the same frame in both transports', () => {
    for (const msg of samples) {
      const frame = encodeFrame(msg, signer);
      const binary = encodeMemo(msg, signer, 'binary');
      expect(binary[0]).toBe(0xff);
      expect(binary.subarray(1, 1 + frame.length)).toEqual(frame);
      expect(binary.subarray(1 + frame.length).every((b) => b === 0)).toBe(true);

      const text = encodeMemo(msg, signer, 'text');
      let len = 512;
      while (len > 0 && text[len - 1] === 0) len--;
      // A valid ZIP 302 text memo: first byte <= 0xF4, UTF-8 once trailing zeros are stripped.
      expect(text[0]).toBeLessThanOrEqual(0xf4);
      const str = new TextDecoder('utf-8', { fatal: true }).decode(text.subarray(0, len));
      expect(str).toMatch(/^slc1:[A-Za-z0-9_-]+$/);
      expect(base64urlnopad.decode(str.slice(5))).toEqual(frame);
    }
  });

  it('accepts a Node Buffer and keeps no reference to it', () => {
    const buf = Buffer.from(encodeMemo(rfq, signer, 'binary'));
    const decoded = decodeMemo(buf)!;
    expect(decoded.msg.rfqId.constructor).toBe(Uint8Array);
    buf.fill(0);
    expect(decoded.msg).toStrictEqual(rfq);
    expect(decoded.verifiedBy(signer.publicKey)).toBe(true);
  });

  it('reads a memo whose zero padding was trimmed off', () => {
    const frame = encodeFrame(pay, signer);
    const trimmed = encodeMemo(pay, signer, 'binary').subarray(0, 1 + frame.length);
    expect(decodeMemo(trimmed)?.msg).toStrictEqual(pay);
  });
});

describe('wire format', () => {
  it('matches a PAY frame built independently from the spec', () => {
    const secret = new Uint8Array(32).fill(5);
    const rfqId = Uint8Array.from({ length: 16 }, (_, i) => i);
    const body = cat([0x82, 0x50], rfqId, [0x18, 0x2a]); // [h'00..0f', 42]
    const sig = ed25519.sign(cat(utf8('silicr/v1/memo'), [1, 4], body), secret);
    const frame = cat(utf8('SLC1'), [1, 4], body, sig);
    const msg: Pay = { t: 'PAY', rfqId, seq: 42 };
    expect(encodeMemo(msg, signerFromSecret(secret), 'binary')).toEqual(pad512(cat([0xff], frame)));
    expect(encodeMemo(msg, signerFromSecret(secret), 'text')).toEqual(textMemo(`slc1:${base64urlnopad.encode(frame)}`));
  });

  it('lays bodies out as positional arrays with integer enum codes', () => {
    expect(bodyOf(rfq, signer)).toEqual([
      rfq.rfqId,
      'a100',
      4n,
      43_200n,
      80_000_000n,
      rfq.replyTo,
      rfq.buyerKey,
      rfq.buyerEph,
      3_100_000n,
    ]);
    expect(bodyOf(bid, signer)).toEqual([bid.rfqId, bid.providerId, 12_500_000n, 600n, 0n, bid.providerEph, bid.payTo]);
    expect(bodyOf(accept, signer)).toEqual([accept.rfqId, accept.providerId, 72n, 12_500_000n]);
    expect(bodyOf(pay, signer)).toEqual([pay.rfqId, 1n]);
    expect(bodyOf(close, signer)).toEqual([close.rfqId, 0n, 1n, 7n, null]);
    const done = samples[5] as Close;
    expect(bodyOf(done, signer)).toEqual([done.rfqId, 1n, 0n, 71n, done.resultDigest]);
  });

  it('uses type codes RFQ=1 BID=2 ACCEPT=3 PAY=4 CLOSE=5', () => {
    expect(samples.slice(0, 5).map((m) => encodeMemo(m, signer, 'binary')[6])).toEqual([1, 2, 3, 4, 5]);
  });

  it('is deterministic for the same message and key', () => {
    const keys = deriveRfqKeys(new Uint8Array(32).fill(9), new Uint8Array(16).fill(3));
    for (const msg of samples) {
      for (const transport of transports) {
        expect(encodeMemo(msg, signer, transport)).toEqual(encodeMemo(msg, signer, transport));
        expect(encodeMemo(msg, keys.signer, transport)).toEqual(encodeMemo(msg, keys.signer, transport));
        expect(encodeMemo(msg, other, transport)).not.toEqual(encodeMemo(msg, signer, transport));
      }
    }
  });
});

describe('verifiedBy', () => {
  it('is true for the signing key and false for any other', () => {
    for (const msg of samples) {
      for (const transport of transports) {
        const decoded = decodeMemo(encodeMemo(msg, signer, transport))!;
        expect(decoded.verifiedBy(signer.publicKey)).toBe(true);
        expect(decoded.verifiedBy(other.publicKey)).toBe(false);
      }
    }
  });

  it('returns false, never throws, for junk keys', () => {
    const decoded = decodeMemo(encodeMemo(rfq, signer, 'text'))!;
    const identity = cat([1], new Uint8Array(31));
    const junk: unknown[] = [
      new Uint8Array(0),
      new Uint8Array(31),
      signer.publicKey.subarray(0, 31),
      cat(signer.publicKey, [0]),
      new Uint8Array(32),
      identity,
      new Uint8Array(32).fill(0xff),
      null,
      undefined,
      'abc',
      Array.from(signer.publicKey),
    ];
    for (const key of junk) expect(decoded.verifiedBy(key as Uint8Array)).toBe(false);
  });

  it('rejects a weak (small-order) key whose forged signature fits every message', () => {
    // With A = R = identity and S = 0, [S]B = R + [k]A holds for any message.
    const identity = cat([1], new Uint8Array(31));
    const forgedSig = cat(identity, new Uint8Array(32));
    const body = encodeCbor(bodyOf({ ...bid, providerId: identity }, signer));
    const decoded = decodeMemo(craftMemo(2, body, forgedSig));
    expect(decoded).not.toBeNull();
    expect(decoded!.verifiedBy(identity)).toBe(false);
  });

  it('supports the buyer/provider flow with per-RFQ keys', () => {
    const buyer = deriveRfqKeys(generateSigner().secret, newRfqId());
    const provider = generateSigner().signer;
    const theRfq: Rfq = { ...rfq, buyerKey: buyer.signer.publicKey, buyerEph: buyer.eph.publicKey };
    const gotRfq = decodeMemo(encodeMemo(theRfq, buyer.signer, 'binary'))!;
    expect(gotRfq.msg.t === 'RFQ' && gotRfq.verifiedBy(gotRfq.msg.buyerKey)).toBe(true);

    const theBid: Bid = { ...bid, providerId: provider.publicKey };
    const gotBid = decodeMemo(encodeMemo(theBid, provider, 'text'))!;
    expect(gotBid.msg.t === 'BID' && gotBid.verifiedBy(gotBid.msg.providerId)).toBe(true);

    const theAccept: Accept = { ...accept, providerId: provider.publicKey };
    expect(decodeMemo(encodeMemo(theAccept, buyer.signer, 'binary'))!.verifiedBy(theRfq.buyerKey)).toBe(true);
    // An ACCEPT signed by anyone else (here, the provider itself) does not pass as the buyer's.
    expect(decodeMemo(encodeMemo(theAccept, provider, 'binary'))!.verifiedBy(theRfq.buyerKey)).toBe(false);
  });
});

describe('memos that are not Silicr v1', () => {
  const frame = encodeFrame(pay, signer);
  const emptyMemo = new Uint8Array(512);
  emptyMemo[0] = 0xf6;

  it.each<[string, Uint8Array]>([
    ['the empty memo (0xF6 + zeros)', emptyMemo],
    ['all zeros', new Uint8Array(512)],
    ['a normal text memo', textMemo('thanks for the coffee')],
    ['an emoji text memo', textMemo('gpu go brrr \u{1f525}')],
    ['the bare prefix', textMemo('slc1:')],
    ['the prefix and non-base64 text', textMemo('slc1:hello world')],
    ['the prefix and base64 of junk', textMemo(`slc1:${base64urlnopad.encode(utf8('not a frame at all'))}`)],
    ['an uppercase prefix', textMemo(`SLC1:${base64urlnopad.encode(frame)}`)],
    ['padded base64', textMemo(`slc1:${base64urlnopad.encode(frame)}==`)],
    ['standard (not url) base64', textMemo(`slc1:${Buffer.from(cat([0xfb, 0xff], frame)).toString('base64')}`)],
    ['binary data that is not Silicr', pad512(cat([0xff], utf8('some other app'), [1, 2, 3]))],
    ['a frame without the 0xFF marker', pad512(frame)],
    ['a frame behind 0xF5', pad512(cat([0xf5], frame))],
    ['a frame behind a reserved 0xF7 marker', pad512(cat([0xf7], frame))],
    ['a 513-byte buffer', cat(encodeMemo(pay, signer, 'binary'), [0])],
    ['an empty buffer', new Uint8Array(0)],
  ])('%s → null', (_label, memo) => {
    expect(decodeMemo(memo)).toBeNull();
  });

  it('returns null for inputs that are not Uint8Arrays, including hostile proxies', () => {
    const memo = encodeMemo(pay, signer, 'binary');
    const hostile = new Proxy(memo, {
      get() {
        throw new Error('boom');
      },
    });
    for (const junk of [null, undefined, 42, 'slc1:', {}, Array.from(memo), memo.buffer, new Uint16Array(512), hostile]) {
      expect(decodeMemo(junk as Uint8Array)).toBeNull();
    }
  });

  it('rejects unknown versions, type codes and magic even when properly signed', () => {
    const body = encodeCbor(bodyOf(pay, signer));
    expect(decodeMemo(craftMemo(4, body, signer))).not.toBeNull(); // control: the crafted memo is fine
    expect(decodeMemo(craftMemo(4, body, signer, 2))).toBeNull();
    expect(decodeMemo(craftMemo(4, body, signer, 0))).toBeNull();
    for (const code of [0, 6, 0xff]) expect(decodeMemo(craftMemo(code, body, signer))).toBeNull();
    const badMagic = craftMemo(4, body, signer);
    badMagic[4] = 0x32; // "SLC2"
    expect(decodeMemo(badMagic)).toBeNull();
  });

  it('rejects anything after the frame', () => {
    const binary = encodeMemo(pay, signer, 'binary');
    const end = 1 + encodeFrame(pay, signer).length;
    for (const at of [end, end + 1, 511]) {
      const m = binary.slice();
      m[at] = 1;
      expect(decodeMemo(m)).toBeNull();
    }
    const b64 = base64urlnopad.encode(frame);
    for (const tail of ['A', 'AA', 'AAAA', ' ', '\n', '\0A', '\0\0x']) {
      expect(decodeMemo(textMemo(`slc1:${b64}${tail}`))).toBeNull();
    }
  });

  it('rejects a text frame with its signature cut short', () => {
    const b64 = base64urlnopad.encode(frame.subarray(0, frame.length - 1));
    expect(decodeMemo(textMemo(`slc1:${b64}`))).toBeNull();
  });
});

describe('size budget', () => {
  const worst = worstCaseMessages();

  it('every worst-case message fits both transports', () => {
    const sizes = Object.fromEntries(worst.map((m) => [m.t, encodeFrame(m, signer).length]));
    // 113-char Orchard-only regtest UAs, 16-char GPU slugs, u64-max prices, u32-max counters.
    expect(sizes).toEqual({ RFQ: 309, BID: 290, ACCEPT: 136, PAY: 93, CLOSE: 129 });
    expect(MAX_FRAME_BYTES).toBe(380);
    for (const msg of worst) {
      for (const transport of transports) {
        const memo = encodeMemo(msg, signer, transport);
        expect(memo).toHaveLength(512);
        const decoded = decodeMemo(memo)!;
        expect(decoded.msg).toStrictEqual(msg);
        expect(decoded.verifiedBy(signer.publicKey)).toBe(true);
      }
    }
  });

  it('a 380-byte frame fills a text memo exactly', () => {
    const rfqMax = { ...worst[0], replyTo: fakeUa(184) } as Rfq;
    expect(encodeFrame(rfqMax, signer)).toHaveLength(380);
    const text = encodeMemo(rfqMax, signer, 'text');
    expect(text.includes(0)).toBe(false);
    expect(decodeMemo(text)?.msg).toStrictEqual(rfqMax);
    expect(decodeMemo(encodeMemo(rfqMax, signer, 'binary'))?.msg).toStrictEqual(rfqMax);
  });

  it('one byte over the budget throws a clear error in both transports', () => {
    const rfqOver = { ...worst[0], replyTo: fakeUa(185) } as Rfq;
    for (const transport of transports) {
      expect(() => encodeMemo(rfqOver, signer, transport)).toThrow(/RFQ frame would be 381 bytes.*380 bytes/);
    }
  });

  it('refuses oversized binary frames on decode too', () => {
    // A properly signed 443-byte frame: room enough in a binary memo, but over the shared budget.
    const longUa = fakeUa(247);
    expect(UA_PATTERN.test(longUa)).toBe(true);
    const body = encodeCbor(bodyOf(worst[0]!, signer).with(5, longUa));
    expect(6 + body.length + 64).toBe(443);
    expect(decodeMemo(craftMemo(1, body, signer))).toBeNull();
  });
});

describe('field bounds', () => {
  const as = <T>(v: unknown) => v as T;
  const encodeCases: [string, MemoMessage][] = [
    ['count 0', { ...rfq, count: 0 }],
    ['count 65', { ...rfq, count: 65 }],
    ['fractional count', { ...rfq, count: 1.5 }],
    ['uppercase gpu', { ...rfq, gpu: 'A100' }],
    ['17-char gpu', { ...rfq, gpu: 'a'.repeat(17) }],
    ['empty gpu', { ...rfq, gpu: '' }],
    ['gpu with a space', { ...rfq, gpu: 'a 100' }],
    ['15-byte rfqId', { ...rfq, rfqId: new Uint8Array(15) }],
    ['17-byte rfqId', { ...rfq, rfqId: new Uint8Array(17) }],
    ['31-byte buyerKey', { ...rfq, buyerKey: new Uint8Array(31) }],
    ['33-byte buyerEph', { ...rfq, buyerEph: new Uint8Array(33) }],
    ['hex-string buyerKey', { ...rfq, buyerKey: as<Uint8Array>('00'.repeat(32)) }],
    ['zero durationS', { ...rfq, durationS: 0 }],
    ['durationS past u32', { ...rfq, durationS: 2 ** 32 }],
    ['negative expiresHeight', { ...rfq, expiresHeight: -1 }],
    ['NaN expiresHeight', { ...rfq, expiresHeight: Number.NaN }],
    ['price as a number', { ...rfq, maxPricePerHourZats: as<bigint>(5) }],
    ['negative price', { ...rfq, maxPricePerHourZats: -1n }],
    ['price past u64', { ...rfq, maxPricePerHourZats: 2n ** 64n }],
    ['transparent replyTo', { ...rfq, replyTo: 'tmHqEMjvxe3ZRGYTWUZjHb6AoeUstpE7vEy' }],
    ['Sapling replyTo', { ...rfq, replyTo: `ztestsapling1${'q'.repeat(75)}` }],
    ['uppercase replyTo', { ...rfq, replyTo: fakeUa().toUpperCase() }],
    ['replyTo with a non-Bech32 char', { ...rfq, replyTo: `${fakeUa(112)}b` }],
    ['replyTo with a trailing newline', { ...rfq, replyTo: `${fakeUa()}\n` }],
    ['zero intervalS', { ...bid, intervalS: 0 }],
    ['negative startWithinS', { ...bid, startWithinS: -1 }],
    ['zero-length providerEph', { ...bid, providerEph: new Uint8Array() }],
    ['empty payTo', { ...bid, payTo: '' }],
    ['zero intervals', { ...accept, intervals: 0 }],
    ['ACCEPT price as a string', { ...accept, pricePerIntervalZats: as<bigint>('1') }],
    ['PAY seq 0 (interval 0 rides on ACCEPT)', { ...pay, seq: 0 }],
    ['PAY seq past u32', { ...pay, seq: U32_MAX + 1 }],
    ['unknown close reason', { ...close, reason: as<Close['reason']>('bored') }],
    ['inherited-property close reason', { ...close, reason: as<Close['reason']>('toString') }],
    ['unknown closer', { ...close, by: as<Close['by']>('relay') }],
    ['31-byte resultDigest', { ...close, resultDigest: new Uint8Array(31) }],
    ['unknown type', as<MemoMessage>({ ...pay, t: 'PING' })],
    ['missing field', as<MemoMessage>({ t: 'PAY', rfqId: pay.rfqId })],
  ];

  it.each(encodeCases)('encode rejects %s', (_label, msg) => {
    for (const transport of transports) expect(() => encodeMemo(msg, signer, transport)).toThrow(ProtocolError);
  });

  it('rejects non-messages and unknown transports', () => {
    for (const junk of [null, undefined, 'PAY', {}]) {
      expect(() => encodeMemo(junk as MemoMessage, signer, 'binary')).toThrow(ProtocolError);
    }
    expect(() => encodeMemo(pay, signer, 'hex' as 'binary')).toThrow(ProtocolError);
  });

  it('names the field in errors but never echoes its value', () => {
    const address = 'tmHqEMjvxe3ZRGYTWUZjHb6AoeUstpE7vEy';
    let message = '';
    try {
      encodeMemo({ ...rfq, replyTo: address }, signer, 'text');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('RFQ.replyTo');
    expect(message).not.toContain(address);
    expect(() => encodeMemo({ ...rfq, count: 999 }, signer, 'text')).toThrow(/^RFQ\.count must be an integer in 1\.\.64 \(got a number\)$/);
  });

  // Properly signed frames whose bodies break a bound: decode must still refuse them.
  const r = bodyOf(rfq, signer);
  const b = bodyOf(bid, signer);
  const a = bodyOf(accept, signer);
  const p = bodyOf(pay, signer);
  const c = bodyOf(samples[5] as Close, signer);
  const decodeCases: [string, number, Uint8Array][] = [
    ['RFQ count 0', 1, encodeCbor(r.with(2, 0n))],
    ['RFQ count 65', 1, encodeCbor(r.with(2, 65n))],
    ['RFQ uppercase gpu', 1, encodeCbor(r.with(1, 'A100'))],
    ['RFQ 17-char gpu', 1, encodeCbor(r.with(1, 'a'.repeat(17)))],
    ['RFQ 15-byte rfqId', 1, encodeCbor(r.with(0, new Uint8Array(15)))],
    ['RFQ 31-byte buyerKey', 1, encodeCbor(r.with(6, new Uint8Array(31)))],
    ['RFQ zero durationS', 1, encodeCbor(r.with(3, 0n))],
    ['RFQ expiresHeight past u32', 1, encodeCbor(r.with(8, 2n ** 32n))],
    ['RFQ transparent replyTo', 1, encodeCbor(r.with(5, 'tmHqEMjvxe3ZRGYTWUZjHb6AoeUstpE7vEy'))],
    ['RFQ price as text', 1, encodeCbor(r.with(4, '80000000'))],
    ['RFQ count as bool', 1, encodeCbor(r.with(2, true))],
    ['RFQ with 8 fields', 1, encodeCbor(r.slice(0, 8) as CborInput[])],
    ['RFQ with 10 fields', 1, encodeCbor([...r, 0n] as CborInput[])],
    ['RFQ nested in an array', 1, encodeCbor([r] as CborInput)],
    ['RFQ body that is a map', 1, Uint8Array.of(0xa1, 0x00, 0x00)],
    ['RFQ body that is a number', 1, Uint8Array.of(0x01)],
    ['RFQ body that is null', 1, Uint8Array.of(0xf6)],
    ['BID zero intervalS', 2, encodeCbor(b.with(3, 0n))],
    ['BID 33-byte providerEph', 2, encodeCbor(b.with(5, new Uint8Array(33)))],
    ['ACCEPT zero intervals', 3, encodeCbor(a.with(2, 0n))],
    ['PAY seq 0', 4, encodeCbor(p.with(1, 0n))],
    ['PAY seq past u32', 4, encodeCbor(p.with(1, 2n ** 32n))],
    ['PAY body under the RFQ type code', 1, encodeCbor(p)],
    ['RFQ body under the PAY type code', 4, encodeCbor(r)],
    ['CLOSE unknown closer code', 5, encodeCbor(c.with(1, 2n))],
    ['CLOSE unknown reason code', 5, encodeCbor(c.with(2, 6n))],
    ['CLOSE reason as text', 5, encodeCbor(c.with(2, 'done'))],
    ['CLOSE 31-byte resultDigest', 5, encodeCbor(c.with(4, new Uint8Array(31)))],
    ['CLOSE resultDigest false', 5, encodeCbor(c.with(4, false))],
  ];

  it('the crafted frames are valid before the edits', () => {
    for (const [code, body] of [[1, r], [2, b], [3, a], [4, p], [5, c]] as const) {
      const decoded = decodeMemo(craftMemo(code, encodeCbor(body as CborInput[]), signer));
      expect(decoded?.verifiedBy(signer.publicKey)).toBe(true);
    }
  });

  it.each(decodeCases)('decode rejects %s', (_label, code, body) => {
    expect(decodeMemo(craftMemo(code, body, signer))).toBeNull();
  });
});
