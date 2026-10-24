'use client';

import clsx from 'clsx';
import { BadgeCheck, Hourglass, ShieldX } from '@/components/icons';
import { useState } from 'react';
import type { RfqDto } from '@silicr/api';
import { errorMessage } from '@/lib/client';
import { getDriver } from '@/lib/driver';
import { formatDuration, formatHeight, formatTime, toZats } from '@/lib/format';
import { rankBids } from '@/lib/market';
import { Badge, Button, Empty, ErrorNote, Mono, Panel, Spinner, Td, Th, Zec } from '../ui';

export function BidTable({ rfq, explorer }: { rfq: RfqDto; explorer: (txid: string) => string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bids = rankBids(rfq.bids);
  const collecting = rfq.state === 'collecting';
  const best = bids.find((b) => b.signatureValid);
  const max = toZats(rfq.request.maxPricePerHourZats);

  const accept = async (providerId: string) => {
    const d = getDriver();
    if (!d) return;
    setBusy(providerId);
    setError(null);
    try {
      await d.accept(rfq.rfqId, providerId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Bids <span className="font-normal tabular-nums text-muted">{rfq.bids.length}</span>
        </span>
      }
      subtitle="Signed by each provider's directory key, sent to a one-time address made for this request"
      actions={
        <span className="flex items-center gap-2">
          {(rfq.rejectedBids ?? 0) > 0 && (
            <Badge tone="warn" title="Dropped: bad signature, provider not asked, above your max, late, or a refused (non-shielded) address">
              {rfq.rejectedBids} rejected
            </Badge>
          )}
          {collecting && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Spinner className="size-3.5" /> collecting
            </span>
          )}
        </span>
      }
    >
      {error && (
        <div className="px-4 pt-3">
          <ErrorNote title="Accept failed">{error}</ErrorNote>
        </div>
      )}
      {!bids.length ? (
        <Empty icon={<Hourglass className="size-6" />} title={collecting || rfq.state === 'broadcasting' ? 'Waiting for sealed bids…' : 'No bids arrived'}>
          {collecting || rfq.state === 'broadcasting'
            ? `Each of the ${rfq.providersAsked} providers decrypts the RFQ from its own shielded output and may answer with a signed bid.`
            : 'No provider answered before the request expired.'}
        </Empty>
      ) : (
        <div className="thin-scroll relative overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line">
                <Th>Provider</Th>
                <Th align="right">Price / h</Th>
                <Th align="right">Per interval</Th>
                <Th align="right">Interval</Th>
                <Th align="right">Start within</Th>
                <Th align="right">Bond</Th>
                <Th>Signature</Th>
                <Th>Block</Th>
                <Th>Received</Th>
                <Th align="right">
                  <span className="sr-only">Action</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {bids.map((b) => {
                const isAccepted = rfq.accepted?.providerId === b.providerId;
                const isBest = best?.providerId === b.providerId;
                const overMax = toZats(b.pricePerHourZats) > max;
                return (
                  <tr key={`${b.providerId}-${b.txid}`} className={clsx('animate-flash border-b border-line last:border-b-0', isAccepted && 'bg-accent-soft')}>
                    <Td>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-fg">{b.alias}</span>
                        {isAccepted && <Badge tone="accent">Accepted</Badge>}
                        {!isAccepted && isBest && collecting && <Badge tone="ok">Best</Badge>}
                      </div>
                    </Td>
                    <Td align="right">
                      <Zec zats={b.pricePerHourZats} className="font-semibold" />
                      {overMax && <div className="text-2xs text-warn">over your max</div>}
                    </Td>
                    <Td align="right">
                      <Zec zats={b.pricePerIntervalZats} />
                    </Td>
                    <Td align="right" className="tabular-nums text-muted">
                      {formatDuration(b.intervalS)}
                    </Td>
                    <Td align="right" className="tabular-nums text-muted">
                      {formatDuration(b.startWithinS)}
                    </Td>
                    <Td align="right">{toZats(b.bondZats) > 0n ? <Zec zats={b.bondZats} /> : <span className="text-faint">none</span>}</Td>
                    <Td>
                      {b.signatureValid ? (
                        <span className="inline-flex items-center gap-1 text-xs text-ok">
                          <BadgeCheck className="size-3.5" aria-hidden /> valid
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-bad">
                          <ShieldX className="size-3.5" aria-hidden /> invalid
                        </span>
                      )}
                    </Td>
                    <Td className="text-xs">
                      <div className="flex flex-col">
                        <span className={clsx('font-mono tabular-nums', b.height === null ? 'text-warn' : 'text-muted')}>{formatHeight(b.height)}</span>
                        <Mono value={b.txid} head={6} tail={4} href={explorer(b.txid)} className="text-2xs text-faint" />
                      </div>
                    </Td>
                    <Td className="font-mono text-xs tabular-nums text-muted">{formatTime(b.receivedAt)}</Td>
                    <Td align="right">
                      {collecting ? (
                        <Button
                          size="sm"
                          variant={isBest ? 'primary' : 'secondary'}
                          disabled={!b.signatureValid || (busy !== null && busy !== b.providerId)}
                          loading={busy === b.providerId}
                          onClick={() => accept(b.providerId)}
                          title={b.signatureValid ? `Accept: the ACCEPT transaction pays interval 0 to ${b.alias}` : 'Invalid signature: cannot accept'}
                        >
                          Accept
                        </Button>
                      ) : isAccepted ? (
                        <span className="text-xs text-accent">winner</span>
                      ) : (
                        <span className="text-xs text-faint">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
