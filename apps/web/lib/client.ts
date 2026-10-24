/**
 * HTTP + SSE client for one Silicr daemon (buyer, provider) or the relay.
 * Talks straight from the browser to localhost; daemons send CORS headers.
 */

import type { DaemonEvent, ErrorDto } from '@silicr/api';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Human prefixes for the ErrorDto codes in @silicr/api. */
const CODE_PREFIX: Record<string, string> = {
  privacy: 'Refused for privacy',
  insufficient_funds: 'Not enough shielded funds',
  wrong_role: 'Wrong daemon for this action (check the buyer and provider URLs)',
  conflict: 'Not possible right now',
  forbidden: 'Refused by the daemon (origin or host not allowed)',
  method_not_allowed: 'Not supported by this daemon',
  unsupported: 'Not supported by this daemon',
  internal: 'Daemon error',
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const prefix = CODE_PREFIX[e.code];
    return prefix && !e.message.toLowerCase().startsWith(prefix.toLowerCase()) ? `${prefix}: ${e.message}` : e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function errorCode(e: unknown): string {
  return e instanceof ApiError ? e.code : 'error';
}

export interface RequestOptions {
  timeoutMs?: number;
}

export type SseState = 'connecting' | 'open' | 'retrying' | 'closed';

export interface SseHandlers {
  onEvent(ev: DaemonEvent): void;
  onState(state: SseState): void;
  /** Called on every successful (re)connect, so the caller can resync anything missed. */
  onOpen?(): void;
}

const EVENT_TYPES: DaemonEvent['type'][] = ['status', 'rfq.updated', 'job.updated', 'log', 'leak', 'chain.tx'];

export class DaemonClient {
  readonly base: string;

  constructor(base: string) {
    this.base = base.replace(/\/+$/, '');
  }

  url(path: string): string {
    return this.base + path;
  }

  async request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch (e) {
      clearTimeout(timer);
      if (ctrl.signal.aborted) throw new ApiError(`Timed out: ${method} ${path}`, 0, 'timeout');
      throw new ApiError(e instanceof Error && e.message ? `Unreachable (${e.message})` : 'Unreachable', 0, 'network');
    }
    try {
      if (!res.ok) {
        let dto: Partial<ErrorDto> | null = null;
        try {
          dto = (await res.json()) as Partial<ErrorDto>;
        } catch {
          // non-JSON error body
        }
        throw new ApiError(dto?.error || `${res.status} ${res.statusText}`.trim(), res.status, dto?.code || `http_${res.status}`);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (ctrl.signal.aborted) throw new ApiError(`Timed out: ${method} ${path}`, 0, 'timeout');
      throw new ApiError(`Bad response from ${path}: ${e instanceof Error ? e.message : String(e)}`, res.status, 'bad_response');
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, opts);
  }

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body ?? {}, opts);
  }

  put<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, opts);
  }

  async blob(path: string, opts: RequestOptions = {}): Promise<Blob> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
    try {
      const res = await fetch(this.url(path), { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) {
        let dto: Partial<ErrorDto> | null = null;
        try {
          dto = (await res.json()) as Partial<ErrorDto>;
        } catch {
          // ignore
        }
        throw new ApiError(dto?.error || `${res.status} ${res.statusText}`, res.status, dto?.code || `http_${res.status}`);
      }
      return await res.blob();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(errorMessage(e), 0, ctrl.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Subscribe to GET /api/events. EventSource retries transient drops itself;
   * when it gives up (readyState CLOSED, e.g. a non-2xx response) we reconnect
   * with capped exponential backoff. Returns an unsubscribe function.
   */
  openEvents(h: SseHandlers): () => void {
    if (typeof EventSource === 'undefined') {
      h.onState('closed');
      return () => {};
    }
    const url = this.url('/api/events');
    let es: EventSource | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string' || !e.data) return;
      try {
        const ev = JSON.parse(e.data) as DaemonEvent;
        if (ev && typeof ev === 'object' && typeof ev.type === 'string') h.onEvent(ev);
      } catch {
        // ignore malformed frames
      }
    };

    const connect = (): void => {
      if (stopped) return;
      h.onState(attempt === 0 ? 'connecting' : 'retrying');
      try {
        es = new EventSource(url);
      } catch {
        es = null;
        schedule();
        return;
      }
      es.onopen = () => {
        attempt = 0;
        h.onState('open');
        h.onOpen?.();
      };
      es.onmessage = onMessage;
      // Also accept frames sent with an explicit `event:` name.
      for (const t of EVENT_TYPES) es.addEventListener(t, onMessage as EventListener);
      es.onerror = () => {
        if (!es) return;
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          schedule();
        } else {
          h.onState('retrying');
        }
      };
    };

    const schedule = (): void => {
      if (stopped) return;
      attempt++;
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempt - 1, 4)) + Math.floor(Math.random() * 400);
      h.onState('retrying');
      timer = setTimeout(connect, delay);
    };

    connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
      es = null;
      h.onState('closed');
    };
  }
}
