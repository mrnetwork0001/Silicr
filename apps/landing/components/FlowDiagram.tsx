import { ArrowDown, ArrowUp, ArrowUpDown } from '@/components/icons';

const LANES = [
  { y: 112, label: '① RFQ · sealed to each provider asked', dir: 'right' },
  { y: 152, label: '② BID · signed, to a one-time address', dir: 'left' },
  { y: 192, label: '④ ACCEPT, then one PAY per interval', dir: 'right' },
  { y: 232, label: 'CLOSE · from either side', dir: 'both' },
] as const;

function Node({ x, title, sub, items }: { x: number; title: string; sub: string; items: string[] }) {
  return (
    <g>
      <rect x={x} y={64} width={250} height={196} rx={14} className="fill-raised stroke-line-strong" strokeWidth={1} />
      <text x={x + 24} y={100} className="fill-fg" fontSize={18} fontWeight={600}>
        {title}
      </text>
      <text x={x + 24} y={121} className="fill-muted font-mono" fontSize={12}>
        {sub}
      </text>
      {items.map((t, i) => (
        <g key={t}>
          <circle cx={x + 28} cy={156 + i * 28} r={2.5} className="fill-accent" />
          <text x={x + 40} y={160 + i * 28} className="fill-fg" fontSize={13.5}>
            {t}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Wide layout: buyer ↔ Zcash ↔ provider, with the ciphertext-only relay below, off the main axis. */
function WideDiagram() {
  return (
    <svg
      viewBox="0 0 1100 380"
      className="hidden h-auto w-full lg:block"
      role="img"
      aria-labelledby="flow-title flow-desc"
    >
      <title id="flow-title">How a Silicr job flows</title>
      <desc id="flow-desc">
        The buyer and the provider exchange the RFQ, the bid, the acceptance, interval payments and the close as encrypted
        memos inside shielded Zcash transactions. The job, logs, heartbeats and results travel sealed through the Silicr
        relay, which stores only ciphertext.
      </desc>
      <defs>
        <marker id="arrow-end" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="fill-accent" />
        </marker>
        <filter id="flow-glow" x="-10%" y="-200%" width="120%" height="500%">
          <feGaussianBlur stdDeviation={3} result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <pattern id="relay-hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={6} strokeWidth={1.2} className="stroke-line-strong" />
        </pattern>
      </defs>

      {/* Zcash band: the shielded motif in gold. */}
      <rect x={300} y={40} width={500} height={240} rx={18} className="fill-zec-soft stroke-accent/40" strokeWidth={1} strokeDasharray="2 4" />
      <text x={550} y={72} textAnchor="middle" className="fill-zec font-mono" fontSize={12.5} fontWeight={600} letterSpacing={1.2}>
        ZCASH · SHIELDED (IRONWOOD)
      </text>

      <Node x={24} title="Buyer" sub="silicr CLI · terminal" items={['Shielded wallet', 'Ranks bids, picks one', 'Pays per interval']} />
      <Node
        x={826}
        title="Provider"
        sub="silicr provide"
        items={['Shielded wallet', 'Bids by policy', 'Docker sandbox, watchdog']}
      />

      {LANES.map((l, i) => (
        <g key={l.label}>
          <line
            x1={l.dir === 'left' ? 822 : 278}
            y1={l.y}
            x2={l.dir === 'left' ? 278 : 822}
            y2={l.y}
            className="stroke-accent"
            strokeWidth={1.8}
            filter="url(#flow-glow)"
            markerEnd="url(#arrow-end)"
            markerStart={l.dir === 'both' ? 'url(#arrow-end)' : undefined}
          />
          {/* A pulse of sealed data travelling the lane, lanes lighting in sequence. */}
          <line
            x1={l.dir === 'left' ? 822 : 278}
            y1={l.y}
            x2={l.dir === 'left' ? 278 : 822}
            y2={l.y}
            pathLength={1000}
            className="flow-pulse"
            style={{ animationDelay: `${i * 0.9}s` }}
          />
          <rect x={392} y={l.y - 14} width={316} height={28} rx={14} className="fill-panel stroke-line-strong" strokeWidth={1} />
          <text x={550} y={l.y + 4.5} textAnchor="middle" className="fill-fg" fontSize={13}>
            {l.label}
          </text>
        </g>
      ))}

      {/* Relay, off to one side: sealed blobs only. */}
      <path d="M149 260 V338 H360" fill="none" className="stroke-accent/70" strokeWidth={1.4} strokeDasharray="5 5" filter="url(#flow-glow)" />
      <path d="M951 260 V338 H740" fill="none" className="stroke-accent/70" strokeWidth={1.4} strokeDasharray="5 5" filter="url(#flow-glow)" />
      <path d="M149 260 V338 H360" fill="none" pathLength={1000} className="flow-pulse flow-pulse-relay" />
      <path d="M951 260 V338 H740" fill="none" pathLength={1000} className="flow-pulse flow-pulse-relay" style={{ animationDelay: '1.8s' }} />
      <rect x={360} y={306} width={380} height={64} rx={12} className="fill-panel stroke-line-strong" strokeWidth={1} />
      <rect x={360} y={306} width={380} height={64} rx={12} fill="url(#relay-hatch)" opacity={0.55} />
      <text x={550} y={333} textAnchor="middle" className="fill-fg" fontSize={14.5} fontWeight={600}>
        ③ Silicr relay: ciphertext only, no keys
      </text>
      <text x={550} y={354} textAnchor="middle" className="fill-muted" fontSize={12.5}>
        sealed job, logs, heartbeats and results
      </text>
    </svg>
  );
}

function StackNode({ title, sub, items }: { title: string; sub: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-line-strong bg-panel px-4 py-3.5">
      <p className="text-[16px] font-semibold">{title}</p>
      <p className="font-mono text-[12px] text-muted">{sub}</p>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13.5px]">
        {items.map((t) => (
          <li key={t} className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Narrow layout: the same flow, stacked. */
function StackedDiagram() {
  const icon = { right: ArrowDown, left: ArrowUp, both: ArrowUpDown } as const;
  return (
    <div className="lg:hidden">
      <StackNode title="Buyer" sub="silicr CLI · terminal" items={['Shielded wallet', 'Ranks bids, picks one', 'Pays per interval']} />
      <div className="mx-3 border-x border-zec/40 bg-zec-soft px-3 py-3">
        <p className="mb-2 font-mono text-[11px] font-semibold tracking-[0.1em] text-zec">ZCASH · SHIELDED (IRONWOOD)</p>
        <ul className="space-y-1.5">
          {LANES.map((l) => {
            const Icon = icon[l.dir];
            return (
              <li key={l.label} className="flex items-center gap-2.5 rounded-lg border border-line-strong bg-panel px-3 py-2 text-[13.5px]">
                <Icon className="size-4 shrink-0 text-accent" aria-hidden />
                <span>{l.label}</span>
              </li>
            );
          })}
        </ul>
      </div>
      <StackNode title="Provider" sub="silicr provide" items={['Shielded wallet', 'Bids by policy', 'Docker sandbox, watchdog']} />
      <div className="hatch mt-4 rounded-xl border border-dashed border-line-strong bg-panel px-4 py-3">
        <p className="text-[14.5px] font-semibold">③ Silicr relay: ciphertext only, no keys</p>
        <p className="text-[13px] text-muted">Off the chain, to one side: buyer and provider swap the sealed job, logs, heartbeats and results here.</p>
      </div>
    </div>
  );
}

export function FlowDiagram() {
  return (
    <div className="rounded-3xl border border-line bg-panel p-3 shadow-[var(--shadow-pop)] sm:p-6">
      <WideDiagram />
      <StackedDiagram />
    </div>
  );
}
