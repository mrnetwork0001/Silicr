'use client';

import clsx from 'clsx';
import { ChevronRight, Inbox } from '@/components/icons';
import Link from 'next/link';
import type { RfqDto } from '@silicr/api';
import { formatAgo, formatDuration, gpuLabel, toZats } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { RfqStateBadge } from '../badges';
import { Empty, Panel, Skeleton, Zec } from '../ui';

const STEPS = ['Broadcast', 'Bids', 'Accepted', 'Running', 'Closed'] as const;

/** Where a request sits on the broadcast → bids → accepted → running → closed rail, and how it ended. */
function railOf(r: RfqDto): { at: number; tone: 'live' | 'done' | 'warn' | 'bad' } {
  switch (r.state) {
    case 'broadcasting':
      return { at: 0, tone: 'live' };
    case 'collecting':
      return { at: 1, tone: 'live' };
    case 'accepted':
      return { at: 2, tone: 'live' };
    case 'running':
      return { at: 3, tone: 'live' };
    case 'closing':
      return { at: 4, tone: 'live' };
    case 'closed':
      return { at: 4, tone: r.closeReason && r.closeReason !== 'done' && r.closeReason !== 'buyer_stop' ? 'warn' : 'done' };
    case 'expired':
      return { at: 1, tone: 'warn' };
    case 'failed':
      return { at: r.accepted ? (toZats(r.spentZats) > 0n ? 3 : 2) : r.bids.length ? 1 : 0, tone: 'bad' };
  }
}

function Rail({ r }: { r: RfqDto }) {
  const { at, tone } = railOf(r);
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1" aria-hidden>
        {STEPS.map((s, i) => (
          <div key={s} className={clsx('flex items-center gap-1', i < STEPS.length - 1 && 'flex-1')}>
            <span
              className="rail-node"
              data-on={i <= at}
              data-current={i === at && tone !== 'done'}
              data-tone={i === at && tone !== 'live' ? tone : undefined}
            />
            {i < STEPS.length - 1 && <span className="rail-seg" data-on={i < at} />}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-5 text-[10px] text-faint">
        {STEPS.map((s, i) => (
          <span key={s} className={clsx(i === 0 ? 'text-left' : i === STEPS.length - 1 ? 'text-right' : 'text-center', i === at && 'font-medium text-secondary')}>
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

export function RequestList({ rfqs, loading, offline }: { rfqs: RfqDto[]; loading: boolean; offline: boolean }) {
  const now = useNow(10_000);
  return (
    <Panel title="Your requests" subtitle="Held by your buyer daemon only">
      {loading && !rfqs.length ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : !rfqs.length ? (
        <Empty icon={<Inbox className="size-6" />} title={offline ? 'Buyer daemon not connected' : 'No requests yet'}>
          {offline ? 'Your requests live in the buyer daemon. Start it to see them here.' : 'Send a sealed request with the form. It will show up here.'}
        </Empty>
      ) : (
        <ul className="grid gap-3 p-4 lg:grid-cols-2">
          {rfqs.map((r) => {
            const spent = toZats(r.spentZats);
            return (
              <li key={r.rfqId} className="min-w-0">
                <Link
                  href={`/rfq/${r.rfqId}`}
                  className="lift group block rounded-xl border border-line bg-[linear-gradient(180deg,rgba(255,190,140,0.03),transparent)] px-3.5 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-fg">
                        {r.request.count}× {gpuLabel(r.request.gpu)} · {formatDuration(r.request.durationS)}
                        {r.accepted && <span className="font-normal text-muted"> · {r.accepted.alias}</span>}
                      </div>
                      <div className="truncate font-mono text-2xs text-faint" title={r.rfqId}>
                        {r.rfqId}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <RfqStateBadge state={r.state} reason={r.closeReason} />
                      <ChevronRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </div>
                  </div>
                  <Rail r={r} />
                  <div className="mt-2.5 flex items-center gap-3 border-t border-line pt-2 text-xs">
                    <span className="text-muted tabular-nums">
                      {r.bids.length} bid{r.bids.length === 1 ? '' : 's'}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{spent > 0n ? <>paid <Zec zats={spent} /></> : <span className="text-faint">nothing paid</span>}</span>
                    <span className="shrink-0 text-faint tabular-nums">{formatAgo(r.createdAt, now)}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
