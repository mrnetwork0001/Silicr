import { describe, expect, it } from 'vitest';
import { buildInspector, defaultTarget } from '../lib/inspector';
import { getState } from '../lib/store';
import { loadDeal, readDeal } from './fixtures/load';

/** The hosted public demo: daemons say publicDemo (every party on one host) but not demoMode. */
describe('Leak Inspector availability on a public demo', () => {
  it('treats publicDemo like demoMode: relay and provider columns are fetched', () => {
    const d = readDeal();
    loadDeal({ ...d, buyerStatus: { ...d.buyerStatus, demoMode: false, publicDemo: true }, providerStatus: { ...d.providerStatus, demoMode: false, publicDemo: true } });
    const s = getState();
    const data = buildInspector(s, defaultTarget(s, '/'), Date.now());
    expect(data.demo).toBe(true);
    expect(data.columns.relay.available).toBe(true);
    expect(data.columns.provider.available).toBe(true);
    expect(data.columns.buyer.available).toBe(true);
  });

  it('without either flag only the home party and the chain are shown', () => {
    const d = readDeal();
    loadDeal({ ...d, buyerStatus: { ...d.buyerStatus, demoMode: false }, providerStatus: { ...d.providerStatus, demoMode: false } });
    const s = getState();
    const data = buildInspector(s, defaultTarget(s, '/'), Date.now());
    expect(data.demo).toBe(false);
    expect(data.columns.relay.available).toBe(false);
    expect(data.columns.provider.available).toBe(false);
    expect(data.columns.relay.reason).toMatch(/Not in demo mode/);
  });
});
