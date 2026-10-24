/**
 * Boot: probe the daemons, then start the driver (HTTP + SSE). The terminal runs only against
 * daemons on Zcash testnet or mainnet: when neither the buyer nor the provider answers, the shell
 * shows how to start one (mode 'offline'); a daemon on any other network (e.g. the test suite's
 * simulated `memory` chain) is refused (mode 'unsupported').
 */

import type { BuyerFault, NewRfqRequest, PresetRfqRequest, ProviderFault, ProviderPolicyDto, RfqDto, StatusDto, WalletDto, WithdrawConfirmDto, WithdrawRequest, WithdrawResultDto } from '@silicr/api';
import { DaemonClient, errorMessage } from './client';
import { config } from './config';
import { actions } from './store';

export interface InspectorTarget {
  rfqId: string | null;
  /** Every txid this terminal knows for the request; their public views feed the chain column. */
  txids: string[];
}

export interface Driver {
  readonly kind: 'real';
  start(): void;
  stop(): void;
  /** A PresetRfqRequest only on a public-demo daemon (StatusDto.publicDemo). */
  createRfq(req: NewRfqRequest | PresetRfqRequest): Promise<{ rfqId: string }>;
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
  /** GET /api/wallet on one daemon: deposit address, ZIP 321 URI, balance. */
  getWallet(role: 'buyer' | 'provider'): Promise<WalletDto>;
  /** POST /api/wallet/withdraw. On mainnet the first call returns the confirm request (409) instead of sending. */
  withdraw(role: 'buyer' | 'provider', req: WithdrawRequest): Promise<WithdrawResultDto | WithdrawConfirmDto>;
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

/** Re-probe the daemons (the connect screen's Retry button). */
export async function retryConnection(): Promise<void> {
  if (bootPromise) await bootPromise.catch(() => undefined);
  current?.stop();
  current = null;
  bootPromise = chooseAndStart(true);
  return bootPromise;
}

export const UNSUPPORTED_NETWORK = 'unsupported network: run the daemon with --network test or main';

/** The networks the terminal runs against. */
export function isSupportedNetwork(n: unknown): n is 'test' | 'main' {
  return n === 'test' || n === 'main';
}

/** null when the probe can start the terminal, else why not (offline or unsupported). */
export function probeVerdict(probe: ProbeResult): { mode: 'offline' | 'unsupported'; error: string } | null {
  const up = [probe.buyer, probe.provider].filter((p): p is { ok: true; status: StatusDto } => p.ok);
  if (up.length === 0) return { mode: 'offline', error: probe.buyer.ok ? '' : probe.buyer.error };
  const bad = up.find((p) => !isSupportedNetwork(p.status.network));
  if (bad) return { mode: 'unsupported', error: `${UNSUPPORTED_NETWORK} (the ${bad.status.role} daemon reports "${String(bad.status.network)}")` };
  return null;
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

async function chooseAndStart(_isRetry: boolean): Promise<void> {
  actions.reset(URLS);
  actions.setMode('probing');
  const probe = await probeAll();
  const verdict = probeVerdict(probe);
  if (verdict) {
    // Show what each daemon said on the connect screen; nothing else from the probe is used.
    for (const role of ['buyer', 'provider'] as const) {
      const p = probe[role];
      actions.setConn(role, p.ok ? { status: 'online', error: null } : { status: 'offline', error: p.error });
      if (p.ok) actions.setStatus(role, p.status);
    }
    actions.setConn('relay', { status: probe.relay.ok ? 'online' : 'offline', error: probe.relay.error });
    actions.setMode(verdict.mode, verdict.error || null);
    return;
  }
  const { RealDriver } = await import('./real');
  const d = new RealDriver(probe);
  current = d;
  actions.setMode('real');
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
