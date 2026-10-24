/**
 * Formatting helpers. Money stays bigint zatoshis until the last moment; JSON
 * carries it as decimal strings (see @silicr/api).
 */

import type { CloseReason, NetworkName, ProviderJobState, RfqState } from '@silicr/api';

export const ZATS_PER_ZEC = 100_000_000n;

export type ZatsLike = bigint | string | number | null | undefined;

/** Lenient conversion: decimal-zatoshi strings, numbers and bigints. Junk becomes 0n. */
export function toZats(z: ZatsLike): bigint {
  if (typeof z === 'bigint') return z;
  if (typeof z === 'number') return Number.isFinite(z) ? BigInt(Math.trunc(z)) : 0n;
  if (typeof z === 'string') {
    const s = z.trim();
    if (/^-?\d+$/.test(s)) return BigInt(s);
  }
  return 0n;
}

const group3 = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export interface ZecFormatOptions {
  /** 0..8, default 8. Rounds half away from zero. */
  maxDecimals?: number;
  /** Pad with zeros to at least this many decimals. Default 0. */
  minDecimals?: number;
  /** Thousands separators in the integer part. Default true. */
  group?: boolean;
}

/** "0.0125", "1,250", "0.00000001": compact decimal ZEC with up to 8 decimals. */
export function zecString(zats: ZatsLike, opts: ZecFormatOptions = {}): string {
  const maxDecimals = Math.max(0, Math.min(8, opts.maxDecimals ?? 8));
  const minDecimals = Math.max(0, Math.min(maxDecimals, opts.minDecimals ?? 0));
  let v = toZats(zats);
  const negative = v < 0n;
  if (negative) v = -v;

  const scale = 10n ** BigInt(8 - maxDecimals);
  const rounded = (v + scale / 2n) / scale; // value in units of 10^-maxDecimals ZEC
  const unit = 10n ** BigInt(maxDecimals);
  const intPart = (rounded / unit).toString();
  let frac = maxDecimals > 0 ? (rounded % unit).toString().padStart(maxDecimals, '0') : '';
  frac = frac.replace(/0+$/, '');
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, '0');

  const intStr = opts.group === false ? intPart : group3(intPart);
  const sign = negative && (rounded !== 0n) ? '-' : '';
  return frac ? `${sign}${intStr}.${frac}` : `${sign}${intStr}`;
}

/** "0.0125 ZEC" */
export function formatZec(zats: ZatsLike, opts?: ZecFormatOptions): string {
  return `${zecString(zats, opts)} ZEC`;
}

/**
 * Parse a user-typed ZEC amount ("0.8", ".5", "12", "1,000.25") into zatoshis.
 * Returns null for empty, negative, malformed or over-precise (> 8 decimals) input.
 */
export function parseZec(input: string): bigint | null {
  const s = input.trim().replace(/,/g, '');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const intDigits = m[1] ?? '';
  const fracDigits = m[2] ?? '';
  if (!intDigits && !fracDigits) return null;
  if (fracDigits.length > 8) return null;
  const int = intDigits ? BigInt(intDigits) : 0n;
  const frac = fracDigits ? BigInt(fracDigits.padEnd(8, '0')) : 0n;
  return int * ZATS_PER_ZEC + frac;
}

/** Price per interval → price per hour (both zatoshis). */
export function perHourZats(perIntervalZats: ZatsLike, intervalS: number): bigint {
  if (!intervalS || intervalS <= 0) return 0n;
  return (toZats(perIntervalZats) * 3600n) / BigInt(Math.round(intervalS));
}

/** Price per hour → price per interval (floor). */
export function perIntervalZats(perHour: ZatsLike, intervalS: number): bigint {
  return (toZats(perHour) * BigInt(Math.round(intervalS))) / 3600n;
}

// ---------------------------------------------------------------------------
// Strings, hashes and addresses

export function truncateMiddle(s: string, head = 6, tail = 4): string {
  if (!s) return s;
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Unified, Sapling or transparent Zcash address shape (not a validity check). */
export function looksLikeAddress(s: string): boolean {
  const v = s.trim();
  if (v.length < 30) return false;
  return (
    /^(u|utest|uregtest|zs|ztestsapling)1[02-9ac-hj-np-z]+$/.test(v) || // bech32(m)
    /^t[13m][1-9A-HJ-NP-Za-km-z]+$/.test(v) // base58 transparent
  );
}

/** Long lowercase hex such as txids, keys, digests and ciphertext samples (possibly pre-truncated with "…"). */
export function looksLikeHex(s: string): boolean {
  return /^(0x)?[0-9a-f]{16,}…?$/i.test(s.trim());
}

/** Truncate long machine strings (hex, addresses) and leave prose alone. */
export function compactValue(s: string): string {
  const v = s.trim();
  if (looksLikeAddress(v)) return truncateMiddle(v, 10, 6);
  if (looksLikeHex(v)) return v.endsWith('…') ? `${v.slice(0, 14)}…` : truncateMiddle(v, 8, 6);
  return v;
}

// ---------------------------------------------------------------------------
// Numbers, sizes, times

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return group3(Math.round(n).toString());
}

export function formatHeight(h: number | null | undefined): string {
  if (h === null || h === undefined) return 'mempool';
  return formatInt(h);
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "20 s", "10 min", "1 h", "1 h 30 min", "2 d 4 h" */
export function formatDuration(totalS: number | null | undefined): string {
  if (totalS === null || totalS === undefined || !Number.isFinite(totalS)) return '—';
  const s = Math.max(0, Math.round(totalS));
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} min ${r} s` : `${m} min`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** "0:12", "9:59", "1:02:03". Negative values clamp to 0:00. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** "13:04:12" (24 h, local time) */
export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return timeFmt.format(new Date(ms));
}

/** "13:04:12" today, "3 Oct 13:04" otherwise. */
export function formatDateTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return formatTime(ms);
  return `${dateFmt.format(d)} ${formatTime(ms).slice(0, 5)}`;
}

/** "just now", "12 s ago", "4 min ago", "2 h ago", "3 d ago" */
export function formatAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const d = Math.round((now - ms) / 1000);
  if (d < 2) return 'just now';
  if (d < 60) return `${d} s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

// ---------------------------------------------------------------------------
// Domain labels

/** "a100" for "NVIDIA A100-SXM4-80GB"-style strings: lowercase, alphanumerics only. */
export function normalizeGpu(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const GPU_LABELS: Record<string, string> = {
  h100: 'H100',
  h200: 'H200',
  a100: 'A100',
  l40s: 'L40S',
  l4: 'L4',
  a10g: 'A10G',
  rtx4090: 'RTX 4090',
  rtx3090: 'RTX 3090',
  mi300x: 'MI300X',
  cpu: 'CPU',
};

export function gpuLabel(model: string): string {
  const n = normalizeGpu(model);
  return GPU_LABELS[n] ?? model.toUpperCase();
}

export const RFQ_STATE_LABEL: Record<RfqState, string> = {
  broadcasting: 'Broadcasting',
  collecting: 'Collecting bids',
  accepted: 'Accepted',
  running: 'Running',
  closing: 'Closing',
  closed: 'Closed',
  expired: 'Expired',
  failed: 'Failed',
};

export const JOB_STATE_LABEL: Record<ProviderJobState, string> = {
  bid: 'Bid sent',
  won: 'Won',
  lost: 'Lost',
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  done: 'Done',
};

export const CLOSE_REASON_LABEL: Record<CloseReason, string> = {
  done: 'Job finished',
  buyer_stop: 'Stopped by buyer',
  provider_stop: 'Stopped by provider',
  unpaid: 'Stopped: payment missed',
  no_heartbeat: 'Stopped: heartbeats lost',
  error: 'Error',
};

/**
 * The terminal runs on Zcash testnet or mainnet only. `short` drops the REAL ZEC suffix where a
 * REAL ZEC chip sits right next to the label.
 */
export function networkLabel(n: NetworkName, opts: { short?: boolean } = {}): string {
  switch (n) {
    case 'test':
      return 'Zcash testnet';
    case 'main':
      return opts.short ? 'Zcash mainnet' : 'Zcash mainnet · REAL ZEC';
    default:
      return `unsupported network (${String(n)})`;
  }
}

/** True for the networks where transactions spend real or faucet coins on a public chain. */
export function isRealChain(n: NetworkName | null | undefined): boolean {
  return n === 'main' || n === 'test';
}

/** Split a command line into argv, honouring single and double quotes and backslash escapes. */
export function splitArgv(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Inverse of splitArgv, for display. */
export function joinArgv(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** RFQ output padding bucket: recipients + change, rounded up to 4 · 8 · 16 · 32. */
export function paddedOutputsFor(recipients: number): number {
  const needed = recipients + 1;
  for (const b of [4, 8, 16, 32]) if (needed <= b) return b;
  return Math.ceil(needed / 16) * 16;
}

/** ZIP 317 conventional fee: 5000 zats per logical action, 2 grace actions. */
export function zip317Fee(actions: number): bigint {
  return 5000n * BigInt(Math.max(2, actions));
}
