/**
 * fetch-based relay client with small retry/backoff on network errors.
 *
 * Delivery is at-least-once: if a PUT reaches the relay but the response is
 * lost, the retry stores a second copy. Sealed blobs carry their own sequence
 * numbers, so consumers should dedupe on those.
 */
import type { RelayClient } from './index.ts';
import { parseProxyUrl, proxyFetch, type ProxyConfig } from './proxy.ts';

const MAILBOX_ID_RE = /^[0-9a-f]{32}$/;

export class RelayError extends Error {
  /** HTTP status, or 0 for a network error. */
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
  }
}

export interface RelayClientOptions {
  /** Custom fetch. Default: global fetch, or proxyFetch(proxy) when `proxy` is set. */
  fetch?: typeof fetch;
  /**
   * SOCKS5 proxy (Tor: socks5h://127.0.0.1:9050) for every connection to the relay. Hostnames are
   * resolved by the proxy and there is no direct fallback. Loopback relays connect directly.
   */
  proxy?: string | ProxyConfig;
  /** Attempts per request on network errors and 502/503/504. Default 4. */
  attempts?: number;
  /** First backoff delay in ms (doubles each retry, with jitter). Default 200. */
  backoffMs?: number;
  /** Stop fetching more messages in one read() once this many bytes were fetched. Default 64 MiB. */
  maxReadBytes?: number;
}

export function relayClient(baseUrl: string, opts: RelayClientOptions = {}): RelayClient {
  const base = baseUrl.replace(/\/+$/, '');
  if (opts.fetch && opts.proxy) throw new TypeError('relayClient: pass either fetch or proxy, not both');
  const proxy = opts.proxy === undefined ? null : typeof opts.proxy === 'string' ? parseProxyUrl(opts.proxy) : opts.proxy;
  const doFetch = opts.fetch ?? (proxy ? proxyFetch(proxy) : fetch);
  const via = proxy ? ` via SOCKS5 proxy ${proxy.url}` : '';
  const attempts = Math.max(1, opts.attempts ?? 4);
  const backoffMs = opts.backoffMs ?? 200;
  const maxReadBytes = opts.maxReadBytes ?? 64 * 1024 * 1024;

  async function request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    let delay = backoffMs;
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      let netErr: unknown;
      try {
        res = await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        netErr = err;
      }
      const retryable = res === undefined || res.status === 502 || res.status === 503 || res.status === 504;
      if (!retryable) return res!;
      if (attempt >= attempts) {
        if (res) return res;
        const why = netErr instanceof Error ? (causeCode(netErr) ?? netErr.message) : 'network error';
        throw new RelayError(0, 'network', `relay unreachable at ${base}${via}: ${why}`);
      }
      await res?.body?.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * delay * 0.25)));
      delay *= 2;
    }
  }

  async function failed(res: Response): Promise<never> {
    let code = 'http_error';
    let message = `relay returned HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown; code?: unknown };
      if (typeof body.code === 'string') code = body.code;
      if (typeof body.error === 'string') message = `${message}: ${body.error}`;
    } catch {
      // not JSON
    }
    throw new RelayError(res.status, code, message);
  }

  function checkId(mailbox: string): void {
    if (!MAILBOX_ID_RE.test(mailbox)) throw new RelayError(400, 'bad_request', 'mailbox id must be 32 lowercase hex chars');
  }

  return {
    baseUrl: base,

    async append(mailbox, data) {
      checkId(mailbox);
      const res = await request(
        `/m/${mailbox}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: data as Uint8Array<ArrayBuffer>,
        },
        120_000,
      );
      if (!res.ok) return failed(res);
      const body = (await res.json()) as { seq?: unknown };
      if (typeof body.seq !== 'number') throw new RelayError(res.status, 'bad_response', 'relay returned no seq');
      return body.seq;
    },

    async read(mailbox, afterSeq, waitS = 0) {
      checkId(mailbox);
      const wait = Math.max(0, Math.min(waitS, 30));
      const listRes = await request(`/m/${mailbox}?after=${Math.max(0, Math.floor(afterSeq))}&wait=${wait}`, { method: 'GET' }, wait * 1000 + 15_000);
      if (!listRes.ok) return failed(listRes);
      const list = (await listRes.json()) as { messages?: { seq: number; size: number }[] };
      const out: { seq: number; data: Uint8Array }[] = [];
      let fetched = 0;
      for (const m of list.messages ?? []) {
        if (out.length > 0 && fetched + m.size > maxReadBytes) break;
        const res = await request(`/m/${mailbox}/${m.seq}`, { method: 'GET' }, 120_000);
        if (res.status === 404) {
          // Expired between listing and fetch: nothing later survives either.
          await res.body?.cancel().catch(() => undefined);
          break;
        }
        if (!res.ok) return failed(res);
        const data = new Uint8Array(await res.arrayBuffer());
        fetched += data.byteLength;
        out.push({ seq: m.seq, data });
      }
      return out;
    },

    async listDirectory() {
      const res = await request('/directory', { method: 'GET' }, 30_000);
      if (!res.ok) return failed(res);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) throw new RelayError(res.status, 'bad_response', 'directory is not a JSON array');
      return body;
    },

    async publishDirectory(entry) {
      const res = await request(
        '/directory',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) },
        30_000,
      );
      if (!res.ok) return failed(res);
      await res.body?.cancel().catch(() => undefined);
    },
  };
}

function causeCode(err: Error): string | undefined {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
  if (typeof cause?.code !== 'string') return undefined;
  // Proxy failures carry a full explanation; errno codes (ECONNREFUSED…) are clear on their own.
  return cause.code.startsWith('proxy_') && typeof cause.message === 'string' ? cause.message : cause.code;
}
