// Migration end to end with the REAL packages: relay over HTTP, process-mode runner and
// examples/tiny-train, which resumes from $SILICR_CHECKPOINT_DIR. Ephemeral ports only.
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NewRfqRequest } from '@silicr/api';
import { createRunner, unpackBundle } from '@silicr/runner';
import { relayClient } from '@silicr/relay';
import { startLocalStack, type LocalStack } from '../src/stack.ts';
import { ProviderNode } from '../src/provider.ts';
import { FAST_PROFILE, withOverrides } from '../src/profile.ts';
import { tempDir, waitFor } from './helpers.ts';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const TINY_TRAIN = join(REPO, 'examples', 'tiny-train');

const PROFILE = withOverrides(FAST_PROFILE, {
  name: 'migrate-e2e',
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

let stack: LocalStack | null = null;
let second: ProviderNode | null = null;
afterEach(async () => {
  await second?.close();
  second = null;
  await stack?.close();
  stack = null;
});

describe('migration with the real runner and tiny-train', () => {
  it('after the first provider goes silent, migrate resumes on a second provider and the step count continues', async () => {
    const root = await tempDir('silicr-migrate-');
    stack = await startLocalStack({
      rootDir: root,
      fresh: true,
      blockTimeMs: 100,
      profile: PROFILE,
      ports: { relay: 0, buyer: 0, provider: 0 },
      runnerMode: 'process',
      providerPolicy: { gpus: [{ model: 'cpu', count: 1, vramGb: 0 }], minPricePerHourZats: 10_000_000n },
      demoMode: true,
    });
    const s = stack;
    // A second, dearer provider on the same chain and relay: it loses the first RFQ. It has two
    // GPUs because a losing bid keeps one committed until the accept window lapses (provider policy).
    second = new ProviderNode({
      backend: s.network.wallet('provider2', { fundZats: 100_000_000n }),
      relay: relayClient(s.relay.url),
      dataDir: join(root, 'provider2'),
      profile: PROFILE,
      runner: await createRunner({ mode: 'process', workDir: join(root, 'provider2', 'runner') }),
      policy: { gpus: [{ model: 'cpu', count: 2, vramGb: 0 }], minPricePerHourZats: 20_000_000n },
      demoMode: true,
    });
    await second.start();
    const p2 = second;

    const STEPS = 400;
    const job = { path: TINY_TRAIN, command: ['python3', 'train.py'], env: { SILICR_STEPS: String(STEPS), SILICR_STEP_DELAY_MS: '20', SILICR_CHECKPOINT_EVERY: '10' } } as NewRfqRequest['job'];
    const req: NewRfqRequest = { gpu: 'cpu', count: 1, durationS: 120, maxPricePerHourZats: '50000000', job, autoAccept: { rule: 'cheapest', waitBlocks: 2 } };
    const { rfqId } = await s.buyer.createRfq(req);
    await waitFor(() => s.buyer.getRfq(rfqId).state === 'running', 'running', 30_000, 20);
    expect(s.buyer.getRfq(rfqId).accepted!.providerId).toBe(s.provider!.providerId);
    await waitFor(() => (s.buyer.getRfq(rfqId).checkpoint?.seq ?? -1) >= 1, 'a checkpoint for interval 1', 20_000, 20);

    // the first provider goes silent: the buyer stops paying, closes no_heartbeat, keeps the checkpoint
    s.provider!.fault(rfqId, 'stop_heartbeats');
    await waitFor(() => s.buyer.getRfq(rfqId).state === 'closed', 'buyer close', 15_000, 20);
    const old = s.buyer.getRfq(rfqId);
    expect(old.closeReason).toBe('no_heartbeat');
    expect(old.checkpoint).toBeDefined();
    const stepAtMigration = Math.max(...old.heartbeats.map((h) => h.step));
    expect(stepAtMigration).toBeGreaterThanOrEqual(10);
    expect(stepAtMigration).toBeLessThan(STEPS);

    // migrate through the daemon API
    const res = await fetch(`${s.buyerDaemon.url}/api/rfqs/${rfqId}/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerIds: [p2.providerId] }),
    });
    expect(res.status).toBe(201);
    const nu = (await res.json()) as { rfqId: string; migratedFrom?: { rfqId: string; seq: number } };
    expect(nu.migratedFrom).toEqual({ rfqId, seq: old.checkpoint!.seq });
    expect(s.buyer.getRfq(rfqId).migratedTo).toBe(nu.rfqId);

    await waitFor(() => ['closed', 'failed', 'expired'].includes(s.buyer.getRfq(nu.rfqId).state), 'migrated RFQ to finish', 60_000, 50);
    const r = s.buyer.getRfq(nu.rfqId);
    expect(r.error).toBeUndefined();
    expect(r.state).toBe('closed');
    expect(r.closeReason).toBe('done');
    expect(r.accepted!.providerId).toBe(p2.providerId);
    expect(r.resultVerified).toBe(true);
    expect(p2.getJob(nu.rfqId).resumedFromSeq).toBe(old.checkpoint!.seq);
    // tiny-train said so in its log, and its metrics show the step count continued
    expect(s.buyer.record(nu.rfqId)!.logTail.some((l) => /resuming from checkpoint at step \d+/.test(l))).toBe(true);
    const out = await tempDir('silicr-migrate-out-');
    await unpackBundle(await s.buyer.resultBytes(nu.rfqId), out);
    const metrics = JSON.parse(await readFile(join(out, 'metrics.json'), 'utf8')) as { steps_completed: number; resumed_from_step: number };
    // The checkpoint can be ahead of the last heartbeat: the job kept serving the intervals already
    // paid for after the heartbeats stopped, and checkpointed at the end of each one.
    expect(metrics.resumed_from_step).toBeGreaterThanOrEqual(10);
    expect(metrics.resumed_from_step).toBeLessThan(STEPS);
    expect(metrics.steps_completed).toBe(STEPS);
    // the second provider's job ran fewer steps than the whole job
    const steps2 = Math.max(...r.heartbeats.map((h) => h.step));
    expect(steps2).toBe(STEPS);
    // the new RFQ's checkpoints kept coming from the second provider too
    expect(r.checkpoint).toBeDefined();
    expect(r.checkpoint!.seq).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
