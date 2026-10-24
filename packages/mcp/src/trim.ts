// RfqDto, trimmed for an LLM caller: ZEC as decimals, times as ISO strings, capped lists.
import type { BidDto, HeartbeatDto, PaymentDto, RfqDto } from '@silicr/api';
import { formatZec, zatsOf, zec } from './zec.ts';

export const TERMINAL_STATES = new Set<RfqDto['state']>(['closed', 'expired', 'failed']);

const iso = (ms: number | undefined | null): string | undefined => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined);
const hours = (durationS: number): number => +(durationS / 3600).toFixed(4);

export function bidView(b: BidDto) {
  return {
    alias: b.alias,
    providerId: b.providerId,
    zecPerHour: zec(b.pricePerHourZats),
    zecPerInterval: zec(b.pricePerIntervalZats),
    intervalS: b.intervalS,
    startWithinS: b.startWithinS,
    ...(b.bondZats !== undefined ? { bondZec: zec(b.bondZats) } : {}),
    signatureValid: b.signatureValid,
    height: b.height,
    receivedAt: iso(b.receivedAt),
  };
}

function paymentView(p: PaymentDto) {
  return { seq: p.seq, kind: p.kind, zec: zec(p.zats), feeZec: zec(p.feeZats), height: p.height, at: iso(p.at) };
}

function heartbeatView(h: HeartbeatDto) {
  return { seq: h.seq, status: h.status, servingSeq: h.servingSeq, step: h.step, at: iso(h.at), ...(h.note ? { note: h.note } : {}) };
}

export interface TrimOptions {
  logLines?: number;
  heartbeats?: number;
  payments?: number;
}

/** The whole request, trimmed: what an agent needs to decide its next step. */
export function trimRfq(r: RfqDto, o: TrimOptions = {}) {
  const logLines = o.logLines ?? 12;
  const nHeartbeats = o.heartbeats ?? 3;
  const nPayments = o.payments ?? 3;
  const latestHeartbeat = r.heartbeats[0];
  const paidThroughSeq = r.payments.reduce((m, p) => Math.max(m, p.seq), -1);
  const accepted = r.accepted
    ? {
        alias: r.accepted.alias,
        providerId: r.accepted.providerId,
        zecPerInterval: zec(r.accepted.pricePerIntervalZats),
        intervalS: r.accepted.intervalS,
        intervals: r.accepted.intervals,
        maxZec: formatZec(zatsOf(r.accepted.pricePerIntervalZats) * BigInt(r.accepted.intervals)),
      }
    : undefined;
  return {
    rfqId: r.rfqId,
    state: r.state,
    terminal: TERMINAL_STATES.has(r.state),
    ...(r.closeReason ? { closeReason: r.closeReason } : {}),
    ...(r.error ? { error: r.error } : {}),
    createdAt: iso(r.createdAt),
    ...(r.closedAt ? { closedAt: iso(r.closedAt) } : {}),
    ...(r.jobStartedAt ? { jobStartedAt: iso(r.jobStartedAt) } : {}),
    request: {
      gpu: r.request.gpu,
      count: r.request.count,
      durationS: r.request.durationS,
      hours: hours(r.request.durationS),
      maxZecPerHour: zec(r.request.maxPricePerHourZats),
      ...(r.discloseMax === undefined ? {} : { budget: r.discloseMax ? 'disclosed to providers' : 'undisclosed to providers' }),
    },
    providersAsked: r.providersAsked,
    paddedOutputs: r.paddedOutputs,
    expiresHeight: r.expiresHeight,
    ...(r.rfqTxid ? { rfqTxid: r.rfqTxid } : {}),
    ...(r.rejectedBids ? { rejectedBids: r.rejectedBids } : {}),
    bids: r.bids.map(bidView),
    ...(accepted ? { accepted } : {}),
    payments: {
      count: r.payments.length,
      paidThroughSeq,
      spentZec: zec(r.spentZats),
      feesZec: zec(r.feesZats),
      ...(r.nextPaymentAt ? { nextPaymentAt: iso(r.nextPaymentAt) } : {}),
      ...(r.paymentsWithheld ? { paymentsWithheld: true } : {}),
      recent: r.payments.slice(-nPayments).map(paymentView),
    },
    heartbeats: {
      count: r.heartbeats.length,
      ...(latestHeartbeat ? { latest: heartbeatView(latestHeartbeat) } : {}),
      recent: r.heartbeats.slice(0, nHeartbeats).map(heartbeatView),
    },
    logTail: r.logTail.slice(-logLines),
    ...(r.result
      ? { result: { sealedDigest: r.result.digest, sizeBytes: r.result.sizeBytes, ...(r.resultVerified !== undefined ? { verified: r.resultVerified } : {}) } }
      : {}),
    ...(r.payPolicy ? { payPolicy: r.payPolicy } : {}),
    ...(r.preparing ? { preparing: r.preparing } : {}),
  };
}

/** One line per request, for lists. */
export function summarizeRfq(r: RfqDto) {
  return {
    rfqId: r.rfqId,
    state: r.state,
    terminal: TERMINAL_STATES.has(r.state),
    ...(r.closeReason ? { closeReason: r.closeReason } : {}),
    ...(r.error ? { error: r.error } : {}),
    createdAt: iso(r.createdAt),
    request: `${r.request.count}× ${r.request.gpu}, ${hours(r.request.durationS)} h, ≤ ${zec(r.request.maxPricePerHourZats)} ZEC/h`,
    bids: r.bids.length,
    ...(r.accepted ? { provider: r.accepted.alias } : {}),
    spentZec: zec(r.spentZats),
    feesZec: zec(r.feesZats),
    hasResult: !!r.result,
  };
}

export type RequestView = ReturnType<typeof trimRfq>;
export type RequestSummary = ReturnType<typeof summarizeRfq>;
