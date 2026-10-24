// Timing profiles. Every timeout and cadence a node uses comes from one of these.
import type { Network } from '@silicr/zec';

export interface TimingProfile {
  name: string;
  /** Expected seconds per block (StatusDto.blockTimeS). */
  blockTimeS: number;
  /** How often a node polls its wallet backend for new notes. */
  pollMs: number;
  /** RFQ expiresHeight = height at broadcast + bidWindowBlocks. */
  bidWindowBlocks: number;
  /** After expiresHeight, how many more blocks the buyer may take to ACCEPT before providers give up. */
  acceptWindowBlocks: number;
  /** Default interval length a provider bids. */
  intervalS: number;
  /** Provider heartbeat period. */
  heartbeatS: number;
  /** Buyer stops paying and sends CLOSE(no_heartbeat) after this long without one. */
  heartbeatTimeoutS: number;
  /** Provider: how long an unpaid interval may stay paused before the job is stopped. */
  graceS: number;
  /** Provider promise in its BID: the job starts within this many seconds of the ACCEPT. */
  startWithinS: number;
  /** Relay long-poll wait. */
  relayWaitS: number;
  /** Buyer: how long to wait in 'closing' for the provider's CLOSE and result. */
  closeWaitS: number;
  /** Provider: how long to wait for the sealed job after an ACCEPT. */
  jobFetchTimeoutS: number;
  /** Provider: how often the signed directory entry is re-published. */
  directoryRefreshS: number;
  /** How long a send that failed on unconfirmed change keeps retrying. */
  sendRetryS: number;
  /**
   * Buyer "prepare funds": before an RFQ, split the balance into up to this many interval-sized
   * notes (+ RFQ, ACCEPT, CLOSE) and wait until they are spendable. 0 = off (the RFQ's padding
   * outputs do a lighter version of the split instead).
   */
  prepareNotes: number;
  /** Confirmations before the wallet's own new notes are spendable (ZIP 315 trusted: 3 on testnet). */
  changeConfirmations: number;
  /** Give up waiting for prepared notes after this long and go ahead anyway. */
  prepareTimeoutS: number;
  /**
   * Buyer: PAY(k) may be sent from `payLeadS` before interval k starts on the BUYER's clock
   * (jobStart + k·I − lead), plus a random 0..lead/2 delay. Worst-case buyer exposure is
   * I + lead of compute: (1 + payLeadS / intervalS) intervals.
   */
  payLeadS: number;
  /** Buyer: a heartbeat older than this doesn't count as "provider alive" for paying. */
  payFreshS: number;
  /**
   * A network upgrade that changes the block time (NU7 on mainnet): from `height` on, these
   * block-denominated values replace the ones above, keeping the same wall-clock windows.
   * Resolve with profileAtHeight().
   */
  upgrade?: { name: string; height: number } & Pick<TimingProfile, 'blockTimeS' | 'bidWindowBlocks' | 'acceptWindowBlocks'>;
}

/** NU7 activation on Zcash mainnet (25 s blocks after it; testnet already runs NU7). */
export const MAINNET_NU7_HEIGHT = 3_543_405;

/** In-process simulated chain, 1 s blocks: the zero-setup demo. */
export const MEMORY_PROFILE: TimingProfile = {
  name: 'memory',
  blockTimeS: 1,
  pollMs: 200,
  bidWindowBlocks: 8,
  acceptWindowBlocks: 120,
  intervalS: 4,
  heartbeatS: 0.5,
  heartbeatTimeoutS: 4,
  graceS: 8,
  startWithinS: 15,
  relayWaitS: 2,
  closeWaitS: 20,
  jobFetchTimeoutS: 15,
  directoryRefreshS: 60,
  sendRetryS: 10,
  prepareNotes: 0,
  changeConfirmations: 1,
  prepareTimeoutS: 30,
  payLeadS: 1, // 25% of the 4 s interval
  payFreshS: 2,
};

/** Simulated chain with 250 ms blocks: `silicr demo --fast` and tests. */
export const FAST_PROFILE: TimingProfile = {
  name: 'fast',
  blockTimeS: 0.25,
  pollMs: 100,
  bidWindowBlocks: 8,
  acceptWindowBlocks: 240,
  intervalS: 2,
  heartbeatS: 0.25,
  heartbeatTimeoutS: 2,
  graceS: 4,
  startWithinS: 10,
  relayWaitS: 1,
  closeWaitS: 10,
  jobFetchTimeoutS: 10,
  directoryRefreshS: 30,
  sendRetryS: 5,
  prepareNotes: 0,
  changeConfirmations: 1,
  prepareTimeoutS: 15,
  payLeadS: 0.5, // 25% of the 2 s interval
  payFreshS: 1,
};

/**
 * Zcash testnet: 25 s blocks since NU7 (75 s before). PAY and ACCEPT are acted on from the mempool
 * where the backend allows. The block windows are the pre-NU7 wall-clock windows in 25 s blocks:
 * bid window 12 blocks (~5 min), accept window 60 blocks (~25 min). Change is spendable after 3
 * confirmations (~75 s), received funds after 10 (~4 min).
 */
export const TESTNET_PROFILE: TimingProfile = {
  name: 'testnet',
  blockTimeS: 25,
  pollMs: 5000,
  bidWindowBlocks: 12,
  // After the bid window: ~25 min for a human to accept a bid.
  acceptWindowBlocks: 60,
  intervalS: 300,
  heartbeatS: 15,
  heartbeatTimeoutS: 90,
  graceS: 180,
  startWithinS: 600,
  relayWaitS: 25,
  closeWaitS: 900,
  jobFetchTimeoutS: 600,
  directoryRefreshS: 600,
  sendRetryS: 600,
  prepareNotes: 6,
  changeConfirmations: 3,
  prepareTimeoutS: 1800,
  payLeadS: 60, // of a 300 s interval
  payFreshS: 45,
};

/**
 * Zcash mainnet: ~75 s blocks and real ZEC, so longer intervals than testnet (fewer transactions
 * per hour) and generous windows. Received funds are spendable after 10 confirmations (the
 * sidecar's ZIP 315 untrusted default, ~13 min); the wallet's own change after changeConfirmations.
 *
 * Settlement arithmetic (ARCHITECTURE.md §4): lead = min(payLeadS, I/4) = 120 s, so PAY k goes out
 * between I + lead/2 = 660 s and I + lead = 720 s before interval k+1 starts: 8.8–9.6 expected
 * blocks for it to be mined by the time the provider requires it (rule 3), and the 300 s grace
 * window adds 4 blocks after that. Buyer exposure: 1 + 120/600 = 1.2 intervals (12 min of compute).
 */
export const MAINNET_PROFILE: TimingProfile = {
  name: 'mainnet',
  blockTimeS: 75,
  pollMs: 5000,
  // ~10 min: the RFQ must be mined, seen, answered, and the bid mined again. 3 blocks lost a
  // real deal by one block on 2026-10-22.
  bidWindowBlocks: 8,
  // After the bid window: 20 blocks (~25 min) for a human to accept a bid.
  acceptWindowBlocks: 20,
  intervalS: 600,
  heartbeatS: 15,
  heartbeatTimeoutS: 90,
  graceS: 300,
  startWithinS: 900,
  relayWaitS: 25,
  closeWaitS: 1200,
  jobFetchTimeoutS: 900,
  directoryRefreshS: 600,
  sendRetryS: 900,
  prepareNotes: 6,
  changeConfirmations: 3,
  prepareTimeoutS: 1800,
  payLeadS: 120, // of a 600 s interval: I/5, under the I/4 clamp
  payFreshS: 45,
  // NU7 (≈ 2026-11-03): 25 s blocks, so three times the blocks for the same ~10 min / ~25 min windows.
  upgrade: { name: 'nu7', height: MAINNET_NU7_HEIGHT, blockTimeS: 25, bidWindowBlocks: 24, acceptWindowBlocks: 60 },
};

/** The profile in force at a block height: applies `upgrade` once the height reaches it. */
export function profileAtHeight(p: TimingProfile, height: number): TimingProfile {
  const u = p.upgrade;
  if (!u || !(height >= u.height)) return p;
  return { ...p, blockTimeS: u.blockTimeS, bidWindowBlocks: u.bidWindowBlocks, acceptWindowBlocks: u.acceptWindowBlocks };
}

export const PROFILES: Record<string, TimingProfile> = {
  memory: MEMORY_PROFILE,
  fast: FAST_PROFILE,
  testnet: TESTNET_PROFILE,
  mainnet: MAINNET_PROFILE,
};

export function defaultProfile(network: Network): TimingProfile {
  if (network === 'memory') return MEMORY_PROFILE;
  if (network === 'main') return MAINNET_PROFILE;
  return TESTNET_PROFILE;
}

export function withOverrides(base: TimingProfile, over: Partial<TimingProfile> = {}): TimingProfile {
  return { ...base, ...over };
}

/** The payment lead actually used for an interval length: the profile's lead, at most I/4. */
export function payLeadFor(p: Pick<TimingProfile, 'payLeadS'>, intervalS: number): number {
  return Math.min(p.payLeadS, intervalS / 4);
}

/** Worst-case buyer exposure, in intervals: (I + lead) / I. Jitter and timer delays only lower it. */
export function maxExposureIntervals(p: Pick<TimingProfile, 'intervalS' | 'payLeadS'>, intervalS = p.intervalS): number {
  return 1 + payLeadFor(p, intervalS) / intervalS;
}

/**
 * The least time (s) a PAY has to get mined before the provider needs it mined: PAY k goes out at
 * the latest lead/2 before interval k starts, and the provider requires it mined when interval k+1
 * starts, I later (ARCHITECTURE.md §4 rule 3). Divide by blockTimeS for the expected block count.
 */
export function payMiningWindowS(p: Pick<TimingProfile, 'intervalS' | 'payLeadS'>, intervalS = p.intervalS): number {
  return intervalS + payLeadFor(p, intervalS) / 2;
}
