'use client';

import clsx from 'clsx';
import { ScanEye, Wallet } from '@/components/icons';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { boot } from '@/lib/driver';
import { isTypingTarget } from '@/lib/hooks';
import { actions, getState, useSilicr } from '@/lib/store';
import { LeakInspector } from '../inspector/LeakInspector';
import { Kbd } from '../ui';
import { ConnectionStatus } from './ConnectionStatus';
import { LogoMark } from './Logo';
import { config } from '@/lib/config';
import { ConnectDaemon } from './ConnectDaemon';
import { PublicDemoBanner } from './PublicDemoBanner';
import { Backdrop } from './Backdrop';
import { WalletDrawer } from '../wallet/WalletDrawer';
import { BurgerButton, isNavActive, MobileTabs, NAV, NavDrawer, NetworkChip } from './MobileNav';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const REVEAL = '.glass-panel, [data-reveal]';

export function AppShell({ children }: { children: ReactNode }) {
  const mode = useSilicr((s) => s.mode);
  const chromeRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const inspectorOpen = useSilicr((s) => s.inspector.open);
  const mainRef = useRef<HTMLElement>(null);
  const pathname = usePathname();
  // The Wallet slide-over: rendered outside the header (its backdrop-filter would trap a fixed child).
  const [walletOpen, setWalletOpen] = useState(false);
  const closeWallet = useCallback(() => setWalletOpen(false), []);
  useEffect(() => setWalletOpen(false), [pathname]);
  // The phone/tablet drawer (≤ 900px). Closes on backdrop, Esc, Close and any navigation.
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const openWallet = useCallback(() => setWalletOpen(true), []);
  useEffect(() => setNavOpen(false), [pathname]);

  // Panels fade-rise in on first load and on every route change, staggered. Opacity and transform only.
  useEffect(() => {
    const main = mainRef.current;
    if (!main || typeof main.animate !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const raf = requestAnimationFrame(() => {
      const els = [...main.querySelectorAll<HTMLElement>(REVEAL)].filter((el) => {
        const outer = el.parentElement?.closest(REVEAL);
        return !outer || !main.contains(outer);
      });
      els.slice(0, 14).forEach((el, i) => {
        el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], {
          duration: 420,
          delay: i * 60,
          easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
          fill: 'backwards',
        });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [pathname]);

  useEffect(() => {
    void boot();
  }, []);

  // Global shortcuts: L toggles the Leak Inspector, Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        actions.toggleInspector();
      } else if (e.key === 'Escape' && getState().inspector.open) {
        actions.setInspector({ open: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Expose the sticky chrome height so the inspector overlay sits below it (the public demo banner stays visible).
  useIsoLayoutEffect(() => {
    const el = chromeRef.current;
    if (!el) return;
    const set = () => {
      document.documentElement.style.setProperty('--chrome-h', `${el.offsetHeight}px`);
      // ≤ 900px the inspector is a full-screen sheet that starts below the public demo banner only.
      document.documentElement.style.setProperty('--banner-h', `${bannerRef.current?.offsetHeight ?? 0}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ≤ 900px the page is taken out of the flow while the inspector sheet is open; put the scroll position back after.
  // The position is tracked while the sheet is closed, because hiding the page clamps it to 0 before any effect runs.
  const savedScroll = useRef(0);
  useEffect(() => {
    if (inspectorOpen) return;
    const onScroll = () => {
      if (!getState().inspector.open) savedScroll.current = window.scrollY;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [inspectorOpen]);
  useIsoLayoutEffect(() => {
    if (inspectorOpen || !savedScroll.current || !window.matchMedia('(max-width: 900px)').matches) return;
    window.scrollTo(0, savedScroll.current);
  }, [inspectorOpen]);

  return (
    <>
      <Backdrop />
      {/* The chrome is translucent over the page; under the open inspector sheet it goes opaque so nothing shows through its strip. */}
      <div ref={chromeRef} className={clsx('sticky top-0 z-40', inspectorOpen && 'bg-bg')}>
        <div ref={bannerRef}>
          <PublicDemoBanner />
        </div>
        <Header walletOpen={walletOpen} setWalletOpen={setWalletOpen} navOpen={navOpen} setNavOpen={setNavOpen} />
        <MobileTabs pathname={pathname} />
      </div>
      <NavDrawer open={navOpen} onClose={closeNav} onWallet={openWallet} />
      <WalletDrawer open={walletOpen && !pathname.startsWith('/wallet')} onClose={closeWallet} />
      <main ref={mainRef} className={clsx('app-main corona relative z-[1] mx-auto w-full max-w-[1600px] px-4 pb-16 pt-5 sm:px-6', inspectorOpen && 'max-[900px]:hidden')}>
        {mode === 'offline' || mode === 'unsupported' ? <ConnectDaemon /> : children}
      </main>
      <LeakInspector />
    </>
  );
}

function Header({
  walletOpen,
  setWalletOpen,
  navOpen,
  setNavOpen,
}: {
  walletOpen: boolean;
  setWalletOpen: (fn: (v: boolean) => boolean) => void;
  navOpen: boolean;
  setNavOpen: (fn: (v: boolean) => boolean) => void;
}) {
  const pathname = usePathname();
  const open = useSilicr((s) => s.inspector.open);
  const onWalletPage = pathname.startsWith('/wallet');
  return (
    <header className="border-b border-line bg-black/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-2 px-4 sm:gap-5 sm:px-6">
        <a
          href={config.landingUrl || '/'}
          className="flex shrink-0 items-center gap-2 rounded-md text-fg"
          aria-label="Silicr home"
          title={config.landingUrl ? 'Back to the Silicr site' : undefined}
        >
          <LogoMark className="size-[22px] text-white" />
          <span className="hidden text-[18px] font-bold tracking-[-0.02em] text-white sm:inline max-[900px]:inline">Silicr</span>
        </a>
        <nav className="flex items-center gap-0.5 max-[900px]:hidden" aria-label="Main">
          {NAV.map((n) => {
            const active = isNavActive(n.href, pathname);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'rounded-full px-3 py-1.5 text-sm font-semibold transition-colors',
                  active ? 'glass-pill text-white' : 'text-secondary hover:text-white',
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
          <div className="max-[900px]:hidden">
            <ConnectionStatus />
          </div>
          <NetworkChip onClick={() => setNavOpen(() => true)} />
          <button
            id="wallet-toggle"
            type="button"
            onClick={() => (onWalletPage ? undefined : setWalletOpen((v) => !v))}
            aria-pressed={walletOpen || onWalletPage}
            aria-haspopup="dialog"
            className={clsx(
              'inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-semibold transition-shadow max-[900px]:hidden',
              walletOpen || onWalletPage ? 'btn-primary' : 'btn-outline',
            )}
            title="Fund this wallet from your own Zcash wallet, or withdraw"
          >
            <Wallet className="size-4" aria-hidden />
            <span className="hidden sm:inline">Wallet</span>
          </button>
          <button
            id="inspector-toggle"
            type="button"
            onClick={() => actions.toggleInspector()}
            aria-pressed={open}
            aria-keyshortcuts="L"
            className={clsx(
              'inline-flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-xs font-semibold transition-shadow max-[900px]:size-10 max-[900px]:justify-center max-[900px]:px-0',
              open ? 'btn-primary' : 'btn-outline',
            )}
            aria-label="Leak Inspector"
          >
            <ScanEye className="size-4" aria-hidden />
            <span className="hidden sm:inline max-[900px]:hidden!">Leak Inspector</span>
            <span className="hidden sm:inline-flex max-[900px]:hidden!">
              <Kbd inverted={open}>L</Kbd>
            </span>
          </button>
          <BurgerButton open={navOpen} onClick={() => setNavOpen((v) => !v)} />
        </div>
      </div>
    </header>
  );
}
