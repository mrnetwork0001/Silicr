import { Check, Minus } from '@/components/icons';

/**
 * Who learns what about a buyer's job. Every cell comes from the "What each
 * party learns" table in THREAT_MODEL.md; keep the two in sync.
 */

type PartyKey = 'chain' | 'lwd' | 'relay' | 'losers' | 'winner' | 'buyer';

const PARTIES: { key: PartyKey; label: string; sub: string }[] = [
  { key: 'chain', label: 'Public chain', sub: 'anyone watching' },
  { key: 'lwd', label: 'Light-wallet server', sub: 'lightwalletd' },
  { key: 'relay', label: 'Silicr relay', sub: 'its operator' },
  { key: 'losers', label: 'Providers asked', sub: 'losing bidders' },
  { key: 'winner', label: 'Winning provider', sub: 'runs the job' },
  { key: 'buyer', label: 'Buyer', sub: 'you' },
];

type Cell = { knows: boolean; note?: string };
const Y = (note?: string): Cell => (note ? { knows: true, note } : { knows: true });
const N = (note?: string): Cell => (note ? { knows: false, note } : { knows: false });

const ROWS: { what: string; cells: Record<PartyKey, Cell> }[] = [
  {
    what: 'Who the buyer is: identity, wallet',
    cells: { chain: N(), lwd: N(), relay: N(), losers: N(), winner: N(), buyer: Y() },
  },
  {
    what: "The buyer's IP address",
    cells: { chain: N(), lwd: Y(), relay: Y(), losers: N(), winner: N('talks only to the relay'), buyer: Y() },
  },
  {
    what: 'Which transactions that IP broadcasts, and when',
    cells: { chain: N('sees them, not who sent them'), lwd: Y(), relay: N(), losers: N(), winner: N(), buyer: Y() },
  },
  {
    what: 'Which transactions belong to one job',
    cells: {
      chain: N('not linkable on-chain'),
      lwd: Y('your IP and the payment train'),
      relay: N(),
      losers: N(),
      winner: Y('its own payments'),
      buyer: Y(),
    },
  },
  {
    what: 'Roughly how long the job ran',
    cells: {
      chain: N(),
      lwd: Y('from the payment count'),
      relay: Y('from blob timing'),
      losers: N(),
      winner: Y(),
      buyer: Y(),
    },
  },
  {
    what: 'Blob sizes, upload and download times',
    cells: { chain: N(), lwd: N(), relay: Y(), losers: N(), winner: Y('its own'), buyer: Y('its own') },
  },
  {
    what: 'The request: GPU, count, duration, max price',
    cells: { chain: N(), lwd: N(), relay: N(), losers: Y(), winner: Y(), buyer: Y() },
  },
  {
    what: 'Which bid won, and at what price',
    cells: { chain: N(), lwd: N(), relay: N(), losers: N(), winner: Y(), buyer: Y() },
  },
  {
    what: 'Amounts paid',
    cells: { chain: N('only fees are public'), lwd: N(), relay: N(), losers: N(), winner: Y(), buyer: Y() },
  },
  {
    what: 'The workload: job bundle and its outputs',
    cells: { chain: N(), lwd: N(), relay: N('ciphertext only'), losers: N(), winner: Y(), buyer: Y() },
  },
];

/** For the closing visual: which of the four live viewpoints know each row. */
export function knowsGrid(): { party: string; cells: boolean[] }[] {
  const keys: [PartyKey, string][] = [
    ['chain', 'Chain'],
    ['relay', 'Relay'],
    ['winner', 'Provider'],
    ['buyer', 'Buyer'],
  ];
  return keys.map(([k, party]) => ({ party, cells: ROWS.map((r) => r.cells[k].knows) }));
}

function Knows({ note }: { note?: string }) {
  return (
    <span className="inline-flex flex-col items-center gap-1">
      <span className="inline-flex items-center gap-1 rounded-full bg-knows px-2 py-0.5 text-[12px] font-medium text-knows-fg">
        <Check className="size-3" aria-hidden strokeWidth={3} />
        Knows
      </span>
      {note && <span className="text-[11.5px] leading-tight text-muted">{note}</span>}
    </span>
  );
}

function DoesNot({ note }: { note?: string }) {
  return (
    <span className="inline-flex flex-col items-center gap-1">
      <span className="inline-flex size-6 items-center justify-center rounded-full text-faint" aria-hidden>
        <Minus className="size-4" />
      </span>
      <span className="sr-only">Does not know</span>
      {note && <span className="text-[11.5px] leading-tight text-muted">{note}</span>}
    </span>
  );
}

export function LeakMatrix() {
  return (
    <div>
      {/* Wide: a real table. */}
      <div className="hidden overflow-hidden rounded-2xl border border-line bg-panel md:block max-[900px]:overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-left max-[900px]:min-w-[760px]">
          <caption className="sr-only">
            What each party learns about a buyer&apos;s job, from THREAT_MODEL.md. Knows means the party can read it in the clear.
          </caption>
          <colgroup>
            <col className="w-[25%]" />
            {PARTIES.map((p) => (
              <col key={p.key} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-line bg-sunken/70">
              <th scope="col" className="px-5 py-3.5 align-bottom text-[13px] font-medium text-muted">
                What about your job
              </th>
              {PARTIES.map((p) => (
                <th key={p.key} scope="col" className="px-2 py-3.5 text-center align-bottom">
                  <span className="block text-[13.5px] font-semibold leading-tight text-fg">{p.label}</span>
                  <span className="mt-0.5 block text-[12px] font-normal text-muted">{p.sub}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.what} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-5 py-3 text-[14px] font-medium leading-snug text-fg">
                  {r.what}
                </th>
                {PARTIES.map((p) => {
                  const c = r.cells[p.key];
                  return (
                    <td key={p.key} className={`px-2 py-3 text-center align-middle ${c.knows ? '' : 'hatch'}`}>
                      {c.knows ? <Knows note={c.note} /> : <DoesNot note={c.note} />}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t border-line bg-zec-soft/60">
              <th scope="row" className="px-5 py-3 text-[14px] font-medium leading-snug text-fg">
                When shielded transactions happen, their action counts and fees
              </th>
              <td colSpan={PARTIES.length} className="px-4 py-3 text-[13.5px] leading-relaxed text-fg">
                Public to everyone. Payments look like ordinary 2-action shielded payments; a padded RFQ (5–8, 9–12 or 17–20
                actions) is a less common shape. Senders, recipients, amounts and memos stay hidden.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Narrow: one card per row, listing who knows it. */}
      <ul className="space-y-3 md:hidden">
        {ROWS.map((r) => {
          const knows = PARTIES.filter((p) => r.cells[p.key].knows);
          const not = PARTIES.filter((p) => !r.cells[p.key].knows);
          return (
            <li key={r.what} className="rounded-xl border border-line bg-panel p-4">
              <p className="text-[15px] font-medium">{r.what}</p>
              <p className="mt-2.5 text-[12px] font-medium uppercase tracking-[0.08em] text-muted">Known to</p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {knows.map((p) => {
                  const note = r.cells[p.key].note;
                  return (
                    <li key={p.key} className="inline-flex items-center gap-1 rounded-full bg-knows px-2.5 py-0.5 text-[12.5px] font-medium text-knows-fg">
                      <Check className="size-3" aria-hidden strokeWidth={3} />
                      {p.label}
                      {note && <span className="font-normal opacity-80">({note})</span>}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                <span className="font-medium">Not known to:</span>{' '}
                {not
                  .map((p) => {
                    const note = r.cells[p.key].note;
                    return note ? `${p.label} (${note})` : p.label;
                  })
                  .join(', ')}
              </p>
            </li>
          );
        })}
        <li className="rounded-xl border border-zec/30 bg-zec-soft p-4 text-[14px]">
          <p className="font-medium">When shielded transactions happen, their action counts and fees</p>
          <p className="mt-1 text-fg/80">
            Public to everyone. Payments look like ordinary 2-action shielded payments; a padded RFQ (5–8, 9–12 or 17–20
            actions) is a less common shape. Senders, recipients, amounts and memos stay hidden.
          </p>
        </li>
      </ul>
    </div>
  );
}

/** One moment, the four live viewpoints the in-app Leak Inspector shows. Field labels follow the engine's records. */
const MOMENT: { party: string; tone: 'chain' | 'relay' | 'provider' | 'buyer'; lines: { k: string; v: string; secret?: boolean }[] }[] = [
  {
    party: 'Public chain',
    tone: 'chain',
    lines: [
      { k: 'A shielded transaction', v: 'v6 · 2 Ironwood actions' },
      { k: 'Fee', v: '10,000 zats' },
      { k: 'Sender, recipient, amount, memo', v: 'hidden', secret: true },
    ],
  },
  {
    party: 'Silicr relay',
    tone: 'relay',
    lines: [
      { k: 'Stored opaque blob #1', v: '48,212 B · mailbox 3f9ca1e2…' },
      { k: 'First 24 bytes', v: '9b1e04c7d2…', secret: true },
      { k: 'Client IP', v: '203.0.113.24' },
    ],
  },
  {
    party: 'Provider',
    tone: 'provider',
    lines: [
      { k: 'Bid won', v: 'ACCEPT for 144 intervals' },
      { k: 'Price', v: '0.06 ZEC per 300 s' },
      { k: 'Buyer identity', v: 'not present in any message', secret: true },
    ],
  },
  {
    party: 'Buyer',
    tone: 'buyer',
    lines: [
      { k: 'Job sealed and uploaded', v: 'command: python train.py' },
      { k: 'Paid now', v: '0.06 ZEC (interval 0)' },
      { k: 'Relay mailbox', v: 'derived from the channel secret' },
    ],
  },
];

export function InspectorMoment() {
  return (
    <figure className="overflow-hidden rounded-2xl border border-line bg-panel shadow-[var(--shadow-pop)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <p className="text-[14px] font-semibold">Leak Inspector · the moment you accept a bid</p>
        <span className="font-mono text-[12px] text-muted">press L in the terminal</span>
      </div>
      <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 xl:grid-cols-4">
        {MOMENT.map((col) => (
          <div key={col.party} className="bg-panel px-4 py-4">
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{col.party}</p>
            <dl className="mt-2.5 space-y-2.5">
              {col.lines.map((l) => (
                <div key={l.k}>
                  <dt className="text-[12px] text-muted">{l.k}</dt>
                  <dd
                    className={`mt-0.5 break-words font-mono text-[12.5px] leading-snug ${
                      l.secret ? 'hatch rounded px-1.5 py-0.5 text-muted' : 'text-fg'
                    }`}
                  >
                    {l.v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <figcaption className="border-t border-line px-5 py-3 text-[12.5px] text-muted">
        Illustrative values. In the app each column is filled from what that party actually received: decoded memos, relay
        requests and public transaction views.
      </figcaption>
    </figure>
  );
}
