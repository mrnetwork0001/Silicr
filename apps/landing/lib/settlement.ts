/**
 * The settlement numbers shown on the page, computed with the same rules the
 * engine uses (packages/engine/src/zats.ts, buyer.ts, chain.ts) and the ZIP 317
 * fee rule the wallets apply. Nothing here is typed in by hand.
 */

export const ZATS_PER_ZEC = 100_000_000n;
/** ZIP 317 marginal fee per logical action. */
export const MARGINAL_FEE_ZATS = 5_000n;
/** ZIP 317 grace actions: every transaction pays for at least this many. */
export const GRACE_ACTIONS = 2;

/**
 * Testnet timing defaults (packages/engine/src/profile.ts, TESTNET_PROFILE). The payment lead is
 * from ARCHITECTURE.md §4: interval k is paid once jobStart + k·I − lead has passed on the buyer's
 * own clock, plus random jitter.
 */
export const TESTNET_DEFAULTS = {
  intervalS: 300,
  payLeadS: 60,
  heartbeatS: 15,
  heartbeatTimeoutS: 90,
  graceS: 180,
} as const;

/**
 * Most a buyer can have paid for but not yet received: `I + lead` of compute, with
 * lead = min(payLeadS, I/4) (ARCHITECTURE.md §4, engine profile.ts). For the testnet defaults
 * that is 360 s of a 300 s interval: 1.2 intervals. Kept as a fraction so the arithmetic stays in bigint.
 */
const LEAD_S = Math.min(TESTNET_DEFAULTS.payLeadS, TESTNET_DEFAULTS.intervalS / 4);
export const BUYER_EXPOSURE = {
  num: BigInt(TESTNET_DEFAULTS.intervalS + LEAD_S),
  den: BigInt(TESTNET_DEFAULTS.intervalS),
  label: String((TESTNET_DEFAULTS.intervalS + LEAD_S) / TESTNET_DEFAULTS.intervalS),
} as const;

export function zip317Fee(logicalActions: number): bigint {
  return MARGINAL_FEE_ZATS * BigInt(Math.max(GRACE_ACTIONS, logicalActions));
}

/** Smallest output bucket (4, 8, 16, then multiples of 16) that holds n outputs: engine padBucket(). */
export function padBucket(n: number): number {
  if (n <= 4) return 4;
  if (n <= 8) return 8;
  if (n <= 16) return 16;
  return Math.ceil(n / 16) * 16;
}

/** Engine perInterval(): the smallest per-interval price that is at least `perHour` per hour. */
export function perInterval(perHourZats: bigint, intervalS: number): bigint {
  const p = (perHourZats * BigInt(intervalS) + 3599n) / 3600n;
  return p > 0n ? p : 1n;
}

/** 80_000_000n → "0.8". Plain decimal, trailing zeros trimmed (engine formatZec()). */
export function formatZec(zats: bigint): string {
  const whole = zats / ZATS_PER_ZEC;
  const frac = (zats % ZATS_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''}`;
}

/** 45000n → "45,000". */
export function formatZats(zats: bigint): string {
  return zats.toLocaleString('en-US');
}

/** Ratio as a percentage with `digits` decimals, e.g. 0.17. */
export function percent(part: bigint, whole: bigint, digits: number): string {
  const scale = 10n ** BigInt(digits + 2);
  const scaled = (part * scale * 10n) / whole; // one extra digit for rounding
  const rounded = (scaled + 5n) / 10n;
  const s = rounded.toString().padStart(digits + 1, '0');
  return digits > 0 ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s;
}

// ---------------------------------------------------------------------------
// The worked example: the same request the hero shows.

const HOUR = 3600;

export const EXAMPLE = (() => {
  const gpu = 'a100';
  const count = 4;
  const hours = 12;
  const durationS = hours * HOUR;
  const intervalS = TESTNET_DEFAULTS.intervalS;
  const maxPerHourZats = 80_000_000n; // 0.8 ZEC/h
  const bidPerHourZats = 72_000_000n; // the winning bid: 0.72 ZEC/h
  const providersAsked = 6;

  // Buyer: intervals = ceil(durationS / intervalS); ACCEPT pays interval 0, PAY 1..n-1 the rest.
  const intervals = Math.ceil(durationS / intervalS);
  const pricePerIntervalZats = perInterval(bidPerHourZats, intervalS);
  const payments = intervals;
  const payCount = intervals - 1;
  const paidZats = pricePerIntervalZats * BigInt(intervals);

  // A payment spends a note and returns change: 1 output + 1 change = 2 logical actions.
  const paymentFeeZats = zip317Fee(2);
  const paymentFeesZats = paymentFeeZats * BigInt(payments);

  // The RFQ: real outputs padded to a bucket, plus one change output.
  const bucket = padBucket(providersAsked);
  const rfqActions = bucket + 1;
  const rfqFeeZats = zip317Fee(rfqActions);
  const closeFeeZats = zip317Fee(2);
  const allInFeesZats = paymentFeesZats + rfqFeeZats + closeFeeZats;

  // Payments follow the buyer's clock, shortly before each interval begins: at most the rest of
  // the interval in progress plus one prepaid interval are paid for and not yet served.
  const buyerMaxExposureZats = (pricePerIntervalZats * BUYER_EXPOSURE.num) / BUYER_EXPOSURE.den;
  const buyerMaxExposureMinutes = (intervalS / 60) * Number(BUYER_EXPOSURE.num) / Number(BUYER_EXPOSURE.den);

  return {
    gpu,
    count,
    hours,
    durationS,
    intervalS,
    intervalMin: intervalS / 60,
    maxPerHourZats,
    bidPerHourZats,
    providersAsked,
    intervals,
    pricePerIntervalZats,
    payments,
    payCount,
    paidZats,
    paymentFeeZats,
    paymentFeesZats,
    feeShare: percent(paymentFeesZats, paidZats, 2),
    bucket,
    rfqActions,
    rfqFeeZats,
    closeFeeZats,
    allInFeesZats,
    buyerMaxExposureZats,
    buyerMaxExposureMinutes,
    buyerExposureShare: percent(buyerMaxExposureZats, paidZats, 1),
  };
})();

/** Other bids shown arriving in the hero (ZEC per hour), cheapest first after ranking. */
export const HERO_BIDS = [
  { alias: 'cobalt-heron-42', perHourZats: 72_000_000n, order: 'b' },
  { alias: 'slate-lynx-8', perHourZats: 75_000_000n, order: 'c' },
  { alias: 'amber-otter-17', perHourZats: 78_000_000n, order: 'a' },
] as const;
