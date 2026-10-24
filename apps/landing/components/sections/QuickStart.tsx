import { REPO_URL, repoFileUrl } from '@/lib/config';
import { CodeBlock, type CommandLine } from '../CodeBlock';
import { Section } from '../Section';

const linkClass = 'font-medium text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent';

function DocRef({ path }: { path: string }) {
  const href = repoFileUrl(path);
  return href ? (
    <a href={href} className={linkClass}>
      {path}
    </a>
  ) : (
    <code className="code-inline text-fg">{path}</code>
  );
}

const Code = ({ children }: { children: string }) => <code className="font-mono text-[12.5px]">{children}</code>;

export function QuickStart() {
  const demo: CommandLine[] = [
    ...(REPO_URL ? [{ cmd: `git clone ${REPO_URL} silicr && cd silicr`, note: 'get the code' }] : []),
    REPO_URL ? { cmd: 'pnpm install' } : { cmd: 'pnpm install', note: 'from the repo root' },
    { cmd: 'pnpm silicr demo --run', note: 'simulated chain, relay, buyer and provider' },
    { cmd: 'pnpm --filter @silicr/web dev', note: 'in a second shell: the terminal, on http://127.0.0.1:7703' },
  ];

  return (
    <Section
      id="quickstart"
      eyebrow="Quick start"
      title="Try it on your machine."
      lead={
        <p>
          You need Node 22 or newer and pnpm 9. The demo needs nothing else: it runs a simulated chain, the relay, a buyer and
          a provider locally, with time compressed. The real thing runs on Zcash mainnet with small balances, or on testnet.
        </p>
      }
      tone="panel"
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="min-w-0 lg:col-span-2">
          <CodeBlock
            title="demo · simulated chain"
            lines={demo}
            footer={<>No wallet setup, no coins, no Docker required. Open the terminal and press L to watch what each party sees.</>}
          />
        </div>
        <CodeBlock
          title="buyer · Zcash mainnet"
          lines={[
            { cmd: 'pnpm silicr init --role buyer --network main --data .silicr/wallets/main-buyer', note: 'keys + a shielded mainnet wallet; prints its u1… address' },
            { cmd: 'pnpm silicr daemon --data .silicr/wallets/main-buyer', note: 'in its own shell; syncs mainnet' },
            { cmd: 'pnpm silicr run --gpu a100 --count 1 --hours 1 --max 0.05 --auto ./job -- python3 train.py', note: 'sealed RFQ, bids, metered pay' },
          ]}
          footer={
            <>
              Fund the buyer with a small amount of ZEC from any shielded wallet: send it to the <Code>u1…</Code> address{' '}
              <Code>init</Code> prints. It is spendable after 10 confirmations, about 12 to 13 minutes. On mainnet the daemon
              refuses to start without spend caps (per request and in total) in its config, and the terminal shows the amount
              and the cap before every send. Testnet: use <Code>--network test</Code> and a faucet. See{' '}
              <DocRef path="docs/MAINNET.md" />.
            </>
          }
        />
        <CodeBlock
          title="provider · Zcash mainnet"
          lines={[
            { cmd: 'pnpm silicr init --role provider --network main --data .silicr/wallets/main-provider', note: 'keys + a shielded mainnet wallet' },
            { cmd: 'pnpm silicr daemon --data .silicr/wallets/main-provider', note: 'in its own shell' },
            { cmd: 'pnpm silicr provide --gpu a100 --count 4 --vram 80 --min 0.6', note: 'publish a signed listing and bid by policy' },
          ]}
          footer={
            <>
              Both sides need the Rust wallet (<Code>cargo build --release</Code> in <Code>zec-sidecar/</Code>) and a relay both
              can reach (<Code>pnpm silicr relay</Code>, default port 7700); the provider needs a little ZEC for bid fees. Install
              Docker for the sandboxed runner, plus the NVIDIA container toolkit to pass GPUs through. Without Docker it falls
              back to process mode, which is not a sandbox. See <DocRef path="docs/ZCASH_SETUP.md" />.
            </>
          }
        />
      </div>
    </Section>
  );
}
