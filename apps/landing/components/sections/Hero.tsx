import { ArrowDown, ArrowUpRight, CodeXml, PlayCircle } from '@/components/icons';
import { APP_URL, DEMO_VIDEO_URL, REPO_URL } from '@/lib/config';
import { formatZec, zip317Fee } from '@/lib/settlement';
import { HeroVisual } from '../HeroVisual';

const GLANCE: [string, string][] = [
  ['What is traded', 'GPU time'],
  ['Chain', 'Zcash mainnet or testnet, shielded only'],
  ['Matching', 'In your client. No server.'],
  ['Settlement', 'Per interval, in shielded ZEC'],
  ['Fee per payment', `${formatZec(zip317Fee(2))} ZEC (ZIP 317)`],
  ['Status', 'Hackathon prototype, unaudited'],
];

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden">
      <div
        className="dot-grid pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-60 [mask-image:linear-gradient(to_bottom,#000,transparent)]"
        aria-hidden
      />
      <div className="relative mx-auto max-w-[1200px] px-4 pb-20 pt-12 sm:px-6 sm:pb-24 sm:pt-16">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-end">
          <div>
            <p className="inline-flex items-center rounded-full border border-line-strong bg-panel px-3 py-1 text-[13px] font-medium text-muted">
              Built for ZECATHON 2026 · Private Markets
            </p>
            <h1
              id="hero-title"
              className="mt-6 max-w-[15ch] text-balance text-[2.5rem] font-semibold leading-[1.02] tracking-[-0.04em] min-[400px]:text-[2.75rem] sm:text-[4rem] lg:text-[4.4rem]"
            >
              Rent a GPU without telling the world.
            </h1>
            <p className="mt-6 max-w-[42rem] text-pretty text-[18px] leading-relaxed text-muted sm:text-[20px]">
              Silicr is a private GPU-compute market on Zcash. Requests and bids travel sealed inside shielded transactions,
              you pay per interval in shielded ZEC, and there is no server in the middle reading your order.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href={APP_URL}
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-accent px-5 text-[16px] font-medium text-accent-fg shadow-[var(--shadow-pop)] transition-colors hover:bg-accent-hover"
              >
                Launch app
                <ArrowUpRight className="size-[18px]" aria-hidden />
              </a>
              <a
                href="#how"
                className="inline-flex h-12 items-center gap-2 rounded-xl border border-line-strong bg-panel px-5 text-[16px] font-medium text-fg transition-colors hover:bg-hover"
              >
                How it works
                <ArrowDown className="size-[18px] text-muted" aria-hidden />
              </a>
              {DEMO_VIDEO_URL && (
                <a
                  href={DEMO_VIDEO_URL}
                  className="inline-flex h-12 items-center gap-2 rounded-xl px-3 text-[15px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  <PlayCircle className="size-[18px]" aria-hidden />
                  Watch the demo
                </a>
              )}
              {REPO_URL && (
                <a
                  href={REPO_URL}
                  className="inline-flex h-12 items-center gap-2 rounded-xl px-3 text-[15px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  <CodeXml className="size-[18px]" aria-hidden />
                  Source
                </a>
              )}
            </div>

            <p className="mt-5 max-w-[44rem] text-[14.5px] leading-relaxed text-muted">
              The terminal runs on your machine, next to your Silicr daemons.{' '}
              <code className="code-inline text-fg">pnpm silicr demo --run</code> starts a zero-setup demo on a simulated
              chain; with no daemons running, the terminal plays a scripted replay labelled{' '}
              <span className="whitespace-nowrap font-mono text-[12.5px] font-semibold tracking-wide text-mock">MOCK DATA</span>.{' '}
              <span className="text-fg">
                Runs on Zcash mainnet or testnet through its own light wallet; the demo runs on a simulated chain. Unaudited
                hackathon software: keep balances small.
              </span>
            </p>
          </div>

          <aside aria-label="At a glance" className="hidden rounded-2xl border border-line bg-panel/90 p-5 lg:block">
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">At a glance</p>
            <dl className="mt-3 divide-y divide-line">
              {GLANCE.map(([k, v]) => (
                <div key={k} className="py-2.5">
                  <dt className="text-[12px] text-muted">{k}</dt>
                  <dd className="mt-0.5 text-[14px] font-medium text-fg">{v}</dd>
                </div>
              ))}
            </dl>
          </aside>
        </div>

        <div className="mt-12 sm:mt-14">
          <HeroVisual />
        </div>
      </div>
    </section>
  );
}
