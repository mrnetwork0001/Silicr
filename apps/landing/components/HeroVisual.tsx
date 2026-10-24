import { BadgeCheck, EyeOff, KeyRound, Lock } from '@/components/icons';
import { EXAMPLE, HERO_BIDS, formatZats, formatZec, perInterval } from '@/lib/settlement';

/** Deterministic pseudo-random bytes, so the server HTML and any client render agree. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexLines(seed: number, lines: number, bytes: number): string[] {
  const r = mulberry32(seed);
  return Array.from({ length: lines }, () =>
    Array.from({ length: bytes }, () => Math.floor(r() * 256).toString(16).padStart(2, '0')).join(''),
  );
}

const CIPHER = hexLines(0x51c1, 9, 32);
const ACTIONS = EXAMPLE.rfqActions;

const BID_CLASS = { a: 'bid-a', b: 'bid-b', c: 'bid-c' } as const;

function Row({ k, v, note, strong }: { k: string; v: string; note?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-[13px] text-muted">
        {k}
        {note && <span className="block text-[11.5px] leading-snug text-muted/90">{note}</span>}
      </dt>
      <dd className={`text-right font-mono text-[13px] tabular-nums text-fg ${strong ? 'font-semibold' : ''}`}>{v}</dd>
    </div>
  );
}

function Hidden({ label }: { label: string }) {
  return (
    <li className="hatch flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px] text-muted">
      <EyeOff className="size-3.5 shrink-0" aria-hidden />
      <span>{label}</span>
    </li>
  );
}

/**
 * The same sealed RFQ shown twice: as the public chain sees it, and as the
 * buyer's own terminal sees it after decrypting locally. Illustrative values;
 * the in-app Leak Inspector shows this split from real data.
 */
export function HeroVisual() {
  const ex = EXAMPLE;
  return (
    <figure aria-labelledby="hero-visual-caption" className="relative">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
        {/* --------------------------------------------------------- chain */}
        <div className="flex min-w-0 flex-col">
          <p className="mb-2.5 flex items-center gap-2 text-sm font-medium text-muted">
            <Lock className="size-4 text-zec" aria-hidden />
            What the public chain sees
          </p>
          <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[var(--shadow-pop)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
              <div className="min-w-0">
                <p className="text-[15px] font-semibold">Shielded transaction</p>
                <p className="truncate font-mono text-[12px] text-muted">txid 7f3a9c0e5b…d2e41b · Zcash mainnet</p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-zec/30 bg-zec-soft px-2.5 py-0.5 text-[12px] font-medium text-zec">
                <span className="live-dot size-1.5 rounded-full bg-zec" aria-hidden />
                v6 · Ironwood
              </span>
            </div>
            <dl className="divide-y divide-line px-5">
              <Row k="Transparent inputs / outputs" v="0 / 0" />
              <Row k="Sapling spends / outputs" v="0 / 0" />
              <Row k="Orchard (legacy) actions" v="0" />
              <Row k="Ironwood actions" v={String(ACTIONS)} note={`${ex.bucket} padded outputs + change`} strong />
              <Row k="Fee (public)" v={`${formatZats(ex.rfqFeeZats)} zats`} />
            </dl>
            <ul className="flex flex-wrap gap-1.5 border-t border-line px-5 py-3" aria-label="Hidden from the chain">
              <Hidden label="sender" />
              <Hidden label="recipients" />
              <Hidden label="amounts" />
              <Hidden label={`${ACTIONS} memos, 512 B each`} />
            </ul>
            <div className="relative mt-auto border-t border-line bg-sunken/70">
              <p className="px-5 pt-3 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Note ciphertext, per action</p>
              <div className="cipher-window h-[132px] overflow-hidden px-5" aria-hidden>
                <div className="cipher-track">
                  {[...CIPHER, ...CIPHER].map((line, i) => (
                    <p key={i} className="truncate font-mono text-[12px] leading-[22px] text-faint">
                      <span className="text-muted">{String((i % CIPHER.length) + 1).padStart(2, '0')}</span> {line}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* --------------------------------------------------------- buyer */}
        <div className="flex min-w-0 flex-col">
          <p className="mb-2.5 flex items-center gap-2 text-sm font-medium text-muted">
            <KeyRound className="size-4 text-accent" aria-hidden />
            What you see
          </p>
          <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[var(--shadow-pop)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
              <div className="min-w-0">
                <p className="text-[15px] font-semibold">Your sealed RFQ</p>
                <p className="truncate font-mono text-[12px] text-muted">same txid, decrypted on your machine</p>
              </div>
              <span className="inline-flex items-center rounded-full border border-accent-line bg-accent-soft px-2.5 py-0.5 text-[12px] font-medium text-accent">
                only you
              </span>
            </div>
            <div className="px-5 py-4">
              <p className="font-mono text-[17px] font-medium tracking-tight sm:text-[19px]">
                {ex.gpu} × {ex.count} · {ex.hours} h · max <span className="zec">{formatZec(ex.maxPerHourZats)} ZEC/h</span>
              </p>
              <ul className="mt-3 space-y-1.5 text-[13px] text-muted">
                <li>
                  Sealed to {ex.providersAsked} providers, padded to {ex.bucket} outputs
                </li>
                <li>
                  Bids return to a one-time address <span className="whitespace-nowrap font-mono text-fg">u1qx7m…3k9vz</span>
                </li>
                <li>Signed with a key made for this RFQ only</li>
              </ul>
            </div>
            <div className="border-t border-line px-5 pb-4 pt-3">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Signed bids, ranked locally</p>
                <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                  <span className="live-dot size-1.5 rounded-full bg-accent text-accent" aria-hidden />
                  collecting
                </span>
              </div>
              <ol className="mt-2.5 space-y-1.5">
                {HERO_BIDS.map((b, i) => (
                  <li
                    key={b.alias}
                    className={`${BID_CLASS[b.order]} flex items-center gap-3 rounded-lg border px-3 py-2 ${
                      i === 0 ? 'border-accent-line bg-accent-soft' : 'border-line bg-raised'
                    }`}
                  >
                    <span className="w-4 font-mono text-[12px] text-muted">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{b.alias}</span>
                    <span className="hidden font-mono text-[12px] text-muted sm:inline">
                      {formatZec(perInterval(b.perHourZats, ex.intervalS))} / {ex.intervalMin} min
                    </span>
                    <span className="zec text-[13px]">{formatZec(b.perHourZats)} ZEC/h</span>
                    <BadgeCheck className="size-4 shrink-0 text-ok" aria-label="signature valid" />
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-[12.5px] text-muted">No server ever holds this list. Your client checked every signature.</p>
            </div>
          </div>
        </div>
      </div>
      <figcaption id="hero-visual-caption" className="mt-4 text-center text-[13px] text-muted">
        One RFQ, two views. Illustrative values; the terminal&apos;s Leak Inspector shows this split from real data.
      </figcaption>
    </figure>
  );
}
