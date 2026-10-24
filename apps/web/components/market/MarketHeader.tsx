'use client';

import type { ReactNode } from 'react';

/** The Market page's header band: title and lede on the left, live die-tile stats on the right, a faint trace behind. */
export function MarketHeader({ stats }: { stats: { label: string; value: ReactNode; sub?: ReactNode }[] }) {
  return (
    <section className="trace-band px-4 py-4 sm:px-5" data-reveal>
      <svg className="traces" viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden>
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M-10 92 H360 L384 68 H640 L664 44 H1210" stroke="rgba(238,127,32,0.10)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d="M-10 30 H180 L204 54 H520" stroke="rgba(255,190,140,0.07)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d="M760 110 V92 L784 68 H1210" stroke="rgba(255,190,140,0.07)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path
            d="M-10 92 H360 L384 68 H640 L664 44 H1210"
            pathLength={100}
            className="trace-pulse"
            stroke="#f7a35c"
            strokeOpacity="0.55"
            strokeWidth="1.6"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      </svg>
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <div className="section-label text-[10px] text-accent">Sealing room</div>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-[-0.02em] text-fg">Market</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            No order book and no matcher. Your request is sealed to the providers you pick, and their signed bids come straight back to you.
          </p>
        </div>
        <div className="grid w-full grid-cols-3 gap-2.5 sm:w-auto">
          {stats.map((s) => (
            <div key={s.label} className="die-tile min-w-0 rounded-lg px-3 py-2 sm:min-w-[150px] max-[600px]:px-2.5">
              <span className="die-pad right-2 top-2" aria-hidden />
              <div className="section-label truncate pr-3 text-[10px] text-muted">{s.label}</div>
              <div className="mt-0.5 truncate text-lg font-semibold tabular-nums text-fg max-[600px]:whitespace-normal max-[600px]:text-[15px] max-[600px]:leading-snug max-[600px]:[overflow-wrap:anywhere]">{s.value}</div>
              {s.sub && <div className="truncate text-2xs text-faint">{s.sub}</div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** A tiny silicon die: a square body with pins, used beside GPU lines. */
export function DieGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <rect x="6" y="6" width="4" height="4" rx="0.8" fill="#ee7f20" />
      {[5.5, 8, 10.5].map((p) => (
        <g key={p} stroke="currentColor" strokeWidth="1" strokeLinecap="round">
          <path d={`M${p} 1.2V3`} />
          <path d={`M${p} 13V14.8`} />
          <path d={`M1.2 ${p}H3`} />
          <path d={`M13 ${p}H14.8`} />
        </g>
      ))}
    </svg>
  );
}
