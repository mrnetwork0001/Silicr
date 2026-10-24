'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from '@/components/icons';
import { Wordmark } from './Logo';

export interface DrawerLink {
  label: string;
  href: string;
}

/**
 * The phone/tablet menu: a left drawer with a dimmed backdrop (brand + × head, section links).
 * Closes on backdrop, Esc, × and any link. Portalled to <body> so no hero stacking context or
 * blurred header can trap or clip it. No "Launch app" here on purpose: the hero and the final
 * section carry that CTA.
 */
export function MobileDrawer({ id, open, onClose, links, active }: { id: string; open: boolean; onClose: () => void; links: readonly DrawerLink[]; active?: string | null }) {
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!mounted) return null;
  return createPortal(
    <>
      <button type="button" tabIndex={-1} aria-hidden className={`mdrawer-backdrop${open ? ' show' : ''}`} onClick={onClose} aria-label="Close menu" />
      <div
        id={id}
        ref={panel}
        role="dialog"
        aria-modal={open}
        aria-label="Menu"
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
        className={`mdrawer outline-none${open ? ' open' : ''}`}
      >
        <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
          <a href="#top" onClick={onClose} className="rounded-md" aria-label="Silicr: back to top">
            <Wordmark />
          </a>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-11 items-center justify-center rounded-full border border-white/20 bg-white/5 text-white transition-colors hover:bg-white/10"
            aria-label="Close menu"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <nav aria-label="Sections" className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="grid gap-1">
            {links.map((l) => {
              const on = active != null && l.href === `#${active}`;
              return (
                <li key={l.href}>
                  <a
                    href={l.href}
                    onClick={onClose}
                    aria-current={on ? 'location' : undefined}
                    className={`flex min-h-12 items-center justify-between rounded-xl px-3 text-[16px] font-semibold transition-colors hover:bg-hover ${on ? 'bg-accent-soft text-white' : 'text-white/85'}`}
                  >
                    {l.label}
                    {on && <span className="size-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" aria-hidden />}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </>,
    document.body,
  );
}
