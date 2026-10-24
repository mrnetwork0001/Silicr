'use client';

import clsx from 'clsx';
import { ChevronDown, FlaskConical, HeartOff, HeartPulse, Pause, Play } from '@/components/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BuyerFault, ProviderFault, ProviderJobDto, RfqDto } from '@silicr/api';
import { errorMessage } from '@/lib/client';
import { getDriver } from '@/lib/driver';
import { Button } from '../ui';

/**
 * Demo-mode fault injection (PRD demo step 5): make the buyer stop paying, or the
 * provider stop sending heartbeats, and watch the other side's watchdog react.
 */
export function FaultMenu({ rfq, job, providerReachable }: { rfq: RfqDto; job: ProviderJobDto | undefined; providerReachable: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const live = rfq.state === 'running' || rfq.state === 'accepted';
  if (!live) return null;

  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await f();
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const buyer = (fault: BuyerFault) => run(fault, async () => getDriver()?.buyerFault(rfq.rfqId, fault));
  const provider = (fault: ProviderFault) => run(fault, async () => getDriver()?.providerFault(rfq.rfqId, fault));

  const withheld = !!rfq.paymentsWithheld;
  const hbStopped = !!job?.heartbeatsStopped;
  const providerServes = providerReachable && !!job && (job.state === 'running' || job.state === 'paused' || job.state === 'won');

  return (
    <div ref={ref} className="relative">
      <Button
        icon={<FlaskConical className="size-3.5" aria-hidden />}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={clsx((withheld || hbStopped) && 'border-warn/60 text-warn')}
      >
        Simulate fault
        <ChevronDown className="size-3.5 text-faint" aria-hidden />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-20 w-[320px] rounded-lg border border-line bg-raised p-1 text-xs shadow-[var(--shadow-pop)]">
          <p className="px-2.5 pb-1.5 pt-2 text-2xs text-faint">Demo mode only. Watch the other side&apos;s watchdog react; the buyer is never more than about one interval ahead (the prepaid one).</p>
          <Item
            icon={withheld ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            title={withheld ? 'Buyer: resume paying' : 'Buyer: stop paying'}
            body={withheld ? 'Send the withheld interval payment and continue.' : 'The provider pauses the job after its grace period, then stops it.'}
            busy={busy === 'stop_paying' || busy === 'resume_paying'}
            onClick={() => buyer(withheld ? 'resume_paying' : 'stop_paying')}
          />
          <Item
            icon={hbStopped ? <HeartPulse className="size-3.5" /> : <HeartOff className="size-3.5" />}
            title={hbStopped ? 'Provider: resume heartbeats' : 'Provider: stop heartbeats'}
            body={
              providerServes
                ? hbStopped
                  ? 'Heartbeats start again; payments continue if the buyer has not closed yet.'
                  : 'The buyer sees no progress, stops paying and closes the job.'
                : 'Needs the winning provider daemon on this machine.'
            }
            disabled={!providerServes}
            busy={busy === 'stop_heartbeats' || busy === 'resume_heartbeats'}
            onClick={() => provider(hbStopped ? 'resume_heartbeats' : 'stop_heartbeats')}
          />
          {error && <p className="px-2.5 py-1.5 text-2xs text-bad">{error}</p>}
        </div>
      )}
    </div>
  );
}

function Item({ icon, title, body, onClick, busy, disabled }: { icon: ReactNode; title: string; body: string; onClick: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled || busy}
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="mt-0.5 text-warn" aria-hidden>
        {icon}
      </span>
      <span>
        <span className="block font-medium text-fg">{busy ? 'Sending…' : title}</span>
        <span className="block text-2xs text-muted">{body}</span>
      </span>
    </button>
  );
}
