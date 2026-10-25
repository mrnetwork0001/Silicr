'use client';

import { Info } from '@/components/icons';
import { zecString } from '@/lib/format';
import { publicDemoBudget } from '@/lib/request-form';
import { useSilicr } from '@/lib/store';

/**
 * Shown whenever the buyer daemon is a public demo (`silicr daemon --public-demo`). On mainnet
 * (`--allow-mainnet`) it says so in red and keeps the budget (spent / cap) on screen at every width.
 */
export function PublicDemoBanner() {
  const status = useSilicr((s) => (s.mode === 'real' ? s.buyerStatus : null));
  const budget = publicDemoBudget(status);
  if (!budget) return null;
  if (budget.mainnet) {
    const cap = budget.cap;
    return (
      <div className="border-b border-real/40 bg-real-soft text-xs" role="note" id="public-demo-banner">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 sm:px-6">
          <span className="flex items-center gap-2">
            <Info className="size-3.5 shrink-0 text-real" aria-hidden />
            <span className="font-semibold text-real">Public mainnet demo: real ZEC, tiny shared wallet, hard-capped.</span>
          </span>
          {cap && (
            <span className="font-mono tabular-nums text-fg" data-testid="demo-budget">
              spent {zecString(cap.spent, { maxDecimals: 5 })} of {zecString(cap.total, { maxDecimals: 5 })} ZEC · {zecString(cap.remaining, { maxDecimals: 5 })} ZEC left · per request ≤{' '}
              {zecString(cap.perRfq, { maxDecimals: 5 })} ZEC
            </span>
          )}
          <span className="hidden text-muted lg:inline">
            Every request's worst case (payments at the max price plus fees) must fit the cap; max price 0.001 ZEC/h, 15 min at most, one
            request at a time.
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="border-b border-accent-line bg-accent-soft text-xs" role="note" id="public-demo-banner">
      <div className="mx-auto flex max-w-[1600px] items-center gap-2 px-4 py-1.5 sm:px-6">
        <Info className="size-3.5 shrink-0 text-accent" aria-hidden />
        <span className="font-semibold text-fg">Public testnet demo: shared wallet, testnet coins only.</span>
        <span className="hidden text-muted sm:inline">
          Pick an example job (&ldquo;Long training run&rdquo; shows interval payments and the watchdog); withdrawals and provider settings are off. One
          request at a time.
        </span>
      </div>
    </div>
  );
}
