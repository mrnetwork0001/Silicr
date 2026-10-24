'use client';

import clsx from 'clsx';
import { Activity } from '@/components/icons';
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { HeartbeatDto } from '@silicr/api';
import { formatAgo, formatInt, formatTime } from '@/lib/format';
import { Badge, Empty, Mono, Panel } from '../ui';

const W = 600;
const H = 64;
const PAD_X = 6;
const PAD_Y = 8;

/**
 * Progress sparkline from signed heartbeats: steps over time. Single series, so
 * no legend; the endpoint is labelled and a crosshair snaps to the nearest beat.
 */
export function Heartbeats({ heartbeats, now, running, withheld }: { heartbeats: HeartbeatDto[]; now: number; running: boolean; withheld?: boolean }) {
  const pts = useMemo(() => [...heartbeats].sort((a, b) => a.at - b.at), [heartbeats]);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gradId = useId();
  const last = pts[pts.length - 1];

  const geo = useMemo(() => {
    if (pts.length === 0) return null;
    const t0 = pts[0]!.at;
    const t1 = Math.max(pts[pts.length - 1]!.at, t0 + 1);
    const maxStep = Math.max(1, ...pts.map((p) => p.step));
    const x = (t: number) => PAD_X + ((t - t0) / (t1 - t0)) * (W - PAD_X * 2);
    const y = (s: number) => H - PAD_Y - (s / maxStep) * (H - PAD_Y * 2);
    const xy = pts.map((p) => [x(p.at), y(p.step)] as const);
    const line = xy.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    const area = `${line} L${xy[xy.length - 1]![0].toFixed(1)},${H - PAD_Y} L${xy[0]![0].toFixed(1)},${H - PAD_Y} Z`;
    return { xy, line, area, maxStep };
  }, [pts]);

  const stale = running && last ? now - last.at > 20_000 : false;
  const shown = hover !== null ? pts[hover] : last;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!geo || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < geo.xy.length; i++) if (Math.abs(geo.xy[i]![0] - px) < Math.abs(geo.xy[best]![0] - px)) best = i;
    setHover(best);
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!pts.length) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cur = hover ?? pts.length - 1;
      setHover(Math.max(0, Math.min(pts.length - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1))));
    }
  };

  return (
    <Panel
      title="Heartbeats"
      subtitle="Signed progress, not proof of correct computation"
      actions={
        last ? (
          <span className="flex items-center gap-1.5">
            {withheld && running && <Badge tone="warn">withheld (demo fault)</Badge>}
            <Badge tone={stale ? 'bad' : last.status === 'paused' ? 'warn' : last.status === 'failed' ? 'bad' : running ? 'ok' : 'neutral'}>
              {stale ? 'stale' : !running && (last.status === 'running' || last.status === 'starting') ? 'ended' : last.status}
            </Badge>
          </span>
        ) : null
      }
    >
      {!geo || !last ? (
        <Empty icon={<Activity className="size-6" />} title="No heartbeats yet">
          They start once the provider has fetched and started the job.
        </Empty>
      ) : (
        <div className="space-y-2 p-4">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-lg font-semibold text-fg">step {formatInt(shown?.step ?? 0)}</span>
              <span className={clsx('shrink-0 text-xs tabular-nums', stale ? 'text-bad' : 'text-faint')}>
                {stale ? `no heartbeat for ${formatAgo(last.at, now).replace(' ago', '')}` : `last ${formatAgo(last.at, now)}`}
              </span>
            </div>
            <div className="truncate text-xs text-muted" title={shown?.note}>
              heartbeat #{shown?.seq} · {formatTime(shown?.at)} · {shown?.status} · interval {shown?.servingSeq}
              {shown?.note ? ` · ${shown.note}` : ''}
            </div>
          </div>
          <div className="relative h-16 w-full">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="h-16 w-full cursor-crosshair overflow-visible outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-accent/40"
              role="img"
              aria-label={`Job progress: step ${last.step} at heartbeat ${last.seq}. Use arrow keys to read earlier heartbeats.`}
              tabIndex={0}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              onKeyDown={onKey}
              onBlur={() => setHover(null)}
            >
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <line x1={PAD_X} x2={W - PAD_X} y1={H - PAD_Y} y2={H - PAD_Y} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <path d={geo.area} fill={`url(#${gradId})`} />
              <path d={geo.line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              {hover !== null && geo.xy[hover] && (
                <line x1={geo.xy[hover]![0]} x2={geo.xy[hover]![0]} y1={PAD_Y / 2} y2={H - PAD_Y} stroke="var(--line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              )}
            </svg>
            {/* End dot and hover dot as HTML so they stay round under preserveAspectRatio="none". */}
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {pts.map((p, i) =>
                p.status === 'paused' && geo.xy[i] ? (
                  <span
                    key={`p${p.seq}`}
                    className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-warn"
                    style={{ left: `${(geo.xy[i]![0] / W) * 100}%`, top: `${(geo.xy[i]![1] / H) * 100}%` }}
                  />
                ) : null,
              )}
              {[hover ?? pts.length - 1].map((i) => {
                const xy = geo.xy[i];
                if (!xy) return null;
                return (
                  <span
                    key={i}
                    className={clsx('absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel', pts[i]?.status === 'paused' ? 'bg-warn' : 'bg-accent')}
                    style={{ left: `${(xy[0] / W) * 100}%`, top: `${(xy[1] / H) * 100}%` }}
                  />
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1 text-2xs text-faint">
            <span>
              {pts.length} beats · max step {formatInt(geo.maxStep)}
            </span>
            <span className="flex items-center gap-1">
              checkpoint <Mono value={shown?.checkpointDigest ?? ''} head={8} tail={4} className="text-muted" />
            </span>
          </div>
        </div>
      )}
    </Panel>
  );
}
