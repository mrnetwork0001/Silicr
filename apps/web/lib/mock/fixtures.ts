/**
 * Mock fixtures: directory, personas and the demo job's log script.
 * IPs come from the RFC 5737 documentation ranges, so they can't be anyone's.
 */

import type { GpuSpec, ProviderDto } from '@silicr/api';
import type { Rng } from './rng';

/** Demo-length interval (the real default is 10 minutes). */
export const INTERVAL_S = 20;
/** Compressed block time for the replay. */
export const BLOCK_MS = 5000;
export const HEARTBEAT_MS = 4000;
export const LOG_MS = 1700;
/** The demo job finishes inside its 6th paid interval. */
export const RUN_INTERVALS = 6;
export const RUN_MS = RUN_INTERVALS * INTERVAL_S * 1000 - 5000;
export const GRACE_S = 10;
/** The buyer stops paying (and CLOSEs) after this long without a heartbeat. */
export const HEARTBEAT_TIMEOUT_MS = 12_000;
export const TOTAL_STEPS = 600;

export const BUYER_IP = '203.0.113.47';
export const PROVIDER_IP = '198.51.100.23';
export const RELAY_HOST = '127.0.0.1:7700';

export const ZEC = 100_000_000n;
export const zec = (v: number) => BigInt(Math.round(v * 1e8));

/** Mainnet height the replay starts near (the real chain was at ~3,525,700 on 2026-10-21). */
export const START_HEIGHT = 3_525_600;
/** Small mainnet balances, as the real daemons would run with. */
export const BUYER_BALANCE = zec(1.21837);
export const PROVIDER_BALANCE = zec(2.0417);
/** The daemons' spend caps (required on mainnet): per request and in total, payments and fees included. */
export const BUYER_CAP = { perRfq: zec(1), total: zec(2.5) } as const;
export const PROVIDER_CAP = { perRfq: zec(0.001), total: zec(0.05) } as const;

export interface MockProvider extends ProviderDto {
  /** Never answers RFQs (busy / auto-bid off). */
  silent?: boolean;
  /** Order in which providers' bids arrive. */
  latencyRank: number;
  startWithinS: number;
}

interface Seed {
  alias: string;
  gpus: GpuSpec[];
  min: number;
  bond?: number;
  region: string;
  verified: boolean;
  silent?: boolean;
  latencyRank: number;
  startWithinS: number;
  ageMin: number;
}

const SEEDS: Seed[] = [
  { alias: 'amber-otter-17', gpus: [{ model: 'a100', count: 4, vramGb: 80 }], min: 0.6, bond: 5, region: 'EU', verified: true, latencyRank: 2, startWithinS: 30, ageMin: 6 },
  { alias: 'quiet-heron-04', gpus: [{ model: 'a100', count: 8, vramGb: 80 }], min: 0.66, bond: 12, region: 'NA', verified: true, latencyRank: 1, startWithinS: 60, ageMin: 14 },
  { alias: 'slate-lynx-31', gpus: [{ model: 'a100', count: 4, vramGb: 40 }], min: 0.52, region: 'AS', verified: true, silent: true, latencyRank: 9, startWithinS: 90, ageMin: 41 },
  { alias: 'cobalt-finch-88', gpus: [{ model: 'a100', count: 4, vramGb: 80 }], min: 0.7, bond: 2.5, region: 'EU', verified: true, latencyRank: 3, startWithinS: 45, ageMin: 3 },
  { alias: 'ember-moth-62', gpus: [{ model: 'h100', count: 8, vramGb: 80 }], min: 1.9, bond: 20, region: 'NA', verified: true, latencyRank: 1, startWithinS: 30, ageMin: 9 },
  { alias: 'pale-ibis-50', gpus: [{ model: 'l40s', count: 2, vramGb: 48 }], min: 0.21, bond: 1, region: 'EU', verified: true, latencyRank: 2, startWithinS: 20, ageMin: 22 },
  { alias: 'dune-gecko-09', gpus: [{ model: 'rtx4090', count: 2, vramGb: 24 }], min: 0.14, region: 'SA', verified: false, latencyRank: 4, startWithinS: 15, ageMin: 63 },
];

export const PERSONA_ALIAS = 'amber-otter-17';

export function makeDirectory(rng: Rng, now: number): MockProvider[] {
  return SEEDS.map((s) => ({
    providerId: rng.hex(32),
    alias: s.alias,
    address: rng.ua(),
    gpus: s.gpus,
    minPricePerHourZats: zec(s.min).toString(),
    ...(s.bond !== undefined ? { bondZats: zec(s.bond).toString() } : {}),
    region: s.region,
    updatedAt: now - s.ageMin * 60_000,
    verified: s.verified,
    silent: s.silent,
    latencyRank: s.latencyRank,
    startWithinS: s.startWithinS,
  }));
}

/** Public DTO view of a mock provider (drops the mock-only fields). */
export function toProviderDto(p: MockProvider): ProviderDto {
  const { silent: _s, latencyRank: _l, startWithinS: _w, ...dto } = p;
  return dto;
}

/** The repo's own example job (examples/tiny-train). */
export const DEMO_JOB = {
  path: './examples/tiny-train',
  command: ['python3', 'train.py'],
  image: 'python:3.12-slim',
  bundleBytes: 5373,
  bundleFiles: 3,
  resultBytes: 2376,
  resultFiles: 'model.json · metrics.json · sample.txt',
};

const PREAMBLE = [
  'silicr-runner: bundle verified (3 files, 5373 bytes, sha256 bc4c9b8e…437b); mounted read-only at /job',
  'silicr-runner: docker sandbox · network=none · read-only rootfs · all capabilities dropped',
  'tiny-train: character bigram LM (29 × 29 logits) · 600 steps · batch 64 · lr 5',
  'eval loss at start: 3.3673 (uniform baseline 3.3673)',
];

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `[${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`;
}

export function lossAt(step: number, jitter: number): number {
  return 2.15 + 1.22 * Math.exp(-step / 120) + jitter;
}

/**
 * The i-th log line of the demo job, `elapsedMs` after it started.
 * Training lines are generated from progress, so the script never runs out.
 */
export function logLine(i: number, elapsedMs: number, rng: Rng): { text: string; step: number } {
  const step = Math.min(TOTAL_STEPS, Math.round((TOTAL_STEPS * elapsedMs) / RUN_MS));
  if (i < PREAMBLE.length) return { text: `${clock(elapsedMs)} ${PREAMBLE[i]}`, step: 0 };
  const loss = lossAt(step, (rng.next() - 0.5) * 0.12);
  return { text: `${clock(elapsedMs)} step ${String(step).padStart(5, ' ')}/${TOTAL_STEPS}  loss ${loss.toFixed(4)}`, step };
}

export function checkpointLine(elapsedMs: number, step: number, digest: string): string {
  return `${clock(elapsedMs)} checkpoint saved at step ${step} (eval loss ${lossAt(step, 0.012).toFixed(4)}, sha256 ${digest.slice(0, 8)}…)`;
}

export function finishLines(elapsedMs: number): string[] {
  return [
    `${clock(elapsedMs)} eval loss at end: 2.1795 (start 3.3673)`,
    `${clock(elapsedMs + 300)} sample: 'the relay keeps only what it cannot read, and the chain keeps less'`,
    `${clock(elapsedMs + 600)} wrote model.json, metrics.json, sample.txt to $SILICR_OUTPUT_DIR`,
    `${clock(elapsedMs + 800)} done in ${Math.round(elapsedMs / 1000)}s`,
  ];
}
