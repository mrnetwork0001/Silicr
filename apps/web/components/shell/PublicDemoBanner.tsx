'use client';

import { Info } from '@/components/icons';
import { useSilicr } from '@/lib/store';

/** Shown whenever the buyer daemon is a public testnet demo (`silicr daemon --public-demo`). */
export function PublicDemoBanner() {
  const publicDemo = useSilicr((s) => s.mode === 'real' && !!s.buyerStatus?.publicDemo);
  if (!publicDemo) return null;
  return (
    <div className="border-b border-accent-line bg-accent-soft text-xs" role="note" id="public-demo-banner">
      <div className="mx-auto flex max-w-[1600px] items-center gap-2 px-4 py-1.5 sm:px-6">
        <Info className="size-3.5 shrink-0 text-accent" aria-hidden />
        <span className="font-semibold text-fg">Public testnet demo: shared wallet, testnet coins only.</span>
        <span className="hidden text-muted sm:inline">Pick an example job; withdrawals and provider settings are off. One request at a time.</span>
      </div>
    </div>
  );
}
