'use client';

import clsx from 'clsx';
import { Blocks, Cpu, Download, Eye, EyeOff, Laptop, Lock, Pin, ScanEye, TriangleAlert, Waypoints, X, type LucideIcon } from '@/components/icons';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Party } from '@silicr/api';
import type { FactKey } from '@/lib/contract-ext';
import { getDriver, saveBlob } from '@/lib/driver';
import { expectationFor, FACTS, KNOWN_LIMITS, PARTIES, type Cell } from '@/lib/facts';
import { useNow, isTypingTarget } from '@/lib/hooks';
import { buildInspector, defaultTarget, describeTarget, targetOptions, type InspectorData, type InspField } from '@/lib/inspector';
import { renderReceipt } from '@/lib/receipt';
import { receiptFilename, receiptFromInspector } from '@/lib/receipt-from-inspector';
import { actions, useSilicr } from '@/lib/store';
import { buildTimeline, stateUntil } from '@/lib/timeline';
import { Badge, Kbd, Select } from '../ui';
import { InspectorColumn, type Spot } from './InspectorColumn';
import { TimelineScrub } from './Timeline';

const PARTY_META: Record<Party, { name: string; sub: string; icon: LucideIcon }> = {
  chain: { name: 'Public chain', sub: 'any block explorer', icon: Blocks },
  relay: { name: 'Silicr relay', sub: 'store-and-forward server', icon: Waypoints },
  provider: { name: 'Provider', sub: 'the GPU seller', icon: Cpu },
  buyer: { name: 'Buyer', sub: 'you, on this machine', icon: Laptop },
};

const GRID = 'grid grid-cols-[176px_repeat(4,minmax(0,1fr))] gap-x-3 xl:grid-cols-[196px_repeat(4,minmax(0,1fr))]';

export function LeakInspector() {
  const open = useSilicr((s) => s.inspector.open);
  return open ? <InspectorPanel /> : null;
}

function InspectorPanel() {
  const pathname = usePathname();
  const state = useSilicr((s) => s);
  const pinnedRfqId = state.inspector.pinnedRfqId;
  const now = useNow(1000);
  const panelRef = useRef<HTMLDivElement>(null);

  const routeTarget = useMemo(() => defaultTarget(state, pathname), [state, pathname]);
  const target = pinnedRfqId ?? routeTarget;
  // The full picture (live), the timeline built from it, and the picture as of the playhead.
  const fullData = useMemo(() => buildInspector(state, target, now), [state, target, now]);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const timeline = useMemo(
    () => buildTimeline({ rfq: fullData.rfq, job: fullData.job, observations: PARTIES.flatMap((p) => fullData.columns[p].observations.map((o) => o.obs)), now }),
    [fullData, now],
  );
  const data = useMemo(
    () => (playhead === null ? fullData : buildInspector(stateUntil(state, playhead), target, Math.min(now, playhead))),
    [fullData, state, target, now, playhead],
  );
  const totalObs = useMemo(() => PARTIES.reduce((n, p) => n + fullData.columns[p].observations.length, 0), [fullData]);
  const visibleObs = useMemo(() => PARTIES.reduce((n, p) => n + data.columns[p].observations.length, 0), [data]);
  const onScrub = useCallback((at: number | null) => setPlayhead(at), []);
  const onPlay = useCallback((p: boolean) => setPlaying(p), []);
  useEffect(() => {
    setPlayhead(null);
    setPlaying(false);
  }, [target]);
  const exportReceipt = () => {
    const html = renderReceipt(receiptFromInspector(fullData, state));
    saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), receiptFilename(fullData.rfqId));
  };
  const options = useMemo(() => targetOptions(state), [state]);

  const [hover, setHover] = useState<Spot | null>(null);
  const [pin, setPin] = useState<Spot | null>(null);
  const [tab, setTab] = useState<Party>('chain');
  const spot = hover ?? pin;

  // A page change re-targets the inspector to that page's request.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname;
      actions.setInspector({ pinnedRfqId: null });
    }
  }, [pathname]);

  // Focus, scroll lock, and focus return.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = prev;
      document.getElementById('inspector-toggle')?.focus({ preventScroll: true });
    };
  }, []);

  // 1–6 pin a fact, 0 clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const n = Number(e.key);
      if (e.key === '0') setPin(null);
      else if (Number.isInteger(n) && n >= 1 && n <= FACTS.length) {
        const fact = FACTS[n - 1]!.key;
        setPin((p) => (p?.kind === 'fact' && p.fact === fact ? null : { kind: 'fact', fact }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Real mode: poll each party's view while open (SSE fills in between).
  const txidsRef = useRef<string[]>(data.txids);
  txidsRef.current = data.txids;
  const mode = state.mode;
  useEffect(() => {
    const d = getDriver();
    if (!d || d.kind === 'mock' || mode !== 'real') return;
    let stopped = false;
    const run = () => {
      if (!stopped) void d.refreshInspector({ rfqId: target, txids: txidsRef.current });
    };
    run();
    const t = setInterval(run, 2500);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [target, mode]);

  const fieldIndex = useMemo(() => {
    const m = new Map<string, InspField>();
    for (const p of PARTIES) for (const o of data.columns[p].observations) for (const f of o.fields) m.set(f.key, f);
    return m;
  }, [data]);

  const limitsUsed = useMemo(() => {
    const set = new Set<number>();
    for (const f of FACTS) for (const p of PARTIES) {
      const c = data.matrix[f.key][p];
      const exp = expectationFor(p, f.key);
      if (c.state === 'knows' && exp?.limit) set.add(exp.limit);
    }
    return [...set].sort();
  }, [data]);

  const togglePinFact = (fact: FactKey) => setPin((p) => (p?.kind === 'fact' && p.fact === fact ? null : { kind: 'fact', fact }));
  const pinLabel = !pin ? '' : pin.kind === 'fact' ? `“${FACTS.find((f) => f.key === pin.fact)?.label ?? pin.fact}”` : `the value of “${pin.label}”`;
  const pinnedFact = pin?.kind === 'fact' ? pin.fact : null;
  const activeFact = spot?.kind === 'fact' ? spot.fact : null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Leak Inspector"
      tabIndex={-1}
      className="fixed inset-x-0 bottom-0 z-30 flex flex-col bg-bg outline-none animate-in"
      style={{ top: 'var(--chrome-h, 48px)' }}
    >
      {/* Header */}
      <div className="shrink-0 border-b border-line bg-panel">
        <div className="mx-auto flex max-w-[1880px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <ScanEye className="size-5 text-accent" aria-hidden />
            <div>
              <h2 className="text-base font-semibold leading-tight tracking-tight text-fg">Leak Inspector</h2>
              <p className="text-[11.5px] leading-tight text-muted">One request, four viewpoints, each from that party&apos;s own data</p>
            </div>
          </div>
          {data.mock && (
            <Badge tone="mock" className="font-mono tracking-wide">
              MOCK DATA
            </Badge>
          )}
          <div className="flex min-w-0 items-center gap-2">
            <label htmlFor="insp-target" className="text-xs text-muted">
              Request
            </label>
            <Select
              id="insp-target"
              value={target ?? ''}
              onChange={(e) => actions.setInspector({ pinnedRfqId: e.target.value || null })}
              className="h-8 w-auto min-w-[280px] max-w-[420px] font-mono text-xs"
            >
              {!options.length && <option value="">No requests yet</option>}
              {target && !options.some((o) => o.rfqId === target) && <option value={target}>{target}</option>}
              {options.map((o) => (
                <option key={o.rfqId} value={o.rfqId}>
                  {o.label}
                </option>
              ))}
            </Select>
            {pinnedRfqId && pinnedRfqId !== routeTarget && (
              <button type="button" className="rounded px-1.5 py-1 text-xs text-accent hover:bg-accent-soft" onClick={() => actions.setInspector({ pinnedRfqId: null })}>
                Follow page
              </button>
            )}
          </div>
          <Legend />
          <button
            type="button"
            onClick={exportReceipt}
            disabled={!fullData.rfqId}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-xs font-medium text-fg hover:bg-hover disabled:opacity-50"
            title="Download a self-contained HTML privacy receipt for this request"
          >
            <Download className="size-3.5" aria-hidden />
            Export receipt
          </button>
          <button
            type="button"
            onClick={() => actions.setInspector({ open: false })}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-2 text-xs text-muted hover:bg-hover hover:text-fg"
            aria-label="Close the Leak Inspector"
          >
            <Kbd>Esc</Kbd>
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
        <div className="mx-auto flex h-full max-w-[1880px] flex-col gap-3 px-4 pb-3 pt-3 sm:px-6">
          <TimelineScrub timeline={timeline} playhead={playhead} now={now} playing={playing} visible={visibleObs} total={totalObs} onScrub={onScrub} onPlay={onPlay} />
          <div className="shrink-0 overflow-x-auto thin-scroll">
            <div className="min-w-[860px] rounded-lg border border-line bg-panel" role="table" aria-label="Who knows what">
              <div role="row" className={clsx(GRID, 'border-b border-line px-1')}>
                <div role="columnheader" className="flex flex-col justify-end px-2 py-2.5">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-faint">Key fact</span>
                  <span className="text-[11px] text-faint">hover or press 1–6</span>
                </div>
                {PARTIES.map((p) => (
                  <PartyHeader key={p} party={p} data={data} />
                ))}
              </div>
              {FACTS.map((f, i) => {
                const active = activeFact === f.key;
                return (
                  <div
                    key={f.key}
                    role="row"
                    tabIndex={0}
                    aria-selected={pinnedFact === f.key}
                    onMouseEnter={() => setHover({ kind: 'fact', fact: f.key })}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover({ kind: 'fact', fact: f.key })}
                    onBlur={() => setHover(null)}
                    onClick={() => togglePinFact(f.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        togglePinFact(f.key);
                      }
                    }}
                    className={clsx(
                      GRID,
                      'cursor-pointer border-b border-line px-1 outline-none transition-colors last:border-b-0 focus-visible:bg-accent-soft',
                      active ? 'bg-accent-soft' : 'hover:bg-hover',
                    )}
                  >
                    <div role="rowheader" className="flex min-w-0 items-center gap-2 px-2 py-1">
                      <Kbd className={clsx(active && 'border-accent text-accent')}>{i + 1}</Kbd>
                      <span className="truncate text-[13px] font-medium text-fg" title={f.hint}>
                        {f.label}
                      </span>
                      {pinnedFact === f.key && <Pin className="size-3 shrink-0 text-accent" aria-label="pinned" />}
                    </div>
                    {PARTIES.map((p) => (
                      <MatrixCell key={p} cell={data.matrix[f.key][p]} party={p} fact={f.key} fieldIndex={fieldIndex} reason={data.columns[p].reason} />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          <Footnotes limits={limitsUsed} spot={spot} pinned={!!pin} onClear={() => setPin(null)} data={data} />

          {/* Mobile: one party at a time */}
          <div className="flex shrink-0 gap-1 rounded-md border border-line bg-panel p-1 lg:hidden" role="tablist" aria-label="Viewpoint">
            {PARTIES.map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={tab === p}
                onClick={() => setTab(p)}
                className={clsx('flex-1 rounded px-2 py-1.5 text-xs font-medium', tab === p ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-hover')}
              >
                {PARTY_META[p].name}
              </button>
            ))}
          </div>

          <div className={clsx(GRID, 'min-h-[420px] flex-1 lg:min-h-0')}>
            <aside className="hidden min-h-0 flex-col gap-3 overflow-y-auto pr-1 text-[11.5px] leading-relaxed text-muted thin-scroll lg:flex">
              <RailNotes data={data} />
            </aside>
            {PARTIES.map((p) => (
              <InspectorColumn
                key={p}
                column={data.columns[p]}
                spot={spot}
                pin={pin}
                pinLabel={pinLabel}
                onHover={setHover}
                onPin={setPin}
                className={clsx('col-span-5 lg:col-span-1', tab === p ? 'flex' : 'hidden lg:flex')}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PartyHeader({ party, data }: { party: Party; data: InspectorData }) {
  const meta = PARTY_META[party];
  const Icon = meta.icon;
  const col = data.columns[party];
  const sub = party === 'provider' && data.mock ? 'amber-otter-17 (this machine)' : meta.sub;
  return (
    <div role="columnheader" className="flex min-w-0 items-end justify-between gap-2 px-2 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-sunken">
          <Icon className="size-4 text-fg" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fg">{meta.name}</div>
          <div className="truncate text-[11px] text-muted">{sub}</div>
        </div>
      </div>
      {col.available ? (
        <div className="shrink-0 text-right leading-none">
          <span className="text-xl font-semibold tabular-nums text-fg">{data.knows[party]}</span>
          <span className="text-xs tabular-nums text-faint">/{FACTS.length}</span>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-faint">known</div>
        </div>
      ) : (
        <Badge>no data</Badge>
      )}
    </div>
  );
}

function MatrixCell({
  cell,
  party,
  fact,
  fieldIndex,
  reason,
}: {
  cell: Cell;
  party: Party;
  fact: FactKey;
  fieldIndex: Map<string, InspField>;
  reason: string | null;
}) {
  const exp = expectationFor(party, fact);
  const first = cell.evidence[0] ? fieldIndex.get(cell.evidence[0]) : undefined;
  const evidence = first ? `“${first.field.label}: ${first.field.value.length > 80 ? `${first.field.value.slice(0, 80)}…` : first.field.value}”` : '';
  if (cell.state === 'knows') {
    const unexpected = !exp;
    const title = cell.self
      ? `Knows by definition: it is the ${party === 'buyer' ? 'buyer' : 'provider'}. ${exp?.note ?? ''}`
      : `Knows, from ${evidence}${cell.evidence.length > 1 ? ` and ${cell.evidence.length - 1} more` : ''}.${exp ? ` ${exp.note}` : ' Not expected by THREAT_MODEL.md: investigate.'}`;
    return (
      <div role="cell" className="px-1 py-1">
        <div
          className={clsx(
            'knows-glow flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-knows-fg',
            unexpected && 'ring-2 ring-bad ring-offset-1 ring-offset-panel',
          )}
          title={title}
        >
          <Eye className="size-3.5" aria-hidden />
          Knows
          {cell.self && <span className="ml-auto rounded bg-white/20 px-1 text-[10px] font-medium">itself</span>}
          {exp?.limit ? <span className="ml-auto rounded bg-white/20 px-1 text-[10px] font-semibold">limit {exp.limit}</span> : null}
          {unexpected && (
            <span className="ml-auto inline-flex items-center gap-0.5 rounded bg-bad px-1 text-[10px]">
              <TriangleAlert className="size-3" aria-hidden />
              unexpected
            </span>
          )}
        </div>
      </div>
    );
  }
  if (cell.state === 'hidden') {
    return (
      <div role="cell" className="px-1 py-1">
        <div
          className="hatch flex h-7 items-center gap-1.5 rounded-md border border-line bg-black px-2.5 text-xs text-muted"
          title={`Doesn't know: ${cell.ciphertext ? 'it holds only ciphertext' : 'withheld from it'} (${evidence}).`}
        >
          <Lock className="size-3 text-faint" aria-hidden />
          {cell.ciphertext ? 'Ciphertext only' : 'Hidden'}
        </div>
      </div>
    );
  }
  if (cell.state === 'na') {
    return (
      <div role="cell" className="px-1 py-1">
        <div className="flex h-7 items-center rounded-md border border-dashed border-line px-2.5 text-xs text-faint" title={reason ?? 'No data for this party'}>
          No data
        </div>
      </div>
    );
  }
  return (
    <div role="cell" className="px-1 py-1">
      <div className="flex h-7 items-center gap-1.5 px-2.5 text-xs text-faint" title="Nothing in this party's data carries this fact.">
        <EyeOff className="size-3.5" aria-hidden />
        Doesn&apos;t know
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="ml-auto hidden items-center gap-3 text-[11.5px] text-muted md:flex" aria-label="Legend">
      <span className="flex items-center gap-1.5">
        <span className="knows-glow inline-block h-3 w-4 rounded-sm" />
        Knows: readable + sensitive
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-4 rounded-sm border border-white/15 bg-white/10" />
        Readable, not sensitive
      </span>
      <span className="flex items-center gap-1.5">
        <span className="hatch inline-block h-3 w-4 rounded-sm border border-line-strong" />
        Ciphertext or withheld
      </span>
    </div>
  );
}

function Footnotes({
  limits,
  spot,
  pinned,
  onClear,
  data,
}: {
  limits: number[];
  spot: Spot | null;
  pinned: boolean;
  onClear: () => void;
  data: InspectorData;
}) {
  return (
    <div className="shrink-0 space-y-1 rounded-md border border-line bg-panel px-3 py-2 text-[11.5px] leading-snug text-muted">
      <p>
        <span className="font-medium text-fg">How to read this.</span> Every cell is computed from the observations below: a field that is
        readable <em>and</em> sensitive means that party knows the fact. Hover a fact or a value to see where it appears; click or press 1–6 to pin it
        {pinned && (
          <>
            {' '}
            (
            <button type="button" className="text-accent hover:underline" onClick={onClear}>
              unpin
            </button>
            )
          </>
        )}
        .{spot?.kind === 'tokens' && <span className="text-accent"> Tracing the value of “{spot.label}” across parties (click a value to pin it).</span>}
      </p>
      {limits.map((n) => (
        <p key={n}>
          <span className="font-medium text-fg">Known limit {n}</span> (THREAT_MODEL.md): {KNOWN_LIMITS[n]}
        </p>
      ))}
      {data.proxied && (
        <p>
          <span className="font-medium text-fg">SOCKS5 proxy in use.</span> This machine&apos;s daemon routes its outbound connections through a
          proxy, so the relay and the light-wallet server see the proxy&apos;s address, not this machine&apos;s IP. A &ldquo;client IP&rdquo; the
          relay logs for this machine is the proxy&apos;s. Timing (known limit 4) is unchanged.
        </p>
      )}
      <p>
        <span className="font-medium text-fg">Not a column: the light-wallet server</span> (lightwalletd
        {data.network === 'test' ? ', testnet.zec.rocks by default' : data.network === 'main' ? ', the mainnet server your daemon syncs from' : ''}) has no
        observer feed. Per THREAT_MODEL.md it learns{' '}
        {data.proxied ? 'the proxy’s address instead of this wallet’s IP, plus' : 'each wallet’s IP address,'} every transaction it broadcasts and
        when, the wallet&apos;s birthday height and any transaction fetched by txid, but not memo contents, amounts, recipients or which notes
        belong to the wallet.
      </p>
    </div>
  );
}

function RailNotes({ data }: { data: InspectorData }) {
  const r = data.rfq;
  return (
    <>
      <div className="rounded-md border border-line bg-panel p-2.5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-faint">Request</div>
        <div className="mt-1 font-mono text-[11px] text-fg" title={data.rfqId ?? undefined}>
          {data.rfqId ? `${data.rfqId.slice(0, 10)}…` : 'none'}
        </div>
        <div className="mt-0.5 text-fg">{describeTarget(data)}</div>
        {r && (
          <dl className="mt-2 space-y-0.5">
            <div className="flex justify-between gap-2">
              <dt>Asked</dt>
              <dd className="tabular-nums text-fg">{r.providersAsked} providers</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Outputs on chain</dt>
              <dd className="tabular-nums text-fg">{r.paddedOutputs} (padded)</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Bids</dt>
              <dd className="tabular-nums text-fg">{r.bids.length}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Payments</dt>
              <dd className="tabular-nums text-fg">{r.payments.length}</dd>
            </div>
          </dl>
        )}
      </div>
      <p>
        <span className="font-medium text-fg">Public chain:</span> opaque shielded transactions. BID, ACCEPT, PAY and CLOSE all look alike: 2
        actions and the standard fee.
      </p>
      {data.network === 'main' && (
        <p className="rounded-md border border-real/40 bg-real-soft p-2 text-fg">
          <span className="font-semibold text-real">Real ZEC.</span> This request runs on Zcash mainnet: the amounts in the buyer and provider
          columns are real funds.
        </p>
      )}
      <p>
        <span className="font-medium text-fg">Relay:</span> sealed blobs under random mailbox ids, plus the IPs that connect
        {data.proxied ? ' (this machine’s is the SOCKS5 proxy’s address, not its own)' : ''}.
      </p>
      <p>
        <span className="font-medium text-fg">Provider:</span> sees the job it runs and the price it bid, never the buyer&apos;s wallet or IP, and the buyer&apos;s max price only if disclosed (off by default).
      </p>
      <p>
        <span className="font-medium text-fg">Buyer:</span> the only party that sees everything.
      </p>
      {!data.demo && (
        <p className="rounded-md border border-warn/30 bg-warn-soft p-2 text-warn">
          Not in demo mode: other parties&apos; views can&apos;t be fetched from this machine. That is the design working.
        </p>
      )}
    </>
  );
}
