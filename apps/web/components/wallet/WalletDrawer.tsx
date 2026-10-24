'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { ArrowUpRight, X } from '@/components/icons';
import { WalletPanel } from './WalletPanel';

/** The Wallet panel as a slide-over below the header (Esc or the backdrop closes it). */
export function WalletDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30" style={{ top: 'var(--chrome-h, 56px)' }}>
      <button type="button" aria-label="Close wallet" className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Wallet"
        className="absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col overflow-y-auto border-l border-line bg-panel/95 p-4 shadow-[-24px_0_60px_rgba(0,0,0,0.6)] outline-none sm:p-5"
      >
        <div className="mb-3 flex items-center justify-end gap-1">
          <Link href="/wallet" onClick={onClose} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-2xs font-semibold text-secondary hover:text-white">
            Full page <ArrowUpRight className="size-3" aria-hidden />
          </Link>
          <button type="button" onClick={onClose} className="inline-flex size-7 items-center justify-center rounded-full text-secondary hover:bg-hover hover:text-white" aria-label="Close wallet">
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <WalletPanel compact />
      </div>
    </div>
  );
}
