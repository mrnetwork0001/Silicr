import { CircleSlash, Pause, Square } from '@/components/icons';
import type { ReactNode } from 'react';
import {
  BUYER_EXPOSURE,
  DEMO_DEFAULTS,
  EXAMPLE,
  MARGINAL_FEE_ZATS,
  TESTNET_DEFAULTS,
  formatZats,
  formatZec,
  zip317Fee,
} from '@/lib/settlement';

const ex = EXAMPLE;
const Z = ({ zats, unit = 'ZEC' }: { zats: bigint; unit?: string }) => (
  <span data-count className="zec whitespace-nowrap text-[0.94em]">
    {formatZec(zats)} {unit}
  </span>
);

type Step = {
  label: string;
  job: 'run' | 'pause' | 'stop';
  /** Payment sent near the start of this column (the ACCEPT). */
  first?: string;
  /** Payment sent shortly before this column ends, for the next interval. */
  ahead?: string;
  missing?: string;
  note: string;
};

/** Interval timeline: the happy path, then the buyer stops paying. */
const STEPS: Step[] = [
  { label: 'Interval 0', job: 'run', first: 'ACCEPT', ahead: 'PAY 1', note: 'paid by the ACCEPT; PAY 1 goes out shortly before it ends' },
  { label: 'Interval 1', job: 'run', ahead: 'PAY 2', note: 'PAY 2 goes out shortly before it ends' },
  { label: 'Interval 2', job: 'run', ahead: 'PAY 3', note: 'PAY 3 goes out shortly before it ends' },
  { label: 'Interval 3', job: 'run', missing: 'no PAY 4', note: 'the buyer stops paying: no PAY 4' },
  { label: 'Grace', job: 'pause', note: `interval 4 unpaid: the job is paused for up to ${TESTNET_DEFAULTS.graceS / 60} min` },
  { label: 'After', job: 'stop', note: 'stopped, signed CLOSE (unpaid), no results' },
];

function JobBar({ job, className = '' }: { job: Step['job']; className?: string }) {
  const base = 'flex items-center justify-center gap-1 rounded-md text-[12px] font-medium';
  if (job === 'run') return <span className={`${base} bg-accent text-accent-fg ${className}`}>running</span>;
  if (job === 'pause')
    return (
      <span className={`${base} hatch border border-warn/60 bg-panel text-warn ${className}`}>
        <Pause className="size-3.5" aria-hidden />
        paused
      </span>
    );
  return (
    <span className={`${base} border border-line-strong bg-sunken text-muted ${className}`}>
      <Square className="size-3" aria-hidden />
      stopped
    </span>
  );
}

function PayChip({ label, missing }: { label: string; missing?: boolean }) {
  return missing ? (
    <span className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md border border-dashed border-bad/50 px-1.5 py-0.5 font-mono text-[11.5px] text-bad">
      <CircleSlash className="size-3 shrink-0" aria-hidden />
      {label}
    </span>
  ) : (
    <span className="inline-flex items-center justify-center whitespace-nowrap rounded-md border border-zec/30 bg-zec-soft px-1.5 py-0.5 font-mono text-[11.5px] text-zec">
      {label}
    </span>
  );
}

function Timeline() {
  return (
    <figure className="rounded-2xl border border-line bg-panel p-5 sm:p-6">
      <figcaption className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[15px] font-semibold">One job, then a buyer who stops paying</span>
        <span className="hidden font-mono text-[12px] text-muted sm:inline">time →</span>
      </figcaption>

      {/* Wide: columns along a time axis. */}
      <ol className="hidden grid-cols-6 gap-1.5 sm:grid">
        {STEPS.map((s) => (
          <li key={s.label} className="flex min-w-0 flex-col gap-1.5">
            <span className="sr-only">
              {s.label}: {s.job === 'run' ? 'running' : s.job === 'pause' ? 'paused' : 'stopped'}, {s.note}.
            </span>
            <div className="flex min-h-[58px] flex-col justify-end gap-1" aria-hidden>
              {s.first && (
                <span className="flex justify-start">
                  <PayChip label={s.first} />
                </span>
              )}
              {s.ahead && (
                <span className="flex justify-end">
                  <PayChip label={s.ahead} />
                </span>
              )}
              {s.missing && (
                <span className="flex justify-end">
                  <PayChip label={s.missing} missing />
                </span>
              )}
            </div>
            <JobBar job={s.job} className="h-10" />
            <span className="truncate text-center font-mono text-[11.5px] text-muted" aria-hidden>
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      {/* Narrow: the same steps as a list. */}
      <ol className="space-y-1.5 sm:hidden">
        {STEPS.map((s) => (
          <li key={s.label} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-3">
            <JobBar job={s.job} className="h-8" />
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium text-fg">{s.label}</p>
              <p className="text-[12.5px] leading-snug text-muted">{s.note}</p>
            </div>
          </li>
        ))}
      </ol>

      <ol className="mt-5 space-y-2 text-[14px] leading-relaxed text-muted">
        <li>
          <span className="font-medium text-fg">Interval 0 is paid by the ACCEPT transaction</span>, before any work starts. The
          job clock starts when the provider&apos;s first signed heartbeat arrives.
        </li>
        <li>
          <span className="font-medium text-fg">Every later interval is paid by the buyer&apos;s own clock</span>, shortly before
          it begins ({TESTNET_DEFAULTS.payLeadS / 60} min ahead by default on testnet), with random jitter so payments have no
          fixed rhythm.
        </li>
        <li>
          <span className="font-medium text-fg">Heartbeats only confirm the job is alive.</span> A missing or stale heartbeat
          holds a payment back, but no heartbeat can bring one forward: a provider can&apos;t speed up payments by claiming
          progress.
        </li>
        <li>
          <span className="font-medium text-fg">The provider never computes an unpaid interval.</span> At an unpaid boundary it
          pauses the job; if the payment hasn&apos;t arrived by the end of the grace period, it stops, sends a signed CLOSE
          (unpaid) and uploads no results.
        </li>
        <li>
          <span className="font-medium text-fg">The buyer has a watchdog too:</span> after {TESTNET_DEFAULTS.heartbeatTimeoutS}{' '}
          s without a signed heartbeat it stops paying and sends CLOSE (no heartbeat).
        </li>
      </ol>
    </figure>
  );
}

function Defaults() {
  const rows: [string, string][] = [
    ['Interval', `${TESTNET_DEFAULTS.intervalS / 60} min, quoted in each bid`],
    ['Each payment goes out', `about ${TESTNET_DEFAULTS.payLeadS / 60} min early, with random jitter`],
    ['Heartbeat', `every ${TESTNET_DEFAULTS.heartbeatS} s, signed and sealed`],
    ['Grace before stopping', `${TESTNET_DEFAULTS.graceS / 60} min`],
    ['Buyer gives up after', `${TESTNET_DEFAULTS.heartbeatTimeoutS} s without a heartbeat`],
  ];
  return (
    <div className="rounded-2xl border border-line bg-panel p-5 sm:p-6">
      <h3 className="text-[16px] font-semibold">Defaults on testnet</h3>
      <dl className="mt-3 divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-2 text-[14.5px]">
            <dt className="text-muted">{k}</dt>
            <dd className="text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        Providers set their own interval and grace. Mainnet uses a longer interval and lead, so fewer payments per hour;{' '}
        <code className="code-inline text-fg">silicr status</code> shows the live values. The simulated demo compresses time:{' '}
        {DEMO_DEFAULTS.intervalS} s intervals, paid {DEMO_DEFAULTS.payLeadS} s early, {DEMO_DEFAULTS.graceS} s grace.
      </p>
    </div>
  );
}

function WorkedExample() {
  const rows: { k: string; v: ReactNode; sub?: ReactNode }[] = [
    {
      k: 'Intervals',
      v: (
        <>
          {ex.hours} h ÷ {ex.intervalMin} min = <b data-count className="font-semibold">{ex.intervals}</b>
        </>
      ),
    },
    {
      k: 'Payment transactions',
      v: (
        <>
          <b data-count className="font-semibold">{ex.payments}</b>: 1 ACCEPT + {ex.payCount} PAY
        </>
      ),
    },
    {
      k: 'Paid to the provider',
      v: (
        <>
          {ex.intervals} × <Z zats={ex.pricePerIntervalZats} /> = <Z zats={ex.paidZats} />
        </>
      ),
    },
    {
      k: 'Network fees on payments',
      v: (
        <>
          {ex.payments} × <Z zats={ex.paymentFeeZats} /> = <Z zats={ex.paymentFeesZats} />
        </>
      ),
      sub: <>{ex.feeShare}% of the job</>,
    },
    {
      k: 'All fees, with the RFQ and your CLOSE',
      v: (
        <>
          ≈ <Z zats={ex.allInFeesZats} />
        </>
      ),
      sub: (
        <>
          RFQ to {ex.providersAsked} providers: {ex.bucket} padded outputs + change = {ex.rfqActions} actions,{' '}
          {formatZats(ex.rfqFeeZats)} zats. CLOSE: {formatZats(ex.closeFeeZats)} zats.
        </>
      ),
    },
    {
      k: 'Most you can lose',
      v: (
        <>
          ≈ <Z zats={ex.buyerMaxExposureZats} />
        </>
      ),
      sub: (
        <>
          The rest of the interval in progress plus the one prepaid interval: about {BUYER_EXPOSURE.label} intervals, or{' '}
          {ex.buyerMaxExposureMinutes} minutes&apos; worth ({ex.buyerExposureShare}% of the job), even against a provider that
          lies about its progress.
        </>
      ),
    },
    {
      k: 'Most the provider can lose',
      v: <>no unpaid compute</>,
      sub: (
        <>
          It never computes an unpaid interval: it pauses at an unpaid boundary and stops after the grace period. It does act
          on payments while they are still in the mempool, since each is small.
        </>
      ),
    },
  ];
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-panel">
      <div className="border-b border-line px-5 py-4 sm:px-6">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Worked example</p>
        <p className="mt-1.5 text-[15.5px] leading-snug">
          {ex.count} × {ex.gpu.toUpperCase()} for {ex.hours} hours, max <Z zats={ex.maxPerHourZats} unit="ZEC/h" />. The
          winning bid is <Z zats={ex.bidPerHourZats} unit="ZEC/h" />, quoted as <Z zats={ex.pricePerIntervalZats} /> per{' '}
          {ex.intervalMin}-minute interval.
        </p>
      </div>
      <dl className="divide-y divide-line px-5 sm:px-6">
        {rows.map((r) => (
          <div key={r.k} className="grid grid-cols-1 gap-1 py-3.5 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] sm:gap-4">
            <dt className="text-[14px] text-muted">{r.k}</dt>
            <dd className="text-[14.5px] text-fg">
              {r.v}
              {r.sub && <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{r.sub}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-line px-5 py-3.5 text-[12.5px] leading-relaxed text-muted sm:px-6">
        Fees assume each payment spends one note and returns one change note: 2 logical actions, the ZIP 317 minimum. Spending
        more notes, or splitting change into extra notes, adds {formatZats(MARGINAL_FEE_ZATS)} zats per extra action.
      </p>
    </div>
  );
}

function WhyNoContract() {
  const points = [
    'Every payment is a plain shielded transaction carrying a signed PAY memo. Nothing is locked or pooled.',
    'Nobody holds custody: not Silicr, not a contract, not the relay.',
    'Instead of escrow, the risk is capped by the interval length. Shorter intervals mean less at stake and more fees.',
    'An escrow on a transparent chain would publish the deal anyway.',
  ];
  return (
    <div className="rounded-2xl border border-line bg-panel p-5 sm:p-6">
      <h3 className="text-[16px] font-semibold">Why no smart contract is needed</h3>
      <ul className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 text-[14.5px] leading-relaxed text-muted md:grid-cols-2 xl:grid-cols-4">
        {points.map((p) => (
          <li key={p} className="border-l-2 border-accent-line pl-3">
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Fees() {
  return (
    <div className="rounded-2xl border border-line bg-panel p-5 sm:p-6">
      <h3 className="text-[16px] font-semibold">Fees (ZIP 317)</h3>
      <p className="mt-3 rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[13px] text-fg">
        fee = {formatZats(MARGINAL_FEE_ZATS)} zats × max(2, logical actions)
      </p>
      <ul className="mt-3 space-y-2 text-[14.5px] leading-relaxed text-muted">
        <li>
          A PAY is one output plus change: 2 actions, {formatZats(zip317Fee(2))} zats, or <Z zats={zip317Fee(2)} />.
        </li>
        <li>
          Each padding output in an RFQ adds {formatZats(MARGINAL_FEE_ZATS)} zats. That is the price of hiding how many
          providers you asked.
        </li>
      </ul>
    </div>
  );
}

export function Settlement() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Timeline />
          <Defaults />
        </div>
        <div className="space-y-6">
          <WorkedExample />
          <Fees />
        </div>
      </div>
      <WhyNoContract />
    </div>
  );
}
