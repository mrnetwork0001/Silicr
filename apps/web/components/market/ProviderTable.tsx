'use client';

import clsx from 'clsx';
import { BadgeCheck, Check, ListOrdered, Server, ShieldAlert, Blocks } from '@/components/icons';
import { useState } from 'react';
import type { ProviderDto } from '@silicr/api';
import { formatAgo, gpuLabel, toZats, zecString } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { gpuSummary } from '@/lib/market';
import { VerifiedBadge } from '../badges';
import { Badge, Empty, ErrorNote, Mono, Panel, Skeleton, Td, Th, Zec } from '../ui';
import { DieGlyph } from './MarketHeader';

export interface ProviderRow {
  p: ProviderDto;
  matches: boolean;
  aboveMax: boolean;
}

export function ProviderTable({
  rows,
  loading,
  error,
  gpu,
  count,
  selected,
  onToggle,
  onSelectMatching,
  onClear,
}: {
  rows: ProviderRow[];
  loading: boolean;
  error: string | null;
  gpu: string;
  count: number;
  selected: ReadonlySet<string>;
  onToggle: (providerId: string) => void;
  onSelectMatching: () => void;
  onClear: () => void;
}) {
  const now = useNow(30_000);
  const matching = rows.filter((r) => r.matches && r.p.verified);
  const selectedCount = rows.filter((r) => selected.has(r.p.providerId)).length;
  const [view, setView] = useState<'chips' | 'list'>('chips');

  return (
    <Panel
      title="Provider directory"
      subtitle="Public, signed and pseudonymous. It holds nothing about buyers."
      actions={
        rows.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="hidden sm:inline">
              <span className="font-medium text-fg tabular-nums">{selectedCount}</span> of {matching.length} matching {count}× {gpuLabel(gpu)} selected
            </span>
            <button type="button" className="rounded px-1.5 py-0.5 text-accent hover:bg-accent-soft" onClick={onSelectMatching}>
              All matching
            </button>
            <button type="button" className="rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg" onClick={onClear}>
              None
            </button>
            <div className="ml-1 flex rounded-full border border-line-strong p-0.5" role="group" aria-label="Directory view">
              {(
                [
                  ['chips', 'Chips', Blocks],
                  ['list', 'List', ListOrdered],
                ] as const
              ).map(([v, label, Icon]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  title={`${label} view`}
                  onClick={() => setView(v)}
                  className={clsx('inline-flex size-6 items-center justify-center rounded-full transition-colors', view === v ? 'bg-accent-soft text-accent' : 'text-faint hover:text-fg')}
                >
                  <Icon className="size-3.5" aria-label={`${label} view`} />
                </button>
              ))}
            </div>
          </div>
        )
      }
    >
      {error && !rows.length ? (
        <div className="p-4">
          <ErrorNote title="Couldn't load the directory">{error}</ErrorNote>
        </div>
      ) : loading && !rows.length ? (
        <div className="space-y-2.5 p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : !rows.length ? (
        <Empty icon={<Server className="size-6" />} title="No providers in the directory yet">
          Providers appear here after <code className="font-mono">silicr provide</code> publishes a signed entry.
        </Empty>
      ) : view === 'chips' ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-4 p-4 max-[900px]:grid-cols-2 max-[900px]:gap-3 max-[900px]:p-3 max-[600px]:grid-cols-1">
          {rows.map((row) => (
            <ProviderChip key={row.p.providerId} row={row} selected={selected.has(row.p.providerId)} onToggle={onToggle} now={now} />
          ))}
        </div>
      ) : (
        <div className="thin-scroll relative overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line">
                <Th className="w-10">
                  <span className="sr-only">Send RFQ</span>
                </Th>
                <Th>Provider</Th>
                <Th>GPUs</Th>
                <Th align="right">Min price</Th>
                <Th align="right">Bond</Th>
                <Th>Region</Th>
                <Th>Updated</Th>
                <Th align="right">Directory</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, matches, aboveMax }) => {
                const selectable = matches && p.verified;
                const isSel = selected.has(p.providerId);
                return (
                  <tr
                    key={p.providerId}
                    className={clsx(
                      'border-b border-line last:border-b-0 transition-colors',
                      selectable ? 'cursor-pointer hover:bg-hover' : 'text-muted',
                      isSel && 'bg-accent-soft/60',
                      !matches && 'opacity-55',
                    )}
                    onClick={() => selectable && onToggle(p.providerId)}
                  >
                    <Td className="w-10">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[var(--accent)]"
                        checked={isSel}
                        disabled={!selectable}
                        onChange={() => onToggle(p.providerId)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Send the RFQ to ${p.alias}`}
                      />
                    </Td>
                    <Td>
                      <div className="flex flex-col">
                        <span className="font-medium text-fg">{p.alias}</span>
                        <Mono value={p.providerId} head={8} tail={4} className="text-2xs text-faint" />
                      </div>
                    </Td>
                    <Td>
                      <span className={clsx(matches ? 'text-fg' : 'text-muted')}>{gpuSummary(p)}</span>
                    </Td>
                    <Td align="right">
                      <div className="flex flex-col items-end">
                        <Zec zats={p.minPricePerHourZats} suffix="/h" />
                        {aboveMax && matches && <span className="text-2xs text-warn">above your max</span>}
                      </div>
                    </Td>
                    <Td align="right">{toZats(p.bondZats) > 0n ? <Zec zats={p.bondZats} /> : <span className="text-faint">none</span>}</Td>
                    <Td>{p.region ? <Badge>{p.region}</Badge> : <span className="text-faint">—</span>}</Td>
                    <Td className="text-xs text-muted tabular-nums">{formatAgo(p.updatedAt, now)}</Td>
                    <Td align="right">
                      <VerifiedBadge verified={p.verified} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ProviderChip({ row: { p, matches, aboveMax }, selected, onToggle, now }: { row: ProviderRow; selected: boolean; onToggle: (id: string) => void; now: number }) {
  const selectable = matches && p.verified;
  const bond = toZats(p.bondZats);
  return (
    <div
      role="checkbox"
      aria-checked={selected}
      aria-disabled={!selectable}
      aria-label={`Send the RFQ to ${p.alias}`}
      tabIndex={selectable ? 0 : -1}
      data-selectable={selectable}
      data-selected={selected}
      onClick={() => selectable && onToggle(p.providerId)}
      onKeyDown={(e) => {
        if (selectable && (e.key === ' ' || e.key === 'Enter')) {
          e.preventDefault();
          onToggle(p.providerId);
        }
      }}
      className={clsx('die-card flex min-w-0 flex-col p-3.5 outline-none', !matches && 'opacity-50', matches && !p.verified && 'opacity-80')}
    >
      {/* corner check pad */}
      <span
        aria-hidden
        className={clsx(
          'absolute right-2.5 top-2.5 inline-flex size-[18px] items-center justify-center rounded-[5px] border transition-colors',
          selected ? 'border-white/30 bg-accent text-white shadow-[0_0_12px_rgba(238,127,32,0.8)]' : selectable ? 'border-line-strong bg-black text-transparent' : 'border-line bg-sunken text-transparent',
        )}
      >
        <Check className="size-3" strokeWidth={2.4} />
      </span>

      <div className="min-w-0 pr-7">
        <div className="truncate font-mono text-sm font-semibold tracking-tight text-fg">{p.alias}</div>
        <Mono value={p.providerId} head={8} tail={4} className="text-2xs text-faint" />
      </div>

      <div className={clsx('mt-3 flex min-w-0 items-center gap-1.5 text-xs', matches ? 'text-secondary' : 'text-muted')}>
        <DieGlyph className={clsx('size-4 shrink-0', matches ? 'text-peach/70' : 'text-faint')} />
        <span className="truncate" title={gpuSummary(p)}>
          {p.gpus.length ? p.gpus.map((g) => `${g.count}× ${gpuLabel(g.model)}${g.vramGb ? ` · ${g.vramGb} GB` : ''}`).join(' + ') : 'none listed'}
        </span>
      </div>

      <div className="mt-3 flex items-baseline gap-1" title={`${zecString(p.minPricePerHourZats)} ZEC per hour minimum`}>
        <span className="text-[26px] font-semibold leading-none tracking-[-0.02em] text-zec">{zecString(p.minPricePerHourZats, { maxDecimals: 4 })}</span>
        <span className="text-xs text-faint">ZEC/h</span>
        <span className="section-label ml-auto text-[9px] text-faint">min</span>
      </div>
      {aboveMax && matches && <div className="mt-0.5 text-2xs text-warn">above your max</div>}

      <div className="mt-3 flex flex-wrap items-center gap-1">
        <Badge title="Bond">{bond > 0n ? <>bond <span className="text-zec">{zecString(bond, { maxDecimals: 4 })}</span></> : 'no bond'}</Badge>
        {p.region && <Badge>{p.region}</Badge>}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2.5">
        {p.verified ? (
          <span className="inline-flex items-center gap-1 text-2xs font-medium text-ok" title="Directory signature verified by your daemon">
            <BadgeCheck className="size-3.5" aria-hidden /> Verified
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded border border-bad/40 bg-bad-soft px-1.5 py-0.5 text-2xs font-semibold text-bad" title="Directory signature does NOT verify. Silicr will not send RFQs to this entry.">
            <ShieldAlert className="size-3.5" aria-hidden /> Bad signature
          </span>
        )}
        <span className="text-2xs text-faint tabular-nums">updated {formatAgo(p.updatedAt, now)}</span>
      </div>
    </div>
  );
}
