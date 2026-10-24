/** Directory matching and request-form helpers (pure). */

import type { ProviderDto, RfqDto, StatusDto } from '@silicr/api';
import { gpuLabel, normalizeGpu, paddedOutputsFor, toZats, zecString, zip317Fee } from './format';

export const DEFAULT_GPUS = ['h100', 'a100', 'l40s', 'rtx4090', 'cpu'];

export function providerMatches(p: ProviderDto, gpu: string, count: number): boolean {
  const want = normalizeGpu(gpu);
  if (!want) return false;
  return p.gpus.some((g) => normalizeGpu(g.model).includes(want) && g.count >= count);
}

/** "4× A100 80 GB" (multiple entries joined with " + "). */
export function gpuSummary(p: Pick<ProviderDto, 'gpus'>): string {
  if (!p.gpus.length) return 'none listed';
  return p.gpus.map((g) => `${g.count}× ${gpuLabel(g.model)}${g.vramGb ? ` ${g.vramGb} GB` : ''}`).join(' + ');
}

/** GPU models offered in the directory, plus the common ones, as select options. */
export function gpuOptions(providers: ProviderDto[] | null): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const p of providers ?? []) {
    for (const g of p.gpus) {
      const n = normalizeGpu(g.model);
      if (n && !seen.has(n)) seen.set(n, g.model);
    }
  }
  for (const d of DEFAULT_GPUS) if (!seen.has(d)) seen.set(d, d);
  return [...seen.keys()].map((value) => ({ value, label: gpuLabel(value) }));
}

export interface CostEstimate {
  maxCost: bigint;
  rfqFee: bigint;
  paymentFees: bigint;
  intervals: number;
  intervalS: number;
  perIntervalAtMax: bigint;
  paddedOutputs: number;
}

/** What a request can cost at most, assuming the default 10-minute interval for fee estimates. */
export function estimateCost(maxPerHour: bigint, durationS: number, recipients: number, intervalS = 600): CostEstimate {
  const intervals = Math.max(1, Math.ceil(durationS / intervalS));
  const padded = paddedOutputsFor(Math.max(1, recipients));
  return {
    maxCost: (maxPerHour * BigInt(Math.round(durationS))) / 3600n,
    rfqFee: zip317Fee(padded),
    // ACCEPT pays interval 0, then one PAY per further interval; each is a 2-action tx.
    paymentFees: zip317Fee(2) * BigInt(intervals),
    intervals,
    intervalS,
    perIntervalAtMax: (maxPerHour * BigInt(intervalS)) / 3600n,
    paddedOutputs: padded,
  };
}

export type SpendCapDto = NonNullable<StatusDto['spendCap']>;

export interface SpendCapCheck {
  /** The request's worst case: max price × duration plus the estimated fees. */
  needed: bigint;
  perRfq: bigint;
  total: bigint;
  spent: bigint;
  /** What the total cap still allows. */
  remaining: bigint;
  /** Which limit the worst case breaks, if any. */
  exceeds: 'per_rfq' | 'total' | null;
}

/**
 * Compare a request's worst case with the daemon's spend cap. The daemon enforces the cap
 * itself; this only explains it before the request is sent. Conservative: fees are counted.
 */
export function checkSpendCap(est: Pick<CostEstimate, 'maxCost' | 'rfqFee' | 'paymentFees'>, cap: SpendCapDto | null | undefined): SpendCapCheck | null {
  if (!cap) return null;
  const perRfq = toZats(cap.perRfqZats);
  const total = toZats(cap.totalZats);
  const spent = toZats(cap.spentZats);
  const remaining = total > spent ? total - spent : 0n;
  const needed = est.maxCost + est.rfqFee + est.paymentFees;
  const exceeds = needed > perRfq ? 'per_rfq' : needed > remaining ? 'total' : null;
  return { needed, perRfq, total, spent, remaining, exceeds };
}

/** "spent 0.0212 of 2.5 ZEC (per request ≤ 1 ZEC)" */
export function spendCapSummary(cap: SpendCapDto): string {
  return `spent ${zecString(cap.spentZats)} of ${zecString(cap.totalZats)} ZEC (per request ≤ ${zecString(cap.perRfqZats)} ZEC)`;
}

/** Cheapest valid bid first, then bigger bond, then earliest. */
export function rankBids(bids: RfqDto['bids']): RfqDto['bids'] {
  return [...bids].sort((a, b) => {
    if (a.signatureValid !== b.signatureValid) return a.signatureValid ? -1 : 1;
    const pa = toZats(a.pricePerHourZats);
    const pb = toZats(b.pricePerHourZats);
    if (pa !== pb) return pa < pb ? -1 : 1;
    const ba = toZats(a.bondZats);
    const bb = toZats(b.bondZats);
    if (ba !== bb) return ba > bb ? -1 : 1;
    return a.receivedAt - b.receivedAt;
  });
}

export function sortedRfqs(rfqs: Record<string, RfqDto>): RfqDto[] {
  return Object.values(rfqs).sort((a, b) => b.createdAt - a.createdAt);
}

export const ACTIVE_STATES = new Set<RfqDto['state']>(['broadcasting', 'collecting', 'accepted', 'running', 'closing']);
