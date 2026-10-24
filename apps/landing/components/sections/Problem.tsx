import { Coins, ListOrdered, Receipt } from '@/components/icons';
import { Section } from '../Section';

const LEAKS = [
  {
    icon: Receipt,
    title: 'Cloud bills',
    body: 'A cloud account ties every GPU-hour to a named company and a card on file. The provider sees who rents what and for how long, and so does anyone who can read its billing data.',
  },
  {
    icon: ListOrdered,
    title: 'Public DeAI order books',
    body: 'Open compute marketplaces publish requests and bids so that anyone can fill them. Anyone includes a competitor watching for a sudden 512-GPU order.',
  },
  {
    icon: Coins,
    title: 'Transparent payments',
    body: 'Paying on a transparent chain publishes payer, payee and amount, permanently. Tie one address to a lab and its whole compute history is public.',
  },
];

export function Problem() {
  return (
    <Section
      id="problem"
      eyebrow="The problem"
      title="Your GPU bill is your roadmap."
      lead={
        <p>
          Which lab rents how many H100s, and for how long, tells you what it is about to ship. Today that signal leaks at
          every step of buying compute: who is training what, at what scale, and whom they pay.
        </p>
      }
      tone="panel"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {LEAKS.map(({ icon: Icon, title, body }) => (
          <article key={title} className="rounded-2xl border border-line bg-bg p-6">
            <span className="inline-flex size-10 items-center justify-center rounded-xl border border-bad/25 bg-bad-soft text-bad">
              <Icon className="size-5" aria-hidden />
            </span>
            <h3 className="mt-5 text-[18px] font-semibold tracking-tight">{title}</h3>
            <p className="mt-2 text-[15.5px] leading-relaxed text-muted">{body}</p>
          </article>
        ))}
      </div>
      <p className="mt-10 max-w-3xl text-[19px] font-medium leading-relaxed tracking-tight text-fg sm:text-[21px]">
        Silicr removes each of those leaks, and lets you check exactly what was removed.
      </p>
    </Section>
  );
}
