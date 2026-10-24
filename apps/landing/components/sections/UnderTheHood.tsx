import { Binary, Braces, CodeXml, Coins, FileLock, KeyRound, Lock, PenLine, Shield, Wallet } from '@/components/icons';
import { REPO_URL } from '@/lib/config';
import { Section } from '../Section';

const SPECS = [
  {
    icon: Shield,
    title: 'Shielded only',
    tag: 'ZIP 316',
    body: 'Orchard-receiver-only unified addresses, with value in the Ironwood pool. One guard checks every recipient and refuses transparent, Sapling, TEX and Sprout addresses, and keys pasted by mistake, with a plain reason.',
  },
  {
    icon: Wallet,
    title: 'Ironwood-only spends',
    tag: 'NU6.3',
    body: 'Spends Ironwood notes only and refuses transparent, Sapling and legacy-Orchard (turnstile) spends, checked in TypeScript and again in the Rust wallet.',
  },
  {
    icon: FileLock,
    title: 'Memo frames',
    tag: 'ZIP 302',
    body: 'Each message is one signed frame in a 512-byte memo: magic, version, type, a CBOR body and an Ed25519 signature. Frames stay within 380 bytes, so they fit a binary memo and a text one (slc1: + base64url) alike.',
  },
  {
    icon: PenLine,
    title: 'Strict Ed25519',
    tag: 'RFC 8032',
    body: 'Signatures verify under RFC 8032 rules, not ZIP 215: canonical encodings only, s < L, small-order keys rejected. A valid signature can’t be mutated into another valid one.',
  },
  {
    icon: KeyRound,
    title: 'X25519 + HKDF-SHA256',
    tag: 'RFC 7748 · 5869',
    body: 'One X25519 shared secret per job yields the channel key and every relay mailbox id through HKDF-SHA256, salted with the RFQ id. Buyer keys are derived per RFQ, so two requests can’t be linked.',
  },
  {
    icon: Lock,
    title: 'XChaCha20-Poly1305',
    tag: 'AEAD',
    body: 'Each relay blob is sealed with a random 24-byte nonce. The blob’s kind and RFQ id are bound in as associated data, so a heartbeat can’t be passed off as a result.',
  },
  {
    icon: Braces,
    title: 'Deterministic CBOR',
    tag: 'RFC 8949',
    body: 'Bodies use deterministic encoding, and the decoder accepts only shortest-form, definite-length input: one message, one valid byte string.',
  },
  {
    icon: Coins,
    title: 'ZIP 317 fees',
    tag: '5,000 zats / action',
    body: 'Minimum 2 logical actions, so a payment costs 0.0001 ZEC. Each RFQ padding output adds 5,000 zats.',
  },
  {
    icon: Binary,
    title: 'Rust light wallet',
    tag: 'zec-sidecar',
    body: 'Our own light wallet on librustzcash (zcash_client_backend, zcash_client_sqlite), one process per wallet. It checks that the server’s reported chain matches the wallet’s network before it syncs.',
  },
  {
    icon: CodeXml,
    title: 'Open source',
    tag: 'TypeScript + Rust',
    body: 'TypeScript packages on Node 22, with crypto and encoding from @noble and @scure only, plus the Rust sidecar.',
  },
];

export function UnderTheHood() {
  return (
    <Section
      id="under-the-hood"
      eyebrow="Under the hood"
      title="Standard parts, strictly checked."
      lead={
        <p>
          Silicr sticks to well-known primitives and Zcash standards, and refuses anything it can&apos;t parse exactly.
          {REPO_URL && (
            <>
              {' '}
              <a href={REPO_URL} className="font-medium text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent">
                Read the source
              </a>
              .
            </>
          )}
        </p>
      }
    >
      <ul className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 xl:grid-cols-5">
        {SPECS.map(({ icon: Icon, title, tag, body }) => (
          <li key={title} className="flex flex-col bg-panel p-5">
            <div className="flex items-center justify-between gap-3">
              <Icon className="size-5 text-accent" aria-hidden />
              <span className="truncate rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted">{tag}</span>
            </div>
            <h3 className="mt-4 text-[16px] font-semibold tracking-tight">{title}</h3>
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{body}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
