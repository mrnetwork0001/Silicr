'use client';

import clsx from 'clsx';
import { ArrowUpRight, Cpu, HeartOff, HeartPulse, ShieldCheck, Square } from '@/components/icons';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ProviderJobDto, ProviderPolicyDto } from '@silicr/api';
import { errorMessage } from '@/lib/client';
import type { ProviderJobExt, WatchdogState } from '@/lib/contract-ext';
import { getDriver } from '@/lib/driver';
import { CLOSE_REASON_LABEL, formatCountdown, formatDateTime, formatDuration, gpuLabel, perHourZats, toZats, zecString } from '@/lib/format';
import { JobStateBadge } from '../badges';
import { LogTail } from '../rfq/LogTail';
import { Payments } from '../rfq/Payments';
import { Button, Empty, Mono, Panel, Stat, Zec } from '../ui';

export interface Watchdog {
  state: WatchdogState;
  paidThroughSeq: number;
  deadlineAt?: number;
}

/** The provider's payment watchdog: from the daemon if it says, else derived from payments and policy. */
export function watchdogOf(job: ProviderJobDto, policy: ProviderPolicyDto | null): Watchdog {
  const paid = job.paymentsReceived.reduce((m, p) => Math.max(m, p.seq), -1);
  const ext = (job as ProviderJobExt).watchdog;
  if (ext) return { state: ext.state, paidThroughSeq: ext.paidThroughSeq ?? paid, deadlineAt: ext.deadlineAt };
  if (job.state === 'paused') return { state: 'paused', paidThroughSeq: paid };
  if (paid >= job.servingSeq) return { state: 'paid_ahead', paidThroughSeq: paid };
  const graceS = policy?.graceS ?? 0;
  const deadlineAt = job.startedAt ? job.startedAt + (job.servingSeq * job.bid.intervalS + graceS) * 1000 : undefined;
  return { state: 'grace', paidThroughSeq: paid, deadlineAt };
}

const WD_STEPS: { key: WatchdogState; label: string; hint: string }[] = [
  { key: 'paid_ahead', label: 'Paid ahead', hint: 'The interval being served is paid for' },
  { key: 'grace', label: 'Grace', hint: 'Payment late: still serving until the grace period ends' },
  { key: 'paused', label: 'Paused', hint: 'Job paused at a checkpoint; stops if payment stays missing' },
];

export function CurrentJob({
  job,
  logs,
  policy,
  now,
  demo,
  buyerHasIt,
}: {
  job: ProviderJobDto | null;
  logs: string[] | undefined;
  policy: ProviderPolicyDto | null;
  now: number;
  demo: boolean;
  buyerHasIt: boolean;
}) {
  if (!job) {
    return (
      <Panel title="Current job">
        <Empty icon={<Cpu className="size-6" />} title="No jobs yet">
          When an RFQ matches your policy, this daemon bids automatically. Won jobs show up here.
        </Empty>
      </Panel>
    );
  }
  const live = job.state === 'running' || job.state === 'paused' || job.state === 'won';
  const wd = watchdogOf(job, policy);
  const perHour = perHourZats(job.bid.pricePerIntervalZats, job.bid.intervalS);
  const intervals = job.intervals ?? Math.max(1, Math.ceil(job.request.durationS / job.bid.intervalS));

  return (
    <div className="space-y-4">
      <Panel
        title={
          <span className="flex items-center gap-2">
            {job.request.count}× {gpuLabel(job.request.gpu)} for {formatDuration(job.request.durationS)}
            <JobStateBadge state={job.state} reason={job.stopReason} />
          </span>
        }
        subtitle={
          <span className="flex items-center gap-1">
            Request <Mono value={job.rfqId} head={8} tail={6} /> · buyer: unknown (one-time key and reply address only)
          </span>
        }
        actions={
          <span className="flex items-center gap-2">
            {buyerHasIt && (
              <Link href={`/rfq/${job.rfqId}`} className="inline-flex items-center gap-0.5 text-xs text-accent hover:underline">
                Buyer view <ArrowUpRight className="size-3" aria-hidden />
              </Link>
            )}
            {live && <JobControls job={job} demo={demo} />}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 p-4 md:grid-cols-4">
          <Stat label="Price" value={<Zec zats={perHour} suffix="/h" />} sub={`${zecString(job.bid.pricePerIntervalZats)} ZEC per ${formatDuration(job.bid.intervalS)}`} />
          <Stat label="Serving" value={`interval ${job.servingSeq}`} sub={`of ${intervals} · heartbeat #${job.lastHeartbeatSeq}`} />
          <Stat label="Earned" value={<Zec zats={job.earnedZats} />} sub={`${job.paymentsReceived.length} payments${job.feesZats ? ` · fees ${zecString(job.feesZats)}` : ''}`} />
          <Stat
            label={job.stoppedAt ? 'Ended' : 'Started'}
            value={formatDateTime(job.stoppedAt ?? job.startedAt ?? null, now)}
            sub={job.stopReason ? CLOSE_REASON_LABEL[job.stopReason] : job.startedAt ? `running ${formatDuration((now - job.startedAt) / 1000)}` : 'not started'}
          />
        </div>

        {live ? (
          <Watchdog wd={wd} now={now} graceS={policy?.graceS ?? null} />
        ) : (
          <div className="border-t border-line px-4 py-3 text-xs text-muted">
            {job.state === 'lost'
              ? 'This bid lost. Losing bidders are never told who won, or whether anyone did.'
              : job.state === 'bid'
                ? 'Bid sent. Waiting for an ACCEPT before the RFQ expires.'
                : `Closed: ${job.stopReason ? CLOSE_REASON_LABEL[job.stopReason].toLowerCase() : job.state}.`}
            {job.resultDigest && (
              <span className="ml-1 inline-flex items-center gap-1">
                Result digest <Mono value={job.resultDigest} head={8} tail={6} />
              </span>
            )}
            {job.error && <span className="ml-1 text-bad">{job.error}</span>}
          </div>
        )}
      </Panel>

      {(live || job.state === 'done' || job.state === 'stopped') && (
        <LogTail lines={logs ?? job.logTail} live={job.state === 'running'} subtitle="The job's own output on this machine. Sent to the buyer sealed." />
      )}
      <Payments
        payments={job.paymentsReceived}
        explorer={() => null}
        title="Payments received"
        subtitle="Each to a fresh address of yours. The sender is not in the transaction."
        emptyText="Interval 0 arrives with the ACCEPT; one PAY follows per interval."
      />
    </div>
  );
}

function Watchdog({ wd, now, graceS }: { wd: Watchdog; now: number; graceS: number | null }) {
  const left = wd.deadlineAt ? wd.deadlineAt - now : null;
  return (
    <div className="border-t border-line p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-fg">
          <ShieldCheck className="size-3.5 text-accent" aria-hidden /> Payment watchdog
        </span>
        <span className="text-2xs text-muted">
          paid through interval <span className="font-mono text-fg">{wd.paidThroughSeq}</span>
          {graceS !== null && ` · grace ${graceS} s`}
        </span>
      </div>
      <ol className="grid grid-cols-3 gap-1.5" aria-label="Watchdog state">
        {WD_STEPS.map((s) => {
          const on = s.key === wd.state;
          return (
            <li
              key={s.key}
              aria-current={on ? 'step' : undefined}
              title={s.hint}
              className={clsx(
                'rounded-md border px-2.5 py-2 text-xs transition-colors',
                on
                  ? s.key === 'paid_ahead'
                    ? 'border-ok/40 bg-ok-soft text-ok'
                    : s.key === 'grace'
                      ? 'border-warn/40 bg-warn-soft text-warn'
                      : 'border-bad/40 bg-bad-soft text-bad'
                  : 'border-line text-faint',
              )}
            >
              <div className="font-semibold">{s.label}</div>
              <div className={clsx('mt-0.5 text-2xs', on ? 'opacity-90' : '')}>
                {on && s.key !== 'paid_ahead' && left !== null
                  ? `${s.key === 'grace' ? 'pause' : 'stop'} in ${formatCountdown(left)}`
                  : s.key === 'paid_ahead'
                    ? 'serving'
                    : s.key === 'grace'
                      ? 'payment late'
                      : 'then stop'}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function JobControls({ job, demo }: { job: ProviderJobDto; demo: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const hbStopped = !!job.heartbeatsStopped;
  const canFault = job.state === 'running' || job.state === 'paused';

  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-2">
        {demo && canFault && (
          <Button
            size="sm"
            icon={hbStopped ? <HeartPulse className="size-3.5" aria-hidden /> : <HeartOff className="size-3.5" aria-hidden />}
            loading={busy === 'hb'}
            className={clsx(hbStopped && 'border-warn/60 text-warn')}
            title="Demo fault injection: the buyer should stop paying when heartbeats stop"
            onClick={() => run('hb', async () => getDriver()?.providerFault(job.rfqId, hbStopped ? 'resume_heartbeats' : 'stop_heartbeats'))}
          >
            {hbStopped ? 'Resume heartbeats' : 'Stop heartbeats'}
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          icon={<Square className="size-3" aria-hidden />}
          loading={busy === 'stop'}
          onClick={() => {
            if (!armed) {
              setArmed(true);
              timer.current = setTimeout(() => setArmed(false), 4000);
              return;
            }
            setArmed(false);
            void run('stop', async () => getDriver()?.stopJob(job.rfqId));
          }}
        >
          {armed ? 'Confirm stop' : 'Stop job'}
        </Button>
      </span>
      {error && <span className="max-w-[300px] text-right text-2xs text-bad">{error}</span>}
    </span>
  );
}

export function jobSortKey(j: ProviderJobDto): number {
  return j.startedAt ?? j.paymentsReceived[0]?.at ?? j.stoppedAt ?? 0;
}

export function isLiveJob(j: ProviderJobDto): boolean {
  return j.state === 'running' || j.state === 'paused' || j.state === 'won';
}

export function earnedTotal(jobs: ProviderJobDto[]): bigint {
  return jobs.reduce((sum, j) => sum + toZats(j.earnedZats), 0n);
}
