import { describe, expect, it } from 'vitest';
import { checkSpendCap, estimateCost, spendCapSummary } from '../lib/market';

const ZEC = 100_000_000n;

describe('estimateCost', () => {
  it('counts one payment per interval and pads the RFQ', () => {
    const est = estimateCost(80_000_000n, 3600, 3); // 0.8 ZEC/h for 1 h to 3 providers
    expect(est.maxCost).toBe(80_000_000n);
    expect(est.intervals).toBe(6);
    expect(est.paddedOutputs).toBe(4);
    expect(est.rfqFee).toBe(20_000n);
    expect(est.paymentFees).toBe(60_000n);
    expect(est.perIntervalAtMax).toBe(13_333_333n);
  });
});

describe('checkSpendCap', () => {
  const est = estimateCost(80_000_000n, 3600, 3);
  const cap = (perRfq: bigint, total: bigint, spent: bigint) => ({ perRfqZats: perRfq.toString(), totalZats: total.toString(), spentZats: spent.toString() });

  it('is absent without a cap', () => {
    expect(checkSpendCap(est, undefined)).toBeNull();
    expect(checkSpendCap(est, null)).toBeNull();
  });

  it('counts the worst case, fees included, against both limits', () => {
    const ok = checkSpendCap(est, cap(ZEC, 2n * ZEC, 0n))!;
    expect(ok.needed).toBe(80_080_000n);
    expect(ok.remaining).toBe(2n * ZEC);
    expect(ok.exceeds).toBeNull();
    expect(checkSpendCap(est, cap(80_000_000n, 2n * ZEC, 0n))!.exceeds).toBe('per_rfq'); // fees tip it over
    expect(checkSpendCap(est, cap(ZEC, 2n * ZEC, 150_000_000n))!.exceeds).toBe('total');
  });

  it('never reports negative headroom', () => {
    const c = checkSpendCap(est, cap(ZEC, ZEC, 3n * ZEC))!;
    expect(c.remaining).toBe(0n);
    expect(c.exceeds).toBe('total');
  });

  it('summarises a cap the way the header shows it', () => {
    expect(spendCapSummary(cap(ZEC, 250_000_000n, 2_120_000n))).toBe('spent 0.0212 of 2.5 ZEC (per request ≤ 1 ZEC)');
  });
});
