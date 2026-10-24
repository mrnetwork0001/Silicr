import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  ProtocolError,
  deriveRfqKeys,
  fromHex,
  generateSigner,
  generateX25519,
  newRfqId,
  sha256,
  signerFromSecret,
  toHex,
  x25519FromSecret,
} from '../src/index.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('hex and sha256', () => {
  it('round-trips hex in lowercase', () => {
    expect(toHex(Uint8Array.of(0, 1, 0xab, 0xff))).toBe('0001abff');
    expect(fromHex('0001abff')).toEqual(Uint8Array.of(0, 1, 0xab, 0xff));
    expect(fromHex('')).toEqual(new Uint8Array());
  });

  it('accepts uppercase hex', () => {
    expect(fromHex('DEADBEEF')).toEqual(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
  });

  it.each(['abc', '0x00', 'zz', ' 00', '00 ', '0g', '+1', '٠١'])('rejects %j', (s) => {
    expect(() => fromHex(s)).toThrow(ProtocolError);
  });

  it('rejects non-strings', () => {
    expect(() => fromHex(12 as unknown as string)).toThrow(ProtocolError);
  });

  it('hashes with SHA-256', () => {
    expect(toHex(sha256(new Uint8Array()))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('Ed25519 signers', () => {
  it('matches RFC 8032 test 1', () => {
    const signer = signerFromSecret(fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'));
    expect(toHex(signer.publicKey)).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    expect(toHex(signer.sign(new Uint8Array()))).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
  });

  it('copies the secret, so mutating the caller buffer changes nothing', () => {
    const secret = new Uint8Array(32).fill(7);
    const signer = signerFromSecret(secret);
    const before = signer.sign(utf8('m'));
    secret.fill(0);
    expect(signer.sign(utf8('m'))).toEqual(before);
  });

  it('does not expose the secret on the signer object', () => {
    const { signer, secret } = generateSigner();
    const exposed = Object.getOwnPropertyNames(signer).map((k) => (signer as unknown as Record<string, unknown>)[k]);
    expect(exposed.some((v) => v instanceof Uint8Array && toHex(v) === toHex(secret))).toBe(false);
    expect(Object.isFrozen(signer)).toBe(true);
  });

  it('generates independent keys whose secret rebuilds the signer', () => {
    const a = generateSigner();
    const b = generateSigner();
    expect(a.secret).toHaveLength(32);
    expect(a.signer.publicKey).toHaveLength(32);
    expect(signerFromSecret(a.secret).publicKey).toEqual(a.signer.publicKey);
    expect(a.signer.publicKey).not.toEqual(b.signer.publicKey);
    const msg = utf8('hello');
    expect(ed25519.verify(a.signer.sign(msg), msg, a.signer.publicKey)).toBe(true);
  });

  it.each([0, 31, 33, 64])('rejects a %i-byte secret', (n) => {
    expect(() => signerFromSecret(new Uint8Array(n))).toThrow(ProtocolError);
  });
});

describe('X25519 keys', () => {
  it('matches RFC 7748 §6.1', () => {
    const alice = x25519FromSecret(fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'));
    expect(toHex(alice.publicKey)).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  });

  it('generates consistent, independent pairs', () => {
    const a = generateX25519();
    const b = generateX25519();
    expect(a.secretKey).toHaveLength(32);
    expect(a.publicKey).toHaveLength(32);
    expect(x25519FromSecret(a.secretKey).publicKey).toEqual(a.publicKey);
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it('rejects a short secret', () => {
    expect(() => x25519FromSecret(new Uint8Array(16))).toThrow(ProtocolError);
  });
});

describe('RFQ ids and per-RFQ keys', () => {
  it('makes random 16-byte RFQ ids', () => {
    const a = newRfqId();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a).toHaveLength(16);
    expect(a).not.toEqual(newRfqId());
  });

  it('derives keys with HKDF-SHA256, salt = rfqId', () => {
    const seed = new Uint8Array(32).fill(1);
    const rfqId = new Uint8Array(16).fill(2);
    const keys = deriveRfqKeys(seed, rfqId);
    const signSecret = hkdf(nobleSha256, seed, rfqId, utf8('silicr/v1/rfq-sign'), 32);
    const ephSecret = hkdf(nobleSha256, seed, rfqId, utf8('silicr/v1/rfq-eph'), 32);
    expect(keys.signer.publicKey).toEqual(ed25519.getPublicKey(signSecret));
    expect(keys.eph.secretKey).toEqual(ephSecret);
    expect(keys.eph.publicKey).toEqual(x25519.getPublicKey(ephSecret));
  });

  it('is deterministic, so a restarted buyer can resume', () => {
    const seed = generateSigner().secret;
    const rfqId = newRfqId();
    const a = deriveRfqKeys(seed, rfqId);
    const b = deriveRfqKeys(seed, rfqId);
    expect(a.signer.publicKey).toEqual(b.signer.publicKey);
    expect(a.eph).toEqual(b.eph);
    expect(a.signer.sign(utf8('x'))).toEqual(b.signer.sign(utf8('x')));
  });

  it('gives unlinkable keys per RFQ and per seed', () => {
    const seed = generateSigner().secret;
    const base = deriveRfqKeys(seed, newRfqId());
    const otherRfq = deriveRfqKeys(seed, newRfqId());
    const otherSeed = deriveRfqKeys(generateSigner().secret, newRfqId());
    for (const other of [otherRfq, otherSeed]) {
      expect(other.signer.publicKey).not.toEqual(base.signer.publicKey);
      expect(other.eph.publicKey).not.toEqual(base.eph.publicKey);
    }
  });

  it('rejects malformed seeds and ids', () => {
    expect(() => deriveRfqKeys(new Uint8Array(31), newRfqId())).toThrow(ProtocolError);
    expect(() => deriveRfqKeys(new Uint8Array(32), new Uint8Array(15))).toThrow(ProtocolError);
  });
});
