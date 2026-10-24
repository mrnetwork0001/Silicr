// Hidden buyer budgets: by default the RFQ memo carries maxPricePerHourZats = 0 ("undisclosed"),
// providers bid their own price (min + markup) and the buyer filters bids against its private max.
import { afterEach, describe, expect, it } from 'vitest';
import { decodeMemo, type Rfq } from '@silicr/protocol';
import { askingPricePerHour } from '../src/provider.ts';
import { type World, makeWorld, waitFor } from './helpers.ts';

let world: World | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const job = (w: World) => ({ path: w.jobDir, command: ['python3', 'train.py'] });

/** The RFQ memos the buyer actually broadcast (what every provider asked can decode). */
function sentRfqs(w: World): Rfq[] {
  return w.buyerBackend.sends
    .flat()
    .map((o) => decodeMemo(o.memo))
    .filter((d) => d?.msg.t === 'RFQ')
    .map((d) => d!.msg as Rfq);
}

describe('askingPricePerHour', () => {
  it('is the minimum with no markup and rounds the markup up', () => {
    expect(askingPricePerHour({ minPricePerHourZats: 36_000_000n })).toBe(36_000_000n);
    expect(askingPricePerHour({ minPricePerHourZats: 36_000_000n, markupPct: 0 })).toBe(36_000_000n);
    expect(askingPricePerHour({ minPricePerHourZats: 36_000_000n, markupPct: 25 })).toBe(45_000_000n);
    expect(askingPricePerHour({ minPricePerHourZats: 1n, markupPct: 0.5 })).toBe(2n);
  });
});

describe('undisclosed max (default)', () => {
  it('keeps the max off the wire; the provider bids min + markup and the buyer still sees its private max', async () => {
    const w = (world = await makeWorld({ providers: [{ name: 'p1', policy: { minPricePerHourZats: 36_000_000n, markupPct: 25 } }] }));
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', job: job(w) });
    await waitFor(() => w.buyer.getRfq(rfqId).bids.length === 1, 'bid');
    const r = w.buyer.getRfq(rfqId);
    expect(r.discloseMax).toBe(false);
    expect(r.request.maxPricePerHourZats).toBe('72000000'); // the private value, for the buyer's own UI
    expect(r.rejectedBids).toBe(0);
    // Wire: every RFQ memo says 0.
    const rfqs = sentRfqs(w);
    expect(rfqs.length).toBeGreaterThan(0);
    expect(rfqs.every((m) => m.maxPricePerHourZats === 0n)).toBe(true);
    // Provider: saw 0, bid 36_000_000 × 1.25 = 45_000_000 ZEC/h (1 s intervals → 12_500 zats).
    const pj = w.providers[0]!.getJob(rfqId);
    expect(pj.request.maxPricePerHourZats).toBe('0');
    expect(r.bids[0]!.pricePerHourZats).toBe('45000000');
    expect(r.bids[0]!.pricePerIntervalZats).toBe('12500');
    // Leak Inspector: the provider records the budget as unknown, the buyer records it as withheld.
    const pl = w.providers[0]!.listLeaks({ rfqId });
    const budget = pl.flatMap((o) => o.fields).find((f) => f.label === 'Buyer budget');
    expect(budget).toMatchObject({ readable: false, sensitive: true });
    expect(budget!.value).toMatch(/undisclosed/);
    expect(pl.flatMap((o) => o.fields).some((f) => f.label === 'Max price')).toBe(false);
    expect(pl.flatMap((o) => o.fields).some((f) => f.label === 'Priced against' && /undisclosed/.test(f.value))).toBe(true);
    const bl = w.buyer.listLeaks({ rfqId });
    const mine = bl.flatMap((o) => o.fields).find((f) => f.label === 'Max price');
    expect(mine!.value).toMatch(/withheld from providers/);
  }, 20_000);

  it('a provider whose minimum is above the private max still bids, and the buyer drops the bid locally', async () => {
    const w = (world = await makeWorld({
      providers: [
        { name: 'dear', policy: { minPricePerHourZats: 90_000_000n } },
        { name: 'fair', policy: { minPricePerHourZats: 36_000_000n } },
      ],
    }));
    // Ask both explicitly: the directory match would already skip "dear" using the private max (locally, nothing leaves the daemon).
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', providerIds: w.providers.map((p) => p.providerId), job: job(w) });
    await waitFor(() => w.buyer.getRfq(rfqId).rejectedBids === 1 && w.buyer.getRfq(rfqId).bids.length === 1, 'one bid kept, one dropped', 8000);
    const r = w.buyer.getRfq(rfqId);
    expect(r.providersAsked).toBe(2);
    expect(r.bids[0]!.alias).toBe(w.providers[1]!.alias);
    const reasons = w.buyer.listLeaks({ rfqId }).filter((o) => o.event === 'bid-rejected').map((o) => o.summary);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/above private max/);
    // The expensive provider did bid (it never learned it was too dear).
    expect(w.providers[0]!.getJob(rfqId).state).toBe('bid');
  }, 20_000);
});

describe('disclosed max (discloseMax: true)', () => {
  it('puts the max in the memo, the provider bids its minimum and refuses when the max is below it', async () => {
    const w = (world = await makeWorld({
      providers: [
        { name: 'dear', policy: { minPricePerHourZats: 90_000_000n, markupPct: 50 } },
        { name: 'fair', policy: { minPricePerHourZats: 36_000_000n, markupPct: 50 } },
      ],
    }));
    const { rfqId } = await w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', discloseMax: true, providerIds: w.providers.map((p) => p.providerId), job: job(w) });
    await waitFor(() => w.buyer.getRfq(rfqId).bids.length === 1, 'bid');
    const r = w.buyer.getRfq(rfqId);
    expect(r.discloseMax).toBe(true);
    expect(sentRfqs(w).every((m) => m.maxPricePerHourZats === 72_000_000n)).toBe(true);
    // Markup is ignored when the max is disclosed: the old behaviour, bid at the minimum.
    expect(r.bids[0]!.pricePerHourZats).toBe('36000000');
    expect(w.providers[1]!.getJob(rfqId).request.maxPricePerHourZats).toBe('72000000');
    // The dear provider saw the max and did not bid.
    const dear = w.providers[0]!.listLeaks({ rfqId });
    expect(dear.some((o) => o.event === 'no-bid' && /below our minimum/.test(o.summary))).toBe(true);
    expect(dear.flatMap((o) => o.fields).some((f) => f.label === 'Max price' && f.readable && f.sensitive)).toBe(true);
    expect(r.rejectedBids).toBe(0);
  }, 20_000);

  it('rejects a non-boolean discloseMax', async () => {
    const w = (world = await makeWorld());
    await expect(w.buyer.createRfq({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: '72000000', discloseMax: 'yes' as unknown as boolean, job: job(w) })).rejects.toThrow(/discloseMax/);
  });
});
