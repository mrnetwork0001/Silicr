'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { ArrowUpRight, ChevronRight, Gauge, Radio, Route, ScanEye, Wallet, X } from '@/components/icons';
import { config } from '@/lib/config';
import { formatHeight, networkLabel, zecString } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { spendCapSummary } from '@/lib/market';
import { actions, useSilicr } from '@/lib/store';
import { Spinner } from '../ui';
import { ConnectionDetails, RealZecChip, useChainInfo } from './ConnectionStatus';
import { LogoMark } from './Logo';

// Phone and tablet chrome (≤ 900px): the burger, the compact network chip, the primary-tab row and the left drawer.
// Every element here is hidden at ≥ 901px, so the desktop header is untouched.

export const NAV = [
  { href: '/', label: 'Market' },
  { href: '/provider', label: 'Provider' },
] as const;

export function isNavActive(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' || pathname.startsWith('/rfq') : pathname.startsWith(href);
}

/** Three lines that animate to an ×. */
export function BurgerButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      id="nav-burger"
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-controls="nav-drawer"
      aria-label={open ? 'Close menu' : 'Open menu'}
      className={clsx('burger-btn btn-outline min-[901px]:hidden', open && 'open')}
    >
      <span />
      <span />
      <span />
    </button>
  );
}

/** The network at a glance. REAL ZEC on mainnet is always shown; tapping opens the drawer with the details. */
export function NetworkChip({ onClick }: { onClick: () => void }) {
  const mode = useSilicr((s) => s.mode);
  const { status } = useChainInfo();
  const main = status?.network === 'main';
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 min-w-0 shrink items-center gap-1.5 rounded-md border border-line px-1.5 text-xs text-muted min-[901px]:hidden"
      aria-label="Connections and network"
    >
      {mode === 'probing' && <Spinner className="size-3.5" />}
      {(mode === 'offline' || mode === 'unsupported') && <span className="truncate px-1 font-medium text-bad">{mode === 'offline' ? 'No daemon' : 'Unsupported'}</span>}
      {main ? (
        <RealZecChip />
      ) : (
        status && <span className="truncate px-1 font-medium text-fg">{networkLabel(status.network)}</span>
      )}
    </button>
  );
}

/** Market and Provider as a segmented row under the top bar (the app's only primary tabs). */
export function MobileTabs({ pathname }: { pathname: string }) {
  return (
    <nav className="mobile-tabs border-b border-line bg-black/80 backdrop-blur-md min-[901px]:hidden" aria-label="Main">
      <div className="grid grid-cols-2 gap-1 rounded-full border border-line bg-sunken p-1">
        {NAV.map((n) => {
          const active = isNavActive(n.href, pathname);
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'flex h-9 items-center justify-center rounded-full text-sm font-semibold transition-colors',
                active ? 'glass-pill text-white' : 'text-secondary hover:text-white',
              )}
            >
              {n.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/** The left drawer: connections, network, spend cap, proxy, Wallet and the Leak Inspector. */
export function NavDrawer({ open, onClose, onWallet }: { open: boolean; onClose: () => void; onWallet: () => void }) {
  const mode = useSilicr((s) => s.mode);
  const { status } = useChainInfo();
  const now = useNow(5000, open);
  const panelRef = useRef<HTMLElement>(null);
  const main = status?.network === 'main';
  const cap = status?.spendCap ?? null;
  const proxy = status?.proxy ?? null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <button type="button" tabIndex={-1} aria-hidden={!open} className={clsx('drawer-backdrop min-[901px]:hidden', open && 'show')} aria-label="Close menu" onClick={onClose} />
      <aside
        id="nav-drawer"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal={open}
        aria-label="Menu"
        aria-hidden={!open}
        inert={!open}
        className={clsx('nav-drawer outline-none min-[901px]:hidden', open && 'open')}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
          <span className="flex items-center gap-2">
            <LogoMark className="size-[22px] text-white" />
            <span className="text-[18px] font-bold tracking-[-0.02em] text-white">Silicr</span>
          </span>
          <button type="button" id="drawer-close" onClick={onClose} className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-secondary hover:bg-hover hover:text-white" aria-label="Close menu">
            Close <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 thin-scroll">
          {/* Network, height, spend cap and proxy at a glance */}
          <div className="space-y-2 rounded-lg border border-line bg-sunken p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              {main && <RealZecChip />}
              {status ? (
                <span className="flex items-center gap-1.5">
                  <Radio className="size-3.5 text-faint" aria-hidden />
                  <span className={clsx('font-medium', main ? 'text-real' : 'text-fg')}>{networkLabel(status.network, { short: true })}</span>
                  <span className="font-mono tabular-nums text-faint">#{formatHeight(status.height ?? null)}</span>
                </span>
              ) : (
                <span className="text-muted">{mode === 'probing' ? 'Connecting to your daemons…' : mode === 'offline' ? 'No daemon connected' : 'No daemon status yet'}</span>
              )}
            </div>
            {cap && (
              <div className="flex items-start gap-1.5 text-muted" title={`Spend cap: ${spendCapSummary(cap)}`}>
                <Gauge className="mt-px size-3.5 shrink-0 text-faint" aria-hidden />
                <span className="tabular-nums">
                  Cap: spent {zecString(cap.spentZats, { maxDecimals: 4 })} of {zecString(cap.totalZats, { maxDecimals: 4 })} ZEC · per request ≤{' '}
                  {zecString(cap.perRfqZats, { maxDecimals: 4 })}
                </span>
              </div>
            )}
            {proxy && (
              <div className="flex items-start gap-1.5 text-ok">
                <Route className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>via {proxy.kind.toUpperCase()} proxy: the relay and light-wallet server see the proxy, not this machine</span>
              </div>
            )}
            {status?.blobTransport === 'memo' && <div className="text-muted">Relay-less · memos only</div>}
          </div>

          <div className="grid gap-2">
            <button
              type="button"
              id="drawer-wallet"
              onClick={() => {
                onClose();
                onWallet();
              }}
              className="flex min-h-11 items-center gap-3 rounded-lg border border-line px-3 text-left text-sm font-semibold text-fg hover:bg-hover"
            >
              <Wallet className="size-4 text-accent" aria-hidden />
              <span className="flex-1">Wallet</span>
              <span className="text-2xs font-normal text-faint">fund · withdraw</span>
              <ChevronRight className="size-4 text-faint" aria-hidden />
            </button>
            <button
              type="button"
              id="drawer-inspector"
              onClick={() => {
                onClose();
                actions.setInspector({ open: true });
              }}
              className="flex min-h-11 items-center gap-3 rounded-lg border border-line px-3 text-left text-sm font-semibold text-fg hover:bg-hover"
            >
              <ScanEye className="size-4 text-accent" aria-hidden />
              <span className="flex-1">Leak Inspector</span>
              <span className="text-2xs font-normal text-faint">who knows what</span>
              <ChevronRight className="size-4 text-faint" aria-hidden />
            </button>
          </div>

          <div>
            <div className="section-label mb-1 px-1 text-[10px] text-muted">Connections</div>
            <div className="rounded-lg border border-line bg-raised p-1 text-xs">
              {mode === 'probing' ? <div className="p-2.5 text-muted">Connecting to your daemons…</div> : <ConnectionDetails now={now} />}
            </div>
          </div>

          {config.landingUrl && (
            <a href={config.landingUrl} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-secondary hover:bg-hover hover:text-white">
              Back to the Silicr site <ArrowUpRight className="size-3.5" aria-hidden />
            </a>
          )}
        </div>
      </aside>
    </>
  );
}
