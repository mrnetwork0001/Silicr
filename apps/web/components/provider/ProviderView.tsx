'use client';

import { BadgeCheck, Server, TriangleAlert } from '@/components/icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { hostOf } from '@/lib/config';
import { formatHeight, gpuLabel, networkLabel, toZats, zecString } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { gpuSummary } from '@/lib/market';
import { useSilicr } from '@/lib/store';
import { VerifiedBadge } from '../badges';
import { RealZecChip } from '../shell/ConnectionStatus';
import { Badge, Empty, ErrorNote, Mono, Panel, Skeleton, Stat, Zec } from '../ui';
import { CurrentJob, earnedTotal, isLiveJob, jobSortKey } from './CurrentJob';
import { JobsTable } from './JobsTable';
import { PolicyEditor } from './PolicyEditor';

export function ProviderView() {
  const mode = useSilicr((s) => s.mode);
  const conn = useSilicr((s) => s.conn.provider);
  const status = useSilicr((s) => s.providerStatus);
  const policy = useSilicr((s) => s.policy);
  const jobMap = useSilicr((s) => s.jobs);
  const jobsLoaded = useSilicr((s) => s.jobsLoaded);
  const jobsError = useSilicr((s) => s.jobsError);
  const jobLogs = useSilicr((s) => s.jobLogs);
  const rfqs = useSilicr((s) => s.rfqs);
  const providers = useSilicr((s) => s.providers);
  const now = useNow(1000);

  const jobs = useMemo(() => Object.values(jobMap).sort((a, b) => jobSortKey(b) - jobSortKey(a)), [jobMap]);
  const [selected, setSelected] = useState<string | null>(null);
  const live = jobs.find(isLiveJob);
  // Follow the live job unless the user picked one.
  useEffect(() => {
    if (!selected && (live || jobs[0])) setSelected((live ?? jobs[0])!.rfqId);
  }, [selected, live, jobs]);
  const current = (selected && jobMap[selected]) || live || jobs[0] || null;

  const online = mode === 'mock' || conn.status === 'online';
  const demo = mode === 'mock' || !!status?.demoMode;
  const entry = providers?.find((p) => p.providerId === status?.providerId);
  const earned = earnedTotal(jobs);
  const done = jobs.filter((j) => j.state === 'done').length;

  if (mode === 'probing') return <ProviderSkeleton />;
  if (!online && !status) {
    return (
      <Panel>
        <Empty icon={<Server className="size-6" />} title="Provider daemon not connected">
          This page talks to the provider daemon at {hostOf(conn.url)}. Start it with <code className="font-mono">silicr provide</code>, then reload.
          {conn.error ? ` (${conn.error})` : ''}
        </Empty>
      </Panel>
    );
  }

  const runner = status?.runner;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <div className="text-xs text-muted">Provider</div>
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold tracking-tight text-fg">
            {status?.alias ?? 'Unnamed provider'}
            {entry && <VerifiedBadge verified={entry.verified} />}
            {status?.network === 'main' && <RealZecChip />}
            {!online && <Badge tone="bad">offline</Badge>}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            {status?.providerId && (
              <span className="flex items-center gap-1">
                Directory key <Mono value={status.providerId} head={8} tail={6} className="text-fg" />
              </span>
            )}
            {status?.address && (
              <span className="flex items-center gap-1">
                RFQ address <Mono value={status.address} className="text-fg" />
              </span>
            )}
            {status && (
              <span className={status.network === 'main' ? 'font-medium text-real' : undefined}>
                {networkLabel(status.network)} · #{formatHeight(status.height)} · v{status.version}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-8">
          <Stat
            label="Shielded balance"
            value={status ? <Zec zats={status.balance.spendable} maxDecimals={4} /> : '—'}
            sub={status && toZats(status.balance.pending) > 0n ? `+${zecString(status.balance.pending)} ZEC pending` : 'spendable'}
          />
          <Stat label="Earned" value={<Zec zats={earned} maxDecimals={4} />} sub={`${done} job${done === 1 ? '' : 's'} done`} />
          <Stat label="Jobs" value={jobs.length} sub={live ? `1 ${live.state}` : 'none running'} />
        </div>
      </div>

      {runner && !runner.sandboxed && (
        <div role="alert" className="flex gap-3 rounded-lg border border-bad/50 bg-bad-soft px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-bad" aria-hidden />
          <div>
            <div className="font-semibold text-bad">Jobs run unsandboxed ({runner.mode} mode)</div>
            <p className="mt-0.5 text-xs leading-relaxed text-fg">
              {runner.warning ?? 'This runner is not a sandbox: jobs run as your user, can read your files and use the network. Use Docker for real jobs.'}
            </p>
          </div>
        </div>
      )}
      {runner?.sandboxed && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <BadgeCheck className="size-4 text-ok" aria-hidden /> Jobs run sandboxed ({runner.mode}: no network, read-only bundle).
        </div>
      )}
      {jobsError && !jobs.length && <ErrorNote title="Couldn't load jobs">{jobsError}</ErrorNote>}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-5">
          {!jobsLoaded && mode === 'real' ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <CurrentJob job={current} logs={current ? jobLogs[current.rfqId] : undefined} policy={policy} now={now} demo={demo} buyerHasIt={!!current && !!rfqs[current.rfqId]} />
          )}
          <JobsTable jobs={jobs} selected={current?.rfqId ?? null} onSelect={setSelected} now={now} />
        </div>
        <div className="min-w-0 space-y-5">
          <PolicyEditor policy={policy} disabled={online ? null : `Provider daemon offline (${hostOf(conn.url)})`} />
          <Panel title="Your directory entry" subtitle="What everyone can see. It holds nothing about buyers.">
            {entry ? (
              <dl className="space-y-2 p-4 text-xs">
                <Row k="Alias" v={entry.alias} />
                <Row k="GPUs" v={gpuSummary(entry)} />
                <Row k="Min price" v={<Zec zats={entry.minPricePerHourZats} suffix="/h" />} />
                <Row k="Bond" v={toZats(entry.bondZats) > 0n ? <Zec zats={entry.bondZats} /> : 'none'} />
                <Row k="Region" v={entry.region ?? 'not given'} />
                <Row k="Address" v={<Mono value={entry.address} />} />
                <Row k="Signature" v={<VerifiedBadge verified={entry.verified} compact />} />
              </dl>
            ) : (
              <p className="p-4 text-xs text-muted">
                {providers ? 'Not found in the directory this terminal loaded.' : 'Loading the directory…'}
                {policy?.gpus.length ? ` Offering ${policy.gpus.map((g) => `${g.count}× ${gpuLabel(g.model)}`).join(', ')}.` : ''}
              </p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 truncate text-right text-fg">{v}</dd>
    </div>
  );
}

function ProviderSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-12 w-80" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    </div>
  );
}
