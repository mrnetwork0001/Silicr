// Metered delivery and job migration: the provider seals a checkpoint after every served interval,
// the buyer verifies and keeps the latest one, and `migrate` hands it to the next provider.
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { decodeCheckpointBlob, decodeJobBlob, encodeCheckpointBlob, encodeJobBlob, type JobManifest } from '../src/jobblob.ts';
import { ChunkAssembler, encodeChunk } from '../src/blobs.ts';
import { sha256 } from '@silicr/protocol';
import { hex } from '../src/util.ts';
import { makeWorld, unbundle, waitFor, type World } from './helpers.ts';

let world: World | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const SCRIPT = { steps: 100_000, stepMs: 20, checkpointEvery: 5 };

async function startRunning(w: World, providerIds?: string[]): Promise<string> {
  const { rfqId } = await w.buyer.createRfq({
    gpu: 'a100',
    count: 1,
    durationS: 120,
    maxPricePerHourZats: '72000000',
    job: { path: w.jobDir, command: ['python3', 'train.py'] },
    autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    ...(providerIds ? { providerIds } : {}),
  });
  await waitFor(() => w.buyer.getRfq(rfqId).state === 'running', 'running', 10_000);
  return rfqId;
}

describe('plaintext formats', () => {
  it('checkpoint blobs round-trip and reject other bytes', () => {
    const tar = new TextEncoder().encode('ckpt bytes');
    const d = sha256(tar);
    const ck = decodeCheckpointBlob(encodeCheckpointBlob(7, d, tar))!;
    expect(ck.seq).toBe(7);
    expect(ck.sha256).toEqual(d);
    expect(ck.tar).toEqual(tar);
    expect(decodeCheckpointBlob(new TextEncoder().encode('SJB1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'))).toBeNull();
    expect(() => encodeCheckpointBlob(-1, d, tar)).toThrow();
  });

  it('a job blob carries a checkpoint iff manifest.resumeFrom is set', () => {
    const bundle = new TextEncoder().encode('bundle');
    const ck = new TextEncoder().encode('checkpoint');
    const base: JobManifest = { v: 1, command: ['python3', 'train.py'], bundleSize: bundle.length, bundleSha256: hex(sha256(bundle)) };
    const plain = decodeJobBlob(encodeJobBlob(base, bundle));
    expect(plain.checkpoint).toBeUndefined();
    expect(plain.bundle).toEqual(bundle);
    const m: JobManifest = { ...base, resumeFrom: { seq: 3, sizeBytes: ck.length, sha256: hex(sha256(ck)) } };
    const got = decodeJobBlob(encodeJobBlob(m, bundle, ck));
    expect(got.bundle).toEqual(bundle);
    expect(got.checkpoint).toEqual(ck);
    expect(got.manifest.resumeFrom).toEqual(m.resumeFrom);
    expect(() => encodeJobBlob(base, bundle, ck)).toThrow();
    expect(() => encodeJobBlob(m, bundle)).toThrow();
    // trailing bytes without resumeFrom, or a short checkpoint, are refused
    const bad = encodeJobBlob(m, bundle, ck);
    expect(() => decodeJobBlob(bad.subarray(0, bad.length - 1))).toThrow(/checkpoint size/);
    expect(() => decodeJobBlob(new Uint8Array([...encodeJobBlob(base, bundle), 1]))).toThrow(/size mismatch/);
  });

  it('ChunkAssembler reassembles many payloads in turn and drops an abandoned upload', () => {
    const asm = new ChunkAssembler(sha256);
    const a = new Uint8Array(10).fill(1);
    const b = new Uint8Array(10).fill(2);
    const chunks = (p: Uint8Array) => [encodeChunk(0, 2, p.length, sha256(p), p.subarray(0, 5)), encodeChunk(1, 2, p.length, sha256(p), p.subarray(5))];
    const [a0, a1] = chunks(a);
    const [b0, b1] = chunks(b);
    expect(asm.push(a0!)).toBeNull();
    expect(asm.push(a0!)).toBeNull(); // duplicate
    expect(asm.push(a1!)).toEqual(a);
    expect(asm.push(b0!)).toBeNull();
    expect(asm.push(a0!)).toBeNull(); // a different upload abandons b's first chunk
    expect(asm.push(b0!)).toBeNull();
    expect(asm.push(b1!)).toEqual(b);
    const bogus = encodeChunk(0, 1, 3, sha256(a), new Uint8Array([9, 9, 9]));
    expect(() => asm.push(bogus)).toThrow(/digest/);
  });
});

describe('metered delivery', () => {
  it('a checkpoint arrives for every served interval, verified and kept on disk; the relay holds ciphertext only', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: SCRIPT }] }));
    const rfqId = await startRunning(w);
    await waitFor(() => (w.buyer.getRfq(rfqId).checkpoint?.seq ?? -1) >= 2, 'checkpoint for interval 2', 10_000, 20);
    const r = w.buyer.getRfq(rfqId);
    const rec = w.buyer.record(rfqId)!;
    expect(r.checkpoint!.digest).toMatch(/^[0-9a-f]{64}$/);
    // the file on disk is the latest checkpoint, and matches the digest
    const onDisk = await readFile(rec.checkpoint!.file);
    expect(hex(sha256(new Uint8Array(onDisk)))).toBe(r.checkpoint!.digest);
    expect(Object.keys(unbundle(new Uint8Array(onDisk))).some((f) => /^ckpt-\d+\.json$/.test(f))).toBe(true);
    // one leak observation per received checkpoint, all verified
    const seen = w.buyer.listLeaks({ rfqId }).filter((o) => o.event === 'checkpoint-received');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((o) => /sealed; digest verified/.test(o.summary))).toBe(true);
    expect(w.buyer.listLeaks({ rfqId }).some((o) => o.event === 'checkpoint-rejected')).toBe(false);
    // the provider reports what it uploaded; the two sides agree on the latest digest (eventually)
    await waitFor(() => w.providers[0]!.getJob(rfqId).checkpoint?.digest === w.buyer.getRfq(rfqId).checkpoint?.digest, 'digests agree', 5000, 20);
    // the relay stored sealed checkpoint chunks in the derived mailbox: no plaintext
    const rt = w.buyer.record(rfqId)!;
    expect(rt.checkpoint!.file).toContain(`checkpoints/${rfqId}`);
    expect(w.relay.containsUtf8('ckpt-')).toBe(false);
    expect(w.relay.containsUtf8('SCP1')).toBe(false);
    expect(w.relay.containsUtf8('"step"')).toBe(false);
    await w.buyer.stop(rfqId);
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 10_000);
  }, 30_000);

  it('a provider that stops heartbeating leaves the buyer with the last paid checkpoint', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: SCRIPT }] }));
    const rfqId = await startRunning(w);
    await waitFor(() => (w.buyer.getRfq(rfqId).checkpoint?.seq ?? -1) >= 1, 'a checkpoint', 10_000, 20);
    w.providers[0]!.fault(rfqId, 'stop_heartbeats');
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'buyer close', 8000, 20);
    const r = w.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('no_heartbeat');
    expect(r.result).toBeUndefined();
    expect(r.checkpoint).toBeDefined();
    const paidThrough = Math.max(...r.payments.map((p) => p.seq));
    expect(r.checkpoint!.seq).toBeLessThanOrEqual(paidThrough);
    const onDisk = await readFile(w.buyer.record(rfqId)!.checkpoint!.file);
    expect(hex(sha256(new Uint8Array(onDisk)))).toBe(r.checkpoint!.digest);
  }, 30_000);
});

describe('migration', () => {
  it('migrate moves the job to a second provider, which resumes from the checkpoint; the old RFQ is stopped', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: SCRIPT }, { name: 'p2', script: { ...SCRIPT, steps: 1 }, policy: { minPricePerHourZats: 40_000_000n } }] }));
    const [p1, p2] = w.providers as [typeof w.providers[0], typeof w.providers[0]];
    // p1 is cheaper, so it wins the first RFQ
    const rfqId = await startRunning(w);
    expect(w.buyer.getRfq(rfqId).accepted!.providerId).toBe(p1.providerId);
    await waitFor(() => (w.buyer.getRfq(rfqId).checkpoint?.seq ?? -1) >= 1, 'checkpoint', 10_000, 20);
    const ck = w.buyer.getRfq(rfqId).checkpoint!;
    const stepAtMigration = w.runners[0]!.handles[0]!.step;
    expect(stepAtMigration).toBeGreaterThanOrEqual(SCRIPT.checkpointEvery);

    // migrate: p2's script finishes a step after resuming, so the job ends quickly
    w.runners[1]!.script = { ...SCRIPT, steps: 100_000 };
    const nu = await w.buyer.migrate(rfqId);
    expect(nu.rfqId).not.toBe(rfqId);
    expect(nu.migratedFrom).toEqual({ rfqId, seq: ck.seq });
    expect(w.buyer.getRfq(rfqId).migratedTo).toBe(nu.rfqId);
    // the old RFQ was stopped by the buyer
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'old RFQ closed', 10_000, 20);
    expect(w.buyer.getRfq(rfqId).closeReason).toBe('buyer_stop');
    // by default the old provider is not asked again
    expect(w.buyer.record(nu.rfqId)!.asked.map((a) => a.providerId)).toEqual([p2.providerId]);
    await waitFor(() => w.buyer.getRfq(nu.rfqId).state === 'running', 'new RFQ running', 15_000, 20);
    expect(w.buyer.getRfq(nu.rfqId).accepted!.providerId).toBe(p2.providerId);
    // p2's runner was started with the checkpoint dir pre-populated and resumed from it
    const h2 = await waitFor(() => w.runners[1]!.handles[0], 'p2 handle', 5000);
    expect(h2.spec.checkpointDir).toBeDefined();
    await waitFor(() => h2.resumedFrom > 0, 'resumed', 5000, 20);
    expect(h2.resumedFrom).toBeGreaterThanOrEqual(SCRIPT.checkpointEvery);
    expect(h2.resumedFrom).toBeLessThanOrEqual(stepAtMigration);
    expect(p2.getJob(nu.rfqId).resumedFromSeq).toBe(ck.seq);
    expect(p2.listLeaks({ rfqId: nu.rfqId }).some((o) => o.event === 'job-resumed')).toBe(true);
    // the step count continues: the final metrics show the resumed step
    await w.buyer.stop(nu.rfqId);
    await waitFor(() => w.buyer.getRfq(nu.rfqId).state === 'closed' && !!w.buyer.getRfq(nu.rfqId).result, 'new RFQ result', 15_000, 20);
    const out = unbundle(await w.buyer.resultBytes(nu.rfqId));
    const metrics = JSON.parse(out['metrics.json']!) as { steps_completed: number; resumed_from_step: number };
    expect(metrics.resumed_from_step).toBe(h2.resumedFrom);
    expect(metrics.steps_completed).toBeGreaterThan(metrics.resumed_from_step);
    // nothing in the new RFQ names the old one, on the relay or in the directory
    expect(w.relay.containsUtf8(rfqId)).toBe(false);
    expect(JSON.stringify(await w.relay.listDirectory())).not.toContain(rfqId);
    // a second migration of the same RFQ is refused
    await expect(w.buyer.migrate(rfqId)).rejects.toThrow(/already migrated/);
  }, 60_000);

  it('migrate is refused before any checkpoint arrived, and with an explicit provider list it asks exactly those', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { ...SCRIPT, checkpointEvery: 0 } }, { name: 'p2', script: SCRIPT }] }));
    const rfqId = await startRunning(w, [w.providers[0]!.providerId]);
    await expect(w.buyer.migrate(rfqId)).rejects.toThrow(/no checkpoint/);
    await w.buyer.stop(rfqId);
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 10_000);
    // a provider whose runner checkpoints: migrate with an explicit list
    const rfq2 = await startRunning(w, [w.providers[1]!.providerId]);
    await waitFor(() => (w.buyer.getRfq(rfq2).checkpoint?.seq ?? -1) >= 1, 'checkpoint', 10_000, 20);
    const nu = await w.buyer.migrate(rfq2, { providerIds: [w.providers[1]!.providerId] });
    expect(w.buyer.record(nu.rfqId)!.asked.map((a) => a.providerId)).toEqual([w.providers[1]!.providerId]);
    await waitFor(() => w.buyer.getRfq(nu.rfqId).state === 'running', 'running again', 15_000, 20);
    await w.buyer.stop(nu.rfqId);
    await waitFor(() => w.buyer.getRfq(nu.rfqId).state === 'closed', 'closed', 15_000);
  }, 60_000);
});
