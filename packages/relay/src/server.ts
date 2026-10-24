/**
 * The relay HTTP server (node:http, no framework). See the contract in index.ts.
 *
 * Privacy: request bodies are never parsed (except directory entries, which are
 * public), never logged and never echoed in errors. The optional request log
 * carries method, path, status, size and duration only.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import type { RelayObserverResponse } from '@silicr/api';
import { DirectoryStore, EntryRejected, checkEntry } from './directory.ts';
import type { CheckedEntry } from './directory.ts';
import { ObserverFeed, bodyFields, clientFields, parseObserverCursor } from './observer.ts';
import { HttpError, MAILBOX_ID_RE, MailboxStore } from './store.ts';
import type { RelayLimits, RelayOptions, RunningRelay } from './index.ts';
import { DEFAULT_LIMITS } from './limits.ts';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const CORS_ORIGINS = new Set(['http://localhost:7703', 'http://127.0.0.1:7703']);
const CORS_PATHS = new Set(['/_observer', '/directory', '/health']);
const SEQ_RE = /^[1-9][0-9]{0,15}$/;
const UINT_RE = /^[0-9]{1,16}$/;

export async function startRelay(opts: RelayOptions): Promise<RunningRelay> {
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const dataDir = resolve(opts.dataDir);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const log = opts.log;
  const store = new MailboxStore(join(dataDir, 'mailboxes'), ttlMs, limits);
  const directory = new DirectoryStore(dataDir, limits.maxDirectoryEntries);
  const observer = opts.observer ? new ObserverFeed(limits.maxObservations) : null;
  await store.init();
  const dropped = await directory.load();
  if (dropped > 0) log?.(`directory: dropped ${dropped} invalid or superseded entr${dropped === 1 ? 'y' : 'ies'} from directory.json`);

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      if (!log) return;
      const path = (req.url ?? '/').split('?')[0];
      const inBytes = req.headers['content-length'] ?? 0;
      const outBytes = res.getHeader('content-length') ?? 0;
      log(`${req.method} ${path} ${res.statusCode} in=${inBytes}B out=${outBytes}B ${Date.now() - started}ms`);
    });
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        sendError(req, res, err.status, err.code, err.message);
        return;
      }
      log?.(`error: ${err instanceof Error ? err.message : 'unknown error'}`);
      sendError(req, res, 500, 'internal', 'internal error');
    });
  });
  // Long-polls hold requests for up to maxWaitS, and a 16 MiB upload over a slow link
  // (e.g. through Tor) can take minutes: keep the request timeout generous.
  server.requestTimeout = 10 * 60_000;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      if (!CORS_PATHS.has(path)) return sendError(req, res, 405, 'method_not_allowed', 'method not allowed');
      writeHead(res, 204, {
        ...corsHeaders(req, path),
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age': '600',
        'Content-Length': '0',
      });
      res.end();
      return;
    }

    if (path === '/health') {
      if (method !== 'GET') return methodNotAllowed(req, res, 'GET');
      return sendJson(req, res, 200, { ok: true });
    }

    if (path === '/directory') {
      if (method === 'GET') {
        const entries = directory.list();
        if (observer) {
          const at = Date.now();
          observer.record(
            'directory-read',
            `Served the public provider directory (${entries.length} entries) to a client`,
            [
              { label: 'entries', value: String(entries.length), readable: true, sensitive: false },
              ...clientFields(clientIp(req), at),
            ],
            at,
          );
        }
        return sendJson(req, res, 200, entries);
      }
      if (method === 'POST') {
        let body: Buffer;
        let checked: CheckedEntry;
        try {
          body = await readBody(req, limits.maxDirectoryEntryBytes);
          checked = checkEntry(body);
          await directory.publish(checked);
        } catch (err) {
          if (observer && err instanceof HttpError) {
            // Rejections record the providerId (only if it was well-formed hex) and the reason, nothing else.
            const pid = err instanceof EntryRejected ? err.providerId : undefined;
            observer.record(
              'directory-rejected',
              `Rejected a directory entry${pid ? ` for provider ${pid.slice(0, 12)}…` : ''} (${err.code})`,
              [
                ...(pid ? [{ label: 'providerId', value: pid, readable: true, sensitive: false }] : []),
                { label: 'reason', value: err.code, readable: true, sensitive: false },
              ],
            );
          }
          throw err;
        }
        if (observer) {
          const at = Date.now();
          observer.record(
            'directory-published',
            `Provider ${checked.providerId.slice(0, 12)}… published its public directory entry`,
            [
              { label: 'providerId', value: checked.providerId, readable: true, sensitive: false },
              ...bodyFields(body).filter((f) => f.label !== 'first 24 bytes'),
              ...clientFields(clientIp(req), at),
            ],
            at,
          );
        }
        writeHead(res, 204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      return methodNotAllowed(req, res, 'GET, POST');
    }

    if (path === '/_observer') {
      if (!observer) return sendError(req, res, 404, 'not_found', 'observer feed is disabled');
      if (method !== 'GET') return methodNotAllowed(req, res, 'GET');
      const after = parseObserverCursor(url.searchParams.get('after'));
      if (after === null) throw new HttpError(400, 'bad_request', 'after must be an observation id');
      const limit = parseUint(url.searchParams.get('limit'), limits.maxObservations, 'limit');
      const out: RelayObserverResponse = {
        observations: observer.since(after, Math.min(Math.max(limit, 1), limits.maxObservations)),
      };
      return sendJson(req, res, 200, out);
    }

    const parts = path.split('/');
    if (parts[1] === 'm' && (parts.length === 3 || parts.length === 4)) {
      const id = parts[2] ?? '';
      if (!MAILBOX_ID_RE.test(id)) throw new HttpError(400, 'bad_request', 'mailbox id must be 32 lowercase hex chars');

      if (parts.length === 3) {
        if (method === 'PUT') {
          const body = await readBody(req, limits.maxMessageBytes);
          const seq = await store.append(id, body);
          if (observer) {
            const at = Date.now();
            observer.record(
              'blob-stored',
              `Stored opaque blob #${seq} (${body.byteLength} B) in mailbox ${id.slice(0, 8)}…; the relay holds ciphertext it cannot read`,
              [mailboxField(id), seqField(seq), ...bodyFields(body), ...clientFields(clientIp(req), at)],
              at,
            );
          }
          return sendJson(req, res, 201, { seq });
        }
        if (method === 'GET') {
          const after = parseUint(url.searchParams.get('after'), 0, 'after');
          const waitRaw = url.searchParams.get('wait');
          let waitS = 0;
          if (waitRaw !== null && waitRaw !== '') {
            waitS = Number(waitRaw);
            if (!Number.isFinite(waitS) || waitS < 0) throw new HttpError(400, 'bad_request', 'wait must be a number of seconds ≥ 0');
            waitS = Math.min(waitS, limits.maxWaitS);
          }
          const limit = Math.max(1, Math.min(parseUint(url.searchParams.get('limit'), limits.maxListMessages, 'limit'), limits.maxListMessages));
          let messages = store.list(id, after, limit);
          if (messages.length === 0 && waitS > 0) {
            const abort = new AbortController();
            const onClose = () => abort.abort();
            res.on('close', onClose);
            await store.waitFor(id, after, waitS * 1000, abort.signal);
            res.off('close', onClose);
            if (abort.signal.aborted || res.destroyed) return;
            messages = store.list(id, after, limit);
          }
          return sendJson(req, res, 200, { messages });
        }
        return methodNotAllowed(req, res, 'GET, PUT');
      }

      const seqRaw = parts[3] ?? '';
      if (!SEQ_RE.test(seqRaw)) throw new HttpError(400, 'bad_request', 'seq must be a positive integer');
      if (method !== 'GET') return methodNotAllowed(req, res, 'GET');
      const seq = Number(seqRaw);
      const data = await store.read(id, seq);
      if (!data) return sendError(req, res, 404, 'not_found', 'no such message');
      if (observer) {
        const at = Date.now();
        observer.record(
          'blob-fetched',
          `Served opaque blob #${seq} (${data.byteLength} B) from mailbox ${id.slice(0, 8)}…`,
          [mailboxField(id), seqField(seq), ...bodyFields(data), ...clientFields(clientIp(req), at)],
          at,
        );
      }
      writeHead(res, 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.byteLength),
        'Cache-Control': 'no-store',
      });
      res.end(data);
      return;
    }

    sendError(req, res, 404, 'not_found', 'not found');
  }

  try {
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
        server.off('error', fail);
        ok();
      });
    });
  } catch (err) {
    await store.close();
    throw err;
  }
  const addr = server.address() as AddressInfo;
  const url = `http://${urlHost(addr.address)}:${addr.port}`;

  let closing: Promise<void> | undefined;
  return {
    url,
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>((ok) => server.close(() => ok()));
        await store.close(); // releases long-polls so their responses go out
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 250).unref();
        await stopped;
        await directory.close();
      })();
      return closing;
    },
  };
}

function corsHeaders(req: http.IncomingMessage, path: string): Record<string, string> {
  const origin = req.headers.origin;
  if (!CORS_PATHS.has(path) || typeof origin !== 'string' || !CORS_ORIGINS.has(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  writeHead(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(data.byteLength),
    'Cache-Control': 'no-store',
    ...corsHeaders(req, path),
  });
  res.end(data);
}

/** setHeader + writeHead, so the request log can read the headers back. */
function writeHead(res: http.ServerResponse, status: number, headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.writeHead(status);
}

function sendError(req: http.IncomingMessage, res: http.ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // Unread request bodies (e.g. a 413) would otherwise stall a keep-alive connection.
  if (!req.complete) res.setHeader('Connection', 'close');
  sendJson(req, res, status, { error: message, code });
}

function methodNotAllowed(req: http.IncomingMessage, res: http.ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendError(req, res, 405, 'method_not_allowed', 'method not allowed');
}

function parseUint(raw: string | null, dflt: number, name: string): number {
  if (raw === null || raw === '') return dflt;
  if (!UINT_RE.test(raw)) throw new HttpError(400, 'bad_request', `${name} must be a non-negative integer`);
  return Number(raw);
}

/**
 * Read the whole body, up to `limit` bytes. Over the limit: stop buffering, drain
 * (bounded) so the client can read the 413, then fail.
 */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const declared = Number(req.headers['content-length'] ?? NaN);
    const tooLarge = () => new HttpError(413, 'too_large', `body exceeds ${limit} bytes`);
    const drainLimit = limit * 2 + 1024 * 1024;
    let size = 0;
    let over = Number.isFinite(declared) && declared > limit;
    const chunks: Buffer[] = [];
    if (over && declared > drainLimit) {
      req.resume();
      fail(tooLarge());
      return;
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (over) {
        if (size > drainLimit) {
          req.destroy();
        }
        return;
      }
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => (over ? fail(tooLarge()) : ok(Buffer.concat(chunks, size))));
    req.on('error', fail);
    req.on('close', () => {
      if (!req.complete) fail(over ? tooLarge() : new HttpError(400, 'bad_request', 'request aborted'));
    });
  });
}

function clientIp(req: http.IncomingMessage): string {
  const ip = req.socket.remoteAddress ?? 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function urlHost(address: string): string {
  if (address === '0.0.0.0') return '127.0.0.1';
  if (address === '::') return '[::1]';
  return address.includes(':') ? `[${address}]` : address;
}

function mailboxField(id: string) {
  return { label: 'mailbox', value: id, readable: true, sensitive: false };
}

function seqField(seq: number) {
  return { label: 'seq', value: String(seq), readable: true, sensitive: false };
}
