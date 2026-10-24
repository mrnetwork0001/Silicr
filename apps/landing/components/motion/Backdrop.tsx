'use client';

import { useEffect, useRef } from 'react';
import s from './Backdrop.module.css';

/**
 * The page backdrop behind every section after the hero: the hero's circuit board, much dimmer.
 * A fine dot grid, sparse orthogonal copper traces with 45° bevels and via pads, a few orange pulses of
 * sealed data running along them, and soft coronas drifting. Fixed under the content, never interactive;
 * three layers move at different speeds as the page scrolls. All motion stops under prefers-reduced-motion.
 */

const W = 1600;
const H = 1200;
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
  const r = rng(0x5111c);
  const out: Trace[] = [];
  for (let t = 0; t < 22; t++) {
    // Most traces enter from the left or right edge, a few start on the board as stubs.
    const side = t % 2 === 0 ? -1 : 1;
    let x = side < 0 ? -20 : W + 20;
    let y = Math.round((60 + r() * (H - 120)) / G) * G;
    let dirX = -side;
    let d = `M${x} ${y}`;
    const segs = 2 + Math.floor(r() * 3);
    for (let k = 0; k < segs; k++) {
      const run = Math.round((80 + r() * 300) / G) * G;
      x += dirX * run;
      d += ` H${x}`;
      if (k === segs - 1) break;
      const dy = (r() < 0.5 ? -1 : 1) * Math.round((40 + r() * 180) / G) * G;
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
    out.push({
      d,
      end: [x, y],
      pulse: t % 3 === 0 ? { dur: 9 + r() * 7, delay: r() * 10 } : undefined,
    });
  }
  return out;
}

const TRACES = makeTraces();

export function Backdrop() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      el.style.setProperty('--p', (window.scrollY / max).toFixed(4));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={ref} className={s.root} aria-hidden>
      <div className={`${s.layer} ${s.dots}`} />
      <div className={`${s.layer} ${s.glows}`}>
        <span className={`${s.glow} ${s.g1}`} />
        <span className={`${s.glow} ${s.g2}`} />
        <span className={`${s.glow} ${s.g3}`} />
      </div>
      <svg className={`${s.layer} ${s.traces}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          {TRACES.map((t, i) => (
            <path key={`t${i}`} d={t.d} stroke="rgba(238,127,32,0.11)" strokeWidth={1.3} />
          ))}
          {TRACES.map((t, i) => (
            <circle key={`v${i}`} cx={t.end[0]} cy={t.end[1]} r={3.2} stroke="rgba(238,127,32,0.16)" strokeWidth={1.2} />
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
