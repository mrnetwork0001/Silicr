// End to end with every REAL package: memory chain, relay (HTTP, observer on), protocol,
// process-mode runner and the examples/tiny-train job. Ephemeral ports only.
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NewRfqRequest, RelayObserverResponse } from '@silicr/api';
import { unpackBundle } from '@silicr/runner';
import { relayClient } from '@silicr/relay';
import { startLocalStack, type LocalStack } from '../src/stack.ts';
import { FAST_PROFILE, withOverrides } from '../src/profile.ts';
import { formatZec } from '../src/zats.ts';
import { tempDir, waitFor } from './helpers.ts';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const TINY_TRAIN = join(REPO, 'examples', 'tiny-train');

const E2E_PROFILE = withOverrides(FAST_PROFILE, {
  name: 'e2e',
  blockTimeS: 0.1,
  pollMs: 50,
  bidWindowBlocks: 50,
  intervalS: 1,
  heartbeatS: 0.2,
  heartbeatTimeoutS: 3,
  graceS: 2,
  startWithinS: 20,
  relayWaitS: 1,
  closeWaitS: 15,
  jobFetchTimeoutS: 15,
});

// Distinctive amounts, so a substring search for them can't hit a size or a timestamp.
const MIN_PER_HOUR = 17_555_554_800n; // → exactly 4_876_543 zats per 1 s interval
const PER_INTERVAL = '4876543';
const MAX_PER_HOUR = '19876543210';

let stack: LocalStack | null = null;
afterEach(async () => {
  await stack?.close();
  stack = null;
});

async function start(): Promise<LocalStack> {
  const root = await tempDir('silicr-e2e-');
  stack = await startLocalStack({
    rootDir: root,
    fresh: true,
    blockTimeMs: 100,
    profile: E2E_PROFILE,
    ports: { relay: 0, buyer: 0, provider: 0 },
    runnerMode: 'process',
    providerPolicy: { gpus: [{ model: 'cpu', count: 1, vramGb: 0 }], minPricePerHourZats: MIN_PER_HOUR },
    demoMode: true,
  });
  return stack;
}

function request(env: Record<string, string>, durationS = 120): NewRfqRequest {
  const job = { path: TINY_TRAIN, command: ['python3', 'train.py'], env } as NewRfqRequest['job'];
  return { gpu: 'cpu', count: 1, durationS, maxPricePerHourZats: MAX_PER_HOUR, job, autoAccept: { rule: 'cheapest', waitBlocks: 2 } };
}

describe('end to end on the memory network with the real packages', () => {
  it('runs tiny-train: padded RFQ, verified bid, metered PAYs, heartbeats, verified result, CLOSE; the relay learns nothing', async () => {
    const s = await start();
    const res = await fetch(`${s.buyerDaemon.url}/api/rfqs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request({ SILICR_STEPS: '120', SILICR_STEP_DELAY_MS: '25' })),
    });
    expect(res.status).toBe(201);
    const { rfqId } = (await res.json()) as { rfqId: string };
    await waitFor(() => ['closed', 'failed', 'expired'].includes(s.buyer.getRfq(rfqId).state), 'RFQ to finish', 60_000, 50);
    const r = s.buyer.getRfq(rfqId);
    expect(r.error).toBeUndefined();
    expect(r.state).toBe('closed');

    // the RFQ went out as one transaction padded to the 4-output bucket
    expect(r.providersAsked).toBe(1);
    expect(r.paddedOutputs).toBe(4);
    expect(r.rfqTxids).toHaveLength(1);
    const rfqTx = s.network.explorer().find((v) => v.txid === r.rfqTxid)!;
    expect((rfqTx.ironwood ?? rfqTx.orchard).actions).toBe(5); // 4 outputs + change, whatever the provider count ≤ 4
    expect(rfqTx.transparent).toEqual({ inputs: 0, outputs: 0 });

    // verified bid, accept, at least two metered PAYs, heartbeats, verified result, CLOSE both ways
    expect(r.bids).toHaveLength(1);
    expect(r.bids[0]!.signatureValid).toBe(true);
    expect(r.bids[0]!.providerId).toBe(s.provider!.providerId);
    expect(r.accepted!.pricePerIntervalZats).toBe(PER_INTERVAL);
    expect(r.payments[0]!.kind).toBe('accept');
    expect(r.payments.filter((p) => p.kind === 'pay').length).toBeGreaterThanOrEqual(2);
    expect(r.heartbeats.length).toBeGreaterThan(0);
    expect(r.heartbeats.some((h) => h.step > 0)).toBe(true);
    expect(r.heartbeats[0]!.status).toBe('finished');
    expect(r.closeReason).toBe('done');
    expect(r.resultVerified).toBe(true);
    const job = s.provider!.getJob(rfqId);
    expect(job.state).toBe('done');
    expect(job.resultDigest).toBe(r.result!.digest);
    expect(job.earnedZats).toBe(r.spentZats);
    expect(r.logTail.some((l) => /loss/.test(l))).toBe(true);

    // the result is tiny-train's real output
    const out = await tempDir('silicr-e2e-out-');
    await unpackBundle(await s.buyer.resultBytes(rfqId), out);
    const metrics = JSON.parse(await readFile(join(out, 'metrics.json'), 'utf8')) as Record<string, unknown>;
    expect(metrics).toBeTruthy();
    expect((await readFile(join(out, 'sample.txt'), 'utf8')).length).toBeGreaterThan(0);

    // the relay operator's view (observer feed) holds no command, rfqId, price or address
    const obs = (await (await fetch(`${s.relay.url}/_observer`)).json()) as RelayObserverResponse;
    expect(obs.observations.length).toBeGreaterThan(5);
    expect(obs.observations.some((o) => o.event === 'blob-stored')).toBe(true);
    const feed = JSON.stringify(obs);
    const rec = s.buyer.record(rfqId)!;
    const forbidden = [
      'train.py',
      'python3',
      rfqId,
      PER_INTERVAL,
      MAX_PER_HOUR,
      MIN_PER_HOUR.toString(),
      formatZec(BigInt(PER_INTERVAL)),
      formatZec(BigInt(MAX_PER_HOUR)),
      rec.replyTo,
      rec.accepted!.payTo,
      await s.provider!.address(),
      await s.buyer.address(),
    ];
    for (const f of forbidden) expect(feed, `observer feed leaks ${f}`).not.toContain(f);

    // nothing about the buyer reaches the directory
    const dir = await relayClient(s.relay.url).listDirectory();
    expect(dir).toHaveLength(1);
    const dirJson = JSON.stringify(dir);
    for (const f of [rec.replyTo, await s.buyer.address(), rfqId]) expect(dirJson).not.toContain(f);
  }, 90_000);

  it('real runner: buyer stops paying → job paused (SIGSTOP), then stopped with CLOSE(unpaid) within grace', async () => {
    const s = await start();
    const { rfqId } = await s.buyer.createRfq(request({ SILICR_STEPS: '100000', SILICR_STEP_DELAY_MS: '20' }));
    await waitFor(() => s.buyer.getRfq(rfqId).payments.some((p) => p.seq === 1), 'PAY 1', 30_000, 20);
    s.buyer.fault(rfqId, 'stop_paying');
    await waitFor(() => s.provider!.getJob(rfqId).state === 'paused', 'pause', 10_000, 10);
    const pausedAt = Date.now();
    const stepAtPause = s.buyer.getRfq(rfqId).heartbeats[0]?.step ?? 0;
    await waitFor(() => s.provider!.getJob(rfqId).state === 'stopped', 'stop', 10_000, 10);
    expect(Date.now() - pausedAt).toBeLessThan(E2E_PROFILE.graceS * 1000 + 1500);
    const job = s.provider!.getJob(rfqId);
    expect(job.stopReason).toBe('unpaid');
    expect(job.servingSeq).toBe(Math.max(...job.paymentsReceived.map((p) => p.seq)));
    await waitFor(() => s.buyer.getRfq(rfqId).state === 'closed', 'buyer close', 10_000);
    const r = s.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('unpaid');
    // no progress was made while unpaid (the job was frozen)
    const paused = r.heartbeats.filter((h) => h.status === 'paused');
    expect(paused.length).toBeGreaterThan(0);
    for (const h of paused) expect(h.step).toBeLessThanOrEqual(stepAtPause + 60);
  }, 60_000);

  it('real relay: provider stops heartbeating → buyer stops paying and closes no_heartbeat', async () => {
    const s = await start();
    const { rfqId } = await s.buyer.createRfq(request({ SILICR_STEPS: '100000', SILICR_STEP_DELAY_MS: '20' }));
    await waitFor(() => s.buyer.getRfq(rfqId).state === 'running', 'running', 30_000, 20);
    s.provider!.fault(rfqId, 'stop_heartbeats');
    await waitFor(() => s.buyer.getRfq(rfqId).state === 'closed', 'buyer close', 15_000, 20);
    const r = s.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('no_heartbeat');
    const paid = r.payments.length;
    await waitFor(() => s.provider!.getJob(rfqId).state === 'stopped', 'provider stop', 10_000);
    expect(s.provider!.getJob(rfqId).stopReason).toBe('no_heartbeat');
    await new Promise((res) => setTimeout(res, 1500));
    expect(s.buyer.getRfq(rfqId).payments.length).toBe(paid);
  }, 60_000);
});
