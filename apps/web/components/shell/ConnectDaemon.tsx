'use client';

import { useEffect, useState } from 'react';
import { CircleAlert, RefreshCw, Server, SquareTerminal } from '@/components/icons';
import { probeAll, probeVerdict, retryConnection } from '@/lib/driver';
import { hostOf } from '@/lib/config';
import { useSilicr, type DaemonRole } from '@/lib/store';
import { Button, CopyButton, Dot } from '../ui';

const COMMANDS: { title: string; note: string; lines: string[]; real?: boolean }[] = [
  {
    title: 'Zcash testnet',
    note: 'Testnet coins only. `pnpm silicr demo` starts a whole testnet stack (relay, buyer and provider) and runs a tiny training deal.',
    lines: ['pnpm silicr daemon --network test --role buyer', 'pnpm silicr daemon --network test --role provider'],
  },
  {
    title: 'Zcash mainnet · REAL ZEC',
    note: 'Real funds: needs spend caps in the daemon config (silicr init --network main --cap-per-request <zec> --cap-total <zec>). See docs/MAINNET.md.',
    lines: ['pnpm silicr daemon --network main --role buyer', 'pnpm silicr daemon --network main --role provider'],
    real: true,
  },
];

const ROLES: DaemonRole[] = ['buyer', 'provider', 'relay'];

/** No daemon answers (or one runs on a network the terminal doesn't support): how to start one. */
export function ConnectDaemon() {
  const mode = useSilicr((s) => s.mode);
  const modeError = useSilicr((s) => s.modeError);
  const conn = useSilicr((s) => s.conn);
  const [busy, setBusy] = useState(false);

  // Pick a daemon up as soon as it starts: probe quietly, and only reboot the driver when one answers.
  useEffect(() => {
    if (mode !== 'offline') return;
    let stopped = false;
    const t = setInterval(() => {
      void probeAll().then((p) => {
        if (!stopped && probeVerdict(p)?.mode !== 'offline') void retryConnection();
      });
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [mode]);

  const retry = async () => {
    setBusy(true);
    try {
      await retryConnection();
    } finally {
      setBusy(false);
    }
  };

  const unsupported = mode === 'unsupported';
  return (
    <div className="mx-auto max-w-3xl py-6 sm:py-12" id="connect-daemon">
      <section className="glass-panel rounded-xl border border-line" data-reveal>
        <header className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4">
          <span className="glass-pill grid size-10 shrink-0 place-items-center rounded-full text-accent">
            {unsupported ? <CircleAlert className="size-5" aria-hidden /> : <Server className="size-5" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-[650] tracking-[-0.02em] text-fg">{unsupported ? 'Unsupported network' : 'Connect to your Silicr daemon'}</h1>
            <p className="mt-0.5 text-sm text-muted">
              {unsupported
                ? modeError
                : 'The terminal talks to a buyer or provider daemon running on Zcash testnet or mainnet. None answered. Start one, then retry.'}
            </p>
          </div>
          <Button variant="primary" size="md" icon={<RefreshCw className="size-4" aria-hidden />} loading={busy} onClick={() => void retry()} id="connect-retry">
            Retry
          </Button>
        </header>

        <div className="grid gap-3 p-5 sm:grid-cols-2">
          {COMMANDS.map((c) => (
            <div key={c.title} className="min-w-0 rounded-lg border border-line bg-sunken p-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <SquareTerminal className="size-4 text-faint" aria-hidden />
                <span className={c.real ? 'text-real' : 'text-fg'}>{c.title}</span>
              </div>
              <div className="mt-2 space-y-1.5">
                {c.lines.map((l) => (
                  <div key={l} className="flex items-center gap-1.5 rounded-md border border-line bg-black/60 px-2 py-1.5">
                    <code className="min-w-0 flex-1 font-mono text-2xs text-fg">{l}</code>
                    <CopyButton text={l} label="Copy command" />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-2xs text-muted">{c.note}</p>
            </div>
          ))}
        </div>

        <div className="border-t border-line px-5 py-3 text-xs text-muted">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {ROLES.map((r) => (
              <span key={r} className="flex min-w-0 items-center gap-1.5" title={conn[r].error ?? undefined}>
                <Dot tone={conn[r].status === 'online' ? 'ok' : conn[r].status === 'offline' ? 'bad' : 'neutral'} />
                <span className="capitalize text-fg">{r}</span>
                <span className="truncate font-mono text-faint">{hostOf(conn[r].url)}</span>
                <span>{conn[r].status === 'online' ? 'online' : conn[r].status === 'offline' ? 'no answer' : 'not checked'}</span>
              </span>
            ))}
          </div>
          {!unsupported && <p className="mt-1.5 text-2xs text-faint">Checking again every 5 seconds.</p>}
        </div>
      </section>
    </div>
  );
}
