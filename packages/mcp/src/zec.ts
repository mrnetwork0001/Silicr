// ZEC amounts: bigint zatoshis in code, decimal strings in JSON. Same rules as @silicr/engine's
// zats.ts, copied here so the MCP server links nothing but the daemon's HTTP contract (no wallet code).

export const ZATS_PER_ZEC = 100_000_000n;

/**
 * Parse a ZEC amount: "0.8", "0.8zec", "0.8 ZEC/h", "125000zats", or a number (rounded to 8 decimals).
 * Throws on anything else (negative, empty, too many decimals, garbage).
 */
export function parseZec(input: string | number): bigint {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`not a ZEC amount: ${input}`);
    input = input.toFixed(8);
  }
  let s = String(input).trim().toLowerCase().replace(/\s+/g, '');
  s = s.replace(/\/(h|hr|hour)$/, '');
  if (/^\d+(zats?|zatoshis?)$/.test(s)) return BigInt(s.replace(/[a-z]+$/, ''));
  s = s.replace(/(zec|taz)$/, '');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] === undefined || m[2] === ''))) throw new Error(`not a ZEC amount: "${input}"`);
  const whole = m[1] === '' ? '0' : m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > 8) throw new Error(`too many decimal places (max 8): "${input}"`);
  return BigInt(whole) * ZATS_PER_ZEC + BigInt((frac + '00000000').slice(0, 8));
}

/** 80_000_000n → "0.8": a plain decimal with trailing zeros trimmed. */
export function formatZec(zats: bigint): string {
  const neg = zats < 0n;
  const abs = neg ? -zats : zats;
  const whole = abs / ZATS_PER_ZEC;
  const frac = (abs % ZATS_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** A decimal zatoshi string from a DTO ("125000000") as bigint; anything unparseable counts as 0. */
export function zatsOf(s: unknown): bigint {
  if (typeof s === 'bigint') return s;
  if (typeof s === 'number' && Number.isSafeInteger(s) && s >= 0) return BigInt(s);
  if (typeof s === 'string' && /^\d{1,20}$/.test(s)) return BigInt(s);
  return 0n;
}

/** DTO zatoshi string → ZEC decimal string. */
export function zec(s: unknown): string {
  return formatZec(zatsOf(s));
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Smallest price per interval that is at least `perHourZats` per hour (what a provider bids). */
export function perInterval(perHourZats: bigint, intervalS: number): bigint {
  const p = ceilDiv(perHourZats * BigInt(intervalS), 3600n);
  return p > 0n ? p : 1n;
}

/** Price per interval normalised to one hour (rounded down). */
export function perHour(pricePerInterval: bigint, intervalS: number): bigint {
  return (pricePerInterval * 3600n) / BigInt(intervalS);
}
