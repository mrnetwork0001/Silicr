'use client';

import s from './Backdrop.module.css';

/**
 * The terminal's app-wide backdrop: a fine dot grid, sparse copper traces with 45° bevels and via pads,
 * a few slow orange pulses of sealed data, and two soft drifting coronas. Adapted from the landing
 * page's backdrop (not imported across apps) and kept much dimmer: this is a tool, so tables and logs
 * stay readable, and the centre column is masked down further. Fixed, never interactive, transforms and
 * opacity only; all motion stops under prefers-reduced-motion.
 */

const W = 1600;
const H = 1000;
const G = 40; // routing grid
const B = 22; // bevel

function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

type Trace = { d: string; end: [number, number]; pulse?: { dur: number; delay: number } };

function makeTraces(): Trace[] {
  const r = rng(0x5111c7);
  const out: Trace[] = [];
  for (let t = 0; t < 16; t++) {
    const side = t % 2 === 0 ? -1 : 1;
    let x = side < 0 ? -20 : W + 20;
    let y = Math.round((60 + r() * (H - 120)) / G) * G;
    const dirX = -side;
    let d = `M${x} ${y}`;
    const segs = 2 + Math.floor(r() * 3);
    for (let k = 0; k < segs; k++) {
      const run = Math.round((80 + r() * 260) / G) * G;
      x += dirX * run;
      d += ` H${x}`;
      if (k === segs - 1) break;
      const dy = (r() < 0.5 ? -1 : 1) * Math.round((40 + r() * 160) / G) * G;
      const sy = Math.sign(dy);
      x += dirX * B;
      y += sy * B;
      d += ` L${x} ${y}`;
      y += dy - sy * 2 * B;
      d += ` V${y}`;
      x += dirX * B;
      y += sy * B;
      d += ` L${x} ${y}`;
    }
    out.push({ d, end: [x, y], pulse: t % 4 === 1 ? { dur: 14 + r() * 8, delay: r() * 12 } : undefined });
  }
  return out;
}

const TRACES = makeTraces();

export function Backdrop() {
  return (
    <div className={s.root} aria-hidden>
      <div className={s.dots} />
      <span className={`${s.glow} ${s.g1}`} />
      <span className={`${s.glow} ${s.g2}`} />
      <svg className={s.traces} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          {TRACES.map((t, i) => (
            <path key={`t${i}`} d={t.d} stroke="rgba(238,127,32,0.09)" strokeWidth={1.2} />
          ))}
          {TRACES.map((t, i) => (
            <circle key={`v${i}`} cx={t.end[0]} cy={t.end[1]} r={3} stroke="rgba(238,127,32,0.13)" strokeWidth={1.1} />
          ))}
          {TRACES.map((t, i) =>
            t.pulse ? (
              <path
                key={`p${i}`}
                d={t.d}
                pathLength={1000}
                className={s.pulse}
                style={{ animationDuration: `${t.pulse.dur.toFixed(2)}s`, animationDelay: `${t.pulse.delay.toFixed(2)}s` }}
              />
            ) : null,
          )}
        </g>
      </svg>
      <div className={s.vignette} />
    </div>
  );
}
