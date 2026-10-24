'use client';

import clsx from 'clsx';
import { Briefcase } from '@/components/icons';
import type { ProviderJobDto } from '@silicr/api';
import { formatDateTime, formatDuration, gpuLabel, perHourZats, truncateMiddle } from '@/lib/format';
import { JobStateBadge } from '../badges';
import { Empty, Panel, Td, Th, Zec } from '../ui';

export function JobsTable({
  jobs,
  selected,
  onSelect,
  now,
}: {
  jobs: ProviderJobDto[];
  selected: string | null;
  onSelect: (rfqId: string) => void;
  now: number;
}) {
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Jobs <span className="font-normal tabular-nums text-muted">{jobs.length}</span>
        </span>
      }
      subtitle="Every RFQ this provider bid on. No buyer column: it never learns who they are."
    >
      {!jobs.length ? (
        <Empty icon={<Briefcase className="size-6" />} title="No jobs yet">
          Bids, wins and losses appear here.
        </Empty>
      ) : (
        <div className="thin-scroll relative overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line">
                <Th>Request</Th>
                <Th>State</Th>
                <Th align="right">Price / h</Th>
                <Th align="right">Interval</Th>
                <Th align="right">Paid</Th>
                <Th align="right">Earned</Th>
                <Th align="right">When</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr
                  key={j.rfqId}
                  onClick={() => onSelect(j.rfqId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(j.rfqId);
                    }
                  }}
                  tabIndex={0}
                  aria-selected={selected === j.rfqId}
                  className={clsx('cursor-pointer border-b border-line outline-none transition-colors last:border-b-0 hover:bg-hover focus-visible:bg-hover', selected === j.rfqId && 'bg-accent-soft')}
                >
                  <Td>
                    <div className="flex flex-col">
                      <span className="font-medium text-fg">
                        {j.request.count}× {gpuLabel(j.request.gpu)} · {formatDuration(j.request.durationS)}
                      </span>
                      <span className="font-mono text-2xs text-faint">{truncateMiddle(j.rfqId, 8, 6)}</span>
                    </div>
                  </Td>
                  <Td>
                    <JobStateBadge state={j.state} reason={j.stopReason} />
                  </Td>
                  <Td align="right">
                    <Zec zats={perHourZats(j.bid.pricePerIntervalZats, j.bid.intervalS)} />
                  </Td>
                  <Td align="right" className="tabular-nums text-muted">
                    {formatDuration(j.bid.intervalS)}
                  </Td>
                  <Td align="right" className="tabular-nums text-muted">
                    {j.paymentsReceived.length}
                    {j.intervals ? ` / ${j.intervals}` : ''}
                  </Td>
                  <Td align="right">
                    <Zec zats={j.earnedZats} className="font-medium" />
                  </Td>
                  <Td align="right" className="text-xs tabular-nums text-muted">
                    {formatDateTime(j.startedAt ?? j.paymentsReceived[0]?.at ?? j.stoppedAt ?? null, now)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
