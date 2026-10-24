'use client';

import clsx from 'clsx';
import { Coins } from '@/components/icons';
import type { PaymentDto } from '@silicr/api';
import { formatHeight, formatTime, zecString } from '@/lib/format';
import { Badge, Empty, Mono, Panel, Td, Th, Zec } from '../ui';

export function Payments({
  payments,
  explorer,
  title = 'Payments',
  subtitle = 'Each one is a separate shielded transaction to a fresh address of the provider',
  emptyText = 'The ACCEPT transaction pays interval 0; one PAY follows per interval.',
}: {
  payments: PaymentDto[];
  explorer: (txid: string) => string | null;
  title?: string;
  subtitle?: string;
  emptyText?: string;
}) {
  const list = [...payments].sort((a, b) => b.seq - a.seq);
  // A provider's received payments carry no fee for it; don't show a column of zeros.
  const showFee = list.some((p) => p.feeZats && p.feeZats !== '0');
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {title} <span className="font-normal tabular-nums text-muted">{payments.length}</span>
        </span>
      }
      subtitle={subtitle}
    >
      {!list.length ? (
        <Empty icon={<Coins className="size-6" />} title="No payments yet">
          {emptyText}
        </Empty>
      ) : (
        <div className="thin-scroll relative max-h-[340px] overflow-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead className="sticky top-0 z-[1] bg-panel">
              <tr className="border-b border-line">
                <Th>#</Th>
                <Th>Memo</Th>
                <Th align="right">Amount</Th>
                {showFee && <Th align="right">Fee</Th>}
                <Th>txid</Th>
                <Th>Block</Th>
                <Th align="right">Time</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={`${p.seq}-${p.txid}`} className="animate-flash border-b border-line last:border-b-0">
                  <Td className="font-mono tabular-nums text-muted">{p.seq}</Td>
                  <Td>
                    <Badge tone={p.kind === 'accept' ? 'accent' : 'neutral'} className="font-mono">
                      {p.kind === 'accept' ? 'ACCEPT' : 'PAY'}
                    </Badge>
                  </Td>
                  <Td align="right">
                    <Zec zats={p.zats} className="font-medium" />
                  </Td>
                  {showFee && (
                    <Td align="right" className="tabular-nums text-xs text-muted">
                      {zecString(p.feeZats)}
                    </Td>
                  )}
                  <Td>
                    <Mono value={p.txid} head={8} tail={6} href={explorer(p.txid)} className="text-xs text-muted" />
                  </Td>
                  <Td className={clsx('font-mono text-xs tabular-nums', p.height === null ? 'text-warn' : 'text-muted')}>{formatHeight(p.height)}</Td>
                  <Td align="right" className="font-mono text-xs tabular-nums text-muted">
                    {formatTime(p.at)}
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
