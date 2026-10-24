// The daemon's HTTP surface: every @silicr/api endpoint for both roles, SSE, CORS and guards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import type { DaemonEvent, ErrorDto, LeakObservation, ProviderDto, ProviderJobDto, ProviderPolicyDto, PublicTxViewDto, RfqDto, StatusDto } from '@silicr/api';
import { PrivacyError } from '@silicr/zec';
import { startDaemon, type RunningDaemon } from '../src/daemon.ts';
import { toErrorDto } from '../src/errors.ts';
import { makeWorld, unbundle, waitFor, type World } from './helpers.ts';

let w: World;
let buyerD: RunningDaemon;
let providerD: RunningDaemon;
const WEB = 'http://localhost:7703';

beforeAll(async () => {
  w = await makeWorld({ providers: [{ name: 'p1', script: { steps: 25, stepMs: 100 } }] });
  buyerD = await startDaemon({ node: w.buyer, port: 0, statusIntervalMs: 200 });
  providerD = await startDaemon({ node: w.providers[0]!, port: 0 });
});

afterAll(async () => {
  await buyerD?.close();
  await providerD?.close();
  await w?.close();
});

async function call<T>(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] ??= 'application/json';
  }
  const res = await fetch(`${base}${path}`, init);
  const ct = res.headers.get('content-type') ?? '';
  const parsed = ct.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, body: parsed as T, headers: res.headers };
}

/** Collect SSE events until `until` returns true (or timeout). */
async function sse(base: string, until: (events: DaemonEvent[]) => boolean, timeoutMs = 10_000): Promise<DaemonEvent[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const res = await fetch(`${base}/api/events`, { headers: { Origin: WEB }, signal: ctl.signal });
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
  const events: DaemonEvent[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as DaemonEvent);
      }
      if (until(events)) break;
    }
  } catch {
    // aborted
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return events;
}

describe('daemon: shared endpoints', () => {
  it('GET /api/status for each role', async () => {
    const b = await call<StatusDto>(buyerD.url, 'GET', '/api/status');
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ role: 'buyer', network: 'memory', demoMode: false, version: '0.1.0', blockTimeS: 0.1 });
    expect(b.body.address).toMatch(/^uregtest1/);
    expect(BigInt(b.body.balance.spendable)).toBeGreaterThan(0n);
    expect(b.body.relayUrl).toBe(w.relay.baseUrl);
    const p = await call<StatusDto & { runner: { sandboxed: boolean; warning?: string } }>(providerD.url, 'GET', '/api/status');
    expect(p.body).toMatchObject({ role: 'provider', providerId: w.providers[0]!.providerId, alias: w.providers[0]!.alias });
    expect(p.body.runner.sandboxed).toBe(false);
    expect(p.body.runner.warning).toMatch(/not.*sandbox/i);
  });

  it('GET /api/providers lists verified directory entries', async () => {
    const r = await call<ProviderDto[]>(buyerD.url, 'GET', '/api/providers');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ providerId: w.providers[0]!.providerId, verified: true, minPricePerHourZats: '36000000' });
    expect(r.body[0]!.updatedAt).toBeGreaterThan(1_700_000_000_000); // unix ms
    const fromProvider = await call<ProviderDto[]>(providerD.url, 'GET', '/api/providers');
    expect(fromProvider.body).toHaveLength(1);
  });

  it('errors: unknown route, wrong role, wrong method, bad JSON, bad content type', async () => {
    const nf = await call<ErrorDto>(buyerD.url, 'GET', '/api/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.code).toBe('not_found');
    const role = await call<ErrorDto>(buyerD.url, 'GET', '/api/jobs');
    expect(role.status).toBe(404);
    expect(role.body.code).toBe('wrong_role');
    const role2 = await call<ErrorDto>(providerD.url, 'POST', '/api/rfqs', {});
    expect(role2.body.code).toBe('wrong_role');
    const method = await call<ErrorDto>(buyerD.url, 'DELETE', '/api/rfqs');
    expect(method.status).toBe(405);
    const badJson = await call<ErrorDto>(buyerD.url, 'POST', '/api/rfqs', '{nope');
    expect(badJson.status).toBe(400);
    expect(badJson.body.code).toBe('bad_request');
    const ct = await call<ErrorDto>(buyerD.url, 'POST', '/api/rfqs', 'x=1', { 'Content-Type': 'text/plain' });
    expect(ct.status).toBe(415);
    const missing = await call<ErrorDto>(buyerD.url, 'GET', '/api/rfqs/00000000000000000000000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
  });

  it('maps PrivacyError to code "privacy"', () => {
    expect(toErrorDto(new PrivacyError('transparent recipients are refused'))).toEqual({ status: 400, body: { error: 'transparent recipients are refused', code: 'privacy' } });
  });

  it('CORS: allows the web terminal origin, refuses others; checks Host', async () => {
    const pre = await fetch(`${buyerD.url}/api/rfqs`, { method: 'OPTIONS', headers: { Origin: WEB, 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(pre.headers.get('access-control-allow-methods')).toMatch(/POST/);
    const alt = await call<StatusDto>(buyerD.url, 'GET', '/api/status', undefined, { Origin: 'http://127.0.0.1:7703' });
    expect(alt.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:7703');
    const old = await call<ErrorDto>(buyerD.url, 'GET', '/api/status', undefined, { Origin: 'http://localhost:3000' });
    expect(old.status).toBe(403);
    const evil = await call<ErrorDto>(buyerD.url, 'POST', '/api/rfqs', {}, { Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    // DNS rebinding: a foreign Host header is refused
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${buyerD.url}/api/status`, { headers: { Host: 'attacker.example:7701' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('binds to loopback only', async () => {
    await expect(startDaemon({ node: w.buyer, port: 0, host: '0.0.0.0' })).rejects.toThrow(/loopback/);
  });
});

describe('daemon: buyer + provider flow over HTTP', () => {
  let rfqId = '';

  it('POST /api/rfqs validates and creates', async () => {
    const bad = await call<ErrorDto>(buyerD.url, 'POST', '/api/rfqs', { gpu: 'a100', count: 0, durationS: 60, maxPricePerHourZats: '1', job: { path: w.jobDir, command: ['x'] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/count/);
    const r = await call<{ rfqId: string }>(buyerD.url, 'POST', '/api/rfqs', {
      gpu: 'a100',
      count: 1,
      durationS: 60,
      maxPricePerHourZats: '72000000',
      job: { path: w.jobDir, command: ['python3', 'train.py'] },
    });
    expect(r.status).toBe(201);
    expect(r.body.rfqId).toMatch(/^[0-9a-f]{32}$/);
    rfqId = r.body.rfqId;
  });

  it('GET /api/rfqs and /api/rfqs/:id show bids; SSE streams rfq.updated', async () => {
    const events = await sse(buyerD.url, (es) => es.some((e) => e.type === 'rfq.updated' && e.rfq.rfqId === rfqId && e.rfq.bids.length > 0));
    expect(events[0]!.type).toBe('status');
    const r = await call<RfqDto>(buyerD.url, 'GET', `/api/rfqs/${rfqId}`);
    expect(r.body.state).toBe('collecting');
    expect(r.body.bids).toHaveLength(1);
    expect(r.body.paddedOutputs).toBe(4);
    const all = await call<RfqDto[]>(buyerD.url, 'GET', '/api/rfqs');
    expect(all.body.map((x) => x.rfqId)).toContain(rfqId);
    const result = await call<ErrorDto>(buyerD.url, 'GET', `/api/rfqs/${rfqId}/result`);
    expect(result.status).toBe(404);
  });

  it('provider endpoints: jobs, job, policy get/put', async () => {
    const jobs = await call<ProviderJobDto[]>(providerD.url, 'GET', '/api/jobs');
    expect(jobs.body.map((j) => j.rfqId)).toContain(rfqId);
    const job = await call<ProviderJobDto>(providerD.url, 'GET', `/api/jobs/${rfqId}`);
    expect(job.body.state).toBe('bid');
    expect(job.body.bid.txid).toMatch(/^[0-9a-f]{64}$/);
    const pol = await call<ProviderPolicyDto>(providerD.url, 'GET', '/api/policy');
    expect(pol.body).toMatchObject({ autoBid: true, minPricePerHourZats: '36000000', intervalS: 1 });
    const put = await call<ProviderPolicyDto>(providerD.url, 'PUT', '/api/policy', { minPricePerHourZats: '36000000', gpus: [{ model: 'a100', count: 2, vramGb: 80 }] });
    expect(put.status).toBe(200);
    expect(put.body.gpus).toEqual([{ model: 'a100', count: 2, vramGb: 80 }]);
    const badPut = await call<ErrorDto>(providerD.url, 'PUT', '/api/policy', { intervalS: -1 });
    expect(badPut.status).toBe(400);
  });

  it('POST accept → running → result download; leaks and chain views', async () => {
    const bad = await call<ErrorDto>(buyerD.url, 'POST', `/api/rfqs/${rfqId}/accept`, { providerId: 'zz' });
    expect(bad.status).toBe(400);
    const unknown = await call<ErrorDto>(buyerD.url, 'POST', `/api/rfqs/${rfqId}/accept`, { providerId: 'ab'.repeat(32) });
    expect(unknown.status).toBe(404);
    const acc = await call<RfqDto>(buyerD.url, 'POST', `/api/rfqs/${rfqId}/accept`, { providerId: w.providers[0]!.providerId });
    expect(acc.status).toBe(200);
    expect(acc.body.state).toBe('accepted');
    expect(acc.body.payments[0]).toMatchObject({ seq: 0, kind: 'accept' });
    const again = await call<ErrorDto>(buyerD.url, 'POST', `/api/rfqs/${rfqId}/accept`, { providerId: w.providers[0]!.providerId });
    expect(again.status).toBe(409);

    const evs = await sse(providerD.url, (es) => es.some((e) => e.type === 'job.updated' && e.job.state === 'running'));
    expect(evs.some((e) => e.type === 'job.updated')).toBe(true);
    for (const e of evs) if (e.type === 'leak') for (const f of e.observation.fields) expect(Array.isArray(f.facts)).toBe(true);
    await waitFor(async () => (await call<RfqDto>(buyerD.url, 'GET', `/api/rfqs/${rfqId}`)).body.state === 'closed', 'closed', 20_000);
    const done = (await call<RfqDto>(buyerD.url, 'GET', `/api/rfqs/${rfqId}`)).body;
    expect(done.closeReason).toBe('done');
    expect(done.result!.sizeBytes).toBeGreaterThan(0);

    const res = await fetch(`${buyerD.url}/api/rfqs/${rfqId}/result`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/silicr-result-/);
    const files = unbundle(new Uint8Array(await res.arrayBuffer()));
    expect(files['result.txt']).toContain('steps=25');

    const leaks = await call<LeakObservation[]>(buyerD.url, 'GET', `/api/leaks?rfqId=${rfqId}`);
    expect(leaks.body.length).toBeGreaterThan(5);
    expect(leaks.body.every((o) => o.rfqId === rfqId)).toBe(true);
    const cursor = leaks.body[2]!.id;
    const after = await call<LeakObservation[]>(buyerD.url, 'GET', `/api/leaks?rfqId=${rfqId}&after=${cursor}`);
    expect(after.body.length).toBe(leaks.body.length - 3);
    const pLeaks = await call<LeakObservation[]>(providerD.url, 'GET', `/api/leaks?rfqId=${rfqId}`);
    expect(pLeaks.body.some((o) => o.party === 'provider')).toBe(true);

    // every emitted LeakField is tagged with the key facts it carries (Leak Inspector matrix)
    const allBuyer = (await call<LeakObservation[]>(buyerD.url, 'GET', '/api/leaks')).body;
    const allProvider = (await call<LeakObservation[]>(providerD.url, 'GET', '/api/leaks')).body;
    const every = [...allBuyer, ...allProvider];
    expect(every.some((o) => o.party === 'chain')).toBe(true);
    for (const o of every) for (const f of o.fields) expect(Array.isArray(f.facts), `${o.party}/${o.event}/${f.label}`).toBe(true);
    const fieldOf = (obs: LeakObservation[], party: string, label: string) => obs.filter((o) => o.party === party).flatMap((o) => o.fields).find((f) => f.label === label);
    expect(fieldOf(allProvider, 'provider', 'Buyer identity')).toMatchObject({ readable: false, facts: ['buyer_identity'] });
    // Default: the buyer's max is undisclosed, so the provider holds no readable price field for it.
    expect(fieldOf(allProvider, 'provider', 'Max price')).toBeUndefined();
    expect(fieldOf(allProvider, 'provider', 'Buyer budget')).toMatchObject({ readable: false, sensitive: true, facts: ['price'] });
    expect(fieldOf(allBuyer, 'buyer', 'Max price')).toMatchObject({ readable: true, facts: ['price'] });
    expect(fieldOf(allProvider, 'provider', 'Command')).toMatchObject({ readable: true, facts: ['workload'] });
    expect(fieldOf(allProvider, 'provider', 'Pseudonym')).toMatchObject({ facts: ['provider_identity'] });
    expect(fieldOf(allBuyer, 'buyer', 'Amount')).toMatchObject({ readable: true, facts: ['amount'] });
    expect(fieldOf(allBuyer, 'buyer', 'Provider')).toMatchObject({ facts: ['provider_identity'] });
    expect(fieldOf(allBuyer, 'buyer', 'Reply address (one-time)')).toMatchObject({ facts: [] });
    const cipher = fieldOf(allBuyer, 'chain', 'Action 1 note ciphertext')!;
    expect(cipher.readable).toBe(false);
    expect(cipher.facts).toContain('amount');
    expect(fieldOf(allBuyer, 'chain', 'Transaction id')).toMatchObject({ readable: true, facts: [] });
    // the RFQ transaction's memos seal the price and workload; its sender seals the buyer
    const rfqChain = allBuyer.find((o) => o.party === 'chain' && o.txid === done.rfqTxid)!;
    expect(rfqChain.fields.find((f) => f.label === 'Memos')).toMatchObject({ readable: false, facts: ['price', 'workload'] });
    expect(rfqChain.fields.find((f) => f.label === 'Sender')).toMatchObject({ readable: false, facts: ['buyer_identity'] });

    const tx = await call<PublicTxViewDto>(buyerD.url, 'GET', `/api/chain/tx/${done.rfqTxid}`);
    expect(tx.status).toBe(200);
    expect((tx.body.ironwood ?? tx.body.orchard).actions).toBe(5);
    expect(tx.body.transparent).toEqual({ inputs: 0, outputs: 0 });
    expect(typeof tx.body.feeZats).toBe('string');
    const noTx = await call<ErrorDto>(buyerD.url, 'GET', `/api/chain/tx/${'00'.repeat(32)}`);
    expect(noTx.status).toBe(404);
    // a transaction between two other wallets: the backend could show it, but this node never inspects it
    const a = w.network.wallet('stranger-a', { fundZats: 10_000_000n });
    const b = w.network.wallet('stranger-b');
    const memo = new Uint8Array(512);
    memo[0] = 0xf6;
    const { txid: foreign } = await a.send([{ to: await b.address(), zats: 1000n, memo }]);
    const foreignRes = await call<ErrorDto>(buyerD.url, 'GET', `/api/chain/tx/${foreign}`);
    expect(foreignRes.status).toBe(404);
    expect(foreignRes.body.error).toMatch(/not a transaction this node sent or received/);
    // the provider can show the ACCEPT it received
    const acceptTx = done.payments[0]!.txid;
    expect((await call<PublicTxViewDto>(providerD.url, 'GET', `/api/chain/tx/${acceptTx}`)).status).toBe(200);
  }, 40_000);

  it('POST stop and fault endpoints', async () => {
    const r = await call<{ rfqId: string }>(buyerD.url, 'POST', '/api/rfqs', {
      gpu: 'a100',
      count: 1,
      durationS: 600,
      maxPricePerHourZats: '72000000',
      job: { path: w.jobDir, command: ['python3', 'train.py'] },
      autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    });
    const id = r.body.rfqId;
    w.runners[0]!.script = { steps: 100_000, stepMs: 50 };
    await waitFor(async () => (await call<RfqDto>(buyerD.url, 'GET', `/api/rfqs/${id}`)).body.state === 'running', 'running', 15_000);
    const f = await call<RfqDto & { paymentsWithheld: boolean }>(buyerD.url, 'POST', `/api/rfqs/${id}/fault`, { fault: 'stop_paying' });
    expect(f.body.paymentsWithheld).toBe(true);
    const f2 = await call<RfqDto & { paymentsWithheld: boolean }>(buyerD.url, 'POST', `/api/rfqs/${id}/fault`, { fault: 'resume_paying' });
    expect(f2.body.paymentsWithheld).toBe(false);
    const badFault = await call<ErrorDto>(buyerD.url, 'POST', `/api/rfqs/${id}/fault`, { fault: 'explode' });
    expect(badFault.status).toBe(400);
    const pf = await call<ProviderJobDto & { heartbeatsStopped: boolean }>(providerD.url, 'POST', `/api/jobs/${id}/fault`, { fault: 'resume_heartbeats' });
    expect(pf.body.heartbeatsStopped).toBe(false);
    const s = await call<RfqDto>(buyerD.url, 'POST', `/api/rfqs/${id}/stop`);
    expect(s.status).toBe(200);
    expect(s.body.state).toBe('closing');
    await waitFor(async () => (await call<RfqDto>(buyerD.url, 'GET', `/api/rfqs/${id}`)).body.state === 'closed', 'closed', 15_000);
    const again = await call<ErrorDto>(buyerD.url, 'POST', `/api/rfqs/${id}/stop`);
    expect(again.status).toBe(409);
  }, 40_000);
});
