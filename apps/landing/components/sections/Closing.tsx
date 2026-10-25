import { DieScene } from '@/components/eclipse/DieScene';
import { ArrowUpRight, FileText } from '@/components/icons';
import { APP_URL, DEMO_VIDEO_URL, MAINNET_DEMO_URL, REPO_URL, repoFileUrl } from '@/lib/config';
import { Wordmark } from '../Logo';
import { Reveal } from '../motion/Reveal';

export function FinalCta() {
  const threatModel = repoFileUrl('THREAT_MODEL.md');
  return (
    <Reveal id="launch" aria-labelledby="launch-title" className="relative">
      <div className="mx-auto max-w-[1410px] px-4 py-20 sm:py-28">
        <div className="relative isolate overflow-hidden rounded-[28px] border border-line bg-black px-6 pb-40 pt-14 text-center sm:px-12 sm:pb-64 sm:pt-20">
          {/* The hero's die, once more, rising from the bottom edge. */}
          <DieScene className="pointer-events-none absolute bottom-0 left-1/2 -z-10 h-[420px] w-auto max-w-none -translate-x-1/2 translate-y-[22%] opacity-80 sm:h-[520px]" />
          <div data-rv-head className="relative mx-auto max-w-2xl">
            <p className="eyebrow">Launch</p>
            <h2 id="launch-title" className="mt-4 text-balance text-[2.25rem] font-[720] leading-[1.06] tracking-[-0.03em] text-white sm:text-[3.4rem]">
              See what each party learns, for yourself.
            </h2>
            <p className="mt-5 text-pretty text-[17px] leading-relaxed text-body sm:text-[19px]">
              Open the terminal, send a request and press <kbd className="code-inline text-fg">L</kbd>. Every column shows what
              that party actually received.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <a
                href={APP_URL}
                className="btn-primary text-[16px]"
              >
                Launch app
                <ArrowUpRight className="size-[18px]" aria-hidden />
              </a>
              {MAINNET_DEMO_URL && (
                <a href={MAINNET_DEMO_URL} className="btn-outline text-[16px]" title="Public mainnet demo: real ZEC, a tiny shared wallet, hard-capped">
                  Real ZEC demo · tiny capped wallet
                  <ArrowUpRight className="size-[18px] text-muted" aria-hidden />
                </a>
              )}
              {threatModel && (
                <a
                  href={threatModel}
                  className="btn-outline text-[16px]"
                >
                  <FileText className="size-[18px] text-muted" aria-hidden />
                  Read the threat model
                </a>
              )}
            </div>
            <p className="mx-auto mt-6 max-w-xl text-[14px] text-muted">
              Launch app opens <span className="font-mono text-fg">{APP_URL.replace(/^https?:\/\//, '')}</span>: the terminal
              runs on your machine, next to your Silicr daemons.
              {!threatModel && (
                <>
                  {' '}
                  The threat model is <code className="code-inline text-fg">THREAT_MODEL.md</code> in the repository.
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-black">
      <div className="mx-auto flex max-w-[1410px] flex-col gap-8 px-4 py-10 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <Wordmark />
          <p className="mt-3 text-[14px] leading-relaxed text-muted">A private GPU-compute market on Zcash.</p>
          <p className="mt-3 font-mono text-[12.5px] text-muted">Zcash mainnet or testnet · small balances · unaudited · built for ZECATHON 2026</p>
        </div>
        <div className="flex flex-col gap-3 text-[14px] md:items-end">
          {(REPO_URL || DEMO_VIDEO_URL) && (
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {REPO_URL && (
                <li>
                  <a href={REPO_URL} className="text-fg underline decoration-accent-line underline-offset-4 hover:decoration-accent">
                    Source code
                  </a>
                </li>
              )}
              {REPO_URL && (
                <li>
                  <a
                    href={repoFileUrl('THREAT_MODEL.md') ?? REPO_URL}
                    className="text-fg underline decoration-accent-line underline-offset-4 hover:decoration-accent"
                  >
                    Threat model
                  </a>
                </li>
              )}
              {DEMO_VIDEO_URL && (
                <li>
                  <a href={DEMO_VIDEO_URL} className="text-fg underline decoration-accent-line underline-offset-4 hover:decoration-accent">
                    Demo video
                  </a>
                </li>
              )}
            </ul>
          )}
          <p className="max-w-[25rem] text-balance text-[13px] leading-relaxed text-muted md:text-right">
            This page sets no cookies and makes no third-party requests.
          </p>
        </div>
      </div>
    </footer>
  );
}
