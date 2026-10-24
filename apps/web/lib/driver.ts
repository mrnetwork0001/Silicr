/**
 * Boot: probe the local daemons, then start either the real driver (HTTP + SSE)
 * or the scripted mock replay. Mock mode is used when NEXT_PUBLIC_SILICR_MOCK=1,
 * when the URL has ?mock=1, or when neither the buyer nor the provider daemon
 * answers at load. The UI always shows a MOCK DATA banner in mock mode.
 */

import type { BuyerFault, NewRfqRequest, ProviderFault, ProviderPolicyDto, RfqDto, StatusDto } from '@silicr/api';
import { DaemonClient, errorMessage } from './client';
import { config } from './config';
import { actions } from './store';

export interface InspectorTarget {
  rfqId: string | null;
  /** Every txid this terminal knows for the request; their public views feed the chain column. */
  txids: string[];
}

export interface Driver {
  readonly kind: 'mock' | 'real';
  start(): void;
  stop(): void;
  createRfq(req: NewRfqRequest): Promise<{ rfqId: string }>;
  accept(rfqId: string, providerId: string): Promise<RfqDto>;
  stopRfq(rfqId: string): Promise<RfqDto>;
  downloadResult(rfqId: string): Promise<void>;
  updatePolicy(patch: Partial<ProviderPolicyDto>): Promise<ProviderPolicyDto>;
  loadRfq(rfqId: string): Promise<void>;
  refreshInspector(target: InspectorTarget): Promise<void>;
  /** Demo fault injection on the buyer (POST /api/rfqs/:id/fault). */
  buyerFault(rfqId: string, fault: BuyerFault): Promise<void>;
  /** Demo fault injection on the provider (POST /api/jobs/:id/fault). */
  providerFault(rfqId: string, fault: ProviderFault): Promise<void>;
  /** Provider stops a job it is serving (POST /api/jobs/:id/stop). */
  stopJob(rfqId: string): Promise<void>;
  /** Mock only: submit the default demo request with auto-accept. */
  replayDemo?(): Promise<string>;
}

export type ProbeOutcome = { ok: true; status: StatusDto } | { ok: false; error: string };

export interface ProbeResult {
  buyer: ProbeOutcome;
  provider: ProbeOutcome;
  relay: { ok: boolean; error: string | null };
}

const URLS = { buyer: config.buyerUrl, provider: config.providerUrl, relay: config.relayUrl };

let current: Driver | null = null;
let bootPromise: Promise<void> | null = null;

export function getDriver(): Driver | null {
  return current;
}

/** Idempotent: safe under React StrictMode double effects and multiple callers. */
export function boot(): Promise<void> {
  if (!bootPromise) bootPromise = chooseAndStart(false);
  return bootPromise;
}

/** Re-probe the daemons (from the mock banner's Retry button). */
export async function retryConnection(): Promise<void> {
  if (bootPromise) await bootPromise.catch(() => undefined);
  current?.stop();
  current = null;
  bootPromise = chooseAndStart(true);
  return bootPromise;
}

function urlWantsMock(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const v = new URLSearchParams(window.location.search).get('mock');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

async function probeStatus(url: string): Promise<ProbeOutcome> {
  try {
    const s = await new DaemonClient(url).get<StatusDto>('/api/status', { timeoutMs: 2500 });
    if (!s || typeof s !== 'object' || typeof s.role !== 'string') {
      return { ok: false, error: 'Not a Silicr daemon (unexpected /api/status body)' };
    }
    return { ok: true, status: s };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function probeRelay(url: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    await new DaemonClient(url).get<unknown>('/health', { timeoutMs: 2500 });
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function probeAll(): Promise<ProbeResult> {
  const [buyer, provider, relay] = await Promise.all([
    probeStatus(URLS.buyer),
    probeStatus(URLS.provider),
    probeRelay(URLS.relay),
  ]);
  return { buyer, provider, relay };
}

async function chooseAndStart(isRetry: boolean): Promise<void> {
  actions.reset(URLS);
  if (config.forceMock || (!isRetry && urlWantsMock())) {
    await startMock('forced', null);
    return;
  }
  actions.setMode('probing');
  const probe = await probeAll();
  if (!probe.buyer.ok && !probe.provider.ok) {
    await startMock('unreachable', probe);
    return;
  }
  const { RealDriver } = await import('./real');
  const d = new RealDriver(probe);
  current = d;
  actions.setMode('real');
  d.start();
}

async function startMock(reason: 'forced' | 'unreachable', probe: ProbeResult | null): Promise<void> {
  if (probe) {
    // Remember why we fell back, for the banner. Nothing else from the probe is used.
    actions.setConn('buyer', { status: 'offline', error: probe.buyer.ok ? null : probe.buyer.error });
    actions.setConn('provider', { status: 'offline', error: probe.provider.ok ? null : probe.provider.error });
    actions.setConn('relay', { status: probe.relay.ok ? 'online' : 'offline', error: probe.relay.error });
  }
  const { MockDriver } = await import('./mock/driver');
  const d = new MockDriver();
  current = d;
  actions.setMode('mock', reason);
  d.start();
}

/** Save a Blob as a file download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
