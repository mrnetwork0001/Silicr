import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StatusDto } from '@silicr/api';
import { ApiError, DaemonClient, errorMessage } from '../lib/client';
import { hostOf } from '../lib/config';
import { UNSUPPORTED_NETWORK, isSupportedNetwork, probeVerdict, type ProbeResult } from '../lib/driver';
import { readDeal } from './fixtures/load';

const deal = readDeal();
const up = (status: StatusDto) => ({ ok: true as const, status });
const down = (error: string) => ({ ok: false as const, error });
const relay = { ok: false, error: 'Unreachable' };

describe('which daemons the terminal runs against', () => {
  it('runs on Zcash testnet and mainnet only', () => {
    expect(isSupportedNetwork('test')).toBe(true);
    expect(isSupportedNetwork('main')).toBe(true);
    expect(isSupportedNetwork('memory')).toBe(false);
    expect(isSupportedNetwork('regtest')).toBe(false);
  });

  it('starts when a daemon answers on testnet or mainnet', () => {
    const p: ProbeResult = { buyer: up(deal.buyerStatus), provider: up(deal.providerStatus), relay };
    expect(probeVerdict(p)).toBeNull();
    expect(probeVerdict({ ...p, provider: down('Unreachable') })).toBeNull();
    expect(probeVerdict({ ...p, buyer: up({ ...deal.buyerStatus, network: 'main' }), provider: down('x') })).toBeNull();
  });

  it('shows the connect screen when no daemon answers', () => {
    const v = probeVerdict({ buyer: down('Unreachable (Failed to fetch)'), provider: down('Unreachable'), relay });
    expect(v?.mode).toBe('offline');
  });

  it('refuses a daemon on any other network with a plain error', () => {
    const v = probeVerdict({ buyer: up({ ...deal.buyerStatus, network: 'memory' }), provider: up(deal.providerStatus), relay });
    expect(v?.mode).toBe('unsupported');
    expect(v?.error).toContain(UNSUPPORTED_NETWORK);
    expect(UNSUPPORTED_NETWORK).toBe('unsupported network: run the daemon with --network test or main');
    expect(v?.error).toContain('"memory"');
  });
});

describe('daemon base URLs with a path prefix (reverse proxy)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the prefix for every request', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(deal.buyerStatus), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const c = new DaemonClient('https://app.example/buyer/');
    expect(c.url('/api/events')).toBe('https://app.example/buyer/api/events');
    const s = await c.get<StatusDto>('/api/status');
    expect(s.network).toBe('test');
    await c.blob('/api/rfqs/ab/result');
    expect(seen).toEqual(['https://app.example/buyer/api/status', 'https://app.example/buyer/api/rfqs/ab/result']);
    expect(hostOf('https://app.example/buyer')).toBe('app.example/buyer');
    expect(hostOf('http://127.0.0.1:7701')).toBe('127.0.0.1:7701');
  });
});

describe('public demo refusals read as plain messages', () => {
  it('names the demo limit', () => {
    expect(errorMessage(new ApiError('withdrawals are off in the public demo', 403, 'demo_disabled'))).toBe(
      'Disabled in the public demo: withdrawals are off in the public demo',
    );
    expect(errorMessage(new ApiError('3 requests per hour', 429, 'rate_limited'))).toMatch(/^Too many requests from your address/);
    expect(errorMessage(new ApiError('another request is running; try again in a few minutes', 409, 'busy'))).toBe('Busy: another request is running; try again in a few minutes');
  });
});
