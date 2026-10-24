/** Silicr next to the two designs it is usually compared with. Generic categories, not named products. */

const SYSTEMS = [
  { key: 'pool', label: 'Dark pool with a central matcher', sub: 'an operator runs the order book' },
  { key: 'public', label: 'Public DeAI marketplace', sub: 'open order book, on-chain payments' },
  { key: 'silicr', label: 'Silicr', sub: 'sealed RFQs on Zcash' },
] as const;

type Key = (typeof SYSTEMS)[number]['key'];

const ROWS: { what: string; cells: Record<Key, string> }[] = [
  {
    what: 'Who sees your order',
    cells: {
      pool: 'The operator sees every order in full. Other traders don’t.',
      public: 'Everyone: requests, bids and fills are public.',
      silicr: 'Only the providers you choose to ask.',
    },
  },
  {
    what: 'Who matches it',
    cells: {
      pool: 'The operator’s matching engine.',
      public: 'A public contract or the marketplace’s servers.',
      silicr: 'Your own client, on your machine.',
    },
  },
  {
    what: 'What payments reveal',
    cells: {
      pool: 'Typically custodial balances or transparent settlement: the operator, or the whole chain, sees amounts.',
      public: 'Payer, payee and amount, on a public ledger, for good.',
      silicr: 'That shielded transactions happened, when, and their fees. Each payment looks like an ordinary 2-action shielded payment.',
    },
  },
  {
    what: 'Who holds the money',
    cells: {
      pool: 'Usually the operator, or an escrow it controls.',
      public: 'Usually an escrow contract.',
      silicr: 'Nobody. You pay per interval from your own wallet.',
    },
  },
  {
    what: 'How you appear',
    cells: {
      pool: 'An account the operator knows, often verified.',
      public: 'A public address that links all your orders.',
      silicr: 'A fresh key and address per request. Providers are signed pseudonyms.',
    },
  },
  {
    what: 'What you have to trust',
    cells: {
      pool: 'The operator not to leak, front-run or lose your orders.',
      public: 'The contract code. Privacy isn’t on offer.',
      silicr: 'The winning provider with your workload; the relay and light-wallet server with network metadata.',
    },
  },
  {
    what: 'Maturity',
    cells: {
      pool: 'Varies; real venues exist.',
      public: 'Live networks with real supply.',
      silicr: 'An unaudited hackathon prototype built for ZECATHON 2026. Runs on Zcash mainnet with small balances, or on testnet.',
    },
  },
];

export function Comparison() {
  return (
    <div>
      <div className="hidden overflow-hidden rounded-2xl border border-line bg-panel md:block max-[900px]:overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-left max-[900px]:min-w-[760px]">
          <caption className="sr-only">How Silicr compares with a central-matcher dark pool and a public DeAI marketplace</caption>
          <colgroup>
            <col className="w-[19%]" />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b border-line bg-sunken/70">
              <th scope="col" className="px-5 py-3.5 align-bottom text-[13px] font-medium text-muted">
                <span className="sr-only">Question</span>
              </th>
              {SYSTEMS.map((s) => (
                <th
                  key={s.key}
                  scope="col"
                  className={`px-5 py-3.5 align-bottom ${s.key === 'silicr' ? 'bg-accent-soft' : ''}`}
                >
                  <span className={`block text-[14.5px] font-semibold ${s.key === 'silicr' ? 'text-accent' : 'text-fg'}`}>{s.label}</span>
                  <span className="mt-0.5 block text-[12.5px] font-normal text-muted">{s.sub}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.what} className="border-b border-line">
                <th scope="row" className="px-5 py-3.5 align-top text-[14px] font-medium text-fg">
                  {r.what}
                </th>
                {SYSTEMS.map((s) => (
                  <td
                    key={s.key}
                    className={`px-5 py-3.5 align-top text-[14px] leading-relaxed ${
                      s.key === 'silicr' ? 'bg-accent-soft/60 text-fg' : 'text-muted'
                    }`}
                  >
                    {r.cells[s.key]}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row" className="px-5 py-3.5 align-top text-[14px] font-medium text-fg">
                Your workload
              </th>
              <td colSpan={3} className="px-5 py-3.5 text-[14px] leading-relaxed text-fg">
                The same in all three today: whoever runs your job can see it. Hiding it needs TEE execution with
                attestation, which is future work for Silicr too.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <ul className="space-y-3 md:hidden">
        {ROWS.map((r) => (
          <li key={r.what} className="rounded-xl border border-line bg-panel p-4">
            <p className="text-[15px] font-semibold">{r.what}</p>
            <dl className="mt-2 space-y-2">
              {SYSTEMS.map((s) => (
                <div key={s.key} className={s.key === 'silicr' ? '-mx-2 rounded-lg bg-accent-soft px-2 py-1.5' : ''}>
                  <dt className={`text-[12px] font-medium ${s.key === 'silicr' ? 'text-accent' : 'text-muted'}`}>{s.label}</dt>
                  <dd className={`text-[14px] leading-snug ${s.key === 'silicr' ? 'text-fg' : 'text-muted'}`}>{r.cells[s.key]}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
        <li className="rounded-xl border border-line bg-panel p-4">
          <p className="text-[15px] font-semibold">Your workload</p>
          <p className="mt-1 text-[14px] leading-snug text-muted">
            The same in all three today: whoever runs your job can see it. Hiding it needs TEE execution with attestation,
            which is future work for Silicr too.
          </p>
        </li>
      </ul>
    </div>
  );
}
