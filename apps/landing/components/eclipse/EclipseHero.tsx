'use client';

import { Inter, Poppins } from 'next/font/google';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MobileDrawer } from '../MobileDrawer';
import { NAV } from '../SiteHeader';
import { APP_URL } from '@/lib/config';
import { DieScene } from './DieScene';
import s from './EclipseHero.module.css';

// Self-hosted at build time by next/font: the browser never contacts Google.
const inter = Inter({ subsets: ['latin'], variable: '--font-eclipse-inter', display: 'swap' });
const poppins = Poppins({ subsets: ['latin'], weight: '600', variable: '--font-eclipse-poppins', display: 'swap' });

const LINKS = [
  { label: 'How it works', href: '#how' },
  { label: 'Leak Inspector', href: '#leaks' },
  { label: 'Settlement', href: '#settlement' },
  { label: 'FAQ', href: '#faq' },
];

/** What Silicr is made of, not partners: there are no endorsements to show. */
const STRIP = [
  { name: 'Sealed RFQs', icon: 'seal' },
  { name: 'Signed bids', icon: 'sign' },
  { name: 'Shielded pay', icon: 'shield' },
  { name: 'Leak Inspector', icon: 'eye' },
  { name: 'Agent-ready', icon: 'agent' },
] as const;

function StripIcon({ kind }: { kind: (typeof STRIP)[number]['icon'] }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <svg viewBox="0 0 24 24" className={s.stripIcon} aria-hidden>
      {kind === 'seal' && (
        <>
          <rect x="4" y="10" width="16" height="10" rx="2.5" {...p} />
          <path d="M8 10V7.5a4 4 0 0 1 8 0V10" {...p} />
        </>
      )}
      {kind === 'sign' && (
        <>
          <path d="M4 18c3-1 4-6 6-6s1 4 3 4 2-3 4-3 2 2 3 2" {...p} />
          <path d="M4 21h16" {...p} />
        </>
      )}
      {kind === 'shield' && <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" {...p} />}
      {kind === 'eye' && (
        <>
          <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" {...p} />
          <circle cx="12" cy="12" r="3" {...p} />
        </>
      )}
      {kind === 'agent' && (
        <>
          <rect x="5" y="7" width="14" height="11" rx="3" {...p} />
          <path d="M12 3.5V7M9.5 12h.01M14.5 12h.01M9 15.5h6" {...p} />
        </>
      )}
    </svg>
  );
}

/** Silicr's mark: a die with a sealed core, drawn as a white stroke. */
function Mark() {
  return (
    <svg viewBox="0 0 24 24" className={s.mark} aria-hidden>
      <rect x="4.5" y="4.5" width="15" height="15" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="9" y="9" width="6" height="6" rx="1.4" fill="currentColor" />
      <path
        d="M8 2v2.5M12 2v2.5M16 2v2.5M8 19.5V22M12 19.5V22M16 19.5V22M2 8h2.5M2 12h2.5M2 16h2.5M19.5 8H22M19.5 12H22M19.5 16H22"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The drawer lists every section, like the sticky header (the hero's inline nav keeps its four). */
const DRAWER_LINKS = NAV.map((n) => ({ label: n.label, href: `#${n.id}` }));

const WORDS = ['GPU', 'H100', 'A100', 'cluster'];

export function EclipseHero() {
  const scene = useRef<HTMLDivElement>(null);
  const [word, setWord] = useState(0);
  // Cycle the rented thing every 2.6 s; stays on "GPU" under reduced motion.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => setWord((w) => (w + 1) % WORDS.length), 2600);
    return () => window.clearInterval(id);
  }, []);
  // Gentle mouse parallax on the backdrop; off under reduced motion and on touch screens.
  useEffect(() => {
    const el = scene.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce), (pointer: coarse)').matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const x = (e.clientX / window.innerWidth - 0.5) * 2;
        const y = (e.clientY / window.innerHeight - 0.5) * 2;
        el.style.setProperty('--px', `${(-x * 10).toFixed(1)}px`);
        el.style.setProperty('--py', `${(-y * 6).toFixed(1)}px`);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);
  const [menu, setMenu] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);

  const strip = (
    <div className={s.marquee}>
      {[0, 1].map((copy) => (
        <ul key={copy} className={s.track} aria-hidden={copy === 1 || undefined}>
          {STRIP.map((i) => (
            <li key={i.name} className={s.stripItem}>
              <StripIcon kind={i.icon} />
              <span>{i.name}</span>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );

  return (
    <section className={`${s.hero} ${inter.variable} ${poppins.variable}`} aria-labelledby="eclipse-title">
      <div ref={scene} className={s.scene} aria-hidden>
        <DieScene className={s.die} />
      </div>

      <header className={s.nav}>
        <a href="/" className={`${s.logo} ${s.in1}`} aria-label="Silicr home">
          <Mark />
          <span>Silicr</span>
        </a>
        <nav className={`${s.links} ${s.in1}`} aria-label="Sections">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <button
          type="button"
          data-burger
          className={s.menuBtn}
          data-open={menu || undefined}
          aria-expanded={menu}
          aria-controls="eclipse-menu"
          aria-label={menu ? 'Close menu' : 'Open menu'}
          onClick={() => setMenu((m) => !m)}
        >
          <span />
          <span />
        </button>
        <MobileDrawer id="eclipse-menu" open={menu} onClose={closeMenu} links={DRAWER_LINKS} />
      </header>

      <div className={s.copy}>
        <p className={`${s.badge} ${s.in2}`}>
          <span className={s.dot} aria-hidden />
          Built for ZECATHON 2026 · Private Markets
        </p>
        <h1 id="eclipse-title" className={s.title}>
          {/* Screen readers get the one full sentence; the animated words are presentation only. */}
          <span className={s.srOnly}>Rent a GPU without telling the world</span>
          <span className={s.in3} aria-hidden>
            Rent a{' '}
            <span className={s.rotor}>
              <span key={word} className={s.rotorWord}>
                {WORDS[word]}
              </span>
            </span>{' '}
            Without{' '}
          </span>
          <span className={`${s.in4} ${s.glint}`} aria-hidden>
            Telling the World
          </span>
        </h1>
        <p className={`${s.sub} ${s.in5}`}>
          Sealed requests, sealed bids and pay-per-interval in shielded ZEC.
          <br className={s.brDesktop} /> No server in the middle ever reads your order, and you can prove it.
        </p>
        <div className={s.ctas}>
          <a href={APP_URL} className={`${s.primary} ${s.sheen} ${s.in6}`}>
            Launch app
          </a>
          <a href="#how" className={`${s.outline} ${s.in7}`}>
            <span>How it works</span>
          </a>
        </div>
        <div className={`${s.strip} ${s.in8}`}>{strip}</div>
      </div>
    </section>
  );
}
