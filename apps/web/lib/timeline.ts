/**
 * Leak Inspector time scrub: the request's timeline (RFQ, bids, accept, payments,
 * heartbeats, close) and a store filter that hides everything after the playhead,
 * so every column and the matrix can be rebuilt "as of" any moment.
 * Pure: no React, no I/O.
 */

import type { LeakObservation, Party, ProviderJobDto, PublicTxViewDto, RfqDto } from '@silicr/api';
import type { State } from './store';

export type MarkerKind = 'rfq' | 'bid' | 'accept' | 'pay' | 'heartbeat' | 'close' | 'observation';

export interface Marker {
  at: number;
  kind: MarkerKind;
  /** Short label for a tooltip, e.g. "PAY #3". */
  label: string;
  /** Which party's data the marker comes from. */
  party: Party;
  /** Stable key for React. */
  key: string;
}

export const MARKER_LABEL: Record<MarkerKind, string> = {
  rfq: 'RFQ',
  bid: 'Bid',
  accept: 'Accept',
  pay: 'Payment',
  heartbeat: 'Heartbeat',
  close: 'Close',
  observation: 'Observation',
};

const CLOSED_RFQ = new Set<RfqDto['state']>(['closed', 'expired', 'failed']);
const CLOSED_JOB = new Set<ProviderJobDto['state']>(['done', 'stopped', 'lost']);

export interface TimelineInput {
  rfq: RfqDto | null;
  job: ProviderJobDto | null;
  /** Every party's observations for the request (already filtered to the request / relay window). */
  observations: LeakObservation[];
  now: number;
}

export interface Timeline {
  /** First and last instant on the bar. `end` is `now` while the request is live. */
  start: number;
  end: number;
  closed: boolean;
  /** Sorted by time; heartbeats included. */
  markers: Marker[];
  /** Markers that aren't heartbeats or raw observations: the steps a judge scrubs through. */
  steps: Marker[];
}

function classifyEvent(o: LeakObservation): MarkerKind | null {
  const e = o.event.toLowerCase();
  const s = o.summary.toLowerCase();
  if (/heartbeat/.test(e) || /^heartbeat/.test(s)) return 'heartbeat';
  if (/close/.test(e) || /^close\b|closed\b|\bclose transaction/.test(s)) return 'close';
  return null;
}

/** The request's timeline, from everything this terminal holds about it. */
export function buildTimeline(input: TimelineInput): Timeline {
  const { rfq, job, observations, now } = input;
  const markers: Marker[] = [];
  const seen = new Set<string>();
  const push = (m: Marker) => {
    if (!Number.isFinite(m.at) || m.at <= 0) return;
    if (seen.has(m.key)) return;
    seen.add(m.key);
    markers.push(m);
  };

  if (rfq) {
    push({ at: rfq.createdAt, kind: 'rfq', label: `RFQ sealed to ${rfq.providersAsked} provider${rfq.providersAsked === 1 ? '' : 's'}`, party: 'buyer', key: 'rfq' });
    for (const b of rfq.bids) push({ at: b.receivedAt, kind: 'bid', label: `Bid from ${b.alias}`, party: 'buyer', key: `bid:${b.providerId}` });
    for (const p of rfq.payments) {
      push({ at: p.at, kind: p.kind === 'accept' ? 'accept' : 'pay', label: p.kind === 'accept' ? 'Accept (pays interval #0)' : `PAY #${p.seq}`, party: 'buyer', key: `pay:${p.seq}` });
    }
    for (const h of rfq.heartbeats) push({ at: h.at, kind: 'heartbeat', label: `Heartbeat #${h.seq} (${h.status})`, party: 'buyer', key: `hb:${h.seq}` });
    if (rfq.closedAt && CLOSED_RFQ.has(rfq.state)) push({ at: rfq.closedAt, kind: 'close', label: `Closed: ${rfq.closeReason ?? rfq.state}`, party: 'buyer', key: 'close' });
  }
  if (job) {
    for (const p of job.paymentsReceived) {
      push({ at: p.at, kind: p.kind === 'accept' ? 'accept' : 'pay', label: p.kind === 'accept' ? 'Accept received' : `PAY #${p.seq} received`, party: 'provider', key: `jpay:${p.seq}` });
    }
    if (job.stoppedAt && CLOSED_JOB.has(job.state)) push({ at: job.stoppedAt, kind: 'close', label: `Job ${job.state}`, party: 'provider', key: 'jclose' });
  }
  for (const o of observations) {
    const kind = classifyEvent(o);
    if (kind === 'close' && !seen.has('close') && !seen.has('jclose')) push({ at: o.at, kind, label: o.summary, party: o.party, key: `obs:${o.id}` });
    else if (kind === 'heartbeat') push({ at: o.at, kind, label: o.summary, party: o.party, key: `obs:${o.id}` });
    else push({ at: o.at, kind: 'observation', label: o.summary, party: o.party, key: `obs:${o.id}` });
  }

  markers.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const closed = rfq ? CLOSED_RFQ.has(rfq.state) : job ? CLOSED_JOB.has(job.state) : false;
  const times = markers.map((m) => m.at);
  const first = times.length ? Math.min(...times) : now;
  const last = times.length ? Math.max(...times) : now;
  const start = first;
  const end = closed ? Math.max(last, rfq?.closedAt ?? 0, job?.stoppedAt ?? 0) : Math.max(now, last);
  const steps = markers.filter((m) => m.kind !== 'heartbeat' && m.kind !== 'observation');
  return { start, end: Math.max(end, start), closed, markers, steps };
}

/** Markers at or before the playhead. */
export function markersUntil(markers: Marker[], playhead: number): Marker[] {
  return markers.filter((m) => m.at <= playhead);
}

/** The step a judge is "on": the latest step at or before the playhead, and its index. */
export function currentStep(t: Timeline, playhead: number): { index: number; marker: Marker | null } {
  let index = -1;
  for (let i = 0; i < t.steps.length; i++) if (t.steps[i]!.at <= playhead) index = i;
  return { index, marker: index >= 0 ? t.steps[index]! : null };
}

/** The next marker strictly after the playhead (steps only), or the end. */
export function nextStop(t: Timeline, playhead: number, stops: Marker[] = t.steps): number {
  for (const m of stops) if (m.at > playhead) return m.at;
  return t.end;
}

/** The previous marker strictly before the playhead (steps only), or the start. */
export function prevStop(t: Timeline, playhead: number, stops: Marker[] = t.steps): number {
  let best = t.start;
  for (const m of stops) if (m.at < playhead) best = m.at;
  return best;
}

export function clampPlayhead(t: Timeline, at: number): number {
  return Math.min(t.end, Math.max(t.start, at));
}

/** Playhead position as a fraction of the bar. */
export function fractionOf(t: Timeline, at: number): number {
  const span = t.end - t.start;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (at - t.start) / span));
}

export function atFraction(t: Timeline, f: number): number {
  return t.start + (t.end - t.start) * Math.min(1, Math.max(0, f));
}

/** Compressed playback: the whole timeline passes in about `seconds` of wall time (never faster than 1×). */
export function playbackSpeed(t: Timeline, seconds = 12): number {
  const span = t.end - t.start;
  return Math.max(1, span / (seconds * 1000));
}

// ---------------------------------------------------------------------------
// Store filter: everything a party held by `until`.

function viewSeenAt(view: PublicTxViewDto, seen: Record<string, number>): number {
  const s = seen[view.txid];
  if (s !== undefined) return s;
  return view.time ? view.time * 1000 : 0;
}

/**
 * The store as it was at `until`: observations, public views, bids, payments and heartbeats
 * with a timestamp after the playhead are dropped. Request and job records stay (their ids,
 * states and txids are what the Leak Inspector keys on), but anything time-stamped later is
 * filtered so each column grows step by step. Idempotent and cheap; returns the same object
 * for `until = Infinity`.
 */
export function stateUntil(s: State, until: number): State {
  if (!Number.isFinite(until)) return s;
  const leaks = {} as State['leaks'];
  for (const p of Object.keys(s.leaks) as Party[]) {
    const bucket: Record<string, LeakObservation> = {};
    for (const [id, o] of Object.entries(s.leaks[p])) if (o.at <= until) bucket[id] = o;
    leaks[p] = bucket;
  }
  const chainTx: Record<string, PublicTxViewDto> = {};
  for (const [txid, v] of Object.entries(s.chainTx)) if (viewSeenAt(v, s.chainSeen) <= until) chainTx[txid] = v;

  const rfqs: Record<string, RfqDto> = {};
  for (const [id, r] of Object.entries(s.rfqs)) {
    rfqs[id] = {
      ...r,
      bids: r.bids.filter((b) => b.receivedAt <= until),
      payments: r.payments.filter((p) => p.at <= until),
      heartbeats: r.heartbeats.filter((h) => h.at <= until),
      ...(r.closedAt !== undefined && r.closedAt > until ? { closedAt: undefined } : {}),
    };
  }
  const jobs: Record<string, ProviderJobDto> = {};
  for (const [id, j] of Object.entries(s.jobs)) {
    jobs[id] = {
      ...j,
      paymentsReceived: j.paymentsReceived.filter((p) => p.at <= until),
      ...(j.stoppedAt !== undefined && j.stoppedAt > until ? { stoppedAt: undefined } : {}),
    };
  }
  return { ...s, leaks, chainTx, rfqs, jobs };
}
