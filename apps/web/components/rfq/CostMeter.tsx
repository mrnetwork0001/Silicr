'use client';

import clsx from 'clsx';
import { ShieldCheck, Timer } from '@/components/icons';
import type { RfqDto } from '@silicr/api';
import { formatCountdown, formatDuration, perHourZats, toZats, zecString } from '@/lib/format';
import { Badge, Panel, Zec } from '../ui';

export function CostMeter({ rfq, now }: { rfq: RfqDto; now: number }) {
  const acc = rfq.accepted;
  const ppi = toZats(acc?.pricePerIntervalZats);
  const maxCommitted = acc ? ppi * BigInt(acc.intervals) : (toZats(rfq.request.maxPricePerHourZats) * BigInt(rfq.request.durationS)) / 3600n;
  const spent = toZats(rfq.spentZats);
  const fees = toZats(rfq.feesZats);
  const pct = maxCommitted > 0n ? Math.min(100, Number((spent * 10_000n) / maxCommitted) / 100) : 0;
  const running = rfq.state === 'running';
  const intervalMs = (acc?.intervalS ?? 0) * 1000;
  const due = rfq.nextPaymentAt;
  const msLeft = due !== undefined ? due - now : null;
  const overdue = msLeft !== null && msLeft < -1500;
  const progress = due !== undefined && intervalMs ? Math.max(0, Math.min(1, 1 - (msLeft ?? 0) / intervalMs)) : 0;
  const nextSeq = rfq.payments.length;
  const withheld = !!rfq.paymentsWithheld;
  const warn = withheld || overdue;
  const ticks = acc && acc.intervals <= 48 ? acc.intervals : 0;

  return (
    <Panel
      title="Cost meter"
      subtitle="Pay as you go: one shielded payment per interval"
      actions={running ? <Badge tone={warn ? 'warn' : 'ok'}>{withheld ? 'payments withheld' : overdue ? 'payment late' : 'metering'}</Badge> : null}
    >
      <div className="space-y-4 p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-2xs font-medium uppercase tracking-wider text-faint">Spent</div>
            <div className="mt-0.5 text-[28px] font-semibold leading-none tracking-tight">
              <Zec zats={spent} unit={false} proportional />
              <span className="ml-1.5 text-base font-medium text-faint">ZEC</span>
            </div>
          </div>
          <div className="text-right text-xs text-muted">
            of <Zec zats={maxCommitted} /> max
            <div className="text-2xs text-faint">{acc ? `${acc.intervals} × ${zecString(ppi)} ZEC` : 'at your max price'}</div>
          </div>
        </div>

        <div>
          <div
            className="relative h-2.5 overflow-hidden rounded-full bg-zec-soft"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            aria-label="Spent of max"
          >
            <div className="absolute inset-y-0 left-0 rounded-full bg-zec transition-[width] duration-700" style={{ width: `${Math.max(pct, spent > 0n ? 0.8 : 0)}%` }} />
            {ticks > 1 &&
              Array.from({ length: ticks - 1 }, (_, i) => (
                <span key={i} className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-panel" style={{ left: `${((i + 1) / ticks) * 100}%` }} aria-hidden />
              ))}
          </div>
          <div className="mt-1 flex justify-between text-2xs tabular-nums text-faint">
            <span>{pct.toFixed(pct < 10 ? 1 : 0)}% of max</span>
            <span>
              {rfq.payments.length}
              {acc ? ` of ${acc.intervals}` : ''} intervals paid
            </span>
          </div>
        </div>

        {running && acc && (
          <div className={clsx('rounded-md border p-3', warn ? 'border-warn/40 bg-warn-soft' : 'border-line bg-sunken/60')}>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
                <Timer className={clsx('size-3.5', warn ? 'text-warn' : 'text-accent')} aria-hidden />
                {withheld
                  ? `PAY #${nextSeq} withheld`
                  : due === undefined
                    ? rfq.payments.length >= acc.intervals
                      ? 'All intervals paid'
                      : 'No payment scheduled'
                    : overdue
                      ? `PAY #${nextSeq} is late`
                      : `Next payment: PAY #${nextSeq}`}
              </span>
              {due !== undefined && (
                <span className={clsx('font-mono text-lg font-semibold tabular-nums', warn ? 'text-warn' : 'text-fg')}>
                  {warn ? `+${formatCountdown(-(msLeft ?? 0))}` : formatCountdown(msLeft ?? 0)}
                </span>
              )}
            </div>
            {due !== undefined && (
              <div className={clsx('mt-2 h-1 overflow-hidden rounded-full', warn ? 'bg-warn-soft' : 'bg-accent-soft')}>
                <div className={clsx('h-full rounded-full transition-[width] duration-1000 ease-linear', warn ? 'bg-warn' : 'bg-accent')} style={{ width: `${progress * 100}%` }} />
              </div>
            )}
            <p className="mt-2 text-2xs text-muted">
              {withheld
                ? "Payments withheld (demo fault). The provider's watchdog pauses the job after its grace period, then stops it. It is never paid more than about one interval ahead (the prepaid one)."
                : `${zecString(ppi)} ZEC every ${formatDuration(acc.intervalS)}, paid before each interval starts.`}
            </p>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
          <div>
            <dt className="text-faint">Price</dt>
            <dd className="mt-0.5">{acc ? <Zec zats={perHourZats(acc.pricePerIntervalZats, acc.intervalS)} suffix="/h" /> : <span className="text-faint">not accepted yet</span>}</dd>
          </div>
          <div>
            <dt className="text-faint">Network fees so far</dt>
            <dd className="mt-0.5 tabular-nums text-fg">{zecString(fees)} ZEC</dd>
          </div>
          <div className="col-span-2 flex items-start gap-2 rounded-md border border-line px-2.5 py-2">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
            <span className="text-muted">
              Exposure: at most about one interval ahead (the prepaid one)
              {acc ? (
                <>
                  , <span className="font-medium text-fg">{zecString(ppi)} ZEC</span>
                </>
              ) : null}
              . Payments are timed by this machine&apos;s clock, not by the provider&apos;s reports. If payment stops, the job stops; if heartbeats stop,
              payment stops.
            </span>
          </div>
        </dl>
      </div>
    </Panel>
  );
}
