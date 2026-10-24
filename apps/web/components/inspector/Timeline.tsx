'use client';

import clsx from 'clsx';
import { Pause, Play, Radio } from '@/components/icons';
import { useCallback, useEffect, useRef } from 'react';
import type { Party } from '@silicr/api';
import { formatDateTime, formatTime } from '@/lib/format';
import { isTypingTarget } from '@/lib/hooks';
import { atFraction, clampPlayhead, currentStep, fractionOf, MARKER_LABEL, nextStop, playbackSpeed, prevStop, type Marker, type MarkerKind, type Timeline } from '@/lib/timeline';
import { Kbd } from '../ui';

const PARTY_COLOR: Record<Party, string> = {
  chain: 'bg-[#6cb6ff]',
  relay: 'bg-faint',
  provider: 'bg-zec',
  buyer: 'bg-accent',
};

const STEP_STYLE: Record<Exclude<MarkerKind, 'heartbeat' | 'observation'>, string> = {
  rfq: 'size-3 rounded-sm bg-accent',
  bid: 'size-2.5 rotate-45 rounded-[2px] bg-zec',
  accept: 'size-3 rotate-45 rounded-[2px] bg-ok',
  pay: 'size-2.5 rounded-full bg-ok',
  close: 'size-3 rounded-sm bg-fg',
};

export interface TimelineProps {
  timeline: Timeline;
  /** null = live (follows now). */
  playhead: number | null;
  now: number;
  playing: boolean;
  /** Observations visible at the playhead / in total. */
  visible: number;
  total: number;
  onScrub: (at: number | null) => void;
  onPlay: (playing: boolean) => void;
}

export function TimelineScrub({ timeline: t, playhead, now, playing, visible, total, onScrub, onPlay }: TimelineProps) {
  const live = playhead === null;
  const at = live ? t.end : clampPlayhead(t, playhead);
  const frac = fractionOf(t, at);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const step = currentStep(t, at);
  const empty = t.markers.length === 0;

  const seek = useCallback(
    (next: number) => {
      const c = clampPlayhead(t, next);
      onScrub(c >= t.end ? null : c);
    },
    [t, onScrub],
  );

  // Playback at compressed speed: the whole timeline in ~12 s.
  useEffect(() => {
    if (!playing) return;
    const speed = playbackSpeed(t);
    let last = performance.now();
    const id = setInterval(() => {
      const nowPerf = performance.now();
      const dt = nowPerf - last;
      last = nowPerf;
      const cur = playhead === null ? t.end : playhead;
      const next = cur + dt * speed;
      if (next >= t.end) {
        onPlay(false);
        onScrub(null);
      } else onScrub(next);
    }, 50);
    return () => clearInterval(id);
  }, [playing, playhead, t, onPlay, onScrub]);

  // Keyboard: ←/→ step between markers, Shift for finer, Home/End, space to play.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const inControl = !!el && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'row' || el.tagName === 'A');
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          onPlay(false);
          seek(e.shiftKey ? at - (t.end - t.start) / 100 : prevStop(t, at, t.steps.length ? t.steps : t.markers));
          break;
        case 'ArrowRight':
          e.preventDefault();
          onPlay(false);
          seek(e.shiftKey ? at + (t.end - t.start) / 100 : nextStop(t, at, t.steps.length ? t.steps : t.markers));
          break;
        case 'Home':
          e.preventDefault();
          onPlay(false);
          seek(t.start);
          break;
        case 'End':
          e.preventDefault();
          onPlay(false);
          onScrub(null);
          break;
        case ' ':
          if (inControl) return;
          e.preventDefault();
          if (playing) onPlay(false);
          else {
            if (at >= t.end) onScrub(t.start);
            onPlay(true);
          }
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t, at, playing, seek, onPlay, onScrub]);

  const fromEvent = (e: React.PointerEvent) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = (e.clientX - r.left) / Math.max(1, r.width);
    onPlay(false);
    seek(atFraction(t, f));
  };

  const span = Math.max(1, t.end - t.start);
  const label = live ? (t.closed ? 'End' : 'Live') : formatTime(at);
  const stepText = step.marker ? `${step.marker.label}` : t.markers.length ? 'Before the first event' : 'No events yet';

  return (
    <div className="shrink-0 rounded-lg border border-line bg-panel px-3 py-2" aria-label="Timeline scrub">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
        <button
          type="button"
          onClick={() => {
            if (playing) onPlay(false);
            else {
              if (at >= t.end) onScrub(t.start);
              onPlay(true);
            }
          }}
          disabled={empty}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2 text-xs font-medium text-fg hover:bg-hover disabled:opacity-50"
          aria-label={playing ? 'Pause playback' : 'Play the timeline at compressed speed'}
          title="Space"
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          onClick={() => {
            onPlay(false);
            onScrub(null);
          }}
          className={clsx(
            'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium',
            live ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong text-fg hover:bg-hover',
          )}
          aria-pressed={live}
          title="End"
        >
          <Radio className={clsx('size-3.5', live && !t.closed && 'animate-pulse')} aria-hidden />
          {t.closed ? 'End' : 'Live'}
        </button>
        <span className="font-mono tabular-nums text-fg" aria-live="polite">
          {label}
        </span>
        <span className="min-w-0 truncate">
          {step.index >= 0 && t.steps.length ? (
            <>
              <span className="text-fg">Step {step.index + 1}/{t.steps.length}</span> · {stepText}
            </>
          ) : (
            stepText
          )}
        </span>
        <span className="tabular-nums">
          {visible}/{total} observations
        </span>
        <span className="ml-auto hidden items-center gap-1 lg:flex">
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> step · <Kbd>Home</Kbd>
          <Kbd>End</Kbd> · <Kbd>Space</Kbd> play · drag the playhead
        </span>
      </div>

      <div className="mt-1.5 flex items-stretch gap-2">
        <div className="relative w-[78px] shrink-0 text-[9.5px] uppercase tracking-wider text-faint" aria-hidden>
          <span className="absolute top-[12px]">steps</span>
          <span className="absolute top-[28px]">heartbeats</span>
          <span className="absolute top-[40px]">observations</span>
        </div>
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Playhead"
          aria-valuemin={t.start}
          aria-valuemax={t.end}
          aria-valuenow={at}
          aria-valuetext={`${formatDateTime(at)}${live ? ' (live)' : ''}`}
          onPointerDown={(e) => {
            dragging.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            fromEvent(e);
          }}
          onPointerMove={(e) => {
            if (dragging.current) fromEvent(e);
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          className="relative h-[52px] min-w-0 flex-1 cursor-ew-resize select-none touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {/* Lanes */}
          <div className="absolute inset-x-0 top-[18px] h-px bg-line-strong" aria-hidden />
          <div className="absolute inset-x-0 top-[34px] h-px bg-line" aria-hidden />
          <div className="absolute inset-x-0 top-[46px] h-px bg-line" aria-hidden />
          {/* Elapsed */}
          <div className="absolute left-0 top-[17px] h-[3px] bg-accent/60" style={{ width: `${frac * 100}%` }} aria-hidden />

          {t.markers.map((m) => {
            const x = `${fractionOf(t, m.at) * 100}%`;
            const past = m.at <= at;
            if (m.kind === 'heartbeat') {
              return <span key={m.key} title={`${formatTime(m.at)} · ${m.label}`} className={clsx('absolute top-[29px] h-[10px] w-px', past ? 'bg-muted' : 'bg-line-strong')} style={{ left: x }} />;
            }
            if (m.kind === 'observation') {
              return (
                <span
                  key={m.key}
                  title={`${formatTime(m.at)} · ${m.label}`}
                  className={clsx('absolute top-[43px] size-[7px] -translate-x-1/2 rounded-full', PARTY_COLOR[m.party], !past && 'opacity-25')}
                  style={{ left: x }}
                />
              );
            }
            return <StepGlyph key={m.key} m={m} x={x} past={past} />;
          })}

          {/* Playhead */}
          <div className="absolute bottom-0 top-0 w-px -translate-x-1/2 bg-accent" style={{ left: `${frac * 100}%` }} aria-hidden>
            <span className="absolute -top-0.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-accent bg-panel shadow-sm" />
          </div>
          <span className="sr-only">{`${Math.round(((at - t.start) / span) * 100)}% of the timeline`}</span>
        </div>
      </div>
      <div className="ml-[86px] flex justify-between font-mono text-[10px] text-faint" aria-hidden>
        <span>{formatTime(t.start)}</span>
        <span>{t.closed ? formatTime(t.end) : `now · ${formatTime(now)}`}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-faint" aria-hidden>
        {(Object.keys(STEP_STYLE) as (keyof typeof STEP_STYLE)[]).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className={clsx('inline-block', STEP_STYLE[k], 'scale-75')} />
            {MARKER_LABEL[k]}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-px bg-muted" /> heartbeat
        </span>
        {(['chain', 'relay', 'provider', 'buyer'] as Party[]).map((p) => (
          <span key={p} className="flex items-center gap-1">
            <span className={clsx('inline-block size-[7px] rounded-full', PARTY_COLOR[p])} /> {p} observation
          </span>
        ))}
      </div>
    </div>
  );
}

function StepGlyph({ m, x, past }: { m: Marker; x: string; past: boolean }) {
  const style = STEP_STYLE[m.kind as keyof typeof STEP_STYLE] ?? STEP_STYLE.pay;
  return (
    <span
      title={`${formatTime(m.at)} · ${m.label}`}
      className={clsx('absolute top-[18px] -translate-x-1/2 -translate-y-1/2', style, !past && 'opacity-30')}
      style={{ left: x }}
    />
  );
}
