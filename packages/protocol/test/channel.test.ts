import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  BLOB_KINDS,
  type BlobKind,
  type Channel,
  ProtocolError,
  deriveChannel,
  fromHex,
  generateX25519,
  newRfqId,
  toHex,
} from '../src/index.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);

function pair(rfqId = newRfqId()) {
  const buyerEph = generateX25519();
  const providerEph = generateX25519();
  return {
    rfqId,
    buyerEph,
    providerEph,
    buyer: deriveChannel(buyerEph.secretKey, providerEph.publicKey, rfqId),
    provider: deriveChannel(providerEph.secretKey, buyerEph.publicKey, rfqId),
  };
}

describe('deriveChannel', () => {
  it('gives both sides the same key and mailboxes', () => {
    const { buyer, provider } = pair();
    expect(buyer.key).toHaveLength(32);
    expect(buyer.key).toEqual(provider.key);
    expect(buyer.mailboxes).toEqual(provider.mailboxes);
  });

  it('derives the key and mailboxes as specified', () => {
    const { buyer, buyerEph, providerEph, rfqId } = pair();
    const shared = x25519.getSharedSecret(buyerEph.secretKey, providerEph.publicKey);
    expect(buyer.key).toEqual(hkdf(sha256, shared, rfqId, utf8('silicr/v1/channel-key'), 32));
    for (const kind of BLOB_KINDS) {
      expect(buyer.mailboxes[kind]).toBe(toHex(hkdf(sha256, shared, rfqId, utf8(`silicr/v1/mailbox/${kind}`), 16)));
    }
  });

  it('has one distinct 32-hex-char mailbox per blob kind', () => {
    const { buyer } = pair();
    expect(Object.keys(buyer.mailboxes).sort()).toEqual(['checkpoint', 'control', 'heartbeat', 'job', 'log', 'result']);
    for (const id of Object.values(buyer.mailboxes)) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(Object.values(buyer.mailboxes)).size).toBe(6);
    expect(Object.isFrozen(buyer.mailboxes)).toBe(true);
  });

  it('seals on one side and opens on the other, for every kind and size', () => {
    const { buyer, provider } = pair();
    const big = crypto.getRandomValues(new Uint8Array(65536));
    for (const kind of BLOB_KINDS) {
      for (const plaintext of [new Uint8Array(), utf8(`a ${kind} blob`), big]) {
        const sealed = buyer.seal(kind, plaintext);
        expect(sealed).toHaveLength(24 + plaintext.length + 16);
        expect(provider.open(kind, sealed)).toEqual(plaintext);
        expect(buyer.open(kind, provider.seal(kind, plaintext))).toEqual(plaintext);
      }
    }
  });

  it('uses a fresh random nonce for every seal', () => {
    const { buyer } = pair();
    const a = buyer.seal('job', utf8('same'));
    const b = buyer.seal('job', utf8('same'));
    expect(a.subarray(0, 24)).not.toEqual(b.subarray(0, 24));
    expect(a).not.toEqual(b);
  });

  it('refuses to open a blob under the wrong kind', () => {
    const { buyer, provider } = pair();
    for (const sealedAs of BLOB_KINDS) {
      const sealed = buyer.seal(sealedAs, utf8('payload'));
      for (const openAs of BLOB_KINDS) {
        if (openAs === sealedAs) continue;
        expect(() => provider.open(openAs, sealed)).toThrow(ProtocolError);
      }
    }
  });

  it('detects tampering with any byte, truncation and extension', () => {
    const { buyer, provider } = pair();
    const sealed = buyer.seal('result', utf8('the weights'));
    for (let i = 0; i < sealed.length; i++) {
      for (const mask of [0x01, 0x80]) {
        const t = sealed.slice();
        t[i] = t[i]! ^ mask;
        expect(() => provider.open('result', t)).toThrow(ProtocolError);
      }
    }
    expect(() => provider.open('result', sealed.subarray(0, sealed.length - 1))).toThrow(ProtocolError);
    expect(() => provider.open('result', new Uint8Array([...sealed, 0]))).toThrow(ProtocolError);
    expect(() => provider.open('result', new Uint8Array(39))).toThrow(ProtocolError);
    expect(() => provider.open('result', 'nope' as unknown as Uint8Array)).toThrow(ProtocolError);
  });

  it('separates RFQs: another rfqId gives another key and mailboxes', () => {
    const { buyerEph, providerEph, buyer } = pair();
    const other = deriveChannel(providerEph.secretKey, buyerEph.publicKey, newRfqId());
    expect(other.key).not.toEqual(buyer.key);
    for (const kind of BLOB_KINDS) {
      expect(other.mailboxes[kind]).not.toBe(buyer.mailboxes[kind]);
      expect(() => other.open(kind, buyer.seal(kind, utf8('x')))).toThrow(ProtocolError);
    }
  });

  it('separates peers: a third key cannot open the channel', () => {
    const { buyer, buyerEph, rfqId } = pair();
    const eve = deriveChannel(generateX25519().secretKey, buyerEph.publicKey, rfqId);
    expect(eve.key).not.toEqual(buyer.key);
    expect(() => eve.open('job', buyer.seal('job', utf8('x')))).toThrow(ProtocolError);
  });

  it.each([
    ['zero', '0000000000000000000000000000000000000000000000000000000000000000'],
    ['zero with the top bit set', '0000000000000000000000000000000000000000000000000000000000000080'],
    ['one', '0100000000000000000000000000000000000000000000000000000000000000'],
    ['an order-8 point', 'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800'],
    ['the other order-8 point', '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157'],
    ['p - 1', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
    ['p', 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
    ['p + 1', 'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
  ])('rejects the low-order public key %s', (_label, hex) => {
    expect(() => deriveChannel(generateX25519().secretKey, fromHex(hex), newRfqId())).toThrow(ProtocolError);
  });

  it('rejects malformed inputs', () => {
    const k = generateX25519();
    expect(() => deriveChannel(k.secretKey.subarray(0, 31), k.publicKey, newRfqId())).toThrow(ProtocolError);
    expect(() => deriveChannel(k.secretKey, new Uint8Array(33), newRfqId())).toThrow(ProtocolError);
    expect(() => deriveChannel(k.secretKey, k.publicKey, new Uint8Array(32))).toThrow(ProtocolError);
  });

  it('rejects unknown blob kinds at runtime', () => {
    const { buyer } = pair();
    for (const kind of ['jobs', 'toString', '', undefined]) {
      expect(() => buyer.seal(kind as BlobKind, utf8('x'))).toThrow(ProtocolError);
      expect(() => buyer.open(kind as BlobKind, new Uint8Array(64))).toThrow(ProtocolError);
    }
  });

  it('exposes a copy of the key, so mutating it changes nothing', () => {
    const { buyer, provider }: { buyer: Channel; provider: Channel } = pair();
    buyer.key.fill(0);
    expect(provider.open('log', buyer.seal('log', utf8('still fine')))).toEqual(utf8('still fine'));
  });
});
