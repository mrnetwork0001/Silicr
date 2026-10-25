// The local daemon: @silicr/api over node:http, bound to loopback, SSE on /api/events.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DaemonEvent, NewRfqRequest, StatusDto } from '@silicr/api';
import { BuyerNode, type BuyerFault } from './buyer.ts';
import { ProviderNode, type ProviderFault } from './provider.ts';
import { EngineError, badRequest, notFound, toErrorDto, wrongRole } from './errors.ts';
import { DEFAULT_PRESETS, presetDto, type JobPreset } from './presets.ts';

/** The web terminal (apps/web) runs on 7703. */
export const WEB_PORT = 7703;
export const DEFAULT_ALLOWED_ORIGINS = [`http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}`];
const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Limits of a public demo daemon (`--public-demo`): a shared testnet wallet anyone may drive. */
export interface PublicDemoOptions {
  /** The only jobs a request may run. Default DEFAULT_PRESETS (examples/tiny-train). */
  presets?: JobPreset[];
  /** Default 900 (15 min). */
  maxDurationS?: number;
  /** GPUs per request. Default 1. */
  maxCount?: number;
  /** Live requests (broadcasting … closing) at once, across every visitor. Default 1. */
  maxActive?: number;
  /** POST /api/rfqs per client IP per hour. Default 3. */
  perIpPerHour?: number;
  /** Highest max price a visitor may set, zatoshis per hour. Default 0.5 ZEC/h (testnet coins). */
  maxPricePerHourZats?: bigint;
  /**
   * Buyer: how many blocks after an RFQ's expiresHeight an unaccepted request may linger before it
   * expires and frees the single slot (the profile allows ~25 min; a visitor who walks away would
   * block everyone else). Default 4 (~7 min in all on testnet, bid window included).
   */
  acceptWindowBlocks?: number;
  /** Clock for the rate limit (tests). */
  now?: () => number;
}

export const PUBLIC_DEMO_DEFAULTS = { maxDurationS: 900, maxCount: 1, maxActive: 1, perIpPerHour: 3, maxPricePerHourZats: 50_000_000n, acceptWindowBlocks: 4 } as const;

export interface DaemonOptions {
  node: BuyerNode | ProviderNode;
  /** 0 = ephemeral (tests). */
  port: number;
  /** Loopback by default (127.0.0.1). Any other bind address needs publicOrigins (a hosted demo behind a reverse proxy). */
  host?: string;
  allowedOrigins?: string[];
  /**
   * Hosted deployments (`--public-origin`): extra allowed Origins, whose host names are also
   * accepted in the Host header. The loopback rules still apply to everything else.
   */
  publicOrigins?: string[];
  /** Take the client IP from the last X-Forwarded-For entry (set by the reverse proxy). Only used for rate limits. */
  trustProxy?: boolean;
  /** Public demo rules (`--public-demo`); refused on mainnet. */
  publicDemo?: boolean | PublicDemoOptions;
  /** How often a changed StatusDto is pushed to SSE clients. Default 2000 ms. */
  statusIntervalMs?: number;
}

export interface RunningDaemon {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  cors: Record<string, string>;
}

type Route = { method: string; re: RegExp; role?: 'buyer' | 'provider'; handle: (c: Ctx) => Promise<void> };

export async function startDaemon(o: DaemonOptions): Promise<RunningDaemon> {
  const host = o.host ?? '127.0.0.1';
  const publicOrigins = (o.publicOrigins ?? []).map(parsePublicOrigin);
  if (!LOOPBACK.has(host) && publicOrigins.length === 0) {
    throw new Error(`the daemon binds to loopback only (got host ${host}); a non-loopback bind needs --public-origin (a hosted demo behind a reverse proxy)`);
  }
  const node = o.node;
  const origins = new Set([...(o.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS), ...publicOrigins.map((u) => u.origin)]);
  const hostNames = new Set([...LOOPBACK, ...publicOrigins.map((u) => u.hostname.replace(/^\[|\]$/g, '').toLowerCase())]);
  const demo = o.publicDemo ? resolvePublicDemo(o.publicDemo === true ? {} : o.publicDemo) : null;
  if (demo && node.network === 'main') throw new Error('--public-demo is refused on Zcash mainnet: a public demo spends a shared wallet; run it on testnet');
  const rateLog = new Map<string, number[]>();
  /** Public demo: which client IP created each RFQ (memory only); stop, accept and fault are theirs alone. */
  const creators = new Map<string, string>();
  let creating = false;
  const sse = new Set<ServerResponse>();
  let boundPort = 0;

  const buyer = (): BuyerNode => node as BuyerNode;
  const provider = (): ProviderNode => node as ProviderNode;
  // Public demo buyer: an unaccepted request frees the single slot after a few blocks, not ~25 min.
  if (demo && node.role === 'buyer') buyer().limitAcceptWindow(demo.acceptWindowBlocks);

  const routes: Route[] = [
    { method: 'GET', re: /^\/api\/status$/, handle: async (c) => send(c, 200, await status()) },
    { method: 'GET', re: /^\/api\/providers$/, handle: async (c) => send(c, 200, await node.providers()) },
    { method: 'GET', re: /^\/api\/leaks$/, handle: async (c) => {
        const q: { rfqId?: string; after?: string } = {};
        const rfqId = c.url.searchParams.get('rfqId');
        const after = c.url.searchParams.get('after');
        if (rfqId) q.rfqId = rfqId.toLowerCase();
        if (after) q.after = after;
        send(c, 200, node.listLeaks(q));
      } },
    { method: 'GET', re: /^\/api\/chain\/tx\/([0-9a-fA-F]{8,128})$/, handle: async (c) => send(c, 200, await node.inspectTx(c.params[0]!)) },
    { method: 'GET', re: /^\/api\/events$/, handle: async (c) => openEvents(c) },
    { method: 'GET', re: /^\/api\/wallet$/, handle: async (c) => send(c, 200, await node.wallet(c.url.searchParams.get('amount'))) },
    { method: 'POST', re: /^\/api\/wallet\/withdraw$/, handle: async (c) => {
        demoDisabled('withdrawals');
        send(c, 200, await node.withdraw((await readJson(c)) as never));
      } },

    // buyer
    { method: 'GET', re: /^\/api\/rfqs$/, role: 'buyer', handle: async (c) => send(c, 200, buyer().listRfqs()) },
    { method: 'POST', re: /^\/api\/rfqs$/, role: 'buyer', handle: async (c) => {
        const body = await readJson(c);
        if (!demo) return send(c, 201, await buyer().createRfq(body as never));
        send(c, 201, await createDemoRfq(c, body));
      } },
    { method: 'GET', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})$/, role: 'buyer', handle: async (c) => send(c, 200, buyer().getRfq(c.params[0]!)) },
    { method: 'POST', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})\/accept$/, role: 'buyer', handle: async (c) => {
        const body = (await readJson(c)) as { providerId?: unknown };
        if (!body || typeof body.providerId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(body.providerId)) throw badRequest('body must be { providerId: <64 hex chars> }');
        demoOwnerOnly(c, c.params[0]!);
        send(c, 200, await buyer().accept(c.params[0]!, body.providerId));
      } },
    { method: 'POST', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})\/stop$/, role: 'buyer', handle: async (c) => {
        demoOwnerOnly(c, c.params[0]!);
        send(c, 200, await buyer().stop(c.params[0]!));
      } },
    { method: 'POST', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})\/migrate$/, role: 'buyer', handle: async (c) => {
        demoDisabled('migrating a job');
        send(c, 201, await buyer().migrate(c.params[0]!, (await readJson(c)) as never));
      } },
    { method: 'POST', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})\/fault$/, role: 'buyer', handle: async (c) => {
        const body = (await readJson(c)) as { fault?: unknown };
        if (body?.fault !== 'stop_paying' && body?.fault !== 'resume_paying') throw badRequest('body must be { fault: "stop_paying" | "resume_paying" }');
        demoOwnerOnly(c, c.params[0]!);
        send(c, 200, buyer().fault(c.params[0]!, body.fault as BuyerFault));
      } },
    { method: 'GET', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})\/result$/, role: 'buyer', handle: async (c) => {
        const bytes = await buyer().resultBytes(c.params[0]!);
        c.res.writeHead(200, {
          ...c.cors,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
          'Content-Disposition': `attachment; filename="silicr-result-${c.params[0]!.slice(0, 8).toLowerCase()}.tar.gz"`,
          'Cache-Control': 'no-store',
        });
        c.res.end(bytes);
      } },

    // provider
    { method: 'GET', re: /^\/api\/jobs$/, role: 'provider', handle: async (c) => send(c, 200, provider().listJobs()) },
    { method: 'GET', re: /^\/api\/jobs\/([0-9a-fA-F]{32})$/, role: 'provider', handle: async (c) => send(c, 200, provider().getJob(c.params[0]!)) },
    { method: 'POST', re: /^\/api\/jobs\/([0-9a-fA-F]{32})\/stop$/, role: 'provider', handle: async (c) => {
        demoDisabled('stopping a job from the provider side');
        send(c, 200, await provider().stopJob(c.params[0]!));
      } },
    { method: 'POST', re: /^\/api\/jobs\/([0-9a-fA-F]{32})\/fault$/, role: 'provider', handle: async (c) => {
        const body = (await readJson(c)) as { fault?: unknown };
        if (body?.fault !== 'stop_heartbeats' && body?.fault !== 'resume_heartbeats') throw badRequest('body must be { fault: "stop_heartbeats" | "resume_heartbeats" }');
        send(c, 200, provider().fault(c.params[0]!, body.fault as ProviderFault));
      } },
    { method: 'GET', re: /^\/api\/policy$/, role: 'provider', handle: async (c) => send(c, 200, provider().getPolicy()) },
    { method: 'PUT', re: /^\/api\/policy$/, role: 'provider', handle: async (c) => {
        demoDisabled('changing the provider policy');
        send(c, 200, await provider().setPolicy((await readJson(c)) as never));
      } },
  ];

  async function status(): Promise<StatusDto> {
    const s = await node.status();
    if (!demo) return s;
    // Every party of a public demo runs on the one host, so the terminal may read all their views (Leak Inspector).
    const out: StatusDto = { ...s, publicDemo: true, demoMode: true };
    if (node.role === 'buyer') {
      out.presets = demo.presets.map(presetDto);
      out.publicDemoLimits = { maxDurationS: demo.maxDurationS, maxCount: demo.maxCount, maxActive: demo.maxActive, perIpPerHour: demo.perIpPerHour, maxPricePerHourZats: demo.maxPricePerHourZats.toString() };
    }
    return out;
  }

  function demoDisabled(what: string): void {
    if (demo) throw new EngineError('demo_disabled', `${what} is disabled in the public testnet demo`, 403);
  }

  /** Public demo: only the visitor (client IP) who created an RFQ may stop, accept or fault it. */
  function demoOwnerOnly(c: Ctx, rfqId: string): void {
    if (!demo) return;
    const owner = creators.get(rfqId.toLowerCase());
    // Unknown creator (made before a restart): nobody is locked out of freeing the slot.
    if (owner !== undefined && owner !== clientIp(c)) {
      throw new EngineError('demo_other_visitor', "This request was made by another visitor; only they can stop, accept or fault it. Watch it in the Market, or make your own once it's done.", 403);
    }
  }

  function clientIp(c: Ctx): string {
    if (o.trustProxy) {
      const xff = c.req.headers['x-forwarded-for'];
      const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      // The reverse proxy appends the address it saw: the last entry is the only one it vouches for.
      if (list.length > 0) return list[list.length - 1]!;
    }
    return c.req.socket.remoteAddress ?? 'unknown';
  }

  /** Public demo POST /api/rfqs: a preset instead of a job, small limits, one at a time, rate limited per IP. */
  async function createDemoRfq(c: Ctx, raw: unknown): Promise<{ rfqId: string }> {
    const d = demo!;
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('body must be a JSON object');
    const job = body['job'] as { preset?: unknown } | undefined;
    const ids = d.presets.map((p) => p.id).join(', ');
    if (!job || typeof job !== 'object' || typeof job.preset !== 'string') throw badRequest(`public demo: the job must be { preset: ${ids} }; folders, commands and env are not accepted`);
    const preset = d.presets.find((p) => p.id === job.preset);
    if (!preset) throw badRequest(`public demo: unknown preset "${job.preset.slice(0, 40)}"; choose one of ${ids}`);
    const durationS = body['durationS'] ?? preset.durationS;
    if (typeof durationS !== 'number' || !Number.isInteger(durationS) || durationS < 1 || durationS > d.maxDurationS) {
      throw badRequest(`public demo: durationS must be an integer 1..${d.maxDurationS} (${d.maxDurationS / 60} min)`);
    }
    const count = body['count'] ?? 1;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > d.maxCount) throw badRequest(`public demo: count must be at most ${d.maxCount}`);
    const max = body['maxPricePerHourZats'];
    if (typeof max !== 'string' || !/^\d{1,20}$/.test(max) || BigInt(max) > d.maxPricePerHourZats) {
      throw badRequest(`public demo: maxPricePerHourZats must be a decimal zatoshi string of at most ${d.maxPricePerHourZats} (${Number(d.maxPricePerHourZats) / 1e8} ZEC/h)`);
    }
    const live = buyer().listRfqs().filter((r) => ACTIVE.has(r.state)).length;
    if (creating || live >= d.maxActive) {
      throw new EngineError('busy', 'The public demo runs one request at a time and another visitor\'s request is live. Watch it in the Market, or try again in a few minutes.', 409);
    }
    const ip = clientIp(c);
    const now = d.now();
    const recent = (rateLog.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= d.perIpPerHour) {
      const waitMin = Math.max(1, Math.ceil((recent[0]! + 3_600_000 - now) / 60_000));
      throw new EngineError('rate_limited', `The public demo allows ${d.perIpPerHour} requests per hour from one address; try again in ${waitMin} min.`, 429);
    }
    recent.push(now);
    rateLog.set(ip, recent);
    const req: NewRfqRequest = {
      gpu: typeof body['gpu'] === 'string' ? body['gpu'] : preset.gpu,
      count,
      durationS,
      maxPricePerHourZats: max,
      job: { path: preset.path, command: [...preset.command], ...(preset.env ? { env: { ...preset.env } } : {}) },
    };
    if (body['discloseMax'] !== undefined) req.discloseMax = body['discloseMax'] as boolean;
    if (body['providerIds'] !== undefined) req.providerIds = body['providerIds'] as string[];
    // Absent (an API client that never thought about it): auto-accept the cheapest bid after one block, so an
    // unattended request runs instead of holding the slot. An explicit null keeps manual acceptance.
    req.autoAccept = body['autoAccept'] === undefined ? { rule: 'cheapest', waitBlocks: 1 } : (body['autoAccept'] as NewRfqRequest['autoAccept']);
    creating = true;
    try {
      const created = await buyer().createRfq(req);
      creators.set(created.rfqId.toLowerCase(), ip);
      return created;
    } finally {
      creating = false;
    }
  }

  function corsFor(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }

  function send(c: Ctx, status: number, body: unknown): void {
    const s = JSON.stringify(body);
    c.res.writeHead(status, { ...c.cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    c.res.end(s);
  }

  async function readJson(c: Ctx): Promise<unknown> {
    const ct = String(c.req.headers['content-type'] ?? '');
    if (!/^application\/json\b/i.test(ct)) {
      throw new EngineError('bad_request', 'Content-Type must be application/json', 415);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of c.req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new EngineError('bad_request', 'request body too large', 413);
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text.trim() === '' ? {} : JSON.parse(text);
  }

  function openEvents(c: Ctx): void {
    c.res.writeHead(200, {
      ...c.cors,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    c.res.write('retry: 2000\n\n');
    const write = (e: DaemonEvent) => {
      if (!c.res.writableEnded) c.res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    sse.add(c.res);
    void node
      .status()
      .then((status) => {
        write({ type: 'status', status });
        if (node instanceof BuyerNode) for (const rfq of node.listRfqs().slice(0, 20)) write({ type: 'rfq.updated', rfq });
        else for (const job of node.listJobs().slice(0, 20)) write({ type: 'job.updated', job });
      })
      .catch(() => undefined);
    const off = node.on(write);
    const ping = setInterval(() => {
      if (!c.res.writableEnded) c.res.write(': ping\n\n');
    }, 15000);
    const done = () => {
      off();
      clearInterval(ping);
      sse.delete(c.res);
    };
    c.req.on('close', done);
    c.res.on('close', done);
  }

  const server = createServer((req, res) => {
    const cors = corsFor(req);
    const fail = (e: unknown) => {
      const { status, body } = toErrorDto(e);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      // A browser page from any other origin must not be able to drive this daemon.
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) throw new EngineError('forbidden', `origin ${origin} is not allowed`, 403);
      // DNS-rebinding guard: only loopback host names (plus the --public-origin hosts).
      const hostHeader = String(req.headers.host ?? '');
      const hostName = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
      if (hostHeader && !hostNames.has(hostName)) throw new EngineError('forbidden', 'bad Host header', 403);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        if (r.role && r.role !== node.role) {
          throw wrongRole(`${url.pathname} is a ${r.role} endpoint; this daemon is a ${node.role}`);
        }
        const ctx: Ctx = { req, res, url, params: m.slice(1), cors };
        r.handle(ctx).catch(fail);
        return;
      }
      if (pathMatched) throw new EngineError('method_not_allowed', `${req.method} not allowed on ${url.pathname}`, 405);
      throw notFound(`no route ${req.method} ${url.pathname}`);
    } catch (e) {
      fail(e);
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(o.port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  boundPort = (server.address() as AddressInfo).port;

  let lastStatus = '';
  const statusTimer = setInterval(() => {
    if (sse.size === 0) return;
    void node
      .status()
      .then((status) => {
        const s = JSON.stringify(status);
        if (s === lastStatus) return;
        lastStatus = s;
        for (const res of sse) if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'status', status })}\n\n`);
      })
      .catch(() => undefined);
  }, o.statusIntervalMs ?? 2000);

  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    async close() {
      clearInterval(statusTimer);
      for (const res of sse) res.end();
      sse.clear();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    },
  };
}

const ACTIVE = new Set(['broadcasting', 'collecting', 'accepted', 'running', 'closing']);

function parsePublicOrigin(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`--public-origin ${raw}: not a URL (e.g. https://app.example.org)`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`--public-origin ${raw}: must be http(s)`);
  return u;
}

function resolvePublicDemo(p: PublicDemoOptions): Required<PublicDemoOptions> {
  const presets = p.presets ?? DEFAULT_PRESETS;
  if (presets.length === 0) throw new Error('--public-demo needs at least one job preset');
  return {
    presets,
    maxDurationS: p.maxDurationS ?? PUBLIC_DEMO_DEFAULTS.maxDurationS,
    maxCount: p.maxCount ?? PUBLIC_DEMO_DEFAULTS.maxCount,
    maxActive: p.maxActive ?? PUBLIC_DEMO_DEFAULTS.maxActive,
    perIpPerHour: p.perIpPerHour ?? PUBLIC_DEMO_DEFAULTS.perIpPerHour,
    maxPricePerHourZats: p.maxPricePerHourZats ?? PUBLIC_DEMO_DEFAULTS.maxPricePerHourZats,
    acceptWindowBlocks: p.acceptWindowBlocks ?? PUBLIC_DEMO_DEFAULTS.acceptWindowBlocks,
    now: p.now ?? Date.now,
  };
}
