'use client';

import { ArrowLeft, BadgeCheck, Download, FileArchive, Loader2, ScanEye, Square } from '@/components/icons';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ProviderJobDto, RfqDto } from '@silicr/api';
import { errorMessage } from '@/lib/client';
import { config, explorerTxLink } from '@/lib/config';
import { getDriver } from '@/lib/driver';
import { CLOSE_REASON_LABEL, formatBytes, formatDateTime, formatDuration, gpuLabel } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { actions, getState, useSilicr } from '@/lib/store';
import { RfqStateBadge } from '../badges';
import { Badge, Button, Empty, ErrorNote, Kbd, Mono, Panel, Skeleton, Zec } from '../ui';
import { BidTable } from './BidTable';
import { CostMeter } from './CostMeter';
import { FaultMenu } from './FaultMenu';
import { Heartbeats } from './Heartbeats';
import { LogTail } from './LogTail';
import { Payments } from './Payments';
import { Timeline } from './Timeline';

export function RequestView({ id }: { id: string }) {
  const mode = useSilicr((s) => s.mode);
  const rfq = useSilicr((s) => s.rfqs[id]);
  const err = useSilicr((s) => s.rfqErrors[id]);
  const logs = useSilicr((s) => s.logs[id]);
  const buyerStatus = useSilicr((s) => s.buyerStatus);
  const job = useSilicr((s) => s.jobs[id]);
  const providerOnline = useSilicr((s) => s.mode === 'mock' || s.conn.provider.status === 'online');
  const now = useNow(1000);
  const demo = mode === 'mock' || !!buyerStatus?.demoMode;

  useEffect(() => {
    if (mode === 'probing') return;
    const d = getDriver();
    if (!d) return;
    void d.loadRfq(id);
    if (mode !== 'real') return;
    // SSE keeps the request fresh; poll only while the event stream is down.
    const t = setInterval(() => {
      if (getState().conn.buyer.sse !== 'open') void d.loadRfq(id);
    }, 3000);
    return () => clearInterval(t);
  }, [id, mode]);

  // Explorer links only for real chains the terminal knows an explorer for; never for the mock replay's random txids.
  const explorer = (txid: string) => (mode === 'real' ? explorerTxLink(txid, buyerStatus?.network) : null);

  if (!rfq) {
    if (mode === 'probing' || (!err && mode === 'real')) return <RequestSkeleton />;
    return (
      <Panel>
        <Empty
          title={err === 'offline' ? 'Buyer daemon not connected' : 'Request not found'}
          action={
            <Link href="/" className="text-sm text-accent hover:underline">
              Back to the market
            </Link>
          }
        >
          {err === 'offline'
            ? `Requests live in your buyer daemon (${config.buyerUrl}). Start it to see this one.`
            : mode === 'mock'
              ? 'Mock requests live only in this browser tab; reloading the page starts a fresh replay.'
              : err && err !== 'not_found'
                ? err
                : `The buyer daemon has no request ${id}.`}
        </Empty>
      </Panel>
    );
  }

  const accepted = !!rfq.accepted;
  const live = rfq.state === 'running' || rfq.state === 'accepted';

  return (
    <div className="space-y-4">
      <Header rfq={rfq} explorer={explorer} demo={demo} job={job} providerOnline={providerOnline} />
      <Timeline rfq={rfq} height={buyerStatus?.height ?? null} />
      {rfq.state === 'failed' && <ErrorNote title="This request failed">{rfq.error ?? 'No error detail from the daemon.'}</ErrorNote>}

      {/* ≤ 900px: both columns flatten into one list so the cost meter can sit first, right under the timeline. */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-4 max-[900px]:contents max-[900px]:space-y-0">
          <BidTable rfq={rfq} explorer={explorer} />
          {accepted && <LogTail lines={logs ?? rfq.logTail} live={live} />}
          {accepted && <Payments payments={rfq.payments} explorer={explorer} />}
        </div>
        <div className="min-w-0 space-y-4 max-[900px]:contents max-[900px]:space-y-0">
          <div className="min-w-0 max-[900px]:order-first">
            <CostMeter rfq={rfq} now={now} />
          </div>
          {accepted && <Heartbeats heartbeats={rfq.heartbeats} now={now} running={rfq.state === 'running'} withheld={!!job?.heartbeatsStopped} />}
          <ResultCard rfq={rfq} />
          <ChainCard rfq={rfq} />
        </div>
      </div>
    </div>
  );
}

function Header({
  rfq,
  explorer,
  demo,
  job,
  providerOnline,
}: {
  rfq: RfqDto;
  explorer: (txid: string) => string | null;
  demo: boolean;
  job: ProviderJobDto | undefined;
  providerOnline: boolean;
}) {
  const split = (rfq.rfqTxids?.length ?? 0) > 1;
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <Link href="/" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
          <ArrowLeft className="size-3" aria-hidden /> Market
        </Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold tracking-tight text-fg">
          <span>
            {rfq.request.count}× {gpuLabel(rfq.request.gpu)} for {formatDuration(rfq.request.durationS)}
          </span>
          <RfqStateBadge state={rfq.state} reason={rfq.closeReason} />
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="flex items-center gap-1">
            Request <Mono value={rfq.rfqId} head={8} tail={6} className="text-fg" />
          </span>
          <span title={rfq.discloseMax === false ? 'The RFQ memo carried 0 (undisclosed): providers bid their own price and this daemon dropped bids above your max.' : rfq.discloseMax ? 'Every provider asked saw this max in the RFQ memo.' : undefined}>
            max <Zec zats={rfq.request.maxPricePerHourZats} suffix="/h" />
            {rfq.discloseMax === false ? <span className="text-faint"> · withheld from providers</span> : rfq.discloseMax ? <span className="text-faint"> · disclosed</span> : null}
          </span>
          <span>sent {formatDateTime(rfq.createdAt)}</span>
          {rfq.rfqTxid && (
            <span className="flex items-center gap-1">
              RFQ tx <Mono value={rfq.rfqTxid} head={8} tail={6} href={explorer(rfq.rfqTxid)} className="text-fg" />
            </span>
          )}
          {split && (
            <Badge tone="warn" title="The backend's output limit forced the RFQ into several transactions. The chain can count them: a privacy trade-off.">
              RFQ split into {rfq.rfqTxids!.length} transactions
            </Badge>
          )}
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Button icon={<ScanEye className="size-3.5" aria-hidden />} onClick={() => actions.setInspector({ open: true, pinnedRfqId: rfq.rfqId })}>
          Inspect leaks <Kbd>L</Kbd>
        </Button>
        {demo && <FaultMenu rfq={rfq} job={job} providerReachable={providerOnline} />}
        <StopButton rfq={rfq} />
      </div>
    </div>
  );
}

function StopButton({ rfq }: { rfq: RfqDto }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const stoppable = ['broadcasting', 'collecting', 'accepted', 'running'].includes(rfq.state);
  if (!stoppable) return null;
  const before = rfq.state === 'collecting' || rfq.state === 'broadcasting';

  const click = async () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    const d = getDriver();
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      await d.stopRfq(rfq.rfqId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <div className="flex flex-col items-end">
      <Button variant="danger" loading={busy} icon={<Square className="size-3" aria-hidden />} onClick={click} title={before ? 'Withdraw: no ACCEPT is sent; the bids just expire' : 'Stop: sends a signed CLOSE; no further payments'}>
        {armed ? (before ? 'Confirm withdraw' : 'Confirm stop') : before ? 'Withdraw' : 'Stop job'}
      </Button>
      {error && <span className="mt-1 max-w-[260px] text-right text-2xs text-bad">{error}</span>}
    </div>
  );
}

function ResultCard({ rfq }: { rfq: RfqDto }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!rfq.result && rfq.state !== 'closing' && rfq.state !== 'closed') return null;

  const download = async () => {
    const d = getDriver();
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      await d.downloadResult(rfq.rfqId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Result" subtitle="Sealed by the provider, fetched from the relay, decrypted here">
      <div className="p-4">
        {rfq.result ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-md border border-line bg-sunken">
                <FileArchive className="size-4 text-accent" aria-hidden />
              </span>
              <div className="min-w-0 text-xs">
                <div className="font-medium text-fg">Result ready · {formatBytes(rfq.result.sizeBytes)}</div>
                <div className="flex items-center gap-1 text-muted">
                  digest <Mono value={rfq.result.digest} head={10} tail={6} />
                </div>
              </div>
            </div>
            <Button variant="primary" className="w-full" icon={<Download className="size-3.5" aria-hidden />} loading={busy} onClick={download}>
              Download result
            </Button>
            {rfq.resultVerified === false ? (
              <p className="text-2xs text-bad">The digest does NOT match the provider&apos;s signed CLOSE. Treat this result as untrusted.</p>
            ) : (
              <p className="flex items-center gap-1 text-2xs text-faint">
                {rfq.resultVerified && <BadgeCheck className="size-3 text-ok" aria-hidden />}
                {rfq.resultVerified ? 'Verified: the digest matches the provider’s signed CLOSE memo.' : 'Check: the digest should match the provider’s signed CLOSE memo.'}
              </p>
            )}
          </div>
        ) : rfq.state === 'closing' ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Settling the last interval and fetching the sealed result…
          </div>
        ) : (
          <p className="text-xs text-muted">No result{rfq.closeReason ? `: ${CLOSE_REASON_LABEL[rfq.closeReason].toLowerCase()}` : ''}.</p>
        )}
        {error && <p className="mt-2 text-2xs text-bad">{error}</p>}
      </div>
    </Panel>
  );
}

function ChainCard({ rfq }: { rfq: RfqDto }) {
  const txs = (rfq.rfqTxid ? 1 : 0) + rfq.bids.length + rfq.payments.length;
  return (
    <Panel title="What the public chain saw" subtitle="Every step is a fully shielded transaction">
      <div className="space-y-2.5 p-4 text-xs text-muted">
        <p>
          <span className="font-semibold tabular-nums text-fg">{txs}</span> shielded transactions so far: the RFQ ({rfq.paddedOutputs} actions, padded
          from {rfq.providersAsked} recipients), {rfq.bids.length} bids and {rfq.payments.length} payments. No transparent or Sapling parts, and
          nothing on the legacy Orchard pool.
        </p>
        <p>A block explorer sees action counts and fees. Not who paid whom, how much, or that this is Silicr traffic.</p>
        <Button size="sm" className="w-full" icon={<ScanEye className="size-3.5" aria-hidden />} onClick={() => actions.setInspector({ open: true, pinnedRfqId: rfq.rfqId })}>
          Compare all four viewpoints
        </Button>
      </div>
    </Panel>
  );
}

function RequestSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-12 w-96" />
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  );
}
