import { beforeAll, describe, expect, it } from 'vitest';
import { PARTIES } from '../lib/facts';
import { buildInspector, defaultTarget } from '../lib/inspector';
import { getState } from '../lib/store';
import { loadDeal, type DealFixture } from './fixtures/load';
import { buildTimeline, clampPlayhead, currentStep, markersUntil, nextStop, prevStop, stateUntil, type Timeline } from '../lib/timeline';

let deal: DealFixture;
let rfqId: string;
let now: number;

beforeAll(() => {
  deal = loadDeal(); // a finished deal as both daemons and the relay observer reported it
  now = Date.now();
  rfqId = defaultTarget(getState(), '/')!;
});

function timelineFor(): Timeline {
  const s = getState();
  const full = buildInspector(s, rfqId, now);
  return buildTimeline({ rfq: full.rfq, job: full.job, observations: PARTIES.flatMap((p) => full.columns[p].observations.map((o) => o.obs)), now });
}

describe('buildTimeline (a finished request from real daemon DTOs)', () => {
  it('has the request steps in order: RFQ, bid(s), accept, payments, close', () => {
    const t = timelineFor();
    expect(t.closed).toBe(true);
    const kinds = t.steps.map((m) => m.kind);
    expect(kinds[0]).toBe('rfq');
    expect(kinds).toContain('bid');
    expect(kinds).toContain('accept');
    expect(kinds.filter((k) => k === 'pay').length).toBeGreaterThan(0);
    expect(kinds[kinds.length - 1]).toBe('close');
    for (let i = 1; i < t.markers.length; i++) expect(t.markers[i]!.at).toBeGreaterThanOrEqual(t.markers[i - 1]!.at);
    expect(t.start).toBeLessThan(t.end);
    expect(t.markers.some((m) => m.kind === 'heartbeat')).toBe(true);
    expect(t.markers.some((m) => m.kind === 'observation' && m.party === 'relay')).toBe(true);
  });

  it('steps between markers with ←/→ semantics and clamps', () => {
    const t = timelineFor();
    const first = t.steps[0]!.at;
    expect(prevStop(t, first)).toBe(t.start);
    expect(nextStop(t, first)).toBe(t.steps[1]!.at);
    expect(nextStop(t, t.end)).toBe(t.end);
    expect(clampPlayhead(t, t.start - 1e9)).toBe(t.start);
    expect(clampPlayhead(t, t.end + 1e9)).toBe(t.end);
    expect(currentStep(t, t.start - 1).index).toBe(-1);
    expect(currentStep(t, t.end).index).toBe(t.steps.length - 1);
    expect(markersUntil(t.markers, t.start - 1)).toHaveLength(0);
    expect(markersUntil(t.markers, t.end)).toHaveLength(t.markers.length);
  });
});

describe('stateUntil + buildInspector (knowledge grows with the playhead)', () => {
  it('shows nothing before the RFQ and everything at the end', () => {
    const s = getState();
    const t = timelineFor();
    const before = buildInspector(stateUntil(s, t.start - 1), rfqId, t.start - 1);
    for (const p of PARTIES) expect(before.columns[p].observations).toHaveLength(0);
    const end = buildInspector(stateUntil(s, t.end), rfqId, now);
    const full = buildInspector(s, rfqId, now);
    for (const p of PARTIES) expect(end.columns[p].observations.length).toBe(full.columns[p].observations.length);
    expect(end.matrix).toEqual(full.matrix);
    expect(stateUntil(s, Infinity)).toBe(s);
  });

  it('is monotone: every column only grows, and the matrix never un-knows a fact', () => {
    const s = getState();
    const t = timelineFor();
    const full = buildInspector(s, rfqId, now);
    let prev = buildInspector(stateUntil(s, t.start - 1), rfqId, t.start - 1);
    const knownAt = (d: typeof full, p: (typeof PARTIES)[number]) => Object.values(d.matrix).filter((row) => row[p].state === 'knows').length;
    for (const m of t.steps) {
      const d = buildInspector(stateUntil(s, m.at), rfqId, m.at);
      for (const p of PARTIES) {
        expect(d.columns[p].observations.length).toBeGreaterThanOrEqual(prev.columns[p].observations.length);
        for (const o of d.columns[p].observations) expect(o.obs.at).toBeLessThanOrEqual(m.at);
        expect(knownAt(d, p)).toBeGreaterThanOrEqual(knownAt(prev, p));
      }
      expect(d.txids.length).toBeGreaterThanOrEqual(prev.txids.length);
      prev = d;
    }
    // The relay sees nothing until the first blob is uploaded, then more with each step.
    const atRfq = buildInspector(stateUntil(s, t.steps[0]!.at), rfqId, t.steps[0]!.at);
    expect(atRfq.columns.relay.observations.length).toBeLessThan(full.columns.relay.observations.length);
  });

  it('filters bids, payments and heartbeats on the request record too', () => {
    const s = getState();
    const r = s.rfqs[rfqId]!;
    const accept = r.payments.find((p) => p.kind === 'accept')!;
    const cut = stateUntil(s, accept.at);
    expect(cut.rfqs[rfqId]!.payments).toHaveLength(1);
    expect(cut.rfqs[rfqId]!.heartbeats.every((h) => h.at <= accept.at)).toBe(true);
    expect(cut.rfqs[rfqId]!.closedAt).toBeUndefined();
  });
});
