/**
 * SOCKS5 (RFC 1928) proxy support for every HTTP(S) connection Silicr's Node side makes, so that
 * with Tor (or any SOCKS5 proxy) the relay never sees this machine's IP address.
 *
 * - `proxyFetch(proxy)` returns a `fetch`-shaped function whose every connection is opened through
 *   the proxy. It is built on node:http / node:https with an Agent whose `createConnection` does the
 *   SOCKS handshake (and TLS on top for https), so no new dependency is needed and nothing in it can
 *   resolve or dial the destination directly.
 * - The destination is handed to the proxy as a hostname (ATYP 0x03): DNS is resolved by the proxy
 *   (`socks5h` semantics, whichever scheme was written), so no lookup leaves this machine.
 * - There is no fallback: an unreachable proxy, a refused CONNECT or a bad reply is an error.
 * - Loopback destinations (localhost, 127/8, ::1) are the one exception: they never go through the
 *   proxy, because nothing leaves the machine (a relay or node on this host). Tor would refuse them anyway.
 */
import http, { type ClientRequestArgs } from 'node:http';
import https from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type ConnectionOptions as TlsConnectionOptions, type TLSSocket } from 'node:tls';

export interface ProxyConfig {
  kind: 'socks5';
  host: string;
  port: number;
  /** RFC 1929 username/password (Tor uses them for stream isolation). Never logged. */
  auth?: { username: string; password: string };
  /** `socks5h://host:port`, credentials stripped: safe to log and show. */
  url: string;
}

export type ProxyErrorCode = 'proxy_bad_url' | 'proxy_unreachable' | 'proxy_timeout' | 'proxy_protocol' | 'proxy_auth' | 'proxy_refused';

export class ProxyError extends Error {
  override name = 'ProxyError';
  readonly code: ProxyErrorCode;
  constructor(code: ProxyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

const HELP = 'expected socks5h://host:port (e.g. socks5h://127.0.0.1:9050 for Tor)';

/**
 * Parses `socks5h://[user:pass@]host[:port]`. `socks5://` is accepted and means the same: names are
 * always resolved by the proxy. The port defaults to 1080. Anything that is not SOCKS5 is refused.
 */
export function parseProxyUrl(raw: string): ProxyConfig {
  const text = raw.trim();
  const m = /^([a-z0-9+.-]+):\/\/(.*)$/i.exec(text);
  if (!m) throw new ProxyError('proxy_bad_url', `bad proxy url ${JSON.stringify(raw)}: ${HELP}`);
  const scheme = m[1]!.toLowerCase();
  if (scheme !== 'socks5' && scheme !== 'socks5h') {
    throw new ProxyError('proxy_bad_url', `unsupported proxy scheme ${JSON.stringify(m[1])} in ${JSON.stringify(raw)}: only SOCKS5 is supported (${HELP})`);
  }
  let rest = m[2]!.replace(/\/+$/, '');
  if (/[/?#]/.test(rest)) throw new ProxyError('proxy_bad_url', `bad proxy url ${JSON.stringify(raw)}: no path or query allowed (${HELP})`);
  let auth: ProxyConfig['auth'];
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const colon = userinfo.indexOf(':');
    if (colon < 0) throw new ProxyError('proxy_bad_url', 'bad proxy url: credentials must be user:pass@');
    const username = userinfo.slice(0, colon);
    const password = userinfo.slice(colon + 1);
    if (username.length === 0 || Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255) {
      throw new ProxyError('proxy_bad_url', 'bad proxy url: username must be 1-255 bytes and password at most 255');
    }
    auth = { username, password };
  }
  let host: string;
  let portText: string | undefined;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0) throw new ProxyError('proxy_bad_url', `bad proxy url ${JSON.stringify(raw)}: unclosed [ipv6]`);
    host = rest.slice(1, end);
    const after = rest.slice(end + 1);
    if (after !== '') {
      if (!after.startsWith(':')) throw new ProxyError('proxy_bad_url', `bad proxy url ${JSON.stringify(raw)}: ${HELP}`);
      portText = after.slice(1);
    }
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon >= 0) {
      host = rest.slice(0, colon);
      portText = rest.slice(colon + 1);
    } else {
      host = rest;
    }
  }
  if (host === '') throw new ProxyError('proxy_bad_url', `bad proxy url ${JSON.stringify(raw)}: missing host (${HELP})`);
  let port = 1080;
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText)) throw new ProxyError('proxy_bad_url', `bad proxy port in ${JSON.stringify(raw)}`);
    port = Number(portText);
    if (port < 1 || port > 65535) throw new ProxyError('proxy_bad_url', `bad proxy url ${JSON.stringify(raw)}: port must be 1-65535`);
  }
  const shown = isIP(host) === 6 ? `[${host}]` : host;
  const cfg: ProxyConfig = { kind: 'socks5', host, port, url: `socks5h://${shown}:${port}` };
  if (auth) cfg.auth = auth;
  return cfg;
}

/** True for destinations on this machine: localhost, 127.0.0.0/8 and ::1 (with or without brackets). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

const REPLY_TEXT: Record<number, string> = {
  1: 'general SOCKS server failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

export interface SocksConnectOptions {
  /** Whole handshake, proxy TCP connect included. Default 45 s (Tor circuits can be slow). */
  timeoutMs?: number;
}

/**
 * Opens a TCP connection to the proxy and asks it to CONNECT to `target`. Hostnames are sent as-is
 * (never resolved here); IP literals use the IPv4/IPv6 address types. Resolves with the tunnelled
 * socket once the proxy has confirmed the connection.
 */
export function socksConnect(proxy: ProxyConfig, target: { host: string; port: number }, opts: SocksConnectOptions = {}): Promise<Socket> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const host = target.host.replace(/^\[|\]$/g, '');
  const port = target.port;
  return new Promise<Socket>((resolve, reject) => {
    const sock = netConnect({ host: proxy.host, port: proxy.port });
    sock.setNoDelay(true);
    let done = false;
    let buf: Buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting';

    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onError);
      sock.off('close', onClose);
      if (err) {
        sock.destroy();
        reject(err);
        return;
      }
      if (buf.length > 0) sock.unshift(buf);
      resolve(sock);
    };
    const timer = setTimeout(() => finish(new ProxyError('proxy_timeout', `SOCKS5 proxy ${proxy.url} did not answer within ${timeoutMs} ms`)), timeoutMs);
    const onError = (e: NodeJS.ErrnoException) =>
      finish(new ProxyError('proxy_unreachable', `SOCKS5 proxy ${proxy.url} is unreachable: ${e.code ?? e.message}`, { cause: e }));
    const onClose = () => finish(new ProxyError('proxy_protocol', `SOCKS5 proxy ${proxy.url} closed the connection during the ${stage}`));

    const connectRequest = (): Buffer => {
      const head = Buffer.from([0x05, 0x01, 0x00]);
      let addr: Buffer;
      const v = isIP(host);
      if (v === 4) {
        addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))]);
      } else if (v === 6) {
        addr = Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)]);
      } else {
        const name = Buffer.from(host, 'utf8');
        if (name.length === 0 || name.length > 255) throw new ProxyError('proxy_bad_url', 'SOCKS5: hostname must be 1-255 bytes');
        addr = Buffer.concat([Buffer.from([0x03, name.length]), name]);
      }
      const p = Buffer.alloc(2);
      p.writeUInt16BE(port, 0);
      return Buffer.concat([head, addr, p]);
    };

    const onData = (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          if (stage === 'greeting') {
            if (buf.length < 2) return;
            const [ver, method] = [buf[0]!, buf[1]!];
            buf = buf.subarray(2);
            if (ver !== 0x05) throw new ProxyError('proxy_protocol', `${proxy.url} is not a SOCKS5 proxy (version byte ${ver})`);
            if (method === 0x00) {
              stage = 'connect';
              sock.write(connectRequest());
            } else if (method === 0x02 && proxy.auth) {
              stage = 'auth';
              const u = Buffer.from(proxy.auth.username, 'utf8');
              const p = Buffer.from(proxy.auth.password, 'utf8');
              sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
            } else if (method === 0xff) {
              throw new ProxyError('proxy_auth', `SOCKS5 proxy ${proxy.url} accepts none of our authentication methods`);
            } else {
              throw new ProxyError('proxy_auth', `SOCKS5 proxy ${proxy.url} chose an unsupported authentication method ${method}`);
            }
          } else if (stage === 'auth') {
            if (buf.length < 2) return;
            const status = buf[1]!;
            buf = buf.subarray(2);
            if (status !== 0x00) throw new ProxyError('proxy_auth', `SOCKS5 proxy ${proxy.url} rejected the username/password`);
            stage = 'connect';
            sock.write(connectRequest());
          } else {
            if (buf.length < 4) return;
            const [ver, rep, , atyp] = [buf[0]!, buf[1]!, buf[2]!, buf[3]!];
            if (ver !== 0x05) throw new ProxyError('proxy_protocol', `SOCKS5 proxy ${proxy.url} sent a malformed CONNECT reply`);
            if (rep !== 0x00) {
              throw new ProxyError('proxy_refused', `SOCKS5 proxy ${proxy.url} refused to connect to ${host}:${port}: ${REPLY_TEXT[rep] ?? `reply code ${rep}`}`);
            }
            let total: number;
            if (atyp === 0x01) total = 4 + 4 + 2;
            else if (atyp === 0x04) total = 4 + 16 + 2;
            else if (atyp === 0x03) {
              if (buf.length < 5) return;
              total = 4 + 1 + buf[4]! + 2;
            } else throw new ProxyError('proxy_protocol', `SOCKS5 proxy ${proxy.url} sent an unknown address type ${atyp} in its reply`);
            if (buf.length < total) return;
            buf = buf.subarray(total);
            finish(null);
            return;
          }
        }
      } catch (e) {
        finish(e instanceof Error ? e : new ProxyError('proxy_protocol', String(e)));
      }
    };

    sock.once('connect', () => {
      const methods = proxy.auth ? [0x00, 0x02] : [0x00];
      sock.write(Buffer.from([0x05, methods.length, ...methods]));
    });
    sock.on('data', onData);
    sock.on('error', onError);
    sock.on('close', onClose);
  });
}

function ipv6Bytes(host: string): Buffer {
  // Expand "::" and parse the 8 groups (an IPv4-mapped tail is rare enough to spell out).
  let h = host;
  const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split('.').map(Number) as [number, number, number, number];
    h = `${h.slice(0, v4.index)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [left, right] = h.split('::');
  const l = left ? left.split(':') : [];
  const r = right ? right.split(':') : [];
  const groups = [...l, ...Array(Math.max(0, 8 - l.length - r.length)).fill('0'), ...r];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return out;
}

export interface ProxyFetchOptions {
  /** Whole SOCKS handshake, proxy TCP connect included. Default 45 s. */
  connectTimeoutMs?: number;
  /** Extra TLS options for https destinations (tests pass a `ca`). Certificates are always verified. */
  tls?: Pick<TlsConnectionOptions, 'ca' | 'minVersion'>;
  /** Connect directly to loopback destinations (nothing leaves the machine). Default true. */
  bypassLoopback?: boolean;
}

type CreateConnectionOptions = ClientRequestArgs & { servername?: string | undefined };

type CreateConnectionCallback = (err: Error | null, socket?: Socket | TLSSocket) => void;

/** Opens sockets for an Agent: a SOCKS tunnel to the destination, with TLS on top for https. */
class Tunneler {
  private readonly proxy: ProxyConfig;
  private readonly secure: boolean;
  private readonly fopts: ProxyFetchOptions;

  constructor(proxy: ProxyConfig, secure: boolean, fopts: ProxyFetchOptions) {
    this.proxy = proxy;
    this.secure = secure;
    this.fopts = fopts;
  }

  create(options: CreateConnectionOptions, callback: CreateConnectionCallback): void {
    const host = String(options.hostname ?? options.host ?? '').replace(/^\[|\]$/g, '');
    const port = Number(options.port ?? (this.secure ? 443 : 80));
    const wrap = (raw: Socket): Socket | TLSSocket => {
      if (!this.secure) return raw;
      const tls: TlsConnectionOptions = { socket: raw, host, port, rejectUnauthorized: true, ...(this.fopts.tls ?? {}) };
      // RFC 6066: no SNI for IP literals.
      if (isIP(host) === 0) tls.servername = options.servername ?? host;
      return tlsConnect(tls);
    };
    if ((this.fopts.bypassLoopback ?? true) && isLoopbackHost(host)) {
      const raw = netConnect({ host, port });
      raw.once('connect', () => callback(null, wrap(raw)));
      raw.once('error', (e) => callback(e));
      return;
    }
    const sopts: SocksConnectOptions = {};
    if (this.fopts.connectTimeoutMs !== undefined) sopts.timeoutMs = this.fopts.connectTimeoutMs;
    socksConnect(this.proxy, { host, port }, sopts).then(
      (raw) => callback(null, wrap(raw)),
      (e: Error) => callback(e),
    );
  }
}

// node:http calls agent.createConnection(options, callback) for every new socket; returning
// nothing and calling back later is the documented asynchronous form. Each protocol needs its own
// Agent class: http.request refuses an agent whose `protocol` differs from the request's.
type NodeCreateConnectionCallback = (err: Error | null, stream: Duplex) => void;

class SocksHttpAgent extends http.Agent {
  private readonly tunnel: Tunneler;
  constructor(tunnel: Tunneler) {
    super({ keepAlive: true, maxSockets: 8 });
    this.tunnel = tunnel;
  }
  override createConnection(options: ClientRequestArgs, callback?: NodeCreateConnectionCallback): Duplex | null | undefined {
    if (!callback) throw new Error('SocksHttpAgent only supports the asynchronous createConnection form');
    this.tunnel.create(options, callback as CreateConnectionCallback);
    return undefined;
  }
}

class SocksHttpsAgent extends https.Agent {
  private readonly tunnel: Tunneler;
  constructor(tunnel: Tunneler) {
    super({ keepAlive: true, maxSockets: 8 });
    this.tunnel = tunnel;
  }
  override createConnection(options: https.RequestOptions, callback?: NodeCreateConnectionCallback): Duplex | null | undefined {
    if (!callback) throw new Error('SocksHttpsAgent only supports the asynchronous createConnection form');
    this.tunnel.create(options, callback as CreateConnectionCallback);
    return undefined;
  }
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

async function bodyBytes(body: RequestInit['body'], headers: Headers): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8');
    return Buffer.from(body, 'utf8');
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    return Buffer.from(body.toString(), 'utf8');
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) {
    if (body.type && !headers.has('content-type')) headers.set('content-type', body.type);
    return Buffer.from(await body.arrayBuffer());
  }
  throw new TypeError('proxyFetch: unsupported request body type (use bytes, a string, URLSearchParams or a Blob)');
}

function abortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new DOMException('This operation was aborted', 'AbortError');
}

/**
 * A `fetch` whose every connection goes through the SOCKS5 proxy. Redirects are returned, not
 * followed; bodies are buffered (Silicr's relay bodies are at most 16 MiB). Network and proxy
 * failures reject with `TypeError('fetch failed', { cause })`, like the real fetch.
 */
export function proxyFetch(proxy: ProxyConfig | string, opts: ProxyFetchOptions = {}): typeof fetch {
  const cfg = typeof proxy === 'string' ? parseProxyUrl(proxy) : proxy;
  const agents = {
    'http:': new SocksHttpAgent(new Tunneler(cfg, false, opts)),
    'https:': new SocksHttpsAgent(new Tunneler(cfg, true, opts)),
  };

  return async function fetchViaProxy(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`proxyFetch: unsupported protocol ${url.protocol}`);
    const signal = init.signal ?? null;
    if (signal?.aborted) throw abortError(signal);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = await bodyBytes(init.body, headers);
    const headerObj: Record<string, string> = {};
    headers.forEach((v, k) => {
      headerObj[k] = v;
    });
    if (body) headerObj['content-length'] = String(body.length);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const mod = url.protocol === 'https:' ? https : http;
    const agent = url.protocol === 'https:' ? agents['https:'] : agents['http:'];

    return new Promise<Response>((resolve, reject) => {
      const req = mod.request(
        {
          host,
          port,
          path: `${url.pathname}${url.search}`,
          method: (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
          headers: headerObj,
          agent,
          servername: isIP(host) === 0 ? host : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('error', (e) => reject(new TypeError('fetch failed', { cause: e })));
          res.on('end', () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) for (const x of v) h.append(k, x);
              else if (v !== undefined) h.set(k, v);
            }
            const status = res.statusCode ?? 0;
            const data = NULL_BODY_STATUS.has(status) ? null : (Buffer.concat(chunks) as Uint8Array<ArrayBuffer>);
            resolve(new Response(data, { status, statusText: res.statusMessage ?? '', headers: h }));
          });
        },
      );
      req.on('error', (e) => reject(signal?.aborted ? abortError(signal) : new TypeError('fetch failed', { cause: e })));
      if (signal) signal.addEventListener('abort', () => req.destroy(abortError(signal)), { once: true });
      req.end(body);
    });
  };
}
