// The local daemon: @silicr/api over node:http, bound to loopback, SSE on /api/events.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DaemonEvent } from '@silicr/api';
import { BuyerNode, type BuyerFault } from './buyer.ts';
import { ProviderNode, type ProviderFault } from './provider.ts';
import { EngineError, badRequest, notFound, toErrorDto, wrongRole } from './errors.ts';

/** The web terminal (apps/web) runs on 7703. */
export const WEB_PORT = 7703;
export const DEFAULT_ALLOWED_ORIGINS = [`http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}`];
const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export interface DaemonOptions {
  node: BuyerNode | ProviderNode;
  /** 0 = ephemeral (tests). */
  port: number;
  /** Loopback only. Default 127.0.0.1. */
  host?: string;
  allowedOrigins?: string[];
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
  if (!LOOPBACK.has(host)) throw new Error(`the daemon binds to loopback only (got host ${host})`);
  const node = o.node;
  const origins = new Set(o.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const sse = new Set<ServerResponse>();
  let boundPort = 0;

  const buyer = (): BuyerNode => node as BuyerNode;
  const provider = (): ProviderNode => node as ProviderNode;

  const routes: Route[] = [
    { method: 'GET', re: /^\/api\/status$/, handle: async (c) => send(c, 200, await node.status()) },
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

    // buyer
    { method: 'GET', re: /^\/api\/rfqs$/, role: 'buyer', handle: async (c) => send(c, 200, buyer().listRfqs()) },
    { method: 'POST', re: /^\/api\/rfqs$/, role: 'buyer', handle: async (c) => send(c, 201, await buyer().createRfq((await readJson(c)) as never)) },
    { method: 'GET', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})$/, role: 'buyer', handle: async (c) => send(c, 200, buyer().getRfq(c.params[0]!)) },
    { method: 'POST', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})\/accept$/, role: 'buyer', handle: async (c) => {
        const body = (await readJson(c)) as { providerId?: unknown };
        if (!body || typeof body.providerId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(body.providerId)) throw badRequest('body must be { providerId: <64 hex chars> }');
        send(c, 200, await buyer().accept(c.params[0]!, body.providerId));
      } },
    { method: 'POST', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})\/stop$/, role: 'buyer', handle: async (c) => send(c, 200, await buyer().stop(c.params[0]!)) },
    { method: 'POST', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})\/migrate$/, role: 'buyer', handle: async (c) => send(c, 201, await buyer().migrate(c.params[0]!, (await readJson(c)) as never)) },
    { method: 'POST', re: /^\/api\/rfqs\/([0-9a-fA-F]{32})\/fault$/, role: 'buyer', handle: async (c) => {
        const body = (await readJson(c)) as { fault?: unknown };
        if (body?.fault !== 'stop_paying' && body?.fault !== 'resume_paying') throw badRequest('body must be { fault: "stop_paying" | "resume_paying" }');
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
    { method: 'POST', re: /^\/api\/jobs\/([0-9a-fA-F]{32})\/stop$/, role: 'provider', handle: async (c) => send(c, 200, await provider().stopJob(c.params[0]!)) },
    { method: 'POST', re: /^\/api\/jobs\/([0-9a-fA-F]{32})\/fault$/, role: 'provider', handle: async (c) => {
        const body = (await readJson(c)) as { fault?: unknown };
        if (body?.fault !== 'stop_heartbeats' && body?.fault !== 'resume_heartbeats') throw badRequest('body must be { fault: "stop_heartbeats" | "resume_heartbeats" }');
        send(c, 200, provider().fault(c.params[0]!, body.fault as ProviderFault));
      } },
    { method: 'GET', re: /^\/api\/policy$/, role: 'provider', handle: async (c) => send(c, 200, provider().getPolicy()) },
    { method: 'PUT', re: /^\/api\/policy$/, role: 'provider', handle: async (c) => send(c, 200, await provider().setPolicy((await readJson(c)) as never)) },
  ];

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
      // DNS-rebinding guard: only loopback host names.
      const hostHeader = String(req.headers.host ?? '');
      const hostName = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (hostHeader && !LOOPBACK.has(hostName)) throw new EngineError('forbidden', 'bad Host header', 403);
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
