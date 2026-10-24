/**
 * LOCAL CONTRACT EXTENSIONS: optional fields the web terminal understands but
 * that are NOT (yet) part of @silicr/api. Every field here is optional, and the
 * UI derives a fallback when a daemon doesn't send it. Proposed upstream as
 * additive changes; see the web agent's report.
 */

import type { LeakField, ProviderJobDto, RfqDto } from '@silicr/api';

/**
 * The key facts in the Leak Inspector's summary matrix.
 * (Not every field maps to one: e.g. a provider's own IP or the GPU request.)
 */
export type FactKey = 'buyer_identity' | 'workload' | 'price' | 'amount' | 'provider_identity' | 'buyer_ip';

export const FACT_KEYS: readonly FactKey[] = [
  'buyer_identity',
  'workload',
  'price',
  'amount',
  'provider_identity',
  'buyer_ip',
];

export function isFactKey(v: unknown): v is FactKey {
  return typeof v === 'string' && (FACT_KEYS as readonly string[]).includes(v);
}

/**
 * EXTENSION of LeakField: `facts` tags which key facts this field carries
 * (in the clear when readable, sealed when not). When absent, the inspector
 * classifies the field from its label. An empty array means "none" explicitly.
 */
export interface LeakFieldExt extends LeakField {
  facts?: FactKey[];
}

export type WatchdogState = 'paid_ahead' | 'grace' | 'paused';

/**
 * EXTENSION of ProviderJobDto: the payment watchdog's own view. When absent,
 * the provider screen derives it from paymentsReceived, servingSeq and policy.
 */
export interface ProviderJobExt extends ProviderJobDto {
  watchdog?: {
    state: WatchdogState;
    /** Highest interval seq paid for (-1 if none). */
    paidThroughSeq: number;
    /** While in grace/paused: when the watchdog escalates (pause, then stop). */
    deadlineAt?: number;
  };
}

/** EXTENSION of RfqDto: when the request reached closed/expired/failed. Bounds the relay time window. */
export interface RfqExt extends RfqDto {
  closedAt?: number;
}

export function fieldFacts(f: LeakField): FactKey[] | undefined {
  const facts = (f as LeakFieldExt).facts;
  return Array.isArray(facts) ? facts.filter(isFactKey) : undefined;
}
