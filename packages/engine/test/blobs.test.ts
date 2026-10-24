import { describe, expect, it } from 'vitest';
import { deriveChannel, generateX25519, newRfqId, sha256 } from '@silicr/protocol';
import { decodeChunk, decodeLogBatch, encodeChunk, encodeLogBatch, readChunked, uploadChunked } from '../src/blobs.ts';
import { FakeRelay } from './helpers.ts';

function channelPair() {
  const a = generateX25519();
  const b = generateX25519();
  const rfqId = newRfqId();
  return { buyer: deriveChannel(a.secretKey, b.publicKey, rfqId), provider: deriveChannel(b.secretKey, a.publicKey, rfqId) };
}

const opts = (ms = 2000) => ({ waitS: 0.2, deadline: Date.now() + ms, live: () => true, idleMs: 10 });

describe('chunked blobs', () => {
  it('splits, seals, reassembles and verifies; the digest covers the sealed chunks', async () => {
    const relay = new FakeRelay();
    const { buyer, provider } = channelPair();
    const payload = new Uint8Array(1000).map((_, i) => i % 251);
    const up = await uploadChunked(relay, buyer, 'job', payload, sha256, 64);
    expect(up.parts).toBe(16);
    expect(relay.boxes.get(buyer.mailboxes.job)).toHaveLength(16);
    const got = (await readChunked(relay, provider, 'job', sha256, opts()))!;
    expect([...got.payload]).toEqual([...payload]);
    expect(Buffer.from(got.sealedDigest).toString('hex')).toBe(Buffer.from(up.sealedDigest).toString('hex'));
  });

  it('a single chunk digest is the SHA-256 of the sealed blob', async () => {
    const relay = new FakeRelay();
    const { buyer, provider } = channelPair();
    const up = await uploadChunked(relay, provider, 'result', new Uint8Array([1, 2, 3]), sha256);
    const stored = relay.boxes.get(provider.mailboxes.result)![0]!;
    expect(Buffer.from(up.sealedDigest).equals(Buffer.from(sha256(stored)))).toBe(true);
    expect((await readChunked(relay, buyer, 'result', sha256, opts()))!.parts).toBe(1);
  });

  it('survives duplicated PUTs and ignores chunks of another upload or another channel', async () => {
    const relay = new FakeRelay();
    const { buyer, provider } = channelPair();
    const other = channelPair();
    const payload = new TextEncoder().encode('x'.repeat(300));
    // junk sealed under another channel into the same mailbox, then a stray upload of other content
    await relay.append(buyer.mailboxes.job, other.buyer.seal('job', encodeChunk(0, 1, 3, sha256(new Uint8Array(3)), new Uint8Array(3))));
    const digest = sha256(payload);
    const total = 3;
    const parts = [0, 1, 2].map((i) => buyer.seal('job', encodeChunk(i, total, payload.length, digest, payload.subarray(i * 100, (i + 1) * 100))));
    await relay.append(buyer.mailboxes.job, parts[0]!);
    await relay.append(buyer.mailboxes.job, parts[0]!); // retried PUT
    await relay.append(buyer.mailboxes.job, parts[2]!); // out of order
    await relay.append(buyer.mailboxes.job, parts[1]!);
    const got = (await readChunked(relay, provider, 'job', sha256, opts()))!;
    expect(new TextDecoder().decode(got.payload)).toBe('x'.repeat(300));
  });

  it('rejects a reassembly whose digest does not match', async () => {
    const relay = new FakeRelay();
    const { buyer, provider } = channelPair();
    await relay.append(buyer.mailboxes.job, buyer.seal('job', encodeChunk(0, 1, 3, new Uint8Array(32), new Uint8Array([1, 2, 3]))));
    await expect(readChunked(relay, provider, 'job', sha256, opts())).rejects.toThrow(/digest/);
  });

  it('gives up at the deadline or when no longer live', async () => {
    const relay = new FakeRelay();
    const { provider } = channelPair();
    expect(await readChunked(relay, provider, 'job', sha256, opts(150))).toBeNull();
    expect(await readChunked(relay, provider, 'job', sha256, { ...opts(), live: () => false })).toBeNull();
  });

  it('rejects malformed chunk headers', () => {
    expect(decodeChunk(new Uint8Array(10))).toBeNull();
    expect(decodeChunk(encodeChunk(2, 2, 0, new Uint8Array(32), new Uint8Array()))).toBeNull(); // index >= total
    expect(decodeChunk(encodeChunk(0, 1, 0, new Uint8Array(32), new Uint8Array()))).not.toBeNull();
  });

  it('log batches carry a sequence number', () => {
    expect(decodeLogBatch(encodeLogBatch(7, ['a', 'b c']))).toEqual({ seq: 7, lines: ['a', 'b c'] });
    expect(decodeLogBatch(new Uint8Array(2))).toBeNull();
  });
});
