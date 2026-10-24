// A small client for the local daemon's @silicr/api, including the SSE stream.
import type { DaemonEvent, ErrorDto, RfqDto } from '@silicr/api';

export const DEFAULT_URLS = {
  relay: 'http://127.0.0.1:7700',
  buyer: 'http://127.0.0.1:7701',
  provider: 'http://127.0.0.1:7702',
  web: 'http://localhost:7703',
} as const;

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class DaemonClient {
  readonly base: string;
  constructor(base: string) {
    this.base = base.replace(/\/+$/, '');
  }

  private async req(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method, headers: {} };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, init);
    } catch {
      throw new ApiError(0, 'unreachable', `no daemon is answering at ${this.base}`);
    }
    if (!res.ok) {
      let e: ErrorDto = { error: `HTTP ${res.status}`, code: 'http_error' };
      try {
        e = (await res.json()) as ErrorDto;
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, e.code, e.error);
    }
    return res;
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.req('GET', path)).json()) as T;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return (await (await this.req('POST', path, body ?? {})).json()) as T;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return (await (await this.req('PUT', path, body)).json()) as T;
  }

  async bytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.req('GET', path)).arrayBuffer());
  }

  /** Resolve a unique rfqId prefix (as printed) to the full id. */
  async resolveRfq(idOrPrefix: string): Promise<string> {
    const p = idOrPrefix.toLowerCase().replace(/…$/, '');
    if (/^[0-9a-f]{32}$/.test(p)) return p;
    const all = await this.get<RfqDto[]>('/api/rfqs');
    const hits = all.filter((r) => r.rfqId.startsWith(p));
    if (hits.length === 1) return hits[0]!.rfqId;
    throw new ApiError(404, 'not_found', hits.length ? `"${idOrPrefix}" matches ${hits.length} RFQs; use more characters` : `no RFQ starts with "${idOrPrefix}"`);
  }

  /** Stream DaemonEvents until the signal aborts or the daemon goes away. */
  async events(onEvent: (e: DaemonEvent) => void, signal: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/events`, { signal });
    } catch (e) {
      if (signal.aborted) return;
      throw new ApiError(0, 'unreachable', `no daemon is answering at ${this.base}`);
    }
    if (!res.ok || !res.body) throw new ApiError(res.status, 'http_error', `event stream refused (HTTP ${res.status})`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              onEvent(JSON.parse(line.slice(6)) as DaemonEvent);
            } catch {
              // ignore a malformed event
            }
          }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      throw e;
    }
  }
}
