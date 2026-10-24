import { repoFileUrl } from '@/lib/config';
import { EXAMPLE, formatZec } from '@/lib/settlement';
import { Faq } from '../Faq';
import { Section } from '../Section';

function DocRef({ path }: { path: string }) {
  const href = repoFileUrl(path);
  return href ? (
    <a href={href} className="font-medium text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent">
      {path}
    </a>
  ) : (
    <code className="code-inline text-fg">{path}</code>
  );
}

const ITEMS = [
  {
    q: 'Is it on mainnet?',
    a: (
      <>
        <p>
          It can be. Silicr runs on Zcash mainnet or testnet through its own light wallet, and the zero-setup demo runs on a
          simulated chain. Mainnet is opt-in: an explicit <code className="code-inline text-fg">--network main</code>, spend caps
          in the daemon config (per request and in total; the daemon refuses to start without them) and small balances.
        </p>
        <p>
          This is unaudited hackathon software. Keep only what you are willing to lose in its wallets, back up the seeds under{' '}
          <code className="code-inline text-fg">.silicr/</code> or treat them as throwaway, and read <DocRef path="docs/MAINNET.md" />{' '}
          first.
        </p>
      </>
    ),
  },
  {
    q: 'Can the provider see my model and data?',
    a: (
      <>
        <p>
          Yes. The winning provider decrypts and runs your job, so it sees your code, your data and the outputs. Hiding the
          workload from the machine that runs it needs TEE execution with attestation, which is future work. Treat a
          provider as able to read everything you send it.
        </p>
        <p>What it doesn&apos;t learn is who you are: no message carries your identity, your wallet or your IP address.</p>
      </>
    ),
  },
  {
    q: 'What stops a provider from taking payment and not computing?',
    a: (
      <>
        <p>
          Nothing prevents it outright; Silicr limits what it costs you. Your client pays each interval by its own clock,
          shortly before it begins, and stops as soon as signed heartbeats stop. Claiming progress can&apos;t speed payments
          up. In the {EXAMPLE.hours}-hour example on this page, a provider that walks away costs you at most about{' '}
          {formatZec(EXAMPLE.buyerMaxExposureZats)} ZEC, or {EXAMPLE.buyerMaxExposureMinutes} minutes&apos; worth.
        </p>
        <p>
          Heartbeats carry a step count and a checkpoint hash. They show the job is progressing, not that it ran on the
          claimed GPU or produced honest outputs. Provider bonds with slashing (FROST 2-of-3) are on the roadmap.
        </p>
      </>
    ),
  },
  {
    q: 'Does Silicr hold my funds?',
    a: (
      <p>
        No. There is no escrow, no custodian and no Silicr account. You pay the provider directly from your own wallet with
        ordinary shielded transactions, one interval at a time.
      </p>
    ),
  },
  {
    q: 'What does the relay know?',
    a: (
      <>
        <p>
          Blob sizes, upload and download times, and the IP addresses of the parties connecting. It stores only ciphertext,
          under mailbox ids derived from the buyer and provider&apos;s shared secret, so it can&apos;t tell which request a
          blob belongs to, what it contains, the price or who anyone is.
        </p>
        <p>
          In this build the relay also serves the public provider directory. It is a small Node server that holds no keys,
          so you can run your own.
        </p>
      </>
    ),
  },
  {
    q: 'And the light-wallet server?',
    a: (
      <p>
        Your wallet syncs from the lightwalletd server you point it at (testnet.zec.rocks by default on testnet). It sees your IP address, every
        transaction you broadcast and when, and your wallet&apos;s birthday height. That is enough to link one job&apos;s
        transactions, a padded RFQ followed by a run of 2-action payments, and to estimate how long the job ran: random
        jitter blurs the cadence, but not the count. It can&apos;t read memos, amounts or recipients, and blocks are scanned
        on your machine. Tor or SOCKS support, batched payments, or running your own Zebra + Zaino/lightwalletd would reduce
        this; all are future work.
      </p>
    ),
  },
  {
    q: 'Who sees my request?',
    a: (
      <p>
        Only the providers you ask: your client picks up to 16 matching ones from the directory, or you name them. They
        learn the GPU type, count, duration and your max price, but not who you are, and the ones that lose never learn
        which bid won. The chain sees a padded transaction that doesn&apos;t show how many providers you asked, within its
        bucket.
      </p>
    ),
  },
  {
    q: 'Why Zcash?',
    a: (
      <p>
        A shielded Zcash transaction hides sender, recipient and amount, and every output carries a 512-byte encrypted memo.
        That gives Silicr a private payment rail and a private message channel in one, with no separate messaging network.
        Unified addresses make a fresh, unlinkable address per request cheap, and metered payments replace the escrow
        contract Zcash doesn&apos;t have.
      </p>
    ),
  },
];

export function FaqSection() {
  return (
    <Section
      id="faq"
      eyebrow="FAQ"
      title="Straight answers."
      lead={<p>The questions people ask first, including the uncomfortable ones.</p>}
      split
    >
      <Faq items={ITEMS} />
    </Section>
  );
}
