// The silicr_* tools. Every tool talks only to the local daemons over HTTP; results are concise JSON
// (structuredContent) plus a one-line human summary (the first line of the text block).
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { LeakObservation, NewRfqRequest, ProviderDto, PublicTxViewDto, RelayObserverResponse, RfqDto, StatusDto } from '@silicr/api';
import { ApiError, DaemonClient } from './client.ts';
import { SpendingCap, type CapRequestState } from './cap.ts';
import { buildLeakReport, type ColumnInput } from './leaks.ts';
import { TERMINAL_STATES, summarizeRfq, trimRfq } from './trim.ts';
import { ceilDiv, formatZec, parseZec, perInterval, zatsOf, zec } from './zec.ts';

export interface ToolContext {
  buyer: DaemonClient;
  provider: DaemonClient | null;
  /** Explicit relay URL; null = the one the buyer daemon reports. */
  relayUrl: string | null;
  cap: SpendingCap;
  outDir: string;
  log: (line: string) => void;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type Data = Record<string, unknown>;

export const TOOL_NAMES = [
  'silicr_status',
  'silicr_list_providers',
  'silicr_estimate',
  'silicr_request_compute',
  'silicr_get_request',
  'silicr_wait',
  'silicr_accept_bid',
  'silicr_stop_request',
  'silicr_download_result',
  'silicr_leak_report',
  'silicr_list_requests',
] as const;

const REAL_ZEC_NOTE = 'REAL ZEC: this daemon is on Zcash mainnet, so every payment here spends real money.';
const NOT_DEMO = "not in demo mode: this party runs on another machine, so its view can't be fetched (and shouldn't be)";

// ---------------------------------------------------------------------------- results

/**
 * A successful result: the one-line summary, then the JSON. The summary is also the first field of the
 * structured content, because some clients (Claude Code among them) show the model only that JSON.
 */
function ok(summary: string, data: Data): CallToolResult {
  const payload: Data = { summary, ...data };
  payload.summary = summary; // first for readers, and never overridden by the data
  return { content: [{ type: 'text', text: `${summary}\n${JSON.stringify(payload)}` }], structuredContent: payload };
}

function refuse(message: string, data?: Data): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }], ...(data ? { structuredContent: data } : {}) };
}

function explain(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'unreachable' || e.code === 'timeout') {
      return `${e.message}. Start the testnet stack with \`silicr demo\` or a buyer daemon with \`silicr daemon --role buyer --data <dir>\`, then retry.`;
    }
    return `${e.message} (daemon error code: ${e.code})`;
  }
  return e instanceof Error ? e.message : String(e);
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return refuse(`error: ${explain(e)}`);
  }
}

// ---------------------------------------------------------------------------- helpers

function networkLabel(n: string): string {
  switch (n) {
    case 'memory':
      return 'simulated chain (in-memory stand-in for Zcash: no real ZEC)';
    case 'test':
      return 'Zcash testnet (TAZ, no real value)';
    case 'regtest':
      return 'Zcash regtest (local, no real value)';
    case 'main':
      return 'Zcash mainnet (real ZEC)';
    default:
      return n;
  }
}

const short = (id: string, n = 12): string => (id.length > n ? `${id.slice(0, n)}…` : id);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A ZEC amount from tool input (number or string), strictly positive. */
function zecIn(v: number | string, what: string): bigint {
  let z: bigint;
  try {
    z = parseZec(v);
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
  if (z <= 0n) throw new Error(`${what} must be a positive ZEC amount`);
  return z;
}

function durationFromHours(hours: number): number {
  const s = Math.round(hours * 3600);
  if (!Number.isFinite(s) || s < 1) throw new Error('hours must be at least 1/3600 (one second)');
  return s;
}

/** Resolve a full rfqId or a unique prefix. */
async function resolveRfqId(ctx: ToolContext, idOrPrefix: string): Promise<string> {
  const p = idOrPrefix.trim().toLowerCase().replace(/…$/, '');
  if (/^[0-9a-f]{32}$/.test(p)) return p;
  if (!/^[0-9a-f]{4,31}$/.test(p)) throw new Error(`rfq_id must be a 32-char hex id or a prefix of at least 4 hex chars, got "${idOrPrefix}"`);
  const all = await ctx.buyer.get<RfqDto[]>('/api/rfqs');
  const hits = all.filter((r) => r.rfqId.startsWith(p));
  if (hits.length === 1) return hits[0]!.rfqId;
  throw new Error(hits.length ? `"${idOrPrefix}" matches ${hits.length} requests; give more characters` : `no request starts with "${idOrPrefix}"`);
}

async function capLookup(ctx: ToolContext): Promise<(id: string) => CapRequestState | undefined> {
  if (ctx.cap.rfqIds.length === 0) return () => undefined;
  const all = await ctx.buyer.get<RfqDto[]>('/api/rfqs');
  const map = new Map(all.map((r) => [r.rfqId, r]));
  return (id) => map.get(id);
}

export interface Limits {
  sessionRemainingZats: bigint;
  daemon: { perRfqZats: bigint; totalZats: bigint; spentZats: bigint; remainingZats: bigint } | null;
  /** The most one new request may commit: the strictest of the session cap and the daemon's own cap. */
  perRequestZats: bigint;
  limitedBy: 'session' | 'daemon_per_rfq' | 'daemon_total';
}

/** The strictest per-request limit: the session cap, the daemon's per-request cap, or what is left of the daemon's total. */
export function limitsFor(status: StatusDto, sessionRemainingZats: bigint): Limits {
  let perRequest = sessionRemainingZats;
  let limitedBy: Limits['limitedBy'] = 'session';
  let daemon: Limits['daemon'] = null;
  if (status.spendCap) {
    const perRfq = zatsOf(status.spendCap.perRfqZats);
    const total = zatsOf(status.spendCap.totalZats);
    const spent = zatsOf(status.spendCap.spentZats);
    const remaining = total > spent ? total - spent : 0n;
    daemon = { perRfqZats: perRfq, totalZats: total, spentZats: spent, remainingZats: remaining };
    if (perRfq < perRequest) {
      perRequest = perRfq;
      limitedBy = 'daemon_per_rfq';
    }
    if (remaining < perRequest) {
      perRequest = remaining;
      limitedBy = 'daemon_total';
    }
  }
  return { sessionRemainingZats, daemon, perRequestZats: perRequest, limitedBy };
}

function capView(l: Limits, sessionMaxZats: bigint): Data {
  return {
    perRequestLimitZec: formatZec(l.perRequestZats),
    limitedBy: l.limitedBy,
    session: { maxZec: formatZec(sessionMaxZats), remainingZec: formatZec(l.sessionRemainingZats) },
    ...(l.daemon
      ? { daemon: { perRfqZec: formatZec(l.daemon.perRfqZats), totalZec: formatZec(l.daemon.totalZats), spentZec: formatZec(l.daemon.spentZats), remainingZec: formatZec(l.daemon.remainingZats) } }
      : {}),
  };
}

function limitText(l: Limits, sessionMaxZats: bigint): string {
  switch (l.limitedBy) {
    case 'daemon_per_rfq':
      return `the buyer daemon's per-request cap (${formatZec(l.perRequestZats)} ZEC)`;
    case 'daemon_total':
      return `what is left of the buyer daemon's total cap (${formatZec(l.perRequestZats)} ZEC)`;
    default:
      return `the remaining session cap (${formatZec(l.sessionRemainingZats)} ZEC of ${formatZec(sessionMaxZats)}; start silicr-mcp with a higher --max-total-zec to raise it)`;
  }
}

/** The billing interval providers on this network bid, guessed from the block time (a bid sets the real one). */
function guessIntervalS(blockTimeS: number): number {
  if (blockTimeS >= 20) return 300; // Zcash testnet (25 s blocks since NU7) and mainnet
  if (blockTimeS >= 1) return 4;
  if (blockTimeS >= 0.25) return 2;
  return 1;
}

function guessLeadS(blockTimeS: number, intervalS: number): number {
  const lead = blockTimeS >= 20 ? 60 : blockTimeS >= 1 ? 1 : blockTimeS >= 0.25 ? 0.5 : 0.25;
  return Math.min(lead, intervalS / 4);
}

function matchingProviders(list: ProviderDto[], gpu: string, count: number, maxZats: bigint): ProviderDto[] {
  return list
    .filter((p) => p.verified && p.gpus.some((g) => g.model.toLowerCase() === gpu && g.count >= count) && zatsOf(p.minPricePerHourZats) <= maxZats)
    .sort((a, b) => (zatsOf(a.minPricePerHourZats) < zatsOf(b.minPricePerHourZats) ? -1 : 1));
}

/** Resolve the result path inside outDir; anything that would land outside is refused (symlinks included). */
export async function resultTarget(outDir: string, name: string): Promise<string> {
  if (!name || name.includes('\0')) throw new Error('file_name must be a file name');
  const root = resolve(outDir);
  const target = isAbsolute(name) ? resolve(name) : resolve(root, name);
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`refusing to write outside the results dir ${root}: ${name}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootReal = await realpath(root);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentReal = await realpath(parent);
  const rel2 = relative(rootReal, parentReal);
  if (rel2 === '..' || rel2.startsWith(`..${sep}`) || isAbsolute(rel2)) throw new Error(`refusing to write outside the results dir ${root}: ${name} resolves to ${parentReal}`);
  // Checked against real paths above; report the path as configured (not its /private/... realpath).
  const existing = await lstat(join(parentReal, basename(target))).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${target}`);
  if (existing?.isDirectory()) throw new Error(`${target} is a directory`);
  return target;
}

// ---------------------------------------------------------------------------- schemas

const rfqIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{4,32}…?$/)
  .describe('The request id (32 hex chars) from silicr_request_compute or silicr_list_requests, or a unique prefix of at least 4 chars.');

const gpuSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,15}$/)
  .describe('GPU model slug exactly as listed by silicr_list_providers, e.g. "a100", "h100", "cpu".');

const countSchema = z.number().int().min(1).max(64).default(1).describe('Number of GPUs (default 1).');
const hoursSchema = z.number().positive().max(720).describe('Requested runtime in hours; decimals allowed (0.1 = 6 minutes). Billing stops early if the job finishes.');
const maxPriceSchema = z
  .union([z.number().positive(), z.string()])
  .describe('The most you will pay per hour for the whole job, in ZEC (e.g. 0.8 or "0.8"). Bids above it are ignored.');

const EstimateShape = {
  gpu: gpuSchema,
  count: countSchema,
  hours: hoursSchema,
  max_zec_per_hour: maxPriceSchema,
  interval_s: z.number().int().min(1).max(86400).optional().describe('Billing interval in seconds, if you know what providers bid; otherwise it is assumed from the network.'),
};

const RequestShape = {
  gpu: gpuSchema,
  count: countSchema,
  hours: hoursSchema,
  max_zec_per_hour: maxPriceSchema,
  job_path: z
    .string()
    .min(1)
    .describe('The job: a directory, or a single .py/.sh file (its directory is sent). THE WHOLE DIRECTORY IS SENT TO THE WINNING PROVIDER, so point at a directory that holds only the job. Relative paths resolve against the MCP server\'s working directory.'),
  command: z
    .array(z.string().min(1).max(4096))
    .min(1)
    .max(64)
    .optional()
    .describe('Command to run inside the job directory, as an argv array, e.g. ["python3", "train.py"]. Defaults: a .py file runs with python3, a .sh file with sh, a directory with a train.py runs it.'),
  image: z.string().regex(/^[\w./:@-]{1,256}$/).optional().describe('Container image (default python:3.12-slim).'),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(4096)).optional().describe('Extra environment variables for the job (reserved SILICR_* names are dropped by the daemon, except the job\'s own knobs like SILICR_STEPS).'),
  providers: z.array(z.string().regex(/^[0-9a-fA-F]{64}$/)).min(1).max(16).optional().describe('providerIds to ask (default: every verified directory provider whose GPUs match).'),
  disclose_max: z.boolean().default(false).describe('Put max_zec_per_hour in the RFQ memo so providers see it. Default false: the budget stays private, providers bid their own price and bids above it are dropped by the daemon.'),
  auto_accept: z.boolean().default(true).describe('Accept the cheapest signed bid automatically (default true). With false, call silicr_wait until="bids" then silicr_accept_bid.'),
  wait_blocks: z.number().int().min(0).max(1000).default(2).describe('With auto_accept: blocks to wait for more bids before choosing (default 2); it chooses sooner once every provider asked has bid.'),
};

const WaitShape = {
  rfq_id: rfqIdSchema,
  until: z
    .enum(['bids', 'accepted', 'running', 'closed'])
    .describe('"bids": at least min_bids bids arrived; "accepted": a bid was accepted; "running": the job reported its first heartbeat; "closed": the request reached closed, expired or failed. Any terminal state returns immediately.'),
  min_bids: z.number().int().min(1).max(16).default(1).describe('With until="bids": how many bids to wait for (default 1).'),
  timeout_s: z.number().min(1).max(600).default(60).describe('Give up after this many seconds (default 60; keep it below your tool-call timeout) and return the current state with reached=false: just call again.'),
};

const RequestIdShape = { rfq_id: rfqIdSchema };

const AcceptShape = {
  rfq_id: rfqIdSchema,
  provider: z.string().min(2).describe("The bidder's alias (e.g. \"velvet-orca-13\") or a prefix of its providerId, from the request's bids."),
};

const DownloadShape = {
  rfq_id: rfqIdSchema,
  file_name: z.string().min(1).max(255).optional().describe('File name (or relative path) inside the results dir; default silicr-result-<rfq>.tar.gz. Anything outside the results dir is refused.'),
};

const ListShape = {
  include_terminal: z.boolean().default(true).describe('Include closed, expired and failed requests (default true).'),
};

type EstimateArgs = z.infer<z.ZodObject<typeof EstimateShape>>;
type RequestArgs = z.infer<z.ZodObject<typeof RequestShape>>;
type WaitArgs = z.infer<z.ZodObject<typeof WaitShape>>;
type AcceptArgs = z.infer<z.ZodObject<typeof AcceptShape>>;
type DownloadArgs = z.infer<z.ZodObject<typeof DownloadShape>>;
type ListArgs = z.infer<z.ZodObject<typeof ListShape>>;

// ---------------------------------------------------------------------------- tools

async function statusTool(ctx: ToolContext): Promise<CallToolResult> {
  const s = await ctx.buyer.get<StatusDto>('/api/status');
  if (s.role !== 'buyer') return refuse(`${ctx.buyer.base} is a ${s.role} daemon, not a buyer; point --buyer at the buyer daemon`);
  const usage = ctx.cap.usage(await capLookup(ctx));
  const limits = limitsFor(s, usage.remainingZats);
  let provider: Data = { url: ctx.provider?.base ?? null, reachable: false };
  if (ctx.provider) {
    try {
      const p = await ctx.provider.get<StatusDto>('/api/status', 3000);
      provider = { url: ctx.provider.base, reachable: true, role: p.role, alias: p.alias ?? null, providerId: p.providerId ?? null, network: p.network, ...(p.runner ? { runner: p.runner } : {}) };
    } catch (e) {
      provider = { url: ctx.provider.base, reachable: false, error: e instanceof ApiError ? e.message : String(e) };
    }
  }
  const data: Data = {
    role: s.role,
    network: networkLabel(s.network),
    networkCode: s.network,
    realZec: s.network === 'main',
    height: s.height,
    blockTimeS: s.blockTimeS,
    address: s.address,
    balance: { spendableZec: zec(s.balance.spendable), pendingZec: zec(s.balance.pending) },
    demoMode: s.demoMode,
    relayUrl: ctx.relayUrl ?? s.relayUrl,
    ...(s.proxy ? { proxy: s.proxy } : {}),
    version: s.version,
    sessionCap: {
      maxZec: formatZec(usage.maxZats),
      committedZec: formatZec(usage.committedZats),
      spentZec: formatZec(usage.spentZats),
      remainingZec: formatZec(usage.remainingZats),
      requests: usage.requests,
      note: 'Per-session ceiling enforced by silicr-mcp: a request reserves hours × max_zec_per_hour until it finishes, then counts what it actually cost.',
    },
    ...(limits.daemon
      ? {
          daemonCap: {
            perRfqZec: formatZec(limits.daemon.perRfqZats),
            totalZec: formatZec(limits.daemon.totalZats),
            spentZec: formatZec(limits.daemon.spentZats),
            remainingZec: formatZec(limits.daemon.remainingZats),
            note: "The buyer daemon's own spending guard; the stricter of the two caps applies.",
          },
        }
      : {}),
    perRequestLimitZec: formatZec(limits.perRequestZats),
    provider,
  };
  const summary =
    `Buyer daemon on ${networkLabel(s.network)}, height ${s.height}: ${zec(s.balance.spendable)} ZEC spendable (${zec(s.balance.pending)} pending)` +
    `; session cap ${formatZec(usage.maxZats)} ZEC, ${formatZec(usage.committedZats)} committed, ${formatZec(usage.remainingZats)} left` +
    (limits.daemon ? `; daemon cap ${formatZec(limits.daemon.perRfqZats)} ZEC per request, ${formatZec(limits.daemon.remainingZats)} ZEC total left` : '') +
    `; demo mode ${s.demoMode ? 'on' : 'off'}` +
    (s.network === 'main' ? `. ${REAL_ZEC_NOTE}` : '');
  return ok(summary, data);
}

async function listProvidersTool(ctx: ToolContext): Promise<CallToolResult> {
  const list = await ctx.buyer.get<ProviderDto[]>('/api/providers');
  const providers = list.map((p) => ({
    alias: p.alias,
    providerId: p.providerId,
    gpus: p.gpus,
    minZecPerHour: zec(p.minPricePerHourZats),
    ...(p.bondZats !== undefined ? { bondZec: zec(p.bondZats) } : {}),
    ...(p.region ? { region: p.region } : {}),
    verified: p.verified,
    updatedAt: new Date(p.updatedAt).toISOString(),
  }));
  const verified = providers.filter((p) => p.verified).length;
  const summary = providers.length
    ? `${providers.length} provider(s) in the directory, ${verified} with a valid signature: ${providers
        .map((p) => `${p.alias} (${p.gpus.map((g) => `${g.count}× ${g.model}`).join(', ')}; min ${p.minZecPerHour} ZEC/h${p.verified ? '' : '; UNVERIFIED'})`)
        .join('; ')}`
    : 'the directory is empty: no provider has published an entry';
  return ok(summary, { count: providers.length, verified, providers });
}

async function estimateTool(ctx: ToolContext, a: EstimateArgs): Promise<CallToolResult> {
  const gpu = a.gpu.toLowerCase();
  const max = zecIn(a.max_zec_per_hour, 'max_zec_per_hour');
  const durationS = durationFromHours(a.hours);
  const [status, list] = await Promise.all([ctx.buyer.get<StatusDto>('/api/status'), ctx.buyer.get<ProviderDto[]>('/api/providers')]);
  const intervalS = a.interval_s ?? guessIntervalS(status.blockTimeS);
  const intervals = Math.max(1, Math.ceil(durationS / intervalS));
  const maxCost = ceilDiv(max * BigInt(durationS), 3600n);
  const perIntervalMax = perInterval(max, intervalS);
  const matching = matchingProviders(list, gpu, a.count, max);
  const asked = Math.min(matching.length, 16);
  const bucket = asked <= 4 ? 4 : asked <= 8 ? 8 : 16;
  // ZIP 317: 5000 zats per logical action, at least 2. RFQ: padded outputs + change; each payment: 2 actions.
  const fees = BigInt(bucket + 1) * 5000n + BigInt(intervals + 1) * 10_000n + BigInt(asked + 1) * 5000n;
  const lead = guessLeadS(status.blockTimeS, intervalS);
  const exposureIntervals = 1 + lead / intervalS;
  const exposure = ceilDiv(perIntervalMax * BigInt(Math.round(exposureIntervals * 1000)), 1000n);
  const limits = limitsFor(status, ctx.cap.remaining(await capLookup(ctx)));
  const fits = maxCost <= limits.perRequestZats;
  const data: Data = {
    gpu,
    count: a.count,
    hours: a.hours,
    durationS,
    maxZecPerHour: formatZec(max),
    intervalS,
    intervalAssumed: a.interval_s === undefined,
    intervals,
    maxCostZec: formatZec(maxCost),
    estimatedFeesZec: formatZec(fees),
    estimatedMaxTotalZec: formatZec(maxCost + fees),
    maxExposure: {
      intervals: +exposureIntervals.toFixed(3),
      zec: formatZec(exposure),
      seconds: intervalS + lead,
      note: 'The most a provider that stops working (or lies about progress) can take: one prepaid interval plus the one in progress.',
    },
    cap: { fits, ...capView(limits, ctx.cap.maxZats) },
    matchingProviders: matching.map((p) => ({ alias: p.alias, providerId: p.providerId, minZecPerHour: zec(p.minPricePerHourZats), gpus: p.gpus, ...(p.bondZats !== undefined ? { bondZec: zec(p.bondZats) } : {}) })),
    realZec: status.network === 'main',
    note: 'No side effects. Cost is price × time actually used; this is the worst case at your max price, and the fee estimate assumes the job runs the full duration.',
  };
  const summary =
    `${a.count}× ${gpu} for ${a.hours} h at ≤ ${formatZec(max)} ZEC/h: at most ${formatZec(maxCost)} ZEC + ≈${formatZec(fees)} ZEC fees over ${intervals} interval(s) of ${intervalS} s` +
    `; worst-case loss to a bad provider ${formatZec(exposure)} ZEC; ${fits ? 'fits' : 'does NOT fit'} ${limitText(limits, ctx.cap.maxZats)}` +
    `; ${matching.length} matching provider(s)${matching.length ? `: ${matching.map((p) => `${p.alias} at ${zec(p.minPricePerHourZats)} ZEC/h`).join(', ')}` : ''}` +
    (status.network === 'main' ? `. ${REAL_ZEC_NOTE}` : '');
  return ok(summary, data);
}

async function requestComputeTool(ctx: ToolContext, a: RequestArgs): Promise<CallToolResult> {
  const gpu = a.gpu.toLowerCase();
  const max = zecIn(a.max_zec_per_hour, 'max_zec_per_hour');
  const durationS = durationFromHours(a.hours);
  const maxCost = ceilDiv(max * BigInt(durationS), 3600n);
  const status = await ctx.buyer.get<StatusDto>('/api/status');
  if (status.role !== 'buyer') return refuse(`${ctx.buyer.base} is a ${status.role} daemon, not a buyer`);
  const lookup = await capLookup(ctx);
  const limits = limitsFor(status, ctx.cap.remaining(lookup));
  if (maxCost > limits.perRequestZats) {
    return refuse(
      `refused by the spending cap: this request could cost up to ${formatZec(maxCost)} ZEC (${a.hours} h × ${formatZec(max)} ZEC/h), more than ${limitText(limits, ctx.cap.maxZats)}. ` +
        'Ask for fewer hours or a lower max_zec_per_hour, or run silicr_estimate to find what fits.',
      { refused: 'cap', maxCostZec: formatZec(maxCost), cap: capView(limits, ctx.cap.maxZats) },
    );
  }

  // The job: a directory, or one file whose directory is sent.
  const abs = resolve(a.job_path);
  const st = await stat(abs).catch(() => null);
  if (!st) return refuse(`job_path does not exist: ${abs}`);
  let dir = abs;
  let command = a.command ? [...a.command] : [];
  if (st.isFile()) {
    dir = dirname(abs);
    if (command.length === 0) {
      const name = basename(abs);
      if (name.endsWith('.py')) command = ['python3', name];
      else if (name.endsWith('.sh')) command = ['sh', name];
      else return refuse(`give the command to run ${name}, e.g. command: ["./${name}"]`);
    }
  } else if (st.isDirectory()) {
    if (command.length === 0) {
      const train = await stat(join(abs, 'train.py')).catch(() => null);
      if (train?.isFile()) command = ['python3', 'train.py'];
      else return refuse(`give the command to run in ${abs}, e.g. command: ["python3", "train.py"]`);
    }
  } else return refuse(`job_path is neither a file nor a directory: ${abs}`);

  const job: NewRfqRequest['job'] = { path: dir, command };
  if (a.image) job.image = a.image;
  if (a.env && Object.keys(a.env).length) job.env = a.env;
  const req: NewRfqRequest = {
    gpu,
    count: a.count,
    durationS,
    maxPricePerHourZats: max.toString(),
    discloseMax: a.disclose_max,
    job,
    autoAccept: a.auto_accept ? { rule: 'cheapest', waitBlocks: a.wait_blocks } : null,
  };
  if (a.providers) req.providerIds = a.providers.map((p) => p.toLowerCase());

  let rfqId: string;
  try {
    ({ rfqId } = await ctx.buyer.post<{ rfqId: string }>('/api/rfqs', req));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'privacy') return refuse(`refused by the daemon's privacy guard: ${e.message}`);
    if (e instanceof ApiError && e.code === 'insufficient_funds') return refuse(`${e.message}. The buyer wallet needs more shielded ZEC (silicr_status shows its address and balance).`);
    throw e;
  }
  ctx.cap.reserve(rfqId, maxCost);
  ctx.log(`request ${short(rfqId)} created: ${a.count}× ${gpu}, ${durationS} s, ≤ ${formatZec(max)} ZEC/h; ${formatZec(maxCost)} ZEC reserved`);
  const remaining = ctx.cap.remaining(lookup);
  const real = status.network === 'main';
  const data: Data = {
    rfqId,
    state: 'broadcasting',
    request: { gpu, count: a.count, hours: a.hours, durationS, maxZecPerHour: formatZec(max), budget: a.disclose_max ? 'disclosed to providers' : 'undisclosed to providers', job: { directory: dir, command, image: a.image ?? 'python:3.12-slim', envKeys: Object.keys(job.env ?? {}) } },
    autoAccept: a.auto_accept ? { rule: 'cheapest', waitBlocks: a.wait_blocks } : null,
    cap: { reservedZec: formatZec(maxCost), sessionRemainingZec: formatZec(remaining) },
    realZec: real,
    ...(real ? { note: REAL_ZEC_NOTE } : {}),
    next: a.auto_accept
      ? 'Call silicr_wait with until="running", then until="closed"; then silicr_download_result and silicr_leak_report.'
      : 'Call silicr_wait with until="bids", pick one with silicr_accept_bid, then silicr_wait until="running" and until="closed".',
  };
  const summary =
    `Request ${short(rfqId)} sent as a sealed, shielded RFQ: ${a.count}× ${gpu} for ${a.hours} h at ≤ ${formatZec(max)} ZEC/h, job "${command.join(' ')}" in ${dir}` +
    `; ${formatZec(maxCost)} ZEC reserved against the session cap (${formatZec(remaining)} ZEC left)` +
    (a.auto_accept ? '; the cheapest signed bid will be accepted automatically' : '; bids need silicr_accept_bid') +
    (real ? `. ${REAL_ZEC_NOTE}` : '');
  return ok(summary, data);
}

function requestSummary(r: RfqDto): string {
  const paid = `${zec(r.spentZats)} ZEC paid in ${r.payments.length} payment(s) + ${zec(r.feesZats)} ZEC fees`;
  switch (r.state) {
    case 'broadcasting':
      return `Request ${short(r.rfqId)} is being broadcast (${r.preparing ? `preparing funds ${r.preparing.confirmations}/${r.preparing.required}` : 'RFQ transaction in flight'})`;
    case 'collecting':
      return `Request ${short(r.rfqId)} is collecting bids: ${r.bids.length} so far from ${r.providersAsked} provider(s) asked, until height ${r.expiresHeight}`;
    case 'accepted':
      return `Request ${short(r.rfqId)}: bid from ${r.accepted?.alias ?? '?'} accepted, waiting for the job to start`;
    case 'running': {
      const hb = r.heartbeats[0];
      return `Request ${short(r.rfqId)} is running on ${r.accepted?.alias ?? '?'}: ${hb ? `${hb.status}, serving interval ${hb.servingSeq}, step ${hb.step}` : 'no heartbeat yet'}; ${paid}`;
    }
    case 'closing':
      return `Request ${short(r.rfqId)} is closing${r.closeReason ? ` (${r.closeReason})` : ''}: fetching the result; ${paid}`;
    case 'closed':
      return `Request ${short(r.rfqId)} closed (${r.closeReason ?? 'done'}): ${paid}; result ${r.result ? `${r.result.sizeBytes} bytes, ${r.resultVerified ? 'verified against the provider\'s signed CLOSE' : 'unverified'}` : 'none'}`;
    case 'expired':
      return `Request ${short(r.rfqId)} expired: ${r.error ?? 'no acceptable bids'}; ${paid}`;
    default:
      return `Request ${short(r.rfqId)} ${r.state}: ${r.error ?? ''}; ${paid}`;
  }
}

async function getRequestTool(ctx: ToolContext, a: { rfq_id: string }): Promise<CallToolResult> {
  const id = await resolveRfqId(ctx, a.rfq_id);
  const r = await ctx.buyer.get<RfqDto>(`/api/rfqs/${id}`);
  return ok(requestSummary(r), trimRfq(r));
}

function reached(r: RfqDto, until: WaitArgs['until'], minBids: number): boolean {
  switch (until) {
    case 'bids':
      return r.bids.length >= minBids || r.accepted !== undefined;
    case 'accepted':
      return r.accepted !== undefined;
    case 'running':
      return r.state === 'running' || r.state === 'closing' || r.jobStartedAt !== undefined;
    case 'closed':
      return TERMINAL_STATES.has(r.state);
  }
}

async function waitTool(ctx: ToolContext, a: WaitArgs, extra: Extra): Promise<CallToolResult> {
  const id = await resolveRfqId(ctx, a.rfq_id);
  const started = Date.now();
  const deadline = started + a.timeout_s * 1000;
  const token = extra._meta?.progressToken;
  let lastProgress = started;
  for (;;) {
    const r = await ctx.buyer.get<RfqDto>(`/api/rfqs/${id}`);
    const hit = reached(r, a.until, a.min_bids);
    const terminal = TERMINAL_STATES.has(r.state);
    const waitedS = +((Date.now() - started) / 1000).toFixed(1);
    if (hit || terminal) {
      const summary = `${hit ? `reached "${a.until}"` : `request ended (${r.state}) before "${a.until}"`} after ${waitedS} s. ${requestSummary(r)}`;
      return ok(summary, { reached: hit, terminal, timedOut: false, state: r.state, waitedS, request: trimRfq(r) });
    }
    if (Date.now() >= deadline) {
      return ok(`timed out after ${a.timeout_s} s without reaching "${a.until}"; call silicr_wait again. ${requestSummary(r)}`, {
        reached: false,
        terminal: false,
        timedOut: true,
        state: r.state,
        waitedS,
        request: trimRfq(r),
      });
    }
    if (token !== undefined && Date.now() - lastProgress >= 5000) {
      lastProgress = Date.now();
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(waitedS), total: a.timeout_s, message: requestSummary(r) } }).catch(() => undefined);
    }
    if (extra.signal.aborted) return refuse('wait cancelled by the client');
    await sleep(Math.min(400, Math.max(50, deadline - Date.now())));
  }
}

async function acceptBidTool(ctx: ToolContext, a: AcceptArgs): Promise<CallToolResult> {
  const id = await resolveRfqId(ctx, a.rfq_id);
  const [r, status] = await Promise.all([ctx.buyer.get<RfqDto>(`/api/rfqs/${id}`), ctx.buyer.get<StatusDto>('/api/status')]);
  const p = a.provider.trim().toLowerCase();
  const hits = r.bids.filter((b) => b.alias.toLowerCase() === p || b.providerId.toLowerCase().startsWith(p));
  const ids = [...new Set(hits.map((b) => b.providerId))];
  if (ids.length !== 1) {
    return refuse(ids.length ? `"${a.provider}" matches ${ids.length} bidders; use the full alias` : `no bid from "${a.provider}" on request ${short(id)}; bids so far: ${r.bids.map((b) => b.alias).join(', ') || 'none'}`);
  }
  const bid = hits[0]!;
  if (!bid.signatureValid) return refuse(`the bid from ${bid.alias} has an invalid signature; refusing to accept it`);
  const intervals = Math.max(1, Math.ceil(r.request.durationS / bid.intervalS));
  const commit = zatsOf(bid.pricePerIntervalZats) * BigInt(intervals);
  if (!ctx.cap.isReserved(id)) {
    // A request made outside this session: commit its worst case now.
    const limits = limitsFor(status, ctx.cap.remaining(await capLookup(ctx)));
    if (commit > limits.perRequestZats) {
      return refuse(`refused by the spending cap: accepting ${bid.alias} commits up to ${formatZec(commit)} ZEC (${intervals} intervals × ${zec(bid.pricePerIntervalZats)} ZEC), more than ${limitText(limits, ctx.cap.maxZats)}.`);
    }
    ctx.cap.reserve(id, commit);
  }
  const acc = await ctx.buyer.post<RfqDto>(`/api/rfqs/${id}/accept`, { providerId: ids[0] });
  const real = status.network === 'main';
  const summary =
    `Accepted ${bid.alias} on request ${short(id)}: interval 0 paid by the ACCEPT transaction (${zec(bid.pricePerIntervalZats)} ZEC per ${bid.intervalS} s, up to ${intervals} intervals = ${formatZec(commit)} ZEC)` +
    (real ? `. ${REAL_ZEC_NOTE}` : '');
  return ok(summary, { ...trimRfq(acc), committedZec: formatZec(commit), realZec: real, ...(real ? { note: REAL_ZEC_NOTE } : {}) });
}

async function stopRequestTool(ctx: ToolContext, a: { rfq_id: string }): Promise<CallToolResult> {
  const id = await resolveRfqId(ctx, a.rfq_id);
  const r = await ctx.buyer.post<RfqDto>(`/api/rfqs/${id}/stop`);
  return ok(`Stop sent for request ${short(id)}: now ${r.state}${r.closeReason ? ` (${r.closeReason})` : ''}; no further payments. Call silicr_wait until="closed" for the partial result.`, trimRfq(r));
}

async function downloadResultTool(ctx: ToolContext, a: DownloadArgs): Promise<CallToolResult> {
  const id = await resolveRfqId(ctx, a.rfq_id);
  const r = await ctx.buyer.get<RfqDto>(`/api/rfqs/${id}`);
  if (!r.result) return refuse(`request ${short(id)} has no result yet (state ${r.state}${r.closeReason ? `, ${r.closeReason}` : ''}); wait with silicr_wait until="closed"`);
  const name = a.file_name ?? `silicr-result-${id.slice(0, 8)}.tar.gz`;
  let target: string;
  try {
    target = await resultTarget(ctx.outDir, name);
  } catch (e) {
    return refuse(`refused: ${(e as Error).message}`);
  }
  const bytes = await ctx.buyer.bytes(`/api/rfqs/${id}/result`);
  await writeFile(target, bytes, { mode: 0o600 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const verified = r.resultVerified === true;
  const data: Data = {
    path: target,
    sizeBytes: bytes.length,
    sha256,
    sealedDigest: r.result.digest,
    resultVerified: r.resultVerified ?? null,
    format: 'tar.gz (unpack with: tar -xzf <path>)',
    note: 'sealedDigest is the SHA-256 of the encrypted blob the provider signed in its CLOSE; sha256 is the plaintext bundle you now hold.',
  };
  return ok(
    `Saved ${bytes.length} bytes to ${target} (sha256 ${sha256.slice(0, 16)}…); ${verified ? "the daemon verified the sealed bundle against the provider's signed CLOSE" : `NOT verified against the provider's CLOSE (${r.resultVerified === false ? 'digest mismatch' : 'no CLOSE seen'})`}`,
    data,
  );
}

async function fetchViews(ctx: ToolContext, txids: string[], providerOk: boolean): Promise<{ views: PublicTxViewDto[]; errors: number }> {
  const views: PublicTxViewDto[] = [];
  let errors = 0;
  const queue = [...txids];
  const worker = async () => {
    for (let txid = queue.shift(); txid !== undefined; txid = queue.shift()) {
      try {
        views.push(await ctx.buyer.get<PublicTxViewDto>(`/api/chain/tx/${txid}`));
      } catch (e) {
        if (providerOk && ctx.provider && e instanceof ApiError && e.status === 404) {
          try {
            views.push(await ctx.provider.get<PublicTxViewDto>(`/api/chain/tx/${txid}`));
            continue;
          } catch {
            // fall through
          }
        }
        errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, txids.length)) }, worker));
  return { views, errors };
}

async function leakReportTool(ctx: ToolContext, a: { rfq_id: string }): Promise<CallToolResult> {
  const id = await resolveRfqId(ctx, a.rfq_id);
  const [rfq, status, buyerLeaks] = await Promise.all([
    ctx.buyer.get<RfqDto>(`/api/rfqs/${id}`),
    ctx.buyer.get<StatusDto>('/api/status'),
    ctx.buyer.get<LeakObservation[]>(`/api/leaks?rfqId=${id}`),
  ]);
  const demo = status.demoMode;

  let providerChain: LeakObservation[] = [];
  let provider: ColumnInput = { available: false, source: ctx.provider?.base ?? 'none', reason: 'no provider daemon configured (--provider)', observations: [] };
  if (ctx.provider) {
    if (!demo) provider = { available: false, source: `${ctx.provider.base}/api/leaks`, reason: NOT_DEMO, observations: [] };
    else {
      try {
        const obs = await ctx.provider.get<LeakObservation[]>(`/api/leaks?rfqId=${id}`, 5000);
        provider = { available: true, source: `${ctx.provider.base}/api/leaks`, observations: obs.filter((o) => o.party === 'provider') };
        providerChain = obs.filter((o) => o.party === 'chain');
      } catch (e) {
        provider = { available: false, source: `${ctx.provider.base}/api/leaks`, reason: `provider daemon not reachable: ${e instanceof ApiError ? e.message : String(e)}`, observations: [] };
      }
    }
  }

  const relayUrl = (ctx.relayUrl ?? status.relayUrl).replace(/\/+$/, '');
  let relay: ColumnInput = { available: false, source: `${relayUrl}/_observer`, reason: NOT_DEMO, observations: [] };
  if (demo) {
    try {
      const res = await fetch(`${relayUrl}/_observer?limit=5000`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 404 ? ' (observer feed disabled: start the relay with --observer)' : ''}`);
      const body = (await res.json()) as RelayObserverResponse;
      relay = { available: true, source: `${relayUrl}/_observer`, observations: body.observations.filter((o) => o.party === 'relay') };
    } catch (e) {
      relay = { available: false, source: `${relayUrl}/_observer`, reason: `relay observer feed not reachable: ${e instanceof Error ? e.message : String(e)}`, observations: [] };
    }
  }

  const daemonChain = [...buyerLeaks.filter((o) => o.party === 'chain'), ...providerChain];
  const txids = new Set<string>();
  const add = (t: string | undefined) => {
    if (t && /^[0-9a-fA-F]{8,128}$/.test(t)) txids.add(t.toLowerCase());
  };
  add(rfq.rfqTxid);
  for (const t of rfq.rfqTxids ?? []) add(t);
  for (const b of rfq.bids) add(b.txid);
  for (const p of rfq.payments) add(p.txid);
  for (const o of [...buyerLeaks, ...provider.observations, ...daemonChain]) add(o.txid);
  const { views, errors } = await fetchViews(ctx, [...txids], provider.available);

  const report = buildLeakReport({
    rfq,
    buyerAddress: status.address,
    buyer: { available: true, source: `${ctx.buyer.base}/api/leaks`, observations: buyerLeaks.filter((o) => o.party === 'buyer') },
    provider,
    relay,
    chain: { available: true, source: `${ctx.buyer.base}/api/chain/tx/:txid`, daemonObservations: daemonChain, views, viewErrors: errors },
  });
  const headline = `Leak report for request ${short(id)} (${rfq.state}): verdict ${report.verdict.toUpperCase()}. ${report.summary}`;
  return ok(headline, { ...(report as unknown as Data), summary: headline });
}

async function listRequestsTool(ctx: ToolContext, a: ListArgs): Promise<CallToolResult> {
  const all = await ctx.buyer.get<RfqDto[]>('/api/rfqs');
  const shown = a.include_terminal ? all : all.filter((r) => !TERMINAL_STATES.has(r.state));
  const requests = shown.map((r) => ({ ...summarizeRfq(r), inSessionCap: ctx.cap.isReserved(r.rfqId) }));
  const live = all.filter((r) => !TERMINAL_STATES.has(r.state)).length;
  const summary = all.length
    ? `${all.length} request(s) known to the buyer daemon, ${live} active${shown.length !== all.length ? ` (${shown.length} shown)` : ''}: ${requests.map((r) => `${short(r.rfqId)} ${r.state}${r.provider ? ` on ${r.provider}` : ''} (${r.spentZec} ZEC)`).join('; ')}`
    : 'no requests yet';
  return ok(summary, { count: all.length, active: live, requests });
}

// ---------------------------------------------------------------------------- registration

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    'silicr_status',
    {
      title: 'Silicr status',
      description:
        'Health of the local Silicr buyer daemon and of this session: role, network (Zcash testnet or Zcash mainnet), chain height, shielded balance in ZEC, demo mode, the session spending cap (max, committed, remaining), the daemon\'s own cap if it has one, and whether a provider daemon is reachable. Call it first. Read-only.',
      inputSchema: {},
      annotations: ro,
    },
    () => run(() => statusTool(ctx)),
  );

  server.registerTool(
    'silicr_list_providers',
    {
      title: 'List providers',
      description:
        'The public provider directory as verified by the buyer daemon: pseudonymous alias, GPUs (model slug, count, VRAM), minimum price in ZEC per hour, bond and whether the signed entry verified. Use it to choose a gpu slug and a sensible max_zec_per_hour. Read-only.',
      inputSchema: {},
      annotations: ro,
    },
    () => run(() => listProvidersTool(ctx)),
  );

  server.registerTool(
    'silicr_estimate',
    {
      title: 'Estimate a rental',
      description:
        'Estimate before committing: worst-case cost (hours × max_zec_per_hour), estimated network fees, number of metered intervals, the most a misbehaving provider could take (about 1.25 intervals), which providers match, and whether it fits the remaining cap (session cap and the daemon\'s cap, whichever is stricter). No side effects.',
      inputSchema: EstimateShape,
      annotations: ro,
    },
    (args) => run(() => estimateTool(ctx, args)),
  );

  server.registerTool(
    'silicr_request_compute',
    {
      title: 'Rent GPUs',
      description:
        'Rent GPUs for a job. The daemon packs the job directory, encrypts it for the winning provider, and broadcasts a sealed request as one shielded Zcash transaction; vetted providers answer with signed bids to a one-time address; with auto_accept (default) the cheapest valid bid is accepted and the job starts, paid per interval in shielded ZEC. ' +
        'Refused when hours × max_zec_per_hour exceeds the remaining cap. The daemon refuses dangerous job paths (home directory, key stores, wallet files). Returns the rfqId; then call silicr_wait.',
      inputSchema: RequestShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(() => requestComputeTool(ctx, args)),
  );

  server.registerTool(
    'silicr_get_request',
    {
      title: 'Get a request',
      description: 'Current state of one request: state, bids, accepted provider, payments so far (ZEC), fees, latest heartbeats, log tail, result digest and close reason. Read-only.',
      inputSchema: RequestIdShape,
      annotations: ro,
    },
    (args) => run(() => getRequestTool(ctx, args)),
  );

  server.registerTool(
    'silicr_wait',
    {
      title: 'Wait for a request',
      description:
        'Poll a request until it reaches a milestone (until="bids" | "accepted" | "running" | "closed") or timeout_s elapses, then return its state. Returns immediately on a terminal state (closed, expired, failed). On timeout it returns reached=false with the current state: call it again. Read-only.',
      inputSchema: WaitShape,
      annotations: ro,
    },
    (args, extra) => run(() => waitTool(ctx, args, extra)),
  );

  server.registerTool(
    'silicr_accept_bid',
    {
      title: 'Accept a bid',
      description:
        'Accept one bid on a request made with auto_accept=false: pays interval 0 with the ACCEPT transaction and starts the job. provider is the bidder\'s alias or a providerId prefix. Checked against the cap when the request was not made in this session.',
      inputSchema: AcceptShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(() => acceptBidTool(ctx, args)),
  );

  server.registerTool(
    'silicr_stop_request',
    {
      title: 'Stop a request',
      description: 'Stop a running request: sends CLOSE(buyer_stop), so no further interval payments; the provider stops the job and returns what it produced so far (partial result).',
      inputSchema: RequestIdShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => run(() => stopRequestTool(ctx, args)),
  );

  server.registerTool(
    'silicr_download_result',
    {
      title: 'Download the result',
      description:
        'Save a finished request\'s result bundle (tar.gz) under the server\'s results dir (--out-dir, default .silicr/mcp-results). file_name is relative to that dir; anything outside it is refused. Returns the path, size, SHA-256 and whether the daemon verified the sealed bundle against the provider\'s signed CLOSE.',
      inputSchema: DownloadShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => downloadResultTool(ctx, args)),
  );

  server.registerTool(
    'silicr_leak_report',
    {
      title: 'Leak report',
      description:
        'Proof that a deal stayed private. Reads the Leak Inspector data of every party (the buyer daemon; the provider daemon and the relay observer feed in demo mode; the public view of every transaction the request touched) and computes who knows which of six facts: buyer identity, workload, price, amounts, provider identity, buyer IP. ' +
        'A party knows a fact only if it holds it readable and sensitive. knownLimits are leaks THREAT_MODEL.md documents (the winning provider sees the job it runs; the relay sees IP addresses). verdict is "private" when unexpected is empty. Read-only.',
      inputSchema: RequestIdShape,
      annotations: ro,
    },
    (args) => run(() => leakReportTool(ctx, args)),
  );

  server.registerTool(
    'silicr_list_requests',
    {
      title: 'List requests',
      description: 'Every request the buyer daemon knows, newest first: state, provider, ZEC paid, close reason, and whether it counts against this session\'s cap. Read-only.',
      inputSchema: ListShape,
      annotations: ro,
    },
    (args) => run(() => listRequestsTool(ctx, args)),
  );
}
