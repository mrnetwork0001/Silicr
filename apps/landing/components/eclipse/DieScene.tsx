import s from './DieScene.module.css';

/**
 * Silicr's backdrop: a silicon die with a sealed core rising from the bottom edge, its rim lit like
 * a corona, and circuit traces carrying pulses of sealed data in from the screen edges.
 * Drawn in the hero's 1448×1086 reference frame, widened to x ∈ [-600, 2048] so traces reach the
 * edges of wide screens. Pure SVG + CSS; animation stops under prefers-reduced-motion.
 */

const TOP = 640; // the die's top edge (rim apex), two thirds of the way down the frame
const LEFT = 334;
const RIGHT = 1114;
const BEVEL = 26;

type Trace = { d: string; dur: number; delay: number };

function topTrace(pinX: number, busY: number, fromLeft: boolean): string {
  const edge = fromLeft ? -600 : 2048;
  const dir = fromLeft ? 1 : -1;
  // edge → along the bus → 45° bevel → straight down into the pin on the die's top edge
  return `M${edge} ${busY} H${pinX - dir * BEVEL} L${pinX} ${busY + BEVEL} V${TOP}`;
}

function sideTrace(y: number, fromLeft: boolean): string {
  return fromLeft ? `M-600 ${y} H${LEFT}` : `M2048 ${y} H${RIGHT}`;
}

const TRACES: Trace[] = [
  ...[
    [420, 470],
    [480, 520],
    [540, 570],
    [600, 610],
  ].map(([x, y], i) => ({ d: topTrace(x!, y!, true), dur: 4.6 + i * 0.7, delay: i * 1.1 })),
  ...[
    [1028, 470],
    [968, 520],
    [908, 570],
    [848, 610],
  ].map(([x, y], i) => ({ d: topTrace(x!, y!, false), dur: 5.1 + i * 0.6, delay: 0.6 + i * 1.3 })),
  ...[700, 760, 820, 880, 940, 1000].flatMap((y, i) => [
    { d: sideTrace(y, true), dur: 3.8 + (i % 3) * 0.9, delay: 0.3 + i * 0.8 },
    { d: sideTrace(y, false), dur: 4.2 + (i % 2) * 1.1, delay: 1.1 + i * 0.7 },
  ]),
];

const PINS_TOP = [420, 480, 540, 600, 660, 724, 788, 848, 908, 968, 1028];

export function DieScene({ className = '' }: { className?: string }) {
  return (
    <svg className={`${s.scene} ${className}`} viewBox="-600 0 2648 1086" preserveAspectRatio="xMidYMax meet" aria-hidden>
      <defs>
        <pattern id="die-dots" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1" fill="rgba(255,190,140,0.10)" />
        </pattern>
        <pattern id="die-grid" width="38" height="38" patternUnits="userSpaceOnUse">
          <path d="M38 0H0V38" fill="none" stroke="rgba(255,170,110,0.07)" strokeWidth="1" />
        </pattern>
        <linearGradient id="die-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c110a" />
          <stop offset="0.35" stopColor="#0b0705" />
          <stop offset="1" stopColor="#020101" />
        </linearGradient>
        <radialGradient id="die-corona" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ee7f20" stopOpacity="0.55" />
          <stop offset="0.45" stopColor="#ee7f20" stopOpacity="0.16" />
          <stop offset="1" stopColor="#ee7f20" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="die-core" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#f7c69b" stopOpacity="0.9" />
          <stop offset="0.5" stopColor="#ee7f20" stopOpacity="0.35" />
          <stop offset="1" stopColor="#ee7f20" stopOpacity="0" />
        </radialGradient>
        <filter id="die-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <filter id="die-glow-wide" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="22" />
        </filter>
      </defs>

      {/* Board: faint dot field fading upward */}
      <rect x="-600" y="300" width="2648" height="786" fill="url(#die-dots)" className={s.board} />

      <g transform="translate(0 84)">
      {/* Traces: dim copper, with pulses of sealed data running into the die */}
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {TRACES.map((t, i) => (
          <path key={`b${i}`} d={t.d} stroke="rgba(238,127,32,0.16)" strokeWidth="1.6" />
        ))}
        {TRACES.map((t, i) => (
          <path
            key={`p${i}`}
            d={t.d}
            pathLength={1000}
            className={s.pulse}
            style={{ animationDuration: `${t.dur}s`, animationDelay: `${t.delay}s` }}
          />
        ))}
      </g>

      {/* Corona: the die's lit rim */}
      <ellipse cx="724" cy={TOP} rx="640" ry="150" fill="url(#die-corona)" className={s.corona} />

      {/* Pins on the top edge */}
      <g stroke="rgba(247,198,155,0.55)" strokeWidth="3" strokeLinecap="round">
        {PINS_TOP.map((x) => (
          <line key={x} x1={x} y1={TOP - 14} x2={x} y2={TOP - 2} />
        ))}
      </g>

      {/* The die */}
      <rect x={LEFT} y={TOP} width={RIGHT - LEFT} height="560" rx="44" fill="url(#die-body)" />
      <rect x={LEFT} y={TOP} width={RIGHT - LEFT} height="560" rx="44" fill="url(#die-grid)" />
      <rect x={LEFT} y={TOP} width={RIGHT - LEFT} height="560" rx="44" fill="none" stroke="#ee7f20" strokeWidth="10" filter="url(#die-glow-wide)" opacity="0.7" className={s.rim} />
      <rect x={LEFT} y={TOP} width={RIGHT - LEFT} height="560" rx="44" fill="none" stroke="#f7a35c" strokeWidth="2" />

      {/* Sealed core */}
      <circle cx="724" cy="820" r="150" fill="url(#die-core)" className={s.coreGlow} />
      <rect x="634" y="730" width="180" height="180" rx="22" fill="#0a0604" stroke="#f7c69b" strokeWidth="2" />
      <rect x="634" y="730" width="180" height="180" rx="22" fill="none" stroke="#ee7f20" strokeWidth="6" filter="url(#die-glow)" opacity="0.8" />
      <g fill="none" stroke="#f7c69b" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.9">
        <rect x="694" y="812" width="60" height="44" rx="8" />
        <path d="M706 812v-14a18 18 0 0 1 36 0v14" />
      </g>
      </g>
    </svg>
  );
}
