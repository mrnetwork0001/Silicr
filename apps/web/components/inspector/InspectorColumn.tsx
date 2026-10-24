'use client';

import clsx from 'clsx';
import { ChevronDown, Eye, Info, Lock } from '@/components/icons';
import { memo, useState } from 'react';
import type { FactKey } from '@/lib/contract-ext';
import { SELF_FACTS } from '@/lib/facts';
import { compactValue, formatTime, looksLikeAddress, looksLikeHex } from '@/lib/format';
import { anyTokenMatch, type Column, type InspField, type ObsGroup } from '@/lib/inspector';

export type Spot = { kind: 'fact'; fact: FactKey } | { kind: 'tokens'; tokens: string[]; label: string };

export function fieldMatchesSpot(f: InspField, spot: Spot): boolean {
  if (spot.kind === 'fact') return f.facts.includes(spot.fact);
  return anyTokenMatch(f.tokens, spot.tokens);
}

export function groupMatchesSpot(g: ObsGroup, spot: Spot): boolean {
  return g.items.some((it) => it.fields.some((f) => fieldMatchesSpot(f, spot)));
}

function spotsEqual(a: Spot | null, b: Spot | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'fact' && b.kind === 'fact') return a.fact === b.fact;
  if (a.kind === 'tokens' && b.kind === 'tokens') return a.tokens.join('|') === b.tokens.join('|');
  return false;
}

type FieldState = 'knows' | 'readable' | 'sealed';

function stateOf(f: InspField): FieldState {
  if (!f.field.readable) return 'sealed';
  return f.field.sensitive ? 'knows' : 'readable';
}

function FieldValue({ value, state }: { value: string; state: FieldState }) {
  const v = value.trim();
  const machine = looksLikeHex(v) || looksLikeAddress(v);
  if (machine) {
    return (
      <span className={clsx('block truncate font-mono text-[11.5px] tracking-tight', state === 'sealed' && 'text-faint')} title={v}>
        {compactValue(v)}
      </span>
    );
  }
  return (
    <span className="line-clamp-2 break-words" title={v.length > 60 ? v : undefined}>
      {v}
    </span>
  );
}

const FieldRow = memo(function FieldRow({
  f,
  spot,
  onHover,
  onPin,
}: {
  f: InspField;
  spot: Spot | null;
  onHover: (s: Spot | null) => void;
  onPin: (s: Spot | null) => void;
}) {
  const st = stateOf(f);
  const on = spot ? fieldMatchesSpot(f, spot) : false;
  const ownSpot: Spot | null = f.tokens.length
    ? { kind: 'tokens', tokens: f.tokens, label: f.field.label }
    : f.facts[0]
      ? { kind: 'fact', fact: f.facts[0] }
      : null;
  return (
    <div
      onMouseEnter={() => onHover(ownSpot)}
      onMouseLeave={() => onHover(null)}
      onClick={() => ownSpot && onPin(ownSpot)}
      title={ownSpot ? 'Click to trace this value across all parties' : undefined}
      className={clsx(
        'grid grid-cols-[minmax(72px,36%)_minmax(0,1fr)_14px] items-start gap-2 px-2.5 py-[5px] text-xs transition-[opacity,background-color] duration-150',
        ownSpot && 'cursor-pointer',
        st === 'knows' && 'bg-knows-soft shadow-[inset_3px_0_0_var(--knows),0_0_14px_rgba(238,127,32,0.08)]',
        st === 'sealed' && 'hatch bg-black',
        on && 'relative z-[1] rounded-[3px] outline outline-2 -outline-offset-1 outline-accent',
        spot && !on && 'opacity-30',
      )}
    >
      <dt className={clsx('truncate pt-px', st === 'knows' ? 'font-medium text-fg' : 'text-muted')} title={f.field.label}>
        {f.field.label}
      </dt>
      <dd className={clsx('min-w-0', st === 'knows' ? 'font-semibold text-fg' : st === 'sealed' ? 'text-faint' : 'text-fg')}>
        <FieldValue value={f.field.value} state={st} />
      </dd>
      <span className="flex justify-end pt-0.5" aria-hidden>
        {st === 'knows' ? <Eye className="size-3.5 text-peach" /> : st === 'sealed' ? <Lock className="size-3 text-faint" /> : null}
      </span>
      <span className="sr-only">{st === 'knows' ? '(this party knows this)' : st === 'sealed' ? '(ciphertext or withheld)' : ''}</span>
    </div>
  );
});

function GroupCard({
  g,
  spot,
  onHover,
  onPin,
}: {
  g: ObsGroup;
  spot: Spot | null;
  onHover: (s: Spot | null) => void;
  onPin: (s: Spot | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const o = g.latest.obs;
  const fields = g.latest.fields;
  const anyOn = spot ? fields.some((f) => fieldMatchesSpot(f, spot)) : false;
  const count = g.items.length;
  return (
    <article
      className={clsx(
        'animate-in overflow-hidden rounded-md border bg-panel transition-opacity duration-150',
        anyOn ? 'border-accent-line' : 'border-line',
        spot && !anyOn && 'opacity-35',
      )}
    >
      <header className="flex items-center gap-2 px-2.5 pt-2">
        <time className="font-mono text-[11px] tabular-nums text-faint">{formatTime(o.at)}</time>
        <span className="truncate rounded bg-sunken px-1 py-px font-mono text-[10px] text-muted">{o.event}</span>
        {g.latest.badge && (
          <span
            className={clsx(
              'shrink-0 rounded border px-1 py-px text-[10px] font-medium',
              g.latest.badge.tone === 'ok' && 'border-ok/30 bg-ok-soft text-ok',
              g.latest.badge.tone === 'warn' && 'border-warn/30 bg-warn-soft text-warn',
              g.latest.badge.tone === 'neutral' && 'border-line-strong text-muted',
            )}
            title="What this terminal's copy of the public view is based on"
          >
            {g.latest.badge.label}
          </span>
        )}
        {count > 1 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded border border-line px-1.5 py-px text-[11px] font-medium tabular-nums text-muted hover:bg-hover hover:text-fg"
            title={open ? 'Hide earlier ones' : `Show all ${count}`}
          >
            ×{count}
            <ChevronDown className={clsx('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        )}
      </header>
      <p className="px-2.5 pb-2 pt-0.5 text-[12.5px] font-medium leading-snug text-fg">{o.summary}</p>
      <dl className="border-t border-line py-0.5">
        {fields.map((f) => (
          <FieldRow key={f.key} f={f} spot={spot} onHover={onHover} onPin={onPin} />
        ))}
      </dl>
      {open && count > 1 && (
        <ol className="max-h-48 overflow-y-auto border-t border-line bg-sunken/50 py-1 thin-scroll">
          {g.items.slice(1).map((it) => (
            <li key={it.obs.id} className="flex gap-2 px-2.5 py-0.5 text-[11px]">
              <time className="shrink-0 font-mono tabular-nums text-faint">{formatTime(it.obs.at)}</time>
              <span className="truncate text-muted" title={it.obs.summary}>
                {it.obs.summary}
              </span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

export function InspectorColumn({
  column,
  spot,
  pin,
  pinLabel,
  onHover,
  onPin,
  className,
}: {
  column: Column;
  spot: Spot | null;
  /** A pinned spot filters the column to the observations that carry it. */
  pin: Spot | null;
  pinLabel: string;
  onHover: (s: Spot | null) => void;
  onPin: (s: Spot | null) => void;
  className?: string;
}) {
  const groups = pin ? column.groups.filter((g) => groupMatchesSpot(g, pin)) : column.groups;
  const knowsBySelf = pin?.kind === 'fact' && !!SELF_FACTS[column.party]?.includes(pin.fact);
  const togglePin = (s: Spot | null) => onPin(spotsEqual(s, pin) ? null : s);
  return (
    <section className={clsx('flex min-h-0 min-w-0 flex-col', className)} aria-label={`${column.party} observations`}>
      <div className="mb-2 shrink-0 space-y-1 px-0.5">
        <div className="flex items-center justify-between gap-2 text-[11px] text-faint">
          <span className="tabular-nums">
            {column.available ? `${column.observations.length} observation${column.observations.length === 1 ? '' : 's'}` : 'not available'}
          </span>
          <span className="truncate font-mono" title={`Source: ${column.source}`}>
            {column.source}
          </span>
        </div>
        {column.note && <p className="text-[11.5px] leading-snug text-muted">{column.note}</p>}
        {column.error && <p className="text-[11.5px] text-bad">Couldn&apos;t refresh: {column.error}</p>}
      </div>
      <div className="thin-scroll min-h-0 flex-1 space-y-2 overflow-y-auto pb-2 pr-1">
        {!column.available ? (
          <div className="hatch flex flex-col gap-2 rounded-md border border-dashed border-line-strong p-3 text-xs leading-relaxed text-muted">
            <Info className="size-4 text-faint" aria-hidden />
            {column.reason}
          </div>
        ) : column.groups.length === 0 ? (
          <div className="rounded-md border border-dashed border-line p-3 text-xs text-muted">{column.emptyText}</div>
        ) : (
          <>
            {pin && (
              <div
                className={clsx(
                  'rounded-md border px-2.5 py-2 text-xs',
                  groups.length || knowsBySelf ? 'border-accent-line bg-accent-soft text-fg' : 'hatch border-line-strong text-fg',
                )}
              >
                {groups.length ? (
                  <>
                    <span className="font-semibold">{groups.length}</span> of {column.groups.length} carry {pinLabel}.
                  </>
                ) : knowsBySelf ? (
                  <>
                    None of its observations carry {pinLabel}: it knows it by definition, because it is the {column.party}.
                  </>
                ) : (
                  <>
                    <span className="font-semibold">Nothing</span> this party holds carries {pinLabel}.
                  </>
                )}{' '}
                <button type="button" className="text-accent hover:underline" onClick={() => onPin(null)}>
                  Show all
                </button>
              </div>
            )}
            {groups.map((g) => (
              <GroupCard key={g.key} g={g} spot={spot} onHover={onHover} onPin={togglePin} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
