// A small HTTP client for the local daemon's @silicr/api (JSON in, JSON or bytes out).
import type { ErrorDto } from '@silicr/api';

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  /** An ErrorDto code, or 'unreachable' / 'timeout' / 'http_error' for transport-level failures. */
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class DaemonClient {
  readonly base: string;
  readonly timeoutMs: number;

  constructor(base: string, timeoutMs = 15_000) {
    this.base = base.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  private async req(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<Response> {
    const init: RequestInit = { method, headers: {}, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, init);
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new ApiError(0, 'timeout', `${this.base} did not answer within ${timeoutMs} ms`);
      throw new ApiError(0, 'unreachable', `no daemon is answering at ${this.base}`);
    }
    if (!res.ok) {
      let e: ErrorDto = { error: `HTTP ${res.status}`, code: 'http_error' };
      try {
        const parsed = (await res.json()) as Partial<ErrorDto>;
        if (parsed && typeof parsed.error === 'string') e = { error: parsed.error, code: typeof parsed.code === 'string' ? parsed.code : 'http_error' };
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, e.code, e.error);
    }
    return res;
  }

  async get<T>(path: string, timeoutMs?: number): Promise<T> {
    return (await (await this.req('GET', path, undefined, timeoutMs)).json()) as T;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return (await (await this.req('POST', path, body ?? {})).json()) as T;
  }

  async bytes(path: string, timeoutMs = 120_000): Promise<Uint8Array> {
    return new Uint8Array(await (await this.req('GET', path, undefined, timeoutMs)).arrayBuffer());
  }
}
