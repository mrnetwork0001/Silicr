// The live terminal view of one RFQ: bids, payments (with txids), heartbeats and logs, from SSE.
import type { BidDto, ProviderJobDto, PublicTxViewDto, RfqDto, StatusDto } from '@silicr/api';
import { DaemonClient } from './client.ts';
import { shieldedBundle } from '@silicr/engine';
import { bytes, duration, event, pc, short, table, zec } from './format.ts';

type Rfq = RfqDto & {
  rfqTxids?: string[];
  rejectedBids?: number;
  paymentsWithheld?: boolean;
  resultVerified?: boolean;
  preparing?: { txid: string; notes: number; confirmations: number; required: number };
  payPolicy?: { leadS: number; jitterMaxS: number; maxExposureIntervals: number };
};

export interface FollowOptions {
  buyer: DaemonClient;
  /** Also show the provider's side (the demo runs both). */
  provider?: DaemonClient;
  rfqId: string;
  /** Stop when the bid window closes instead of at the end of the job (manual accept). */
  untilBidWindow?: boolean;
  /** At most one log line per this many ms (the rest are counted). Default 300. */
  logEveryMs?: number;
}

const TERMINAL = new Set(['closed', 'failed', 'expired']);

export function pricePerHour(b: { pricePerIntervalZats: string; intervalS: number }): bigint {
  return (BigInt(b.pricePerIntervalZats) * 3600n) / BigInt(b.intervalS);
}

export function printBids(bids: BidDto[]): void {
  if (bids.length === 0) {
    console.log(`  ${pc.dim('no bids')}`);
    return;
  }
  table(
    ['#', 'provider', 'price/h', 'per interval', 'interval', 'starts within', 'signature', 'txid'],
    bids.map((b, i) => [
      String(i + 1),
      `${b.alias} ${pc.dim(short(b.providerId, 8))}`,
      zec(b.pricePerHourZats),
      zec(b.pricePerIntervalZats),
      `${b.intervalS} s`,
      `${b.startWithinS} s`,
      b.signatureValid ? pc.green('valid') : pc.red('INVALID'),
      short(b.txid, 12),
    ]),
  );
}

export function follow(o: FollowOptions): Promise<Rfq> {
  const ctl = new AbortController();
  const logEveryMs = o.logEveryMs ?? 300;
  let prev: Rfq | null = null;
  let done = false;
  let lastLogAt = 0;
  let skipped = 0;
  let lastHbKey = '';
  let lastHbAt = 0;
  let prevJob: ProviderJobDto | null = null;
  let resolveP!: (r: Rfq) => void;
  let rejectP!: (e: unknown) => void;
  const p = new Promise<Rfq>((res, rej) => {
    resolveP = res;
    rejectP = rej;
  });

  const finish = (r: Rfq) => {
    if (done) return;
    done = true;
    ctl.abort();
    resolveP(r);
  };

  const showChain = (txid: string) => {
    o.buyer
      .get<PublicTxViewDto>(`/api/chain/tx/${txid}`)
      .then((v) => {
        const b = shieldedBundle(v);
        event(
          'chain',
          `public view of ${short(txid, 12)}: ${b.actions} shielded (${b.pool}) actions, fee ${v.feeZats === null || v.estimated?.includes('feeZats') ? 'unknown' : zec(v.feeZats)}, ` +
            `${v.transparent.inputs + v.transparent.outputs} transparent parts; ${pc.dim('no sender, recipients, amounts or memo text')}`,
        );
      })
      .catch(() => undefined);
  };

  const onRfq = (r: Rfq) => {
    if (done) return;
    const was = prev;
    prev = r;
    if (r.preparing && (r.preparing.confirmations !== was?.preparing?.confirmations || !was?.preparing)) {
      event(
        'info',
        `preparing funds: ${r.preparing.notes} job-sized notes (${r.preparing.confirmations}/${r.preparing.required} confirmations)  ${pc.dim('tx ' + short(r.preparing.txid, 12))}`,
      );
    }
    if (r.rfqTxid && !was?.rfqTxid) {
      const txs = r.rfqTxids && r.rfqTxids.length > 1 ? `${r.rfqTxids.length} txs (backend limit)` : '1 tx';
      event(
        'rfq',
        `${r.request.count}× ${r.request.gpu} for ${duration(r.request.durationS)}, max ${zec(r.request.maxPricePerHourZats)}/h${r.discloseMax === false ? ' (private)' : ''} → sealed to ` +
          `${r.providersAsked} provider(s) in ${txs}, ${r.paddedOutputs} outputs after padding  ${pc.dim('tx ' + short(r.rfqTxid, 12))}`,
      );
      showChain(r.rfqTxid);
    }
    const seenBid = new Set((was?.bids ?? []).map((b) => b.txid));
    for (const b of r.bids) {
      if (seenBid.has(b.txid)) continue;
      event(
        'bid',
        `${pc.bold(b.alias)}  ${zec(b.pricePerHourZats)}/h (${zec(b.pricePerIntervalZats)} per ${b.intervalS} s)  ` +
          `signature ${b.signatureValid ? pc.green('valid') : pc.red('INVALID')}  ${pc.dim('tx ' + short(b.txid, 12))}`,
      );
    }
    if ((r.rejectedBids ?? 0) > (was?.rejectedBids ?? 0)) event('bid', pc.red(`ignored ${(r.rejectedBids ?? 0) - (was?.rejectedBids ?? 0)} bid(s) that failed verification or policy`));
    if (r.accepted && !was?.accepted) {
      const p0 = r.payments.find((x) => x.seq === 0);
      event(
        'accept',
        `${pc.bold(r.accepted.alias)} · up to ${r.accepted.intervals} × ${r.accepted.intervalS} s intervals · interval #0 paid ` +
          `${zec(p0?.zats ?? r.accepted.pricePerIntervalZats)}  ${pc.dim('tx ' + short(p0?.txid, 12))}`,
      );
      event('job', 'job sealed to the channel key and uploaded to the relay (ciphertext only)');
      if (r.payPolicy) {
        const pp = r.payPolicy;
        const I = r.accepted.intervalS;
        event(
          'pay',
          pc.dim(
            `metered on the buyer's own clock: interval k is paid ${+pp.leadS.toFixed(2)}–${+(pp.leadS - pp.jitterMaxS).toFixed(2)} s before it starts, ` +
              `at a random point (no fixed cadence); heartbeats can only delay a payment. At most ${+pp.maxExposureIntervals.toFixed(3)} intervals ` +
              `(${+(I + pp.leadS).toFixed(2)} s of compute) at risk.`,
          ),
        );
      }
    }
    const seenPay = new Set((was?.payments ?? []).map((x) => x.txid));
    for (const pay of r.payments) {
      if (pay.seq === 0 || seenPay.has(pay.txid)) continue;
      event('pay', `#${pay.seq}  ${zec(pay.zats)}  ${pc.dim('tx ' + short(pay.txid, 12))}   ${pc.dim('total ' + zec(r.spentZats))}`);
    }
    const hb = r.heartbeats[0];
    if (hb) {
      const key = `${hb.status}/${hb.servingSeq}`;
      if (key !== lastHbKey || Date.now() - lastHbAt > 5000) {
        lastHbKey = key;
        lastHbAt = Date.now();
        const paint = hb.status === 'paused' || hb.status === 'failed' ? pc.red : (s: string) => s;
        event('hb', paint(`${hb.status} · step ${hb.step} · serving interval #${hb.servingSeq} · checkpoint ${short(hb.checkpointDigest, 8)} · signed`));
      }
    }
    if (r.paymentsWithheld && !was?.paymentsWithheld) event('fault', 'buyer stopped paying (fault injection): watch the provider pause, then stop');
    if (r.result && !was?.result) event('result', `${bytes(r.result.sizeBytes)} · sha256 ${short(r.result.digest, 16)} · decrypted and saved`);
    if (r.resultVerified === true && was?.resultVerified !== true) event('result', pc.green("digest matches the provider's signed CLOSE"));
    if (r.error && r.error !== was?.error && !TERMINAL.has(r.state)) event('error', r.error);
    if (TERMINAL.has(r.state)) {
      if (r.state === 'closed') {
        const paid = r.payments.length;
        event('close', `${r.closeReason ?? 'closed'} · ${paid} interval(s) paid: ${zec(r.spentZats)} + ${zec(r.feesZats)} fees and dust`);
      } else {
        event('error', `${r.state}${r.error ? `: ${r.error}` : ''}`);
      }
      finish(r);
    }
  };

  const onLog = (lines: string[]) => {
    for (const line of lines) {
      if (!line.trim()) continue;
      const now = Date.now();
      if (now - lastLogAt < logEveryMs) {
        skipped++;
        continue;
      }
      lastLogAt = now;
      const more = skipped > 0 ? pc.dim(`  (+${skipped} lines)`) : '';
      skipped = 0;
      console.log(`         ${pc.dim('│')} ${pc.dim(line.length > 110 ? line.slice(0, 110) + '…' : line)}${more}`);
    }
  };

  const onJob = (j: ProviderJobDto & { error?: string }) => {
    const was = prevJob;
    prevJob = j;
    if (was?.state === j.state) return;
    switch (j.state) {
      case 'won':
        event('provider', 'won the bid; fetching the sealed job from the relay');
        break;
      case 'running':
        if (was?.state === 'paused') event('watchdog', pc.green(`payment arrived: job resumed at interval #${j.servingSeq}`));
        else event('provider', `job running · earned so far ${zec(j.earnedZats)}`);
        break;
      case 'paused':
        event('watchdog', `interval #${j.servingSeq + 1} not paid: job paused`);
        break;
      case 'stopped':
        event('provider', `job stopped: ${j.stopReason ?? 'stopped'}${j.error ? ` (${j.error})` : ''} · earned ${zec(j.earnedZats)}`);
        break;
      case 'done':
        event('provider', `job done · result sealed and uploaded · earned ${zec(j.earnedZats)}`);
        break;
      default:
        break;
    }
  };

  o.buyer
    .events((e) => {
      if (e.type === 'rfq.updated' && e.rfq.rfqId === o.rfqId) onRfq(e.rfq as Rfq);
      else if (e.type === 'log' && e.rfqId === o.rfqId) onLog(e.lines);
    }, ctl.signal)
    .then(
      () => {
        if (!done) rejectP(new Error('the buyer daemon closed the event stream'));
      },
      (e) => {
        if (!done) rejectP(e);
      },
    );
  o.provider
    ?.events((e) => {
      if (e.type === 'job.updated' && e.job.rfqId === o.rfqId) onJob(e.job);
    }, ctl.signal)
    .catch(() => undefined);
  o.buyer
    .get<Rfq>(`/api/rfqs/${o.rfqId}`)
    .then(onRfq)
    .catch(() => undefined);

  if (o.untilBidWindow) {
    const t = setInterval(() => {
      if (done) {
        clearInterval(t);
        return;
      }
      o.buyer
        .get<StatusDto>('/api/status')
        .then((s) => {
          if (prev && s.height > prev.expiresHeight) {
            clearInterval(t);
            finish(prev);
          }
        })
        .catch(() => undefined);
    }, 1000);
  }
  return p;
}
