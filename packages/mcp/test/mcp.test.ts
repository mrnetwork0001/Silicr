// The MCP server end to end: a real local stack (memory chain, relay with observer, both daemons) on
// ephemeral ports, the server spawned over stdio through its bin launcher, driven by the SDK client.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FAST_PROFILE, startLocalStack, withOverrides, type LocalStack } from '@silicr/engine';
import { unpackBundle } from '@silicr/runner';
import type { LeakReport } from '../src/leaks.ts';
import { TOOL_NAMES } from '../src/tools.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../..');
const TINY = join(REPO, 'examples', 'tiny-train');
const BIN = resolve(HERE, '../bin/silicr-mcp.js');

let stack: LocalStack;
let tmp: string;
let outDir: string;
let client: Client;
let transport: StdioClientTransport;
const stderr: string[] = [];

interface ToolReply<T> {
  text: string;
  data: T;
  isError: boolean;
}

async function call<T = Record<string, any>>(name: string, args: Record<string, unknown> = {}): Promise<ToolReply<T>> {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const content = res.content as { type: string; text?: string }[];
  return { text: content.map((c) => c.text ?? '').join('\n'), data: res.structuredContent as T, isError: res.isError === true };
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'silicr-mcp-'));
  outDir = join(tmp, 'results');
  stack = await startLocalStack({
    rootDir: join(tmp, 'stack'),
    fresh: true,
    blockTimeMs: 100,
    profile: withOverrides(FAST_PROFILE, { blockTimeS: 0.1, pollMs: 50, bidWindowBlocks: 50, intervalS: 1, heartbeatS: 0.2, heartbeatTimeoutS: 3, relayWaitS: 1 }),
    ports: { relay: 0, buyer: 0, provider: 0 },
    runnerMode: 'process',
    providerPolicy: { gpus: [{ model: 'a100', count: 1, vramGb: 80 }], minPricePerHourZats: 60_000_000n },
    demoMode: true,
  });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, '--buyer', stack.buyerDaemon.url, '--provider', stack.providerDaemon!.url, '--relay', stack.relay.url, '--max-total-zec', '0.5', '--out-dir', outDir],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d: Buffer) => stderr.push(String(d)));
  client = new Client({ name: 'silicr-mcp-test', version: '0.0.0' });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await stack?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('silicr-mcp over stdio against a real local stack', () => {
  it('announces every silicr_* tool with a description and schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.description?.length ?? 0).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    const req = tools.find((t) => t.name === 'silicr_request_compute')!;
    expect(Object.keys(req.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['gpu', 'hours', 'max_zec_per_hour', 'job_path', 'command', 'auto_accept']));
    expect(stderr.join('')).toMatch(/silicr-mcp: ready/);
  });

  it('status: simulated chain, demo mode, balance and the session cap', async () => {
    const r = await call('silicr_status');
    expect(r.isError).toBe(false);
    expect(r.text.split('\n')[0]).toMatch(/simulated chain/);
    expect(r.data).toMatchObject({ role: 'buyer', networkCode: 'memory', realZec: false, demoMode: true, sessionCap: { maxZec: '0.5', committedZec: '0', remainingZec: '0.5', requests: 0 }, perRequestLimitZec: '0.5' });
    expect(r.data.network).toMatch(/simulated/);
    expect(Number(r.data.balance.spendableZec)).toBeGreaterThan(1);
    expect(r.data.provider).toMatchObject({ reachable: true, alias: stack.provider!.alias });
    expect(r.data.daemonCap).toBeUndefined();
  });

  it('lists the directory', async () => {
    const r = await call('silicr_list_providers');
    expect(r.isError).toBe(false);
    expect(r.data.count).toBe(1);
    expect(r.data.providers[0]).toMatchObject({ alias: stack.provider!.alias, minZecPerHour: '0.6', verified: true, gpus: [{ model: 'a100', count: 1, vramGb: 80 }] });
    expect(r.text).toContain(stack.provider!.alias);
  });

  it('estimates without side effects and checks the cap', async () => {
    const fits = await call('silicr_estimate', { gpu: 'a100', hours: 0.1, max_zec_per_hour: 0.8 });
    expect(fits.isError).toBe(false);
    expect(fits.data).toMatchObject({ gpu: 'a100', count: 1, durationS: 360, maxZecPerHour: '0.8', maxCostZec: '0.08', cap: { fits: true, limitedBy: 'session' } });
    expect(fits.data.matchingProviders).toHaveLength(1);
    expect(fits.data.intervals).toBeGreaterThan(0);
    expect(Number(fits.data.estimatedFeesZec)).toBeGreaterThan(0);
    expect(Number(fits.data.maxExposure.zec)).toBeGreaterThan(0);
    const no = await call('silicr_estimate', { gpu: 'a100', hours: 1, max_zec_per_hour: '0.8' });
    expect(no.data.cap.fits).toBe(false);
    expect(no.text).toMatch(/does NOT fit/);
    const nobody = await call('silicr_estimate', { gpu: 'h100', hours: 0.1, max_zec_per_hour: 0.8 });
    expect(nobody.data.matchingProviders).toHaveLength(0);
    expect((await call('silicr_status')).data.sessionCap.requests).toBe(0);
  });

  it('refuses a request over the session cap, without touching the daemon', async () => {
    const before = stack.buyer.listRfqs().length;
    const r = await call('silicr_request_compute', { gpu: 'a100', hours: 1, max_zec_per_hour: 0.8, job_path: TINY });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/spending cap/);
    expect(r.text).toMatch(/0\.8 ZEC/);
    expect(stack.buyer.listRfqs().length).toBe(before);
  });

  it('surfaces the daemon privacy guard for a dangerous job path', async () => {
    const r = await call('silicr_request_compute', { gpu: 'a100', hours: 0.01, max_zec_per_hour: 0.8, job_path: homedir(), command: ['python3', 'x.py'] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/privacy guard/);
    expect(r.text).toMatch(/home directory/);
    const missing = await call('silicr_request_compute', { gpu: 'a100', hours: 0.01, max_zec_per_hour: 0.8, job_path: join(tmp, 'nope') });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/does not exist/);
  });

  let rfqId = '';

  it('rents the GPU for tiny-train: request → running → closed → result → leak report', async () => {
    const req = await call('silicr_request_compute', {
      gpu: 'a100',
      hours: 0.1,
      max_zec_per_hour: 0.8,
      job_path: TINY,
      command: ['python3', 'train.py'],
      env: { SILICR_STEPS: '60', SILICR_STEP_DELAY_MS: '30' },
    });
    expect(req.isError, req.text).toBe(false);
    expect(req.data.rfqId).toMatch(/^[0-9a-f]{32}$/);
    expect(req.data.cap).toEqual({ reservedZec: '0.08', sessionRemainingZec: '0.42' });
    expect(req.data.request.job.envKeys).toEqual(['SILICR_STEPS', 'SILICR_STEP_DELAY_MS']);
    expect(req.text).not.toContain('30'); // env values are not echoed
    rfqId = req.data.rfqId;

    const running = await call('silicr_wait', { rfq_id: rfqId, until: 'running', timeout_s: 60 });
    expect(running.isError, running.text).toBe(false);
    expect(running.data.reached).toBe(true);
    expect(['running', 'closing', 'closed']).toContain(running.data.state);
    expect(running.data.request.accepted.alias).toBe(stack.provider!.alias);

    const closed = await call('silicr_wait', { rfq_id: rfqId.slice(0, 10), until: 'closed', timeout_s: 90 });
    expect(closed.data).toMatchObject({ reached: true, terminal: true, state: 'closed' });
    const view = closed.data.request;
    expect(view.closeReason).toBe('done');
    expect(view.result).toMatchObject({ verified: true });
    expect(view.payments.count).toBeGreaterThanOrEqual(2);
    expect(view.logTail.some((l: string) => /loss/.test(l))).toBe(true);
    expect(view.bids[0]).toMatchObject({ signatureValid: true, intervalS: 1 });
    expect(Number(view.bids[0].zecPerHour)).toBeGreaterThanOrEqual(0.6); // 0.6 ZEC/h rounded up to whole zats per 1 s interval

    const got = await call('silicr_get_request', { rfq_id: rfqId });
    expect(got.data.state).toBe('closed');
    expect(got.text.split('\n')[0]).toMatch(/closed \(done\)/);

    const list = await call('silicr_list_requests');
    expect(list.data.requests.find((r: { rfqId: string }) => r.rfqId === rfqId)).toMatchObject({ state: 'closed', inSessionCap: true, provider: stack.provider!.alias });

    const status = await call('silicr_status');
    const committed = Number(status.data.sessionCap.committedZec);
    expect(committed).toBeGreaterThan(0);
    expect(committed).toBeLessThan(0.08); // the reservation shrank to what was actually paid
    expect(Number(status.data.sessionCap.remainingZec)).toBeGreaterThan(0.42);
  }, 120_000);

  it('downloads the result into the out dir and refuses to escape it', async () => {
    const r = await call('silicr_download_result', { rfq_id: rfqId });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.path.startsWith(outDir)).toBe(true);
    expect(r.data.path.endsWith(`silicr-result-${rfqId.slice(0, 8)}.tar.gz`)).toBe(true);
    expect(r.data.resultVerified).toBe(true);
    const bytes = await readFile(r.data.path);
    expect(bytes.length).toBe(r.data.sizeBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(r.data.sha256);
    const unpacked = join(tmp, 'unpacked');
    await unpackBundle(new Uint8Array(bytes), unpacked);
    expect(existsSync(join(unpacked, 'metrics.json'))).toBe(true);

    for (const file_name of ['../escape.tar.gz', '/tmp/escape.tar.gz', join(tmp, 'escape.tar.gz')]) {
      const bad = await call('silicr_download_result', { rfq_id: rfqId, file_name });
      expect(bad.isError, file_name).toBe(true);
      expect(bad.text).toMatch(/outside the results dir/);
    }
    expect(existsSync(join(tmp, 'escape.tar.gz'))).toBe(false);
    const sub = await call('silicr_download_result', { rfq_id: rfqId, file_name: 'sub/again.tar.gz' });
    expect(sub.data.path).toBe(join(outDir, 'sub', 'again.tar.gz'));
  }, 30_000);

  it('leak report: chain and relay learn no deal facts, the provider never learns who the buyer is', async () => {
    const r = await call<LeakReport>('silicr_leak_report', { rfq_id: rfqId });
    expect(r.isError, r.text).toBe(false);
    const rep = r.data;
    expect(rep.verdict).toBe('private');
    expect(rep.unexpected).toEqual([]);
    expect(r.text.split("\n")[0]).toMatch(/PRIVATE/);
    for (const p of ['chain', 'relay', 'provider', 'buyer'] as const) expect(rep.parties[p].available, p).toBe(true);

    // the chain: every transaction fully shielded, nothing readable
    expect(rep.counts.chain.knows).toBe(0);
    expect(rep.chain.transactions).toBeGreaterThanOrEqual(4); // RFQ, BID, ACCEPT, PAYs, CLOSEs
    expect(rep.chain).toMatchObject({ transparentParts: 0, saplingParts: 0, legacyOrchardActions: 0, viewsUnavailable: 0 });
    expect(rep.chain.shieldedActions).toBeGreaterThan(rep.chain.transactions);
    for (const fact of ['buyer_identity', 'workload', 'price', 'amount', 'provider_identity'] as const) expect(rep.matrix[fact].chain.state, fact).toBe('hidden');

    // the relay: ciphertext and IPs only (known limit 2)
    expect(rep.counts.relay.dealFactsKnown).toBe(0);
    expect(rep.parties.relay.knows).toEqual(['buyer_ip']);
    expect(rep.matrix.buyer_ip.relay).toMatchObject({ state: 'knows', knownLimit: 2 });
    expect(rep.matrix.workload.relay).toMatchObject({ state: 'hidden', ciphertext: true });
    expect(rep.parties.relay.observations).toBeGreaterThan(3);

    // the provider: the job it ran, the price it set and what it was paid, never the buyer
    expect(rep.matrix.buyer_identity.provider.state).toBe('hidden');
    expect(rep.matrix.buyer_ip.provider.state).toBe('no');
    expect(rep.parties.provider.knows.sort()).toEqual(['amount', 'price', 'provider_identity', 'workload']);
    expect(rep.matrix.workload.provider.knownLimit).toBe(1);

    // the buyer: its own deal
    expect(rep.counts.buyer.knows).toBe(6);
    expect(rep.knownLimits.map((k) => `${k.party}:${k.fact}`).sort()).toEqual(['provider:workload', 'relay:buyer_ip']);
    expect(rep.parties.buyer.examples.length).toBeGreaterThan(0);
  }, 30_000);

  it('manual flow: bids → accept → running → stop → closed with a partial result', async () => {
    const req = await call('silicr_request_compute', {
      gpu: 'a100',
      hours: 0.05,
      max_zec_per_hour: '0.8',
      job_path: join(TINY, 'train.py'),
      env: { SILICR_STEPS: '100000', SILICR_STEP_DELAY_MS: '20' },
      auto_accept: false,
    });
    expect(req.isError, req.text).toBe(false);
    expect(req.data.request.job.command).toEqual(['python3', 'train.py']);
    const id = req.data.rfqId as string;

    const bids = await call('silicr_wait', { rfq_id: id, until: 'bids', timeout_s: 30 });
    expect(bids.data.reached).toBe(true);
    expect(bids.data.state).toBe('collecting');
    expect(bids.data.request.bids).toHaveLength(1);

    const nobody = await call('silicr_accept_bid', { rfq_id: id, provider: 'nobody' });
    expect(nobody.isError).toBe(true);
    expect(nobody.text).toMatch(/no bid from/);

    const acc = await call('silicr_accept_bid', { rfq_id: id, provider: stack.provider!.alias });
    expect(acc.isError, acc.text).toBe(false);
    expect(acc.data.accepted.alias).toBe(stack.provider!.alias);
    expect(acc.text).toMatch(/interval 0 paid/);

    const running = await call('silicr_wait', { rfq_id: id, until: 'running', timeout_s: 60 });
    expect(running.data.reached).toBe(true);

    const stop = await call('silicr_stop_request', { rfq_id: id });
    expect(stop.isError, stop.text).toBe(false);
    expect(['closing', 'closed']).toContain(stop.data.state);

    const closed = await call('silicr_wait', { rfq_id: id, until: 'closed', timeout_s: 60 });
    expect(closed.data.state).toBe('closed');
    expect(closed.data.request.closeReason).toBe('buyer_stop');
    expect(stack.provider!.getJob(id).state).toBe('stopped');

    const list = await call('silicr_list_requests', { include_terminal: false });
    expect(list.data.requests).toHaveLength(0);
  }, 120_000);

  it('wait reports a timeout instead of failing, and unknown ids fail clearly', async () => {
    const r = await call('silicr_wait', { rfq_id: rfqId, until: 'bids', min_bids: 5, timeout_s: 1 });
    // the request is closed, so a terminal state is reported rather than a timeout
    expect(r.data).toMatchObject({ terminal: true, timedOut: false });
    const unknown = await call('silicr_get_request', { rfq_id: 'ffff' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/no request starts with/);
    const missing = await call('silicr_get_request', { rfq_id: '0'.repeat(32) });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/not_found/);
  });
});
