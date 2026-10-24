// Buyer/provider state machines end to end, with the real protocol and memory chain
// but an in-memory relay and a scripted runner (fast and deterministic enough for CI).
import { afterEach, describe, expect, it } from 'vitest';
import { decodeMemo } from '@silicr/protocol';
import { makeWorld, unbundle, waitFor, type World } from './helpers.ts';

let world: World | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const job = (w: World) => ({ path: w.jobDir, command: ['python3', 'train.py'] });

describe('happy path', () => {
  it('RFQ → verified bid → accept → metered PAYs → heartbeats → verified result → CLOSE', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', policy: { minPricePerHourZats: 36_123_456n }, script: { steps: 30, stepMs: 100 } }] }));
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100',
      count: 1,
      durationS: 60,
      maxPricePerHourZats: '72000000',
      job: job(w),
      autoAccept: { rule: 'cheapest', waitBlocks: 2 },
    });
    expect(w.buyer.getRfq(rfqId).state).toBe('broadcasting');
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'RFQ to close', 20_000);
    const r = w.buyer.getRfq(rfqId);

    // one RFQ transaction, padded to the 4-output bucket; every output carries a 512-byte memo
    expect(r.providersAsked).toBe(1);
    expect(r.paddedOutputs).toBe(4);
    expect(r.rfqTxids).toHaveLength(1);
    const rfqSend = w.buyerBackend.sends[0]!;
    expect(rfqSend).toHaveLength(4);
    expect(rfqSend.filter((o) => decodeMemo(o.memo)?.msg.t === 'RFQ')).toHaveLength(1);
    expect(rfqSend.filter((o) => decodeMemo(o.memo) === null)).toHaveLength(3);
    const view = w.network.explorer().find((v) => v.txid === r.rfqTxid)!;
    expect((view.ironwood ?? view.orchard).actions).toBe(5); // 4 padded outputs + change

    // the bid was verified and accepted
    expect(r.bids).toHaveLength(1);
    expect(r.bids[0]!.signatureValid).toBe(true);
    expect(r.accepted?.providerId).toBe(w.providers[0]!.providerId);
    expect(r.rejectedBids).toBe(0);

    // metered: interval 0 paid by ACCEPT, then at least two PAYs, in order
    const pays = r.payments.filter((p) => p.kind === 'pay');
    expect(r.payments[0]!.kind).toBe('accept');
    expect(pays.length).toBeGreaterThanOrEqual(2);
    expect(pays.map((p) => p.seq)).toEqual(pays.map((_, i) => i + 1));
    expect(BigInt(r.spentZats)).toBe(BigInt(r.accepted!.pricePerIntervalZats) * BigInt(r.payments.length));

    // heartbeats arrived, result digest matches the provider's signed CLOSE
    expect(r.heartbeats.length).toBeGreaterThan(0);
    expect(r.heartbeats[0]!.status).toBe('finished');
    expect(r.closeReason).toBe('done');
    expect(r.resultVerified).toBe(true);
    const pj = w.providers[0]!.getJob(rfqId);
    expect(pj.state).toBe('done');
    expect(pj.resultDigest).toBe(r.result!.digest);
    expect(pj.earnedZats).toBe(r.spentZats);
    const files = unbundle(await w.buyer.resultBytes(rfqId));
    expect(files['result.txt']).toContain('steps=30');
    expect(files['result.txt']).toContain('env=p1'); // provider jobEnv reached the job
    expect(r.logTail.some((l) => l.startsWith('step '))).toBe(true);

    // the relay only ever held ciphertext
    expect(w.relay.containsUtf8('SECRET-WORKLOAD-MARKER')).toBe(false);
    expect(w.relay.containsUtf8('train.py')).toBe(false);
    expect(w.relay.containsUtf8('step 1 loss')).toBe(false);
    expect(w.relay.operatorView()).not.toContain(rfqId);

    // leak log: the provider holds the request but no buyer identity; the chain sees no amounts
    const pLeaks = w.providers[0]!.listLeaks({ rfqId });
    const rfqObs = pLeaks.find((o) => o.party === 'provider' && o.summary.startsWith('Sealed RFQ received'))!;
    expect(rfqObs.fields.find((f) => f.label === 'Buyer identity')).toMatchObject({ value: 'not present in any message', readable: false });
    expect(rfqObs.fields.find((f) => f.label === 'GPU')).toMatchObject({ readable: true, sensitive: true });
    expect(pLeaks.some((o) => o.event === 'job-started' && o.fields.some((f) => f.label === 'Command' && f.value === 'python3 train.py'))).toBe(true);
    const chainObs = w.buyer.listLeaks({ rfqId }).filter((o) => o.party === 'chain');
    expect(chainObs.length).toBeGreaterThan(2);
    const price = r.accepted!.pricePerIntervalZats;
    expect(price).toBe('10035'); // distinctive: never a fee multiple
    for (const o of chainObs) {
      expect(o.fields.find((f) => f.label === 'Amounts')).toMatchObject({ readable: false });
      for (const f of o.fields.filter((x) => x.label !== 'Transaction id' && !x.label.includes('ciphertext'))) {
        expect(f.value).not.toContain(price);
        expect(f.value).not.toContain(r.request.maxPricePerHourZats);
      }
    }
  }, 30_000);
});

describe('padding and limited backends', () => {
  it('pads 5 providers to 8 outputs in one transaction', async () => {
    const w = (world = await makeWorld({ providers: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name })) }));
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 2, durationS: 60, maxPricePerHourZats: '72000000', job: job(w) });
    await waitFor(() => w.buyer.getRfq(rfqId).bids.length === 5, 'five bids', 10_000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.state).toBe('collecting');
    expect(r.providersAsked).toBe(5);
    expect(r.paddedOutputs).toBe(8);
    expect(w.buyerBackend.sends[0]).toHaveLength(8);
    expect(new Set(r.bids.map((b) => b.providerId)).size).toBe(5);
    await w.buyer.stop(rfqId);
    expect(w.buyer.getRfq(rfqId).state).toBe('closed');
  }, 20_000);

  it('splits the RFQ when the backend carries one output per tx, and works over text memos', async () => {
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', script: { steps: 12, stepMs: 100 } }],
      memory: { capabilities: { maxOutputsPerTx: 1, binaryMemos: false } },
    }));
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100',
      count: 1,
      durationS: 30,
      maxPricePerHourZats: '72000000',
      job: job(w),
      autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'RFQ to close', 25_000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.paddedOutputs).toBe(4);
    expect(r.rfqTxids).toHaveLength(4);
    expect(w.buyerBackend.sends.slice(0, 4).every((s) => s.length === 1)).toBe(true);
    const tradeoff = w.buyer.listLeaks({ rfqId }).find((o) => o.event === 'privacy-tradeoff');
    expect(tradeoff?.party).toBe('chain');
    // text transport: every Silicr memo starts with "slc1:"
    const rfqMemo = w.buyerBackend.sends.flat().map((o) => decodeMemo(o.memo)).find((d) => d?.msg.t === 'RFQ')!;
    expect(rfqMemo.transport).toBe('text');
    expect(r.closeReason).toBe('done');
    expect(r.resultVerified).toBe(true);
  }, 30_000);
});

describe('prepare funds', () => {
  it('splits the balance into job-sized notes, waits for their confirmations, then broadcasts the RFQ', async () => {
    const w = (world = await makeWorld({
      providers: [{ name: 'p1', script: { steps: 25, stepMs: 100 } }],
      profile: { prepareNotes: 3, changeConfirmations: 2 },
    }));
    const updates: { state: string; preparing?: { confirmations: number; required: number; notes: number } }[] = [];
    w.buyer.on((e) => {
      if (e.type === 'rfq.updated') updates.push(e.rfq as (typeof updates)[number]);
    });
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100',
      count: 1,
      durationS: 60,
      maxPricePerHourZats: '72000000',
      job: job(w),
      autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 25_000);
    const prep = updates.filter((u) => u.preparing);
    expect(prep.length).toBeGreaterThan(0);
    expect(prep[0]!.state).toBe('broadcasting');
    expect(prep[0]!.preparing).toMatchObject({ notes: 6, required: 2 });
    expect(prep.some((u) => u.preparing!.confirmations === 2)).toBe(true);
    // the self-send went out first, with one output per prepared note
    expect(w.buyerBackend.sends[0]).toHaveLength(6);
    expect(w.buyerBackend.sends[1]).toHaveLength(4); // then the padded RFQ
    const r = w.buyer.getRfq(rfqId);
    expect(r.closeReason).toBe('done');
    expect(r.payments.filter((p) => p.kind === 'pay').length).toBeGreaterThanOrEqual(1);
    expect(w.buyer.listLeaks({ rfqId }).some((o) => o.summary.startsWith('Split'))).toBe(true);
  }, 30_000);
});

describe('auto-accept and expiry', () => {
  it('auto-accepts the cheapest of several bids', async () => {
    const w = (world = await makeWorld({
      providers: [
        { name: 'dear', policy: { minPricePerHourZats: 60_000_000n } },
        { name: 'cheap', policy: { minPricePerHourZats: 20_000_000n }, script: { steps: 5, stepMs: 100 } },
        { name: 'mid', policy: { minPricePerHourZats: 40_000_000n } },
      ],
    }));
    const { rfqId } = await w.buyer.createRfq({
      gpu: 'a100',
      count: 1,
      durationS: 60,
      maxPricePerHourZats: '72000000',
      job: job(w),
      autoAccept: { rule: 'cheapest', waitBlocks: 5 },
    });
    await waitFor(() => w.buyer.getRfq(rfqId).accepted, 'an accept', 10_000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.bids).toHaveLength(3);
    // ranked cheapest first (hourly prices carry whole-interval rounding)
    expect(r.bids.map((b) => b.alias)).toEqual([1, 2, 0].map((i) => w.providers[i]!.alias));
    expect(BigInt(r.bids[0]!.pricePerHourZats)).toBeGreaterThanOrEqual(20_000_000n);
    expect(r.accepted!.providerId).toBe(w.providers[1]!.providerId);
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'closed', 'close', 15_000);
    // the losers learn nothing and eventually give up
    await waitFor(() => w.providers[0]!.getJob(rfqId).state === 'lost' || w.providers[0]!.getJob(rfqId).state === 'bid', 'loser state');
  }, 30_000);

  it('expires when nobody bids', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'off', policy: { autoBid: false } }], profile: { bidWindowBlocks: 4 } }));
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w) });
    await waitFor(() => w.buyer.getRfq(rfqId).state === 'expired', 'expiry', 10_000);
    expect(w.buyer.getRfq(rfqId).bids).toHaveLength(0);
    expect(w.providers[0]!.listLeaks({ rfqId }).some((o) => o.event === 'no-bid')).toBe(true);
  }, 20_000);

  it('refuses requests no directory provider can serve', async () => {
    const w = (world = await makeWorld());
    await expect(w.buyer.createRfq({ gpu: 'h100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w) })).rejects.toThrow(/no verified provider/);
    await expect(w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '1000', job: job(w) })).rejects.toThrow(/no verified provider/);
    await expect(w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: { path: '/nonexistent', command: ['x'] } })).rejects.toThrow(/not a directory/);
    await expect(w.buyer.createRfq({ gpu: 'A 100!', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w) })).rejects.toThrow(/slug/);
  });
});
