// ZEC amounts: bigint zatoshis in code, decimal strings at the edges.

export const ZATS_PER_ZEC = 100_000_000n;

/**
 * Parse a ZEC amount written as a decimal, e.g. "0.8", "0.8zec", "0.8 ZEC/h", "1.25".
 * At most 8 decimal places. A "zats"/"zat" suffix means the number is already zatoshis.
 * Throws on anything else (negative, empty, too many decimals, garbage).
 */
export function parseZec(input: string): bigint {
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

/** 80_000_000n → "0.8". Always a plain decimal with trailing zeros trimmed. */
export function formatZec(zats: bigint): string {
  const neg = zats < 0n;
  const abs = neg ? -zats : zats;
  const whole = abs / ZATS_PER_ZEC;
  const frac = (abs % ZATS_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Parse a decimal zatoshi string from JSON ("125000000"). */
export function parseZats(s: unknown, what = 'amount'): bigint {
  if (typeof s === 'bigint') return s;
  if (typeof s === 'number' && Number.isSafeInteger(s) && s >= 0) return BigInt(s);
  if (typeof s !== 'string' || !/^\d{1,20}$/.test(s)) throw new Error(`${what} must be a decimal zatoshi string`);
  return BigInt(s);
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Price per interval normalised to one hour (rounded down). */
export function perHour(pricePerInterval: bigint, intervalS: number): bigint {
  return (pricePerInterval * 3600n) / BigInt(intervalS);
}

/** Smallest price per interval that is at least `perHourZats` per hour. */
export function perInterval(perHourZats: bigint, intervalS: number): bigint {
  const p = ceilDiv(perHourZats * BigInt(intervalS), 3600n);
  return p > 0n ? p : 1n;
}

/** True if `pricePerInterval` over `intervalS` costs at most `maxPerHour` per hour (exact, no rounding). */
export function withinHourly(pricePerInterval: bigint, intervalS: number, maxPerHour: bigint): boolean {
  return pricePerInterval * 3600n <= maxPerHour * BigInt(intervalS);
}
