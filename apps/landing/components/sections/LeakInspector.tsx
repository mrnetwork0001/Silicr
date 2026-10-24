import { repoFileUrl } from '@/lib/config';
import { InspectorMoment, LeakMatrix } from '../LeakMatrix';
import { Section } from '../Section';

export function ThreatModelLink({ children = 'THREAT_MODEL.md' }: { children?: string }) {
  const href = repoFileUrl('THREAT_MODEL.md');
  return href ? (
    <a href={href} className="font-medium text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent">
      {children}
    </a>
  ) : (
    <span className="code-inline text-fg">THREAT_MODEL.md</span>
  );
}

export function LeakInspector() {
  return (
    <Section
      id="leaks"
      eyebrow="Leak Inspector"
      title="Don't take the diagram's word for it."
      lead={
        <>
          <p>
            Every screen in the terminal has a Leak Inspector toggle. Press <kbd className="code-inline text-fg">L</kbd> and the
            same moment appears from four viewpoints side by side: the public chain, the Silicr relay, the provider and the
            buyer.
          </p>
          <p>
            Each column lists what that party actually received, recorded from real data rather than drawn: decoded memos,
            relay requests and public transaction views. What a party can read is marked; ciphertext stays ciphertext.
          </p>
        </>
      }
      tone="panel"
    >
      <InspectorMoment />

      <div className="mt-16 max-w-3xl">
        <h3 className="text-[24px] font-semibold tracking-tight sm:text-[28px]">Who learns what</h3>
        <p className="mt-3 text-[16px] leading-relaxed text-muted">
          This is the table in <ThreatModelLink />, the one the inspector fills in live. It also covers two parties the live
          view can&apos;t show: the light-wallet server your wallet syncs from, and the providers that bid and lost.{' '}
          <span className="text-fg">Knows</span> means the party can read it in the clear. The same file lists what Silicr
          does <span className="text-fg">not</span> protect: the winning provider sees the workload, and without Tor the relay
          and light-wallet server see your IP and timing.
        </p>
      </div>
      <div className="mt-8">
        <LeakMatrix />
      </div>
      <ul className="mt-6 grid gap-x-8 gap-y-2.5 text-[14px] leading-relaxed text-muted md:grid-cols-2">
        <li>
          <span className="font-medium text-fg">Light-wallet server</span> (lightwalletd, the server your wallet syncs from): also
          learns each wallet&apos;s birthday height and any transaction the wallet fetches by txid. It can&apos;t tell which
          notes belong to the wallet; blocks are scanned locally.
        </li>
        <li>
          <span className="font-medium text-fg">Directory host</span>: the public provider entries, and the IP of whoever
          publishes or reads them; nothing about buyers or trades. Entries are signature-checked by the relay on write and by
          every client on read, so the host can drop an entry but can&apos;t forge or replace one. In this build the relay
          serves the directory.
        </li>
        <li>
          <span className="font-medium text-fg">Winning provider</span>: can&apos;t link the job to the buyer&apos;s other
          jobs, because each RFQ uses a fresh key and address.
        </li>
        <li>
          <span className="font-medium text-fg">Buyer</span>: can&apos;t learn providers&apos; other jobs or earnings.
        </li>
        <li>
          <span className="font-medium text-fg">Silicr arbiter</span> (roadmap, FROST bonds): would see bond addresses and
          the evidence submitted in disputes, and nothing about undisputed trades.
        </li>
      </ul>
    </Section>
  );
}
