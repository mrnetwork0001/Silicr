/**
 * Observer feed for the Leak Inspector: what the relay operator could learn.
 *
 * Privacy rule: for any body, record at most its first 24 bytes (as hex),
 * its size and a short SHA-256 prefix. Nothing else from a body is ever kept.
 * The relay knows no rfqIds, so observations carry none.
 */
import { createHash } from 'node:crypto';
import type { LeakField, LeakObservation } from '@silicr/api';

export const OBSERVED_PREFIX_BYTES = 24;
const ID_PREFIX = 'relay-';

export class ObserverFeed {
  private readonly max: number;
  private readonly items: { n: number; obs: LeakObservation }[] = [];
  private counter = 0;

  constructor(max: number) {
    this.max = max;
  }

  record(event: string, summary: string, fields: LeakField[], at = Date.now()): LeakObservation {
    const n = ++this.counter;
    const obs: LeakObservation = { id: `${ID_PREFIX}${n}`, party: 'relay', at, event, summary, fields };
    this.items.push({ n, obs });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    return obs;
  }

  /**
   * Observations with id > after, oldest first. `after` is a previous id
   * ("relay-12") or its number ("12"). A cursor from before a relay restart
   * (larger than anything issued) returns everything retained.
   */
  since(after: number, limit: number): LeakObservation[] {
    const start = after > this.counter ? 0 : firstAbove(this.items, after);
    return this.items.slice(start, start + limit).map((i) => i.obs);
  }
}

/** Parse an `after=` cursor: "", "12" or "relay-12". Returns null if malformed. */
export function parseObserverCursor(raw: string | null): number | null {
  if (raw === null || raw === '') return 0;
  const s = raw.startsWith(ID_PREFIX) ? raw.slice(ID_PREFIX.length) : raw;
  if (!/^[0-9]{1,15}$/.test(s)) return null;
  return Number(s);
}

function firstAbove(items: { n: number }[], after: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid]!.n <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function bodyFields(data: Uint8Array): LeakField[] {
  const sha = createHash('sha256').update(data).digest('hex');
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(OBSERVED_PREFIX_BYTES, data.byteLength)).toString('hex');
  return [
    { label: 'size', value: `${data.byteLength} bytes`, readable: true, sensitive: false },
    { label: 'sha256', value: `${sha.slice(0, 16)}…`, readable: true, sensitive: false },
    {
      label: `first ${OBSERVED_PREFIX_BYTES} bytes`,
      value: head + (data.byteLength > OBSERVED_PREFIX_BYTES ? '…' : ''),
      readable: false,
      sensitive: true,
    },
  ];
}

export function clientFields(ip: string, at: number): LeakField[] {
  return [
    { label: 'client ip', value: ip, readable: true, sensitive: true },
    { label: 'time', value: new Date(at).toISOString(), readable: true, sensitive: false },
  ];
}
