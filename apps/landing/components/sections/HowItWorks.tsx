import { Route } from '@/components/icons';
import { FlowDiagram } from '../FlowDiagram';
import { Section } from '../Section';

const STEPS = [
  {
    n: 1,
    title: 'Sealed RFQ',
    who: 'Only the providers you ask',
    body: (
      <>
        Your client picks matching providers from the public, signed directory and sends{' '}
        <strong className="font-medium text-fg">one shielded transaction</strong>. Each output carries your request in an
        encrypted memo only its recipient can read: GPU, count, duration, max price, a one-time reply address, a signing key
        made for this request and a channel key. Outputs are padded to <strong className="font-medium text-fg">4, 8 or 16</strong>{' '}
        with dummies to fresh addresses of your own, so the chain can&apos;t tell how many providers you asked within that
        bucket.
      </>
    ),
  },
  {
    n: 2,
    title: 'Sealed bids',
    who: 'Only you',
    body: (
      <>
        Each provider answers with a BID memo <strong className="font-medium text-fg">signed by its directory key</strong>{' '}
        and sent to your one-time address. Your client checks every signature and drops bids that are late, above your max,
        or from providers you didn&apos;t ask. Each bid names a fresh payment address and its own channel key.
      </>
    ),
  },
  {
    n: 3,
    title: 'Encrypted job channel',
    who: 'You and the winning provider',
    body: (
      <>
        The channel keys in your RFQ and the winning bid meet in <strong className="font-medium text-fg">X25519</strong>;
        HKDF-SHA256 turns the shared secret into one <strong className="font-medium text-fg">XChaCha20-Poly1305</strong> key.
        The job, logs, heartbeats and results are sealed with it and pass through a relay that stores only ciphertext, under
        mailbox ids derived from the same secret. No memo ever names a mailbox.
      </>
    ),
  },
  {
    n: 4,
    title: 'Metered settlement',
    who: 'You and the provider',
    body: (
      <>
        The ACCEPT transaction pays interval 0. After that your client pays each interval in shielded ZEC{' '}
        <strong className="font-medium text-fg">by its own clock</strong>, shortly before it begins, with random jitter.
        Heartbeats only confirm the job is alive, so a provider can&apos;t speed payments up by claiming progress. The
        provider runs only paid intervals: neither side can lose much more than one interval&apos;s worth.
      </>
    ),
  },
  {
    n: 5,
    title: 'Bonded providers',
    who: 'Bond holders',
    roadmap: true,
    body: (
      <>
        Planned: providers lock a bond in a <strong className="font-medium text-fg">FROST 2-of-3</strong> shielded address
        (provider, buyer pool, arbiter) that can be slashed on signed evidence of fraud. Not built yet: it is a stretch goal,
        and the arbiter would be a trusted party.
      </>
    ),
  },
];

export function HowItWorks() {
  return (
    <Section
      id="how"
      eyebrow="How it works"
      title="Five steps, and no one in the middle."
      lead={
        <p>
          Requests, bids, acceptances, payments and closes are signed frames inside encrypted Zcash memos. The job, its logs,
          heartbeats and results are too big for a memo, so they move over a relay that only ever holds ciphertext.
        </p>
      }
    >
      <FlowDiagram />

      <ol className="mt-10 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
        {STEPS.map((s) => (
          <li
            key={s.n}
            className={`grid grid-cols-1 gap-3 px-5 py-6 sm:grid-cols-[3rem_minmax(0,1fr)] sm:px-7 lg:grid-cols-[3rem_minmax(0,1fr)_15rem] lg:gap-8 ${
              s.roadmap ? 'hatch' : ''
            }`}
          >
            <span
              className={`step-dot inline-flex size-9 items-center justify-center rounded-full font-mono text-[14px] font-semibold ${
                s.roadmap ? 'border border-dashed border-line-strong text-muted' : 'bg-accent text-accent-fg'
              }`}
              aria-hidden
            >
              {s.n}
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[19px] font-semibold tracking-tight">
                  <span className="sr-only">Step {s.n}: </span>
                  {s.title}
                </h3>
                {s.roadmap && (
                  <span className="rounded-full border border-warn/60 bg-panel px-2 py-0.5 text-[12px] font-medium text-warn">
                    Roadmap · not built
                  </span>
                )}
              </div>
              <p className="mt-2 text-[15.5px] leading-relaxed text-muted">{s.body}</p>
            </div>
            <div className="sm:col-start-2 lg:col-start-auto lg:pt-1">
              <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-muted">Who can read it</p>
              <p className="mt-1 text-[14.5px] font-medium text-fg">{s.who}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-8 flex flex-col gap-4 rounded-2xl border border-accent-line bg-accent-soft p-6 sm:flex-row sm:p-7">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg">
          <Route className="size-5" aria-hidden />
        </span>
        <div>
          <h3 className="text-[19px] font-semibold tracking-tight">No matching engine</h3>
          <p className="mt-1.5 max-w-3xl text-[15.5px] leading-relaxed text-fg/85">
            There is no order book on a server and no operator who sees every order. Bids land at your one-time address and
            your own client ranks them: by price per hour, then bond size (bonds are on the roadmap), then arrival. You accept
            one yourself, or set an auto-accept rule such as &ldquo;the cheapest bid after waiting two blocks&rdquo;.
          </p>
        </div>
      </div>
    </Section>
  );
}
