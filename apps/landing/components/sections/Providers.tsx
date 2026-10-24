import { BadgeCheck, Box, Coins, Eye, PauseCircle, Settings2, TriangleAlert } from '@/components/icons';
import { CodeBlock } from '../CodeBlock';
import { Section } from '../Section';

const FEATURES = [
  {
    icon: Coins,
    title: 'Earn shielded ZEC',
    body: 'You are paid one interval at a time in shielded transactions, at a fresh address of yours for every job.',
  },
  {
    icon: BadgeCheck,
    title: 'A pseudonymous, signed listing',
    body: 'Your directory entry holds a pseudonym derived from your key (like amber-otter-17), your GPUs, your minimum price, a shielded address and your Ed25519 key, all signed. Nothing about buyers ever goes in it.',
  },
  {
    icon: Settings2,
    title: 'Automatic bids by policy',
    body: 'The daemon reads the RFQ memos sent to you and bids your minimum price whenever the GPU model, free capacity, the buyer’s max and the expiry allow. No manual quoting.',
  },
  {
    icon: Box,
    title: 'A sandboxed Docker runner',
    body: 'Jobs run with no network, a read-only root filesystem, all capabilities dropped, no-new-privileges, and CPU, memory and process limits. GPUs are passed through only when a job asks and the NVIDIA runtime is present.',
  },
  {
    icon: PauseCircle,
    title: 'Pay or pause',
    body: 'Each interval runs only once it is paid. A missing payment pauses the container; if it hasn’t arrived when the grace period ends, the job stops and no results are uploaded.',
  },
  {
    icon: Eye,
    title: 'What you can and can’t see',
    body: 'You see the job you run, with its code, data and outputs, and the request details of every RFQ sent to you. You never learn who the buyer is.',
  },
];

const LISTING = `{
  "v": 1,
  "providerId": "28500011…e9c4",
  "alias": "amber-otter-17",
  "address": "u1…7k2p",
  "gpus": [
    { "model": "a100", "count": 4, "vramGb": 80 }
  ],
  "minPricePerHourZats": "60000000",
  "updatedAt": 1790812800,
  "sig": "9e1a…0b5f"
}`;

export function Providers() {
  return (
    <Section
      id="providers"
      eyebrow="For providers"
      title="Turn a GPU box into a seller."
      lead={
        <p>
          <code className="code-inline text-fg">silicr provide</code> publishes a signed, pseudonymous listing, watches your
          wallet for sealed requests, bids by policy and runs the jobs you win in a sandbox.
        </p>
      }
      tone="panel"
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <div className="min-w-0 space-y-4">
          <CodeBlock
            title="provider · mainnet or testnet"
            lines={[{ cmd: 'pnpm silicr provide --gpu a100 --count 4 --vram 80 --min 0.6' }]}
            footer={<>Lists 4 × A100 at a minimum of 0.6 ZEC/h and starts bidding.</>}
          />
          <figure className="overflow-hidden rounded-xl border border-line bg-bg">
            <figcaption className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
              <span className="font-mono text-[12px] font-medium text-muted">your directory entry · public, signed</span>
            </figcaption>
            <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.7] text-fg">
              {LISTING}
            </pre>
            <p className="border-t border-line px-4 py-2.5 text-[12.5px] text-muted">
              Illustrative values. The alias comes from the key; buyers check the signature and the address before use.
            </p>
          </figure>
          <div className="rounded-2xl border border-warn/40 bg-warn-soft p-5">
            <p className="flex items-center gap-2 text-[15.5px] font-semibold text-fg">
              <TriangleAlert className="size-[18px] shrink-0 text-warn" aria-hidden />
              Process mode is a dev fallback, not a sandbox
            </p>
            <p className="mt-2 text-[14.5px] leading-relaxed text-fg/85">
              Without Docker, jobs run as plain child processes under your user account. They can read your files, including
              wallets under <code className="font-mono text-[13px]">.silicr/</code>, and use the network; only the timeout is
              enforced. The provider&apos;s status says so. Use it for development and demos only.
            </p>
          </div>
        </div>
        <ul className="grid grid-cols-1 gap-px self-start overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="bg-bg p-5 sm:p-6">
              <Icon className="size-5 text-accent" aria-hidden />
              <h3 className="mt-3 text-[16.5px] font-semibold tracking-tight">{title}</h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
