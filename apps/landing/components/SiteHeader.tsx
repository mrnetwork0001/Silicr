'use client';

import { useCallback, useEffect, useState } from 'react';
import { Wordmark } from './Logo';
import { MobileDrawer } from './MobileDrawer';

export const NAV = [
  { id: 'how', label: 'How it works' },
  { id: 'leaks', label: 'Leak Inspector' },
  { id: 'settlement', label: 'Settlement' },
  { id: 'quickstart', label: 'Quick start' },
  { id: 'faq', label: 'FAQ' },
] as const;

const DRAWER_LINKS = NAV.map((n) => ({ label: n.label, href: `#${n.id}` }));

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  // Hidden while the hero (which has its own nav) is on screen; slides in once it has scrolled out.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const hero = document.querySelector('section[aria-labelledby="eclipse-title"]');
    if (!hero || !('IntersectionObserver' in window)) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setShown(!(e?.isIntersecting ?? false)), { rootMargin: '-64px 0px 0px 0px' });
    io.observe(hero);
    return () => io.disconnect();
  }, []);

  // The drawer is not tied to `shown`: locking the body while it opens can make the hero re-intersect
  // for a frame, and closing the drawer on that would make it impossible to open from a phone.

  // Highlight the section that crosses the middle of the viewport.
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    const els = NAV.map((n) => document.getElementById(n.id)).filter((e): e is HTMLElement => e !== null);
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        setActive(NAV.find((n) => visible.has(n.id))?.id ?? null);
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <header
        aria-hidden={!shown || undefined}
        inert={!shown}
        className={`fixed inset-x-0 top-0 z-50 border-b border-line bg-black/70 backdrop-blur-xl transition-[opacity,transform] duration-300 ease-out ${
          shown ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0'
        }`}
      >
        <div className="flex h-16 items-center gap-3 px-4">
          <a href="#top" className="shrink-0 rounded-md" aria-label="Silicr: back to top">
            <Wordmark />
          </a>

          <nav aria-label="Sections" className="ml-auto hidden lg:block">
            <ul className="flex items-center gap-0.5">
              {NAV.map((n) => (
                <li key={n.id}>
                  <a
                    href={`#${n.id}`}
                    aria-current={active === n.id ? 'location' : undefined}
                    className={`relative rounded-full px-2.5 py-1.5 text-[14px] font-semibold transition-colors xl:px-3 ${
                      active === n.id
                        ? 'text-white after:absolute after:bottom-0 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-accent after:shadow-[0_0_8px_var(--accent)]'
                        : 'text-white/65 hover:text-white'
                    }`}
                  >
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="ml-auto flex items-center gap-1 sm:gap-2 lg:hidden">
            <button
              type="button"
              data-burger
              className={`lburger inline-flex size-11 items-center justify-center rounded-full border border-white/20 bg-white/5 text-white transition-colors hover:bg-white/10 lg:hidden${open ? ' open' : ''}`}
              aria-expanded={open}
              aria-controls="mobile-nav"
              onClick={() => setOpen((v) => !v)}
            >
              <span aria-hidden />
              <span aria-hidden />
              <span aria-hidden />
              <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
            </button>
          </div>
        </div>

      </header>
      <MobileDrawer id="mobile-nav" open={open} onClose={close} links={DRAWER_LINKS} active={active} />
    </>
  );
}
