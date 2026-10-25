// Public demo mode (`--public-demo`, `--public-origin`, `--trust-proxy`): presets only, small
// limits, one live request, a per-IP rate limit, disabled endpoints, hosted Origin/Host rules.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import type { ErrorDto, RfqDto, StatusDto } from '@silicr/api';
import { createMemoryNetwork, type ZecBackend } from '@silicr/zec';
import { join } from 'node:path';
import { BuyerNode } from '../src/buyer.ts';
import { startDaemon, type RunningDaemon } from '../src/daemon.ts';
import type { JobPreset } from '../src/presets.ts';
import { DEFAULT_PRESETS, PUBLIC_DEMO_INTERVAL_S } from '../src/presets.ts';
import { FakeRelay, fakeBundles, makeWorld, tempDir, waitFor, type World } from './helpers.ts';

const PUBLIC = 'https://app.silicr.38-49-213-208.sslip.io';
const MAX = '50000000'; // 0.5 ZEC/h, the demo ceiling; the test provider asks 0.36 ZEC/h

let w: World;
let presets: JobPreset[];
let buyerD: RunningDaemon;
let providerD: RunningDaemon;

beforeAll(async () => {
  w = await makeWorld({ providers: [{ name: 'p1', script: { steps: 40, stepMs: 100 } }] });
  presets = [{ id: 'tiny-train', title: 'Tiny', description: 'd', command: ['python3', 'train.py'], gpu: 'a100', durationS: 60, path: w.jobDir, env: { SILICR_STEPS: '5' } }];
  buyerD = await startDaemon({ node: w.buyer, port: 0, publicDemo: { presets }, publicOrigins: [PUBLIC], trustProxy: true });
  providerD = await startDaemon({ node: w.providers[0]!, port: 0, publicDemo: true, publicOrigins: [PUBLIC] });
});

afterAll(async () => {
  await buyerD?.close();
  await providerD?.close();
  await w?.close();
});

async function call<T>(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

const rfq = (job: unknown, extra: Record<string, unknown> = {}) => ({ gpu: 'a100', count: 1, durationS: 60, maxPricePerHourZats: MAX, job, ...extra });

function hostStatus(url: string, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = request(`${url}/api/status`, { headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('public demo: status', () => {
  it('buyer status says publicDemo and lists presets without paths or env; provider says publicDemo', async () => {
    const b = await call<StatusDto>(buyerD.url, 'GET', '/api/status');
    expect(b.body.publicDemo).toBe(true);
    expect(b.body.presets).toEqual([{ id: 'tiny-train', title: 'Tiny', description: 'd', command: ['python3', 'train.py'], gpu: 'a100', durationS: 60 }]);
    expect(JSON.stringify(b.body.presets)).not.toContain(w.jobDir);
    expect(b.body.publicDemoLimits).toEqual({ maxDurationS: 900, maxCount: 1, maxActive: 1, perIpPerHour: 3, maxPricePerHourZats: '50000000', minWorstCaseZats: '873334' });
    const p = await call<StatusDto>(providerD.url, 'GET', '/api/status');
    expect(p.body.publicDemo).toBe(true);
    expect(p.body.presets).toBeUndefined();
    // Every party of a public demo runs on one host: the Leak Inspector may read all their views.
    expect(b.body.demoMode).toBe(true);
    expect(p.body.demoMode).toBe(true);
  });

  it('a normal daemon reports no publicDemo', async () => {
    const d = await startDaemon({ node: w.buyer, port: 0 });
    try {
      const s = await call<StatusDto>(d.url, 'GET', '/api/status');
      expect(s.body.publicDemo).toBeUndefined();
      expect(s.body.presets).toBeUndefined();
      expect(s.body.demoMode).toBe(false);
    } finally {
      await d.close();
    }
  });

  it('default presets point at examples/tiny-train', () => {
    expect(DEFAULT_PRESETS.map((p) => p.id)).toEqual(['tiny-train', 'tiny-train-quick', 'tiny-train-long']);
    for (const p of DEFAULT_PRESETS) expect(p.path).toMatch(/examples\/tiny-train$/);
    // The long run shows a PAY train: ~8 min of steps inside a 15 min request, several 60 s intervals.
    const long = DEFAULT_PRESETS.find((p) => p.id === 'tiny-train-long')!;
    expect(long.env).toEqual({ SILICR_STEPS: '2000', SILICR_STEP_DELAY_MS: '250' });
    expect(long.durationS).toBe(900);
    expect(PUBLIC_DEMO_INTERVAL_S).toBe(60);
  });
});

/** Collect SSE `status` events until `count` of them arrived (or timeout). */
async function statusEvents(base: string, count: number, timeoutMs = 10_000): Promise<StatusDto[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const out: StatusDto[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const e = JSON.parse(line.slice(6)) as { type: string; status?: StatusDto };
          if (e.type === 'status' && e.status) out.push(e.status);
        }
      }
    }
  } catch {
    // aborted
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return out;
}

/** Everything but the fields the simulated chain moves between two reads. */
const stable = ({ height: _h, balance: _b, ...rest }: StatusDto) => rest;

describe('public demo: SSE status events', () => {
  it('the status event on /api/events is the same DTO as GET /api/status (publicDemo, presets, limits, demoExhausted)', async () => {
    // The terminal races GET /api/status against the SSE snapshot: both must carry the demo view, or
    // it renders the full job form and no demo banner (seen on the hosted mainnet demo).
    for (const d of [buyerD, providerD]) {
      const get = (await call<StatusDto>(d.url, 'GET', '/api/status')).body;
      const [snapshot] = await statusEvents(d.url, 1);
      expect(snapshot, d === buyerD ? 'buyer' : 'provider').toBeDefined();
      expect(Object.keys(snapshot!).sort()).toEqual(Object.keys(get).sort());
      expect(stable(snapshot!)).toEqual(stable(get));
    }
    const [b] = await statusEvents(buyerD.url, 1);
    expect(b!.publicDemo).toBe(true);
    expect(b!.demoMode).toBe(true);
    expect(b!.presets).toEqual([{ id: 'tiny-train', title: 'Tiny', description: 'd', command: ['python3', 'train.py'], gpu: 'a100', durationS: 60 }]);
    expect(b!.publicDemoLimits).toEqual({ maxDurationS: 900, maxCount: 1, maxActive: 1, perIpPerHour: 3, maxPricePerHourZats: '50000000', minWorstCaseZats: '873334' });
    expect(b!.demoExhausted).toBe(false);
  });

  it('the periodic status push carries the demo view too', async () => {
    // A fast status timer: the simulated chain's height moves, so a second (pushed) status event follows the snapshot.
    const d = await startDaemon({ node: w.buyer, port: 0, publicDemo: { presets }, statusIntervalMs: 50 });
    try {
      const events = await statusEvents(d.url, 2);
      expect(events.length).toBe(2);
      const get = (await call<StatusDto>(d.url, 'GET', '/api/status')).body;
      for (const e of events) {
        expect(Object.keys(e).sort()).toEqual(Object.keys(get).sort());
        expect(stable(e)).toEqual(stable(get));
      }
    } finally {
      await d.close();
    }
  });
});

describe('public demo: POST /api/rfqs', () => {
  it('refuses a folder/command job, unknown presets and anything over the limits', async () => {
    const bad = async (body: unknown, re: RegExp) => {
      const r = await call<ErrorDto>(buyerD.url, 'POST', '/api/rfqs', body);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('bad_request');
      expect(r.body.error).toMatch(re);
    };
    await bad(rfq({ path: w.jobDir, command: ['python3', 'train.py'] }), /preset/);
    await bad(rfq({ preset: 'mine-bitcoin' }), /unknown preset/);
    await bad(rfq({ preset: 'tiny-train' }, { durationS: 901 }), /durationS/);
    await bad(rfq({ preset: 'tiny-train' }, { count: 2 }), /count/);
    await bad(rfq({ preset: 'tiny-train' }, { maxPricePerHourZats: '50000001' }), /maxPricePerHourZats/);
    expect(w.buyer.listRfqs()).toHaveLength(0);
  });

  it('runs the server-side preset (client path/command/env ignored), then answers 409 busy while it is live', async () => {
    const created = await call<{ rfqId: string }>(
      buyerD.url,
      'POST',
      '/api/rfqs',
      rfq({ preset: 'tiny-train', path: '/etc', command: ['sh', '-c', 'cat /etc/passwd'], env: { X: '1' }, image: 'evil' }, { autoAccept: { rule: 'cheapest', waitBlocks: 1 } }),
      { 'X-Forwarded-For': '203.0.113.7' },
    );
    expect(created.status).toBe(201);
    const busy = await call<ErrorDto>(buyerD.url, 'POST', '/api/rfqs', rfq({ preset: 'tiny-train' }), { 'X-Forwarded-For': '203.0.113.8' });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('busy');
    expect(busy.body.error).toMatch(/one request at a time/);
    const runner = w.runners[0]!;
    const h = await waitFor(() => runner.handles[0], 'job started');
    expect(h.spec.command).toEqual(['python3', 'train.py']);
    expect(h.spec.image ?? 'python:3.12-slim').toBe('python:3.12-slim');
    expect(h.spec.env?.['X']).toBeUndefined();
    expect(h.spec.env?.['SILICR_STEPS']).toBe('5');
    await call(buyerD.url, 'POST', `/api/rfqs/${created.body.rfqId}/stop`);
    await waitFor(async () => {
      const r = (await call<RfqDto>(buyerD.url, 'GET', `/api/rfqs/${created.body.rfqId}`)).body;
      return r.state === 'closed' || r.state === 'failed' ? r : null;
    }, 'closed', 20_000);
  }, 30_000);

  it('auto-accepts the cheapest bid when the request says nothing about it; only the creating visitor may stop, accept or fault it', async () => {
    const mine = { 'X-Forwarded-For': '203.0.113.21' };
    const other = { 'X-Forwarded-For': '203.0.113.22' };
    const created = await call<{ rfqId: string }>(buyerD.url, 'POST', '/api/rfqs', rfq({ preset: 'tiny-train' }), mine);
    expect(created.status).toBe(201);
    const id = created.body.rfqId;
    // Nobody calls accept: the daemon filled in autoAccept (cheapest, 1 block) and the deal goes ahead on its own.
    await waitFor(async () => {
      const r = (await call<RfqDto>(buyerD.url, 'GET', `/api/rfqs/${id}`)).body;
      return r.state === 'accepted' || r.state === 'running' ? r : null;
    }, 'auto-accepted', 20_000);
    // Another visitor cannot touch it.
    for (const [path, body] of [
      [`/api/rfqs/${id}/stop`, {}],
      [`/api/rfqs/${id}/accept`, { providerId: 'ab'.repeat(32) }],
      [`/api/rfqs/${id}/fault`, { fault: 'stop_paying' }],
    ] as [string, unknown][]) {
      const r = await call<ErrorDto>(buyerD.url, 'POST', path, body, other);
      expect(r.status, path).toBe(403);
      expect(r.body.code).toBe('demo_other_visitor');
      expect(r.body.error).toMatch(/another visitor/);
    }
    // The creator can.
    const stopped = await call<RfqDto>(buyerD.url, 'POST', `/api/rfqs/${id}/stop`, {}, mine);
    expect(stopped.status).toBe(200);
    await waitFor(async () => {
      const r = (await call<RfqDto>(buyerD.url, 'GET', `/api/rfqs/${id}`)).body;
      return r.state === 'closed' || r.state === 'failed' ? r : null;
    }, 'closed', 20_000);
  }, 45_000);

  it('a request nobody accepts expires acceptWindowBlocks after its bid window, freeing the slot', async () => {
    // autoAccept: null = manual acceptance; the bids arrive and nobody accepts.
    const created = await call<{ rfqId: string }>(buyerD.url, 'POST', '/api/rfqs', rfq({ preset: 'tiny-train' }, { autoAccept: null }), { 'X-Forwarded-For': '203.0.113.31' });
    expect(created.status).toBe(201);
    const id = created.body.rfqId;
    const collecting = await waitFor(async () => {
      const r = (await call<RfqDto>(buyerD.url, 'GET', `/api/rfqs/${id}`)).body;
      return r.state === 'collecting' && r.bids.length > 0 ? r : null;
    }, 'a bid', 20_000);
    const expired = await waitFor(async () => {
      const r = (await call<RfqDto>(buyerD.url, 'GET', `/api/rfqs/${id}`)).body;
      return r.state === 'expired' ? r : null;
    }, 'expired', 30_000);
    expect(expired.error).toMatch(/not accepted in time/);
    // The memory profile alone would have waited 120 blocks; the demo cap is 4 blocks past expiresHeight.
    expect(w.buyer.record(id)!.expiresHeight + 4).toBeLessThanOrEqual(await w.buyer.status().then((s) => s.height));
    expect(collecting.expiresHeight).toBe(expired.expiresHeight);
    // Too late to accept now, and the slot is free again.
    const late = await call<ErrorDto>(buyerD.url, 'POST', `/api/rfqs/${id}/accept`, { providerId: collecting.bids[0]!.providerId }, { 'X-Forwarded-For': '203.0.113.31' });
    expect(late.status).toBe(409);
    expect((await call<ErrorDto>(buyerD.url, 'POST', '/api/rfqs', rfq({ preset: 'tiny-train' }, { providerIds: ['ff'.repeat(32)] }), { 'X-Forwarded-For': '203.0.113.32' })).status).toBe(400);
  }, 60_000);

  it('rate limits per client IP (X-Forwarded-For with --trust-proxy), resetting after an hour', async () => {
    let now = 1_000_000;
    const d = await startDaemon({ node: w.buyer, port: 0, trustProxy: true, publicDemo: { presets, maxActive: 100, perIpPerHour: 2, now: () => now } });
    try {
      // Invalid bodies are refused before the limiter: they don't use up the quota.
      const post = (ip: string, xff = `198.51.100.1, ${ip}`) => call<ErrorDto>(d.url, 'POST', '/api/rfqs', rfq({ preset: 'tiny-train' }, { providerIds: ['ff'.repeat(32)] }), { 'X-Forwarded-For': xff });
      // providerIds names nobody: each request passes the demo checks and then fails in the node (400).
      expect((await post('192.0.2.1')).status).toBe(400);
      expect((await post('192.0.2.1')).status).toBe(400);
      const limited = await post('192.0.2.1');
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(limited.body.error).toMatch(/2 requests per hour/);
      // Only the last X-Forwarded-For entry (the proxy's) counts: a spoofed first entry doesn't help.
      expect((await post('192.0.2.1', '10.9.9.9, 192.0.2.1')).status).toBe(429);
      expect((await post('192.0.2.2')).status).toBe(400);
      now += 3_600_001;
      expect((await post('192.0.2.1')).status).toBe(400);
    } finally {
      await d.close();
    }
  });

  it('without --trust-proxy, X-Forwarded-For is ignored', async () => {
    const d = await startDaemon({ node: w.buyer, port: 0, publicDemo: { presets, maxActive: 100, perIpPerHour: 1 } });
    try {
      const post = (xff: string) => call<ErrorDto>(d.url, 'POST', '/api/rfqs', rfq({ preset: 'tiny-train' }, { providerIds: ['ee'.repeat(32)] }), { 'X-Forwarded-For': xff });
      expect((await post('192.0.2.10')).status).toBe(400);
      expect((await post('192.0.2.11')).status).toBe(429);
    } finally {
      await d.close();
    }
  });
});

describe('public demo: disabled endpoints', () => {
  it('withdraw, policy, provider job stop and migrate answer 403 demo_disabled; faults stay', async () => {
    const id = '00'.repeat(16);
    const cases: [RunningDaemon, string, string, unknown][] = [
      [buyerD, 'POST', '/api/wallet/withdraw', { to: 'utest1x', amount: 'all' }],
      [providerD, 'POST', '/api/wallet/withdraw', { to: 'utest1x', amount: 'all' }],
      [providerD, 'PUT', '/api/policy', { minPricePerHourZats: '1' }],
      [providerD, 'POST', `/api/jobs/${id}/stop`, {}],
      [buyerD, 'POST', `/api/rfqs/${id}/migrate`, {}],
    ];
    for (const [d, method, path, body] of cases) {
      const r = await call<ErrorDto>(d.url, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.code).toBe('demo_disabled');
    }
    expect((await call<ErrorDto>(providerD.url, 'GET', '/api/policy')).status).toBe(200);
    const fault = await call<ErrorDto>(buyerD.url, 'POST', `/api/rfqs/${id}/fault`, { fault: 'stop_paying' });
    expect(fault.status).toBe(404); // reaches the node: unknown RFQ, not refused
  });
});

describe('public origin and Host rules', () => {
  it('allows the public Origin and Host, still the loopback ones, nothing else', async () => {
    const ok = await call<StatusDto>(buyerD.url, 'GET', '/api/status', undefined, { Origin: PUBLIC });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(PUBLIC);
    expect((await call<ErrorDto>(buyerD.url, 'GET', '/api/status', undefined, { Origin: 'https://evil.example' })).status).toBe(403);
    expect(await hostStatus(buyerD.url, 'app.silicr.38-49-213-208.sslip.io')).toBe(200);
    expect(await hostStatus(buyerD.url, 'APP.silicr.38-49-213-208.sslip.io:443')).toBe(200);
    expect(await hostStatus(buyerD.url, '127.0.0.1:7701')).toBe(200);
    expect(await hostStatus(buyerD.url, 'attacker.example')).toBe(403);
  });

  it('a non-loopback bind needs --public-origin; a bad origin is refused', async () => {
    await expect(startDaemon({ node: w.buyer, port: 0, host: '0.0.0.0' })).rejects.toThrow(/--public-origin/);
    await expect(startDaemon({ node: w.buyer, port: 0, publicOrigins: ['not a url'] })).rejects.toThrow(/not a URL/);
  });
});

describe('public demo refuses mainnet', () => {
  it('startDaemon throws for a mainnet node', async () => {
    const net = createMemoryNetwork({ blockTimeMs: 0 });
    const inner = net.wallet('m', { fundZats: 1_000_000n });
    const backend = Object.create(inner, { network: { value: 'main', enumerable: true } }) as ZecBackend;
    const node = new BuyerNode({ backend, relay: new FakeRelay(), dataDir: join(await tempDir(), 'b'), deps: { ...fakeBundles } });
    await expect(startDaemon({ node, port: 0, publicDemo: true })).rejects.toThrow(/refused on Zcash mainnet/);
    net.stop();
  });
});
