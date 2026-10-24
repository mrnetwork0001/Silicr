// Restarts: the buyer resumes a running job from its data dir; a provider shutting down closes its jobs.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BuyerNode } from '../src/buyer.ts';
import { fakeBundles, makeWorld, TEST_PROFILE, waitFor, type World } from './helpers.ts';

let world: World | null = null;
let extra: BuyerNode | null = null;
afterEach(async () => {
  await extra?.close();
  extra = null;
  await world?.close();
  world = null;
});

const job = (w: World) => ({ path: w.jobDir, command: ['python3', 'train.py'] });

describe('persistence', () => {
  it('a restarted buyer resumes the running job from its data dir and finishes it', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 40, stepMs: 100 } }] }));
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).payments.some((p) => p.seq === 1), 'PAY 1');
    await w.buyer.close();
    expect(existsSync(join(w.root, 'buyer', 'buyer-state.json'))).toBe(true);
    expect(existsSync(join(w.root, 'buyer', 'master.seed'))).toBe(true);

    const b2 = (extra = new BuyerNode({ backend: w.buyerBackend, relay: w.relay, dataDir: join(w.root, 'buyer'), profile: TEST_PROFILE, deps: { ...fakeBundles } }));
    await b2.start();
    expect(['accepted', 'running', 'closing', 'closed']).toContain(b2.getRfq(rfqId).state);
    await waitFor(() => b2.getRfq(rfqId).state === 'closed', 'resumed RFQ to close', 20_000);
    const r = b2.getRfq(rfqId);
    expect(r.closeReason).toBe('done');
    expect(r.resultVerified).toBe(true);
    const seqs = r.payments.map((p) => p.seq);
    expect(seqs).toEqual([...new Set(seqs)]); // nothing paid twice
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(w.providers[0]!.getJob(rfqId).earnedZats).toBe(r.spentZats);
  }, 30_000);

  it('a provider shutting down stops its job and tells the buyer (CLOSE provider_stop)', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', script: { steps: 100_000, stepMs: 50 } }] }));
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w), autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'running', 'running');
    await w.providers[0]!.close();
    expect(w.providers[0]!.getJob(rfqId)).toMatchObject({ state: 'stopped', stopReason: 'provider_stop' });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'buyer close', 10_000);
    expect(w.buyer.getRfq(rfqId).closeReason).toBe('provider_stop');
  }, 30_000);
});
