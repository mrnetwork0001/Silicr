'use client';

import { BadgeCheck, ShieldAlert } from '@/components/icons';
import type { CloseReason, ProviderJobState, RfqState } from '@silicr/api';
import { CLOSE_REASON_LABEL, JOB_STATE_LABEL, RFQ_STATE_LABEL } from '@/lib/format';
import { Badge, Dot, type Tone } from './ui';

const RFQ_TONE: Record<RfqState, Tone> = {
  broadcasting: 'accent',
  collecting: 'accent',
  accepted: 'accent',
  running: 'ok',
  closing: 'neutral',
  closed: 'neutral',
  expired: 'warn',
  failed: 'bad',
};

const LIVE: ReadonlySet<RfqState> = new Set(['broadcasting', 'collecting', 'accepted', 'running', 'closing']);

export function RfqStateBadge({ state, reason }: { state: RfqState; reason?: CloseReason }) {
  let tone = RFQ_TONE[state];
  if (state === 'closed' && reason && reason !== 'done' && reason !== 'buyer_stop') tone = 'warn';
  const label = state === 'closed' && reason === 'done' ? 'Done' : RFQ_STATE_LABEL[state];
  return (
    <Badge tone={tone} title={reason ? CLOSE_REASON_LABEL[reason] : undefined}>
      {LIVE.has(state) && <Dot tone={tone} pulse />}
      {label}
    </Badge>
  );
}

const JOB_TONE: Record<ProviderJobState, Tone> = {
  bid: 'accent',
  won: 'accent',
  lost: 'neutral',
  running: 'ok',
  paused: 'warn',
  stopped: 'warn',
  done: 'neutral',
};

export function JobStateBadge({ state, reason }: { state: ProviderJobState; reason?: CloseReason }) {
  const tone = state === 'stopped' && reason === 'buyer_stop' ? 'neutral' : JOB_TONE[state];
  return (
    <Badge tone={tone} title={reason ? CLOSE_REASON_LABEL[reason] : undefined}>
      {(state === 'running' || state === 'bid' || state === 'paused') && <Dot tone={tone} pulse={state !== 'paused'} />}
      {JOB_STATE_LABEL[state]}
    </Badge>
  );
}

export function VerifiedBadge({ verified, compact }: { verified: boolean; compact?: boolean }) {
  return verified ? (
    <Badge tone="ok" icon={<BadgeCheck className="size-3" aria-hidden />} title="Directory signature verified by your daemon">
      {compact ? 'Signed' : 'Verified'}
    </Badge>
  ) : (
    <Badge tone="bad" icon={<ShieldAlert className="size-3" aria-hidden />} title="Directory signature does NOT verify. Silicr will not send RFQs to this entry.">
      Bad signature
    </Badge>
  );
}
