'use client';

import clsx from 'clsx';
import { ChevronDown, Coins, Gauge, Radio, Route } from '@/components/icons';
import { useEffect, useRef, useState } from 'react';
import type { StatusDto } from '@silicr/api';
import { hostOf } from '@/lib/config';
import { formatAgo, formatHeight, networkLabel, truncateMiddle, zecString } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { spendCapSummary } from '@/lib/market';
import { useSilicr, type DaemonConn, type DaemonRole } from '@/lib/store';
import { Badge, Dot, Mono, Spinner, type Tone } from '../ui';

const ROLE_LABEL: Record<DaemonRole, string> = { buyer: 'Buyer', provider: 'Provider', relay: 'Relay' };

function connTone(c: DaemonConn): Tone {
  if (c.status === 'online') return c.sse === 'retrying' ? 'warn' : 'ok';
  if (c.status === 'offline') return 'bad';
  return 'neutral';
}

/** The network + height everyone should agree on, preferring the buyer's view. */
export function useChainInfo(): { status: StatusDto | null; mismatch: boolean } {
  const buyer = useSilicr((s) => s.buyerStatus);
  const provider = useSilicr((s) => s.providerStatus);
  const conn = useSilicr((s) => s.conn);
  const b = conn.buyer.status === 'online' || buyer?.network ? buyer : null;
  const p = conn.provider.status === 'online' || provider?.network ? provider : null;
  return { status: b ?? p, mismatch: !!(b && p && b.network !== p.network) };
}

/** Real mainnet funds. Solid red and never striped, so it can't be confused with the orange MOCK DATA marks. */
export function RealZecChip({ className }: { className?: string }) {
  return (
    <Badge
      tone="real"
      className={clsx('font-mono font-bold tracking-[0.12em]', className)}
      icon={<Coins className="size-3" aria-hidden />}
      title="Real ZEC: this daemon spends Zcash mainnet funds. Keep balances small."
    >
      REAL ZEC
    </Badge>
  );
}

function proxyTitle(proxy: NonNullable<StatusDto['proxy']>): string {
  return `Outbound traffic goes through a ${proxy.kind.toUpperCase()} proxy (${proxy.url}): the relay and the light-wallet server see the proxy's address, not this machine's IP.`;
}

export function ConnectionStatus() {
  const mode = useSilicr((s) => s.mode);
  const conn = useSilicr((s) => s.conn);
  const { status } = useChainInfo();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(5000, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (mode === 'probing') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <Spinner className="size-3.5" />
        <span className="hidden sm:inline">Connecting to local daemons…</span>
      </div>
    );
  }

  const network = status ? networkLabel(status.network) : null;
  const main = status?.network === 'main';
  const cap = status?.spendCap ?? null;
  const proxy = status?.proxy ?? null;
  const memoMode = status?.blobTransport === 'memo';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-8 items-center gap-2 rounded-md border border-line px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-fg sm:gap-2.5 sm:px-2.5"
      >
        {mode === 'mock' ? (
          <Badge tone="mock" className="font-mono tracking-wide">
            MOCK
          </Badge>
        ) : (
          <span className="flex items-center gap-2.5">
            {(['buyer', 'provider', 'relay'] as const).map((r) => (
              <span key={r} className="flex items-center gap-1.5" title={`${ROLE_LABEL[r]} ${conn[r].status}`}>
                <Dot tone={connTone(conn[r])} pulse={conn[r].status === 'online' && conn[r].sse === 'open'} />
                <span className="hidden lg:inline">{ROLE_LABEL[r]}</span>
              </span>
            ))}
          </span>
        )}
        {main && <RealZecChip />}
        {network && (
          <span className="hidden items-center gap-1.5 border-line sm:flex md:border-l md:pl-2.5">
            <span className={clsx('font-medium', main ? 'text-real' : 'text-fg')}>{network}</span>
            <span className="font-mono tabular-nums text-faint">#{formatHeight(status?.height ?? null)}</span>
          </span>
        )}
        {cap && (
          <span className="hidden items-center gap-1 border-l border-line pl-2.5 lg:flex" title={`Spend cap: ${spendCapSummary(cap)}`}>
            <Gauge className="size-3.5 text-faint" aria-hidden />
            <span className="tabular-nums">
              cap: spent {zecString(cap.spentZats, { maxDecimals: 4 })} of {zecString(cap.totalZats, { maxDecimals: 4 })} ZEC
              <span className="hidden xl:inline"> (per request ≤ {zecString(cap.perRfqZats, { maxDecimals: 4 })})</span>
            </span>
          </span>
        )}
        {proxy && (
          <span className="hidden items-center gap-1 border-l border-line pl-2.5 text-ok md:flex" title={proxyTitle(proxy)}>
            <Route className="size-3.5" aria-hidden />
            <span>via SOCKS5 proxy</span>
          </span>
        )}
        {memoMode && (
          <span
            className="hidden items-center gap-1 border-l border-line pl-2.5 md:flex"
            title="Relay-less mode: the job, logs, heartbeats and result travel inside shielded memos. No relay holds any blob; every hop is a Zcash transaction (fees apply)."
          >
            <span>relay-less · memos only</span>
          </span>
        )}
        <ChevronDown className="size-3.5 text-faint" aria-hidden />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Connections"
          className="absolute right-0 top-10 z-50 w-[min(92vw,380px)] rounded-lg border border-line bg-raised p-1 text-xs shadow-[var(--shadow-pop)]"
        >
          <ConnectionDetails now={now} />
        </div>
      )}
    </div>
  );
}

/** Per-daemon connection details: the dropdown body on desktop, the top of the drawer on phones. */
export function ConnectionDetails({ now }: { now: number }) {
  const mode = useSilicr((s) => s.mode);
  const conn = useSilicr((s) => s.conn);
  const buyerStatus = useSilicr((s) => s.buyerStatus);
  const providerStatus = useSilicr((s) => s.providerStatus);
  const relayObserver = useSilicr((s) => s.relayObserver);
  const { status, mismatch } = useChainInfo();
  const main = status?.network === 'main';
  return (
    <>
      {mode === 'mock' && (
        <div className="mock-stripes m-1 rounded-md border border-mock/40 p-2.5 text-mock">
          <div className="font-mono font-semibold tracking-wide">MOCK DATA</div>
          <div className="mt-0.5 text-fg">Scripted replay inside this browser tab. Nothing below is a live connection.</div>
        </div>
      )}
      {(['buyer', 'provider', 'relay'] as const).map((r) => {
        const c = conn[r];
        const st = r === 'buyer' ? buyerStatus : r === 'provider' ? providerStatus : null;
        return (
          <div key={r} className="rounded-md px-2.5 py-2 hover:bg-hover">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-medium text-fg">
                <Dot tone={mode === 'mock' ? 'neutral' : connTone(c)} />
                {ROLE_LABEL[r]} {r === 'relay' ? '' : 'daemon'}
              </span>
              <span className="font-mono text-faint">{hostOf(c.url)}</span>
            </div>
            <div className="mt-1 space-y-0.5 pl-3.5 text-muted">
              {mode === 'mock' ? (
                <div>{c.error ? `Unreachable at load: ${c.error}` : 'Not contacted (mock mode)'}</div>
              ) : c.status === 'online' ? (
                <>
                  <div>
                    Online
                    {r !== 'relay' && <> · events {c.sse === 'open' ? 'streaming' : c.sse === 'off' ? 'off' : c.sse}</>}
                    {c.lastOkAt ? <> · seen {formatAgo(c.lastOkAt, now)}</> : null}
                  </div>
                </>
              ) : (
                <div className="text-bad">{c.status === 'offline' ? `Offline: ${c.error ?? 'no answer'}` : 'Not checked yet'}</div>
              )}
              {st && (mode === 'mock' || c.status === 'online') && (
                <>
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className={st.network === 'main' ? 'font-medium text-real' : undefined}>{networkLabel(st.network)}</span>
                    <span>v{st.version}</span>
                    <span>{st.demoMode ? 'demo mode' : 'not in demo mode'}</span>
                    {st.alias && <span className="text-fg">{st.alias}</span>}
                  </div>
                  {st.address && (
                    <div className="flex items-center gap-1">
                      Address <Mono value={st.address} className="text-fg" />
                    </div>
                  )}
                  {st.spendCap && <div>Spend cap: {spendCapSummary(st.spendCap)}</div>}
                  {st.network === 'main' && !st.spendCap && (
                    <div className="text-bad">No spend cap reported: a mainnet daemon should refuse to start without one.</div>
                  )}
                  {st.proxy && (
                    <div className="flex items-center gap-1" title={proxyTitle(st.proxy)}>
                      <Route className="size-3 text-ok" aria-hidden /> via {st.proxy.kind} proxy <Mono value={st.proxy.url} copy={false} />
                    </div>
                  )}
                </>
              )}
              {r === 'relay' && (mode === 'mock' || c.status === 'online') && (
                <div>Observer feed: {relayObserver === 'available' ? 'available (demo)' : relayObserver === 'unavailable' ? 'not exposed' : 'not checked yet'}</div>
              )}
            </div>
          </div>
        );
      })}
      {status && (
        <div className="m-1 flex items-center gap-2 rounded-md border border-line px-2.5 py-2 text-muted">
          <Radio className="size-3.5 text-faint" aria-hidden />
          <span>
            {networkLabel(status.network)} · height <span className="font-mono text-fg">{formatHeight(status.height)}</span> · ~
            {status.blockTimeS}s blocks
          </span>
        </div>
      )}
      {mismatch && <div className="m-1 rounded-md bg-bad-soft px-2.5 py-2 text-bad">Buyer and provider report different networks.</div>}
      {main && (
        <div className="m-1 rounded-md border border-real/40 bg-real-soft px-2.5 py-2 text-fg">
          <span className="font-semibold text-real">Real ZEC.</span> Every payment spends Zcash mainnet funds.{' '}
          {status?.spendCap ? `Spend cap: ${spendCapSummary(status.spendCap)}.` : 'No spend cap reported: the daemon should refuse to run on mainnet without one.'}
        </div>
      )}
      {mode === 'real' && buyerStatus?.address && (
        <div className="px-2.5 pb-2 pt-1 text-2xs text-faint">Buyer wallet {truncateMiddle(buyerStatus.address, 10, 6)} stays on this machine.</div>
      )}
    </>
  );
}
