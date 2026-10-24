import { CircleAlert, ShieldCheck } from '@/components/icons';
import type { ReactNode } from 'react';
import { Section } from '../Section';
import { ThreatModelLink } from './LeakInspector';

/** "Mitigations we ship" from THREAT_MODEL.md. */
const PROTECT: { title: string; body: ReactNode }[] = [
  {
    title: 'Shielded only',
    body: 'Every address is an Orchard-receiver-only unified address, and the wallet spends Ironwood notes only. Transparent, Sapling and legacy-Orchard (turnstile) spends are refused in TypeScript and again in the Rust wallet, on both the proposal and the finished transaction, with a plain explanation of why.',
  },
  {
    title: 'Fixed output buckets',
    body: 'RFQ transactions are padded to buckets of 4, 8 or 16 outputs, so the action count doesn’t show how many providers were asked.',
  },
  {
    title: 'Fresh keys per RFQ',
    body: 'A one-time diversified reply address and a per-RFQ signing key, so one buyer’s RFQs can’t be linked to each other. Each bid names a fresh payment address too.',
  },
  {
    title: 'Signed protocol messages',
    body: 'A forged BID or PAY is rejected. Signature checks are strict (RFC 8032).',
  },
  {
    title: 'Bounded loss, timed by the buyer’s own clock',
    body: 'The buyer pays each interval shortly before it starts, with random jitter. Heartbeats can block a payment, but they can never trigger one early, so a provider that vanishes or lies about progress takes at most the rest of the interval in progress plus one prepaid interval: at most 1.25 intervals of compute (1.2 on testnet). A buyer that stops paying gets nothing past the interval it paid for: the provider pauses at the unpaid boundary and stops after the grace period. A payment still in the mempool must be mined before the next interval starts, so a double-spent payment costs the provider at most one interval, once.',
  },
  {
    title: 'No lookups that reveal interest',
    body: 'The wallet never asks the light-wallet server for another party’s transaction by txid. The Leak Inspector’s public view of received transactions is built from blocks the wallet already downloads.',
  },
];

/** "Known limits" from THREAT_MODEL.md, in the same order. */
const LIMITS: { title: string; body: ReactNode }[] = [
  {
    title: 'The workload is visible to the winning provider.',
    body: 'Hiding it would need TEE execution with attestation, which is future work. Buyers with secret weights should treat providers as able to see their code and data.',
  },
  {
    title: 'Network metadata.',
    body: 'Without a proxy, the relay sees both parties’ IP addresses and the light-wallet server sees each wallet’s IP and broadcasts. With --proxy (Tor), every connection goes through SOCKS5, DNS included, and nothing falls back to a direct connection, so they see Tor’s address instead. Timing, a wallet’s birthday height and the moment of each broadcast remain visible.',
  },
  {
    title: 'No proof of correct computation.',
    body: 'Heartbeats show the job is progressing, not that it ran on the claimed GPU or produced honest outputs. Bonds and reputation discourage cheating but don’t prevent it.',
  },
  {
    title: 'Timing correlation and the payment train.',
    body: 'The light-wallet server sees the buyer’s IP broadcast one padded RFQ, then a run of uniform 2-action payments. From that it can link one job’s transactions and infer roughly how long the job ran. Random jitter on payment times blurs the cadence, but not the count. Whoever runs the relay can also line up blob timing with chain timing. Mitigations not yet built: batched payments, randomised upload delays, Tor, and running your own light-wallet server.',
  },
  {
    title: 'Losing bidders see demand.',
    body: 'RFQ details reach every provider asked. Buyers control this by choosing how many to ask.',
  },
  {
    title: 'The arbiter is trusted',
    body: 'in the FROST bond flow (stretch only).',
  },
  {
    title: 'Process-mode runner is not a sandbox.',
    body: 'The Docker runner isolates jobs: no network, read-only filesystem, all capabilities dropped. The process-mode fallback, used when Docker is unavailable, does not, and the provider’s status says so.',
  },
];

export function Privacy() {
  return (
    <Section
      id="privacy"
      eyebrow="Privacy"
      title="What we protect, and what we don't."
      lead={
        <p>
          ZECATHON treats a privacy leak as disqualifying, and so do we. Both lists come straight from <ThreatModelLink />,
          limits included.
        </p>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-panel">
          <div className="flex items-center gap-3 border-b border-line px-6 py-4">
            <ShieldCheck className="size-5 text-ok" aria-hidden />
            <h3 className="text-[18px] font-semibold tracking-tight">What we protect</h3>
          </div>
          <ul className="divide-y divide-line">
            {PROTECT.map((p) => (
              <li key={p.title} className="px-6 py-4">
                <p className="text-[15.5px] font-medium text-fg">{p.title}</p>
                <p className="mt-1 text-[14.5px] leading-relaxed text-muted">{p.body}</p>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl border border-line bg-panel">
          <div className="flex items-center gap-3 border-b border-line px-6 py-4">
            <CircleAlert className="size-5 text-warn" aria-hidden />
            <h3 className="text-[18px] font-semibold tracking-tight">Known limits, stated, not hidden</h3>
          </div>
          <ol className="divide-y divide-line">
            {LIMITS.map((l, i) => (
              <li key={l.title} className="flex gap-4 px-6 py-4">
                <span className="mt-0.5 font-mono text-[13px] font-semibold text-warn">{i + 1}</span>
                <p className="text-[14.5px] leading-relaxed text-muted">
                  <span className="font-medium text-fg">{l.title}</span> {l.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className="mt-6 max-w-3xl text-[14.5px] leading-relaxed text-muted">
        <span className="font-medium text-fg">Mainnet or testnet.</span> Silicr runs on Zcash mainnet (small balances, spend caps
        required) or on testnet; the zero-setup demo uses a simulated chain. On mainnet its transactions sit among every other
        shielded Ironwood transaction on the network, a far larger crowd than testnet, which weakens the traffic-shape inference
        in limit 4. Real funds raise the stakes of every limit above, so keep wallets small.
      </p>
    </Section>
  );
}
