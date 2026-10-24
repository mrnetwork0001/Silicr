'use client';

import clsx from 'clsx';
import { Check, X } from '@/components/icons';
import type { RfqDto } from '@silicr/api';
import { CLOSE_REASON_LABEL, formatHeight, formatTime, perHourZats, zecString } from '@/lib/format';

type StepStatus = 'done' | 'active' | 'pending' | 'failed' | 'skipped';

interface Step {
  label: string;
  status: StepStatus;
  detail: string;
  at?: number;
}

export function timelineSteps(r: RfqDto, currentHeight: number | null): Step[] {
  const s = r.state;
  const ran = r.payments.length > 0 && !!r.accepted;
  const accepted = !!r.accepted;
  const order = ['broadcasting', 'collecting', 'accepted', 'running', 'closing', 'closed'] as const;
  const idx = (order as readonly string[]).indexOf(s);
  const at = (i: number) => (idx < 0 ? 'pending' : idx > i ? 'done' : idx === i ? 'active' : 'pending') as StepStatus;

  const firstPay = r.payments.find((p) => p.seq === 0);
  const lastPay = r.payments[r.payments.length - 1];
  // Heartbeats are capped (most recent first), so neither end of the list marks the start.
  const lastActivity = Math.max(lastPay?.at ?? 0, r.heartbeats[0]?.at ?? 0, r.createdAt);
  const blocksLeft = currentHeight !== null ? r.expiresHeight - currentHeight : null;

  const steps: Step[] = [
    {
      label: 'Broadcast',
      status: at(0),
      detail: r.rfqTxid
        ? `${r.providersAsked} asked · ${r.paddedOutputs} outputs${(r.rfqTxids?.length ?? 0) > 1 ? ` · ${r.rfqTxids!.length} txs` : ''}`
        : r.preparing
          ? `preparing funds ${r.preparing.confirmations}/${r.preparing.required}`
          : 'building shielded tx…',
      at: r.createdAt,
    },
    {
      label: 'Bids',
      status: at(1),
      detail:
        s === 'collecting'
          ? `${r.bids.length} in · expires #${formatHeight(r.expiresHeight)}${blocksLeft !== null && blocksLeft >= 0 ? ` (${blocksLeft} blocks)` : ''}`
          : `${r.bids.length} received`,
      at: r.bids[0]?.receivedAt,
    },
    {
      label: 'Accepted',
      status: at(2),
      detail: r.accepted ? `${r.accepted.alias} · ${zecString(perHourZats(r.accepted.pricePerIntervalZats, r.accepted.intervalS))} ZEC/h` : '—',
      at: firstPay?.at,
    },
    {
      label: 'Running',
      status: at(3),
      detail: r.accepted && r.payments.length ? `${r.payments.length} of ${r.accepted.intervals} intervals paid` : '—',
      at: r.payments.find((p) => p.seq === 1)?.at,
    },
    {
      label: 'Closed',
      status: s === 'closed' ? 'done' : s === 'closing' ? 'active' : 'pending',
      detail: r.closeReason ? CLOSE_REASON_LABEL[r.closeReason] : s === 'closing' ? 'settling, fetching result' : '—',
      at: s === 'closed' ? (r as { closedAt?: number }).closedAt ?? lastActivity : undefined,
    },
  ];

  if (s === 'closing') steps[3]!.status = ran ? 'done' : 'skipped';
  if (s === 'closed') {
    steps[1]!.status = 'done';
    steps[2]!.status = accepted ? 'done' : 'skipped';
    steps[3]!.status = ran ? 'done' : 'skipped';
    if (r.closeReason && r.closeReason !== 'done' && r.closeReason !== 'buyer_stop') steps[4]!.status = 'failed';
  }
  if (s === 'expired') {
    steps[0]!.status = 'done';
    steps[1] = { ...steps[1]!, status: 'failed', detail: `expired at #${formatHeight(r.expiresHeight)} · ${r.bids.length} bids` };
    for (const i of [2, 3, 4]) steps[i]!.status = 'skipped';
  }
  if (s === 'failed') {
    const where = r.accepted ? (ran ? 3 : 2) : r.rfqTxid ? 1 : 0;
    steps.forEach((st, i) => {
      st.status = i < where ? 'done' : i === where ? 'failed' : 'skipped';
    });
    steps[where]!.detail = r.error ?? 'failed';
  }
  return steps;
}

export function Timeline({ rfq, height }: { rfq: RfqDto; height: number | null }) {
  const steps = timelineSteps(rfq, height);
  return (
    <ol className="grid grid-cols-5 gap-0 rounded-lg border border-line bg-panel px-2 py-3" aria-label="Request timeline">
      {steps.map((st, i) => (
        <li key={st.label} className="relative flex min-w-0 flex-col items-center px-2 text-center" aria-current={st.status === 'active' ? 'step' : undefined}>
          {i > 0 && (
            <span
              aria-hidden
              className={clsx(
                'absolute right-1/2 top-[11px] h-px w-full',
                st.status === 'pending' || st.status === 'skipped' ? 'bg-line-strong' : 'bg-accent',
              )}
            />
          )}
          <span
            className={clsx(
              'relative z-[1] flex size-[22px] items-center justify-center rounded-full border text-[10px] font-semibold',
              st.status === 'done' && 'border-accent bg-accent text-accent-fg',
              st.status === 'active' && 'border-accent bg-panel text-accent ring-4 ring-accent-soft',
              st.status === 'pending' && 'border-line-strong bg-panel text-faint',
              st.status === 'skipped' && 'border-dashed border-line-strong bg-panel text-faint',
              st.status === 'failed' && 'border-warn bg-warn-soft text-warn',
            )}
          >
            {st.status === 'done' ? (
              <Check className="size-3" aria-hidden />
            ) : st.status === 'failed' ? (
              <X className="size-3" aria-hidden />
            ) : st.status === 'active' ? (
              <span className="live-dot size-2 rounded-full bg-accent text-accent" />
            ) : (
              i + 1
            )}
          </span>
          <span className={clsx('mt-2 text-xs font-semibold', st.status === 'pending' || st.status === 'skipped' ? 'text-faint' : 'text-fg')}>{st.label}</span>
          <span className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-muted">{st.status === 'skipped' ? 'skipped' : st.detail}</span>
          {st.at && st.status !== 'pending' && st.status !== 'skipped' ? (
            <span className="mt-0.5 font-mono text-[10px] tabular-nums text-faint">{formatTime(st.at)}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
