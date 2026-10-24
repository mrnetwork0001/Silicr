/**
 * Client-side store: one module-level immutable state object, read through
 * useSyncExternalStore. Both the real driver (daemons over HTTP/SSE) and the
 * mock replay write into it through `actions`; components never fetch directly.
 *
 * Selectors passed to useSilicr must return existing references or primitives
 * (derive arrays with useMemo), otherwise React re-renders forever.
 */

import { useSyncExternalStore } from 'react';
import type {
  LeakObservation,
  Party,
  ProviderDto,
  ProviderJobDto,
  ProviderPolicyDto,
  PublicTxViewDto,
  RfqDto,
  StatusDto,
} from '@silicr/api';
import type { SseState } from './client';

export type Mode = 'probing' | 'mock' | 'real';
export type MockReason = 'forced' | 'unreachable';
export type DaemonRole = 'buyer' | 'provider' | 'relay';
export type ConnStatus = 'unknown' | 'online' | 'offline';

export interface DaemonConn {
  url: string;
  status: ConnStatus;
  sse: SseState | 'off';
  error: string | null;
  lastOkAt: number | null;
}

export interface State {
  mode: Mode;
  mockReason: MockReason | null;
  conn: Record<DaemonRole, DaemonConn>;
  buyerStatus: StatusDto | null;
  providerStatus: StatusDto | null;
  /** Whether GET {relay}/_observer answers (only in demo mode). */
  relayObserver: 'unknown' | 'available' | 'unavailable';
  relayObserverError: string | null;

  providers: ProviderDto[] | null;
  providersError: string | null;

  rfqs: Record<string, RfqDto>;
  rfqsLoaded: boolean;
  rfqErrors: Record<string, string>;
  /** Buyer-side decrypted job log per RFQ: every line seen, merged from logTail snapshots + SSE `log` events. */
  logs: Record<string, string[]>;

  jobs: Record<string, ProviderJobDto>;
  jobsLoaded: boolean;
  jobsError: string | null;
  jobLogs: Record<string, string[]>;
  policy: ProviderPolicyDto | null;

  leaks: Record<Party, Record<string, LeakObservation>>;
  leakErrors: Record<Party, string | null>;
  chainTx: Record<string, PublicTxViewDto>;
  /** First time this terminal saw each txid (orders mempool transactions). */
  chainSeen: Record<string, number>;
  chainErrors: Record<string, string>;

  inspector: { open: boolean; pinnedRfqId: string | null };
}

function conn(url: string): DaemonConn {
  return { url, status: 'unknown', sse: 'off', error: null, lastOkAt: null };
}

export function initialState(urls: Record<DaemonRole, string> = { buyer: '', provider: '', relay: '' }): State {
  return {
    mode: 'probing',
    mockReason: null,
    conn: { buyer: conn(urls.buyer), provider: conn(urls.provider), relay: conn(urls.relay) },
    buyerStatus: null,
    providerStatus: null,
    relayObserver: 'unknown',
    relayObserverError: null,
    providers: null,
    providersError: null,
    rfqs: {},
    rfqsLoaded: false,
    rfqErrors: {},
    logs: {},
    jobs: {},
    jobsLoaded: false,
    jobsError: null,
    jobLogs: {},
    policy: null,
    leaks: { chain: {}, relay: {}, provider: {}, buyer: {} },
    leakErrors: { chain: null, relay: null, provider: null, buyer: null },
    chainTx: {},
    chainSeen: {},
    chainErrors: {},
    inspector: { open: false, pinnedRfqId: null },
  };
}

const SERVER_STATE: State = initialState();
let state: State = initialState();
const listeners = new Set<() => void>();
let notifyQueued = false;

function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const l of listeners) l();
  });
}

export function getState(): State {
  return state;
}

export function setState(fn: (s: State) => State): void {
  const next = fn(state);
  if (next !== state) {
    state = next;
    notify();
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSilicr<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(SERVER_STATE),
  );
}

// ---------------------------------------------------------------------------
// Log merging

const LOG_CAP = 1000;

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Merge a "last N lines" snapshot into an accumulated buffer, using the longest overlap. */
export function mergeLogTail(buffer: string[] | undefined, tail: string[]): string[] {
  if (!tail.length) return buffer ?? [];
  if (!buffer || !buffer.length) return tail.slice(-LOG_CAP);
  // Snapshot entirely contained at the end of the buffer: nothing new.
  if (tail.length <= buffer.length && sameLines(buffer.slice(buffer.length - tail.length), tail)) return buffer;
  const max = Math.min(buffer.length, tail.length);
  for (let k = max; k >= 1; k--) {
    if (sameLines(buffer.slice(buffer.length - k), tail.slice(0, k))) {
      return [...buffer, ...tail.slice(k)].slice(-LOG_CAP);
    }
  }
  // No overlap: the snapshot skipped ahead (or the daemon restarted). Keep both, newest last.
  return [...buffer, ...tail].slice(-LOG_CAP);
}

function appendLines(buffer: string[] | undefined, lines: string[]): string[] {
  const b = buffer ?? [];
  if (!lines.length) return b;
  if (b.length >= lines.length && sameLines(b.slice(b.length - lines.length), lines)) return b;
  return [...b, ...lines].slice(-LOG_CAP);
}

// ---------------------------------------------------------------------------
// Actions (the only writers)

export const actions = {
  reset(urls: Record<DaemonRole, string>, keepInspector = true): void {
    setState((s) => {
      const fresh = initialState(urls);
      return keepInspector ? { ...fresh, inspector: s.inspector } : fresh;
    });
  },

  setMode(mode: Mode, mockReason: MockReason | null = null): void {
    setState((s) => (s.mode === mode && s.mockReason === mockReason ? s : { ...s, mode, mockReason }));
  },

  setConn(role: DaemonRole, patch: Partial<DaemonConn>): void {
    setState((s) => {
      const cur = s.conn[role];
      let changed = false;
      for (const k of Object.keys(patch) as (keyof DaemonConn)[]) {
        if (cur[k] !== patch[k]) changed = true;
      }
      if (!changed) return s;
      return { ...s, conn: { ...s.conn, [role]: { ...cur, ...patch } } };
    });
  },

  setStatus(role: 'buyer' | 'provider', status: StatusDto | null): void {
    setState((s) => (role === 'buyer' ? { ...s, buyerStatus: status } : { ...s, providerStatus: status }));
  },

  setRelayObserver(v: State['relayObserver'], error: string | null = null): void {
    setState((s) => (s.relayObserver === v && s.relayObserverError === error ? s : { ...s, relayObserver: v, relayObserverError: error }));
  },

  setProviders(list: ProviderDto[] | null, error: string | null = null): void {
    setState((s) => ({ ...s, providers: list ?? s.providers, providersError: error }));
  },

  upsertRfq(rfq: RfqDto): void {
    setState((s) => {
      const errors = s.rfqErrors[rfq.rfqId] ? { ...s.rfqErrors } : s.rfqErrors;
      if (errors !== s.rfqErrors) delete errors[rfq.rfqId];
      const merged = mergeLogTail(s.logs[rfq.rfqId], rfq.logTail ?? []);
      return {
        ...s,
        rfqs: { ...s.rfqs, [rfq.rfqId]: rfq },
        rfqErrors: errors,
        logs: merged === s.logs[rfq.rfqId] ? s.logs : { ...s.logs, [rfq.rfqId]: merged },
      };
    });
  },

  upsertRfqs(list: RfqDto[]): void {
    setState((s) => {
      const rfqs = { ...s.rfqs };
      const logs = { ...s.logs };
      for (const r of list) {
        rfqs[r.rfqId] = r;
        logs[r.rfqId] = mergeLogTail(logs[r.rfqId], r.logTail ?? []);
      }
      return { ...s, rfqs, logs, rfqsLoaded: true };
    });
  },

  setRfqsLoaded(): void {
    setState((s) => (s.rfqsLoaded ? s : { ...s, rfqsLoaded: true }));
  },

  setRfqError(rfqId: string, error: string | null): void {
    setState((s) => {
      if ((s.rfqErrors[rfqId] ?? null) === error) return s;
      const rfqErrors = { ...s.rfqErrors };
      if (error === null) delete rfqErrors[rfqId];
      else rfqErrors[rfqId] = error;
      return { ...s, rfqErrors };
    });
  },

  appendLogs(role: 'buyer' | 'provider', rfqId: string, lines: string[]): void {
    setState((s) => {
      if (role === 'buyer') {
        const next = appendLines(s.logs[rfqId], lines);
        return next === s.logs[rfqId] ? s : { ...s, logs: { ...s.logs, [rfqId]: next } };
      }
      const next = appendLines(s.jobLogs[rfqId], lines);
      return next === s.jobLogs[rfqId] ? s : { ...s, jobLogs: { ...s.jobLogs, [rfqId]: next } };
    });
  },

  upsertJob(job: ProviderJobDto): void {
    setState((s) => {
      const merged = mergeLogTail(s.jobLogs[job.rfqId], job.logTail ?? []);
      return {
        ...s,
        jobs: { ...s.jobs, [job.rfqId]: job },
        jobLogs: merged === s.jobLogs[job.rfqId] ? s.jobLogs : { ...s.jobLogs, [job.rfqId]: merged },
      };
    });
  },

  upsertJobs(list: ProviderJobDto[]): void {
    setState((s) => {
      const jobs = { ...s.jobs };
      const jobLogs = { ...s.jobLogs };
      for (const j of list) {
        jobs[j.rfqId] = j;
        jobLogs[j.rfqId] = mergeLogTail(jobLogs[j.rfqId], j.logTail ?? []);
      }
      return { ...s, jobs, jobLogs, jobsLoaded: true, jobsError: null };
    });
  },

  setJobsError(error: string | null): void {
    setState((s) => (s.jobsError === error ? s : { ...s, jobsError: error, jobsLoaded: true }));
  },

  setPolicy(policy: ProviderPolicyDto | null): void {
    setState((s) => ({ ...s, policy }));
  },

  addLeaks(observations: LeakObservation[]): void {
    if (!observations.length) return;
    setState((s) => {
      const touched: Partial<Record<Party, Record<string, LeakObservation>>> = {};
      for (const o of observations) {
        if (!o || typeof o.id !== 'string' || !(o.party in s.leaks)) continue;
        const bucket = touched[o.party] ?? (touched[o.party] = { ...s.leaks[o.party] });
        bucket[o.id] = o;
      }
      if (!Object.keys(touched).length) return s;
      return { ...s, leaks: { ...s.leaks, ...touched } };
    });
  },

  setLeakError(party: Party, error: string | null): void {
    setState((s) => (s.leakErrors[party] === error ? s : { ...s, leakErrors: { ...s.leakErrors, [party]: error } }));
  },

  setChainTx(view: PublicTxViewDto, seenAt: number = Date.now()): void {
    setState((s) => {
      const chainErrors = s.chainErrors[view.txid] ? { ...s.chainErrors } : s.chainErrors;
      if (chainErrors !== s.chainErrors) delete chainErrors[view.txid];
      return {
        ...s,
        chainTx: { ...s.chainTx, [view.txid]: view },
        chainSeen: view.txid in s.chainSeen ? s.chainSeen : { ...s.chainSeen, [view.txid]: seenAt },
        chainErrors,
      };
    });
  },

  setChainError(txid: string, error: string): void {
    setState((s) => (s.chainErrors[txid] === error ? s : { ...s, chainErrors: { ...s.chainErrors, [txid]: error } }));
  },

  setInspector(patch: Partial<State['inspector']>): void {
    setState((s) => {
      const next = { ...s.inspector, ...patch };
      if (next.open === s.inspector.open && next.pinnedRfqId === s.inspector.pinnedRfqId) return s;
      return { ...s, inspector: next };
    });
  },

  toggleInspector(): void {
    setState((s) => ({ ...s, inspector: { ...s.inspector, open: !s.inspector.open } }));
  },
};
