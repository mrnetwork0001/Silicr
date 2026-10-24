/**
 * Builds the Leak Inspector's four columns for one request from the store:
 *   chain    public views of every txid this terminal knows for the request
 *   relay    everything the relay saw during the request's time window (it can't link blobs to requests)
 *   provider / buyer   each daemon's own observations for the request
 * plus the summary matrix computed from those fields.
 */

import type { LeakObservation, NetworkName, Party, ProviderJobDto, PublicTxViewDto, RfqDto } from '@silicr/api';
import { hostOf } from './config';
import type { FactKey, LeakFieldExt, RfqExt } from './contract-ext';
import { classifyObservation, computeMatrix, FACTS, PARTIES, type ClassifiedField, type Matrix } from './facts';
import { formatBytes, formatDuration, formatHeight, formatInt, formatTime, formatZec, gpuLabel, RFQ_STATE_LABEL, JOB_STATE_LABEL, truncateMiddle } from './format';
import type { State } from './store';

export interface InspField extends ClassifiedField {
  tokens: string[];
}

export interface InspObs {
  obs: LeakObservation;
  fields: InspField[];
  group: string;
  synthetic: boolean;
  /** Chain views: how this terminal got the view (exact broadcast copy, partial compact block, …). */
  badge?: { label: string; tone: 'ok' | 'warn' | 'neutral' };
}

export interface ObsGroup {
  key: string;
  latest: InspObs;
  /** Newest first; includes `latest`. */
  items: InspObs[];
}

export interface Column {
  party: Party;
  available: boolean;
  /** Why this party's view isn't shown. */
  reason: string | null;
  /** Context for reading the column honestly. */
  note: string | null;
  source: string;
  error: string | null;
  emptyText: string;
  observations: InspObs[];
  groups: ObsGroup[];
}

export interface InspectorData {
  rfqId: string | null;
  rfq: RfqDto | null;
  job: ProviderJobDto | null;
  window: [number, number] | null;
  columns: Record<Party, Column>;
  matrix: Matrix;
  knows: Record<Party, number>;
  txids: string[];
  demo: boolean;
  mock: boolean;
  /** The network the connected daemons report (buyer first). */
  network: NetworkName | null;
  /** This machine's daemon routes its outbound traffic through a SOCKS5 proxy, so its IP isn't what the relay and light-wallet server see. */
  proxied: boolean;
}

export interface TargetOption {
  rfqId: string;
  label: string;
  at: number;
}

const CLOSED_RFQ = new Set<RfqDto['state']>(['closed', 'expired', 'failed']);
const CLOSED_JOB = new Set<ProviderJobDto['state']>(['done', 'stopped', 'lost']);
const NOT_DEMO =
  "Not in demo mode: each party runs on its own machine, so this terminal can't fetch this party's view, and shouldn't be able to. Only this machine's own view and the public chain are shown.";

// ---------------------------------------------------------------------------
// Targets

export function targetOptions(s: State): TargetOption[] {
  const out = new Map<string, TargetOption>();
  for (const r of Object.values(s.rfqs)) {
    out.set(r.rfqId, {
      rfqId: r.rfqId,
      at: r.createdAt,
      label: `${truncateMiddle(r.rfqId, 6, 4)} · ${r.request.count}× ${gpuLabel(r.request.gpu)} · ${r.state === 'closed' && r.closeReason === 'done' ? 'Done' : RFQ_STATE_LABEL[r.state]}`,
    });
  }
  for (const j of Object.values(s.jobs)) {
    if (out.has(j.rfqId)) continue;
    out.set(j.rfqId, {
      rfqId: j.rfqId,
      at: j.startedAt ?? j.paymentsReceived[0]?.at ?? 0,
      label: `${truncateMiddle(j.rfqId, 6, 4)} · ${j.request.count}× ${gpuLabel(j.request.gpu)} · provider job, ${JOB_STATE_LABEL[j.state].toLowerCase()}`,
    });
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

/** The request the inspector should show for a route: the page's own, else the most recent. */
export function defaultTarget(s: State, pathname: string): string | null {
  const m = /^\/rfq\/([^/?#]+)/.exec(pathname);
  if (m?.[1]) return decodeURIComponent(m[1]);
  if (pathname.startsWith('/provider')) {
    const jobs = Object.values(s.jobs);
    const live = jobs.find((j) => j.state === 'running' || j.state === 'paused' || j.state === 'won');
    if (live) return live.rfqId;
    const recent = jobs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (recent) return recent.rfqId;
  }
  return targetOptions(s)[0]?.rfqId ?? null;
}

// ---------------------------------------------------------------------------
// Tokens for cross-highlighting identical values across columns

const TOKEN_RES: RegExp[] = [
  /\b(?:u|utest|uregtest)1[02-9ac-hj-np-z]{20,}\b/g,
  /\b(?:u|utest|uregtest)1[02-9ac-hj-np-z]{3,}…[02-9ac-hj-np-z]{3,}/g,
  /[0-9a-f]{16,}/gi,
  /[0-9a-f]{4,}…[0-9a-f]{3,}/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /\b[a-z]+-[a-z]+-\d{2}\b/g,
  /\b\d+(?:\.\d+)?\s?ZEC\b/g,
];

export function extractTokens(value: string): string[] {
  const out = new Set<string>();
  for (const re of TOKEN_RES) {
    for (const m of value.matchAll(re)) out.add(m[0].toLowerCase().replace(/\s+/g, ' '));
  }
  return [...out];
}

export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = a.indexOf('…');
  const tb = b.indexOf('…');
  if (ta > 0 && tb < 0) return b.startsWith(a.slice(0, ta)) && b.endsWith(a.slice(ta + 1));
  if (tb > 0 && ta < 0) return a.startsWith(b.slice(0, tb)) && a.endsWith(b.slice(tb + 1));
  return false;
}

export function anyTokenMatch(as: string[], bs: string[]): boolean {
  for (const a of as) for (const b of bs) if (tokensMatch(a, b)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Chain: synthesize an observation from the literal public view

const plain = (label: string, value: string): LeakFieldExt => ({ label, value, readable: true, sensitive: false, facts: [] });
/** Ciphertext the chain stores: unreadable, and not itself a fact. */
const cipher = (label: string, value: string): LeakFieldExt => ({ label, value, readable: false, sensitive: false, facts: [] });
/** A fact the chain does not have, by construction of a fully shielded transaction. */
const absent = (label: string, value: string, facts: FactKey[]): LeakFieldExt => ({ label, value, readable: false, sensitive: true, facts });

/** Provenance chip for a chain view: what this terminal's copy of the public view is based on. */
export function viewProvenance(v: PublicTxViewDto): InspObs['badge'] {
  const partial = v.complete === false;
  switch (v.source) {
    case 'broadcast':
      return { label: partial ? 'own broadcast (partial)' : 'exact (own broadcast)', tone: partial ? 'warn' : 'ok' };
    case 'wallet':
      return { label: partial ? 'wallet copy (partial)' : 'exact (wallet copy)', tone: partial ? 'warn' : 'ok' };
    case 'mempool':
      return { label: partial ? 'mempool (partial)' : 'exact (mempool)', tone: partial ? 'warn' : 'ok' };
    case 'compact-block':
      return { label: 'compact block (partial)', tone: 'warn' };
    case 'simulated':
      return { label: 'simulated', tone: 'neutral' };
    default:
      return partial ? { label: 'partial view', tone: 'warn' } : undefined;
  }
}

const EST_ALIASES: Record<string, string[]> = {
  fee: ['feeZats', 'fee'],
  value: ['valueBalances', 'valueBalanceZats', 'valueBalance', 'ironwood.valueBalanceZats', 'orchard.valueBalanceZats'],
  size: ['sizeBytes', 'size'],
  transparent: ['transparent'],
  sapling: ['sapling'],
  orchard: ['orchard'],
  time: ['time'],
};

export function chainObservation(v: PublicTxViewDto, seenAt: number | undefined): LeakObservation {
  const shielded = v.ironwood ?? v.orchard;
  const samples = shielded.ciphertextSamples ?? [];
  const estimated = new Set(v.estimated ?? []);
  const est = (k: keyof typeof EST_ALIASES) => EST_ALIASES[k]!.some((n) => estimated.has(n));
  const fee = est('fee') ? null : v.feeZats;
  const valueKnown = !est('value');
  const fields: LeakFieldExt[] = [
    plain('txid', v.txid),
    plain('Block', v.height === null ? 'mempool (not mined yet)' : formatHeight(v.height)),
    plain('Ironwood (shielded)', `${shielded.actions} action${shielded.actions === 1 ? '' : 's'}`),
    plain('Fee', fee === null ? 'unknown' : formatZec(fee)),
    plain(
      'Value leaving the pool',
      valueKnown ? `${formatZec(shielded.valueBalanceZats)}${fee !== null && shielded.valueBalanceZats === fee ? ' (= the fee)' : ''}` : 'unknown',
    ),
    plain('Transparent in / out', est('transparent') ? 'unknown' : `${v.transparent.inputs} / ${v.transparent.outputs}`),
    plain('Sapling spends / outputs', est('sapling') ? 'unknown' : `${v.sapling.spends} / ${v.sapling.outputs}`),
    ...(v.ironwood ? [plain('Legacy Orchard actions', est('orchard') ? 'unknown' : String(v.orchard.actions))] : []),
    plain('Size', `${est('size') ? `≈ ${formatBytes(v.sizeBytes)}` : `${formatInt(v.sizeBytes)} bytes`} · v${v.version}`),
    ...samples.slice(0, 3).map((hex, i) => cipher(`Action ${i + 1} note ciphertext`, hex)),
    ...(samples.length > 3 ? [cipher('Other actions', `${samples.length - 3} more note ciphertexts`)] : []),
    absent('Sender', 'hidden: shielded spends reveal only nullifiers', ['buyer_identity']),
    absent('Recipients', 'hidden: encrypted inside each note', ['provider_identity']),
    absent('Amounts', 'hidden: encrypted inside each note', ['amount']),
    absent('Memos', 'hidden: one 512-byte encrypted memo per output', ['price']),
  ];
  return {
    id: `tx:${v.txid}`,
    party: 'chain',
    at: seenAt ?? (v.time ? v.time * 1000 : 0),
    txid: v.txid,
    event: v.height === null ? 'tx-mempool' : 'tx-mined',
    summary: `Shielded transaction · ${shielded.actions} actions · ${v.height === null ? 'in the mempool' : `block ${formatHeight(v.height)}`}`,
    fields,
  };
}

/** Update a daemon's chain observation with the latest public view (mined height, estimated fields). */
function enrichChainObservation(o: LeakObservation, v: PublicTxViewDto): LeakObservation {
  const estimated = new Set(v.estimated ?? []);
  const est = (k: keyof typeof EST_ALIASES) => EST_ALIASES[k]!.some((n) => estimated.has(n));
  const fields = o.fields.map((f) => {
    const l = f.label.toLowerCase();
    if (/\b(block|height)\b/.test(l) && v.height !== null) return { ...f, value: formatHeight(v.height) };
    if (est('fee') && /^fee\b/.test(l)) return { ...f, value: 'unknown' };
    if (est('value') && /value/.test(l)) return { ...f, value: 'unknown' };
    if (est('size') && /^size\b/.test(l)) return { ...f, value: `≈ ${formatBytes(v.sizeBytes)}` };
    return f;
  });
  return { ...o, fields };
}

// ---------------------------------------------------------------------------

function summaryTemplate(s: string): string {
  return s.replace(/[0-9a-f]{6,}/gi, '#').replace(/\d+(?:[.,]\d+)*/g, '#');
}

function toInsp(o: LeakObservation, buyerAddress: string | null, group?: string, synthetic = false): InspObs {
  const fields = classifyObservation(o, { buyerAddress }).map((cf) => ({ ...cf, tokens: extractTokens(cf.field.value) }));
  return { obs: o, fields, synthetic, group: group ?? `${o.party}|${o.event}|${summaryTemplate(o.summary)}` };
}

function groupObservations(list: InspObs[]): ObsGroup[] {
  const byKey = new Map<string, InspObs[]>();
  for (const o of list) {
    const arr = byKey.get(o.group);
    if (arr) arr.push(o);
    else byKey.set(o.group, [o]);
  }
  const groups: ObsGroup[] = [];
  for (const [key, items] of byKey) {
    items.sort((a, b) => b.obs.at - a.obs.at);
    groups.push({ key, latest: items[0]!, items });
  }
  return groups.sort((a, b) => b.latest.obs.at - a.latest.obs.at);
}

function newestFirst(list: InspObs[]): InspObs[] {
  return list.sort((a, b) => b.obs.at - a.obs.at);
}

export function buildInspector(s: State, rfqId: string | null, now: number): InspectorData {
  const mock = s.mode === 'mock';
  const rfq = (rfqId && s.rfqs[rfqId]) || null;
  const job = (rfqId && s.jobs[rfqId]) || null;
  const buyerAddress = s.buyerStatus?.address ?? null;

  // --- availability -----------------------------------------------------
  const buyerOnline = mock || s.conn.buyer.status === 'online';
  const providerOnline = mock || s.conn.provider.status === 'online';
  const statuses = [buyerOnline ? s.buyerStatus : null, providerOnline ? s.providerStatus : null].filter((x) => !!x);
  const demo = mock || (statuses.length > 0 && statuses.every((x) => x!.demoMode));
  const home: Party | null = buyerOnline ? 'buyer' : providerOnline ? 'provider' : null;
  const homeStatus = home === 'buyer' ? s.buyerStatus : home === 'provider' ? s.providerStatus : null;
  const network = statuses[0]?.network ?? null;
  const proxied = !!homeStatus?.proxy;

  const avail: Record<Party, { available: boolean; reason: string | null; source: string }> = {
    chain: {
      available: buyerOnline || providerOnline,
      reason: buyerOnline || providerOnline ? null : 'No daemon connected to read public transaction views from.',
      source: mock ? 'mock replay' : `${hostOf(buyerOnline ? s.conn.buyer.url : s.conn.provider.url)}/api/chain/tx/:txid`,
    },
    relay: {
      available: demo && (mock || s.relayObserver === 'available'),
      reason: !demo
        ? NOT_DEMO
        : s.relayObserver === 'unavailable'
          ? `The relay's observer feed isn't reachable${s.relayObserverError ? `: ${s.relayObserverError}` : ''}.`
          : 'Checking the relay observer feed…',
      source: mock ? 'mock replay' : `${hostOf(s.conn.relay.url)}/_observer`,
    },
    provider: {
      available: providerOnline && (demo || home === 'provider'),
      reason: !providerOnline ? `Provider daemon not connected (${hostOf(s.conn.provider.url)}).` : NOT_DEMO,
      source: mock ? 'mock replay' : `${hostOf(s.conn.provider.url)}/api/leaks`,
    },
    buyer: {
      available: buyerOnline && (demo || home === 'buyer'),
      reason: !buyerOnline ? `Buyer daemon not connected (${hostOf(s.conn.buyer.url)}).` : NOT_DEMO,
      source: mock ? 'mock replay' : `${hostOf(s.conn.buyer.url)}/api/leaks`,
    },
  };

  // --- per-request observations -------------------------------------------
  const forRfq = (p: Party) => (rfqId ? Object.values(s.leaks[p]).filter((o) => o.rfqId === rfqId) : []);
  const buyerObs = avail.buyer.available ? forRfq('buyer') : [];
  const providerObs = avail.provider.available ? forRfq('provider') : [];

  const txids = new Set<string>();
  if (rfq) {
    if (rfq.rfqTxid) txids.add(rfq.rfqTxid);
    for (const b of rfq.bids) if (b.txid) txids.add(b.txid);
    for (const p of rfq.payments) if (p.txid) txids.add(p.txid);
  }
  if (job) {
    if (job.bid.txid) txids.add(job.bid.txid);
    for (const p of job.paymentsReceived) if (p.txid) txids.add(p.txid);
  }
  for (const o of [...buyerObs, ...providerObs]) if (o.txid) txids.add(o.txid);

  // --- time window (relay can't link blobs to requests) ------------------
  const times: number[] = [];
  if (rfq) times.push(rfq.createdAt, ...rfq.payments.map((p) => p.at), ...rfq.bids.map((b) => b.receivedAt), ...rfq.heartbeats.map((h) => h.at));
  if (job) times.push(...job.paymentsReceived.map((p) => p.at), ...[job.startedAt, job.stoppedAt].filter((x): x is number => !!x));
  for (const o of [...buyerObs, ...providerObs]) times.push(o.at);
  let window: [number, number] | null = null;
  if (times.length) {
    const closed = rfq ? CLOSED_RFQ.has(rfq.state) : job ? CLOSED_JOB.has(job.state) : false;
    const closedAt = (rfq as RfqExt | null)?.closedAt;
    const start = Math.min(...times) - 5000;
    const end = closed ? (closedAt ?? Math.max(...times)) + 8000 : now + 1000;
    window = [start, end];
  }

  // --- columns ------------------------------------------------------------
  const chainList: InspObs[] = [];
  let missingViews = 0;
  let viewErrors = 0;
  if (avail.chain.available && rfqId) {
    // The daemons' own 'chain' observations (one per txid; buyer and provider may both report one),
    // enriched with the freshest public view. Txids without one get a view synthesized observation.
    const byTx = new Map<string, LeakObservation>();
    const loose: LeakObservation[] = [];
    for (const o of Object.values(s.leaks.chain)) {
      if (!(o.rfqId === rfqId || (o.txid && txids.has(o.txid)))) continue;
      if (!o.txid) {
        loose.push(o);
        continue;
      }
      txids.add(o.txid);
      const prev = byTx.get(o.txid);
      if (!prev || o.fields.length > prev.fields.length || (o.fields.length === prev.fields.length && o.at < prev.at)) byTx.set(o.txid, o);
    }
    for (const txid of txids) {
      const v = s.chainTx[txid];
      const o = byTx.get(txid);
      const shieldedActions = v ? (v.ironwood ?? v.orchard).actions : null;
      const groupTail = v ? `${shieldedActions}|${v.source ?? ''}|${v.complete === false ? 'partial' : ''}` : '';
      if (o) {
        const insp = toInsp(v ? enrichChainObservation(o, v) : o, buyerAddress, `chain|${summaryTemplate(o.summary)}|${groupTail}`);
        if (v) insp.badge = viewProvenance(v);
        chainList.push(insp);
      } else if (v) {
        const insp = toInsp(chainObservation(v, s.chainSeen[txid]), buyerAddress, `chain|view|${groupTail}`, true);
        insp.badge = viewProvenance(v);
        chainList.push(insp);
      } else if (s.chainErrors[txid]) viewErrors++;
      else missingViews++;
    }
    for (const o of loose) chainList.push(toInsp(o, buyerAddress));
  }

  const relayList: InspObs[] =
    avail.relay.available && window
      ? Object.values(s.leaks.relay)
          .filter((o) => o.at >= window![0] && o.at <= window![1])
          .map((o) => toInsp(o, buyerAddress))
      : [];

  const lists: Record<Party, InspObs[]> = {
    chain: newestFirst(chainList),
    relay: newestFirst(relayList),
    provider: newestFirst(providerObs.map((o) => toInsp(o, buyerAddress))),
    buyer: newestFirst(buyerObs.map((o) => toInsp(o, buyerAddress))),
  };

  const providerAlias = s.providerStatus?.alias;
  const notes: Record<Party, string | null> = {
    chain:
      `What any block explorer shows. It can't tell these are Silicr transactions: they're listed because the buyer and provider know their txids.` +
      (missingViews ? ` Fetching ${missingViews} more public view${missingViews === 1 ? '' : 's'}…` : '') +
      (viewErrors ? ` ${viewErrors} view${viewErrors === 1 ? '' : 's'} unavailable from the daemon.` : ''),
    relay: window
      ? `The relay can't link blobs to a request. This is everything it saw from ${formatTime(window[0])} to ${formatTime(Math.min(window[1], now))}.` +
        (proxied ? ' This machine connected through a SOCKS5 proxy, so the client IP it logged is the proxy’s, not yours.' : '')
      : null,
    provider: providerAlias ? `The provider daemon on this machine (${providerAlias}).` : null,
    buyer: 'The buyer daemon: its own request, bids, job and payments.',
  };

  const empty: Record<Party, string> = {
    chain: rfqId ? 'No transactions known for this request yet.' : 'No request selected.',
    relay: rfqId ? 'The relay saw nothing during this request yet.' : 'No request selected.',
    provider: rfqId ? 'This provider holds nothing about this request (it may not have been asked).' : 'No request selected.',
    buyer: rfqId ? (rfq ? 'No observations yet.' : 'The buyer daemon has no record of this request.') : 'No request selected.',
  };

  const columns = {} as Record<Party, Column>;
  for (const p of PARTIES) {
    columns[p] = {
      party: p,
      available: avail[p].available,
      reason: avail[p].available ? null : avail[p].reason,
      note: avail[p].available ? notes[p] : null,
      source: avail[p].source,
      error: p === 'chain' ? null : s.leakErrors[p],
      emptyText: empty[p],
      observations: lists[p],
      groups: groupObservations(lists[p]),
    };
  }

  const matrix = computeMatrix({
    chain: { available: columns.chain.available, fields: lists.chain.flatMap((o) => o.fields) },
    relay: { available: columns.relay.available, fields: lists.relay.flatMap((o) => o.fields) },
    provider: { available: columns.provider.available, fields: lists.provider.flatMap((o) => o.fields) },
    buyer: { available: columns.buyer.available, fields: lists.buyer.flatMap((o) => o.fields) },
  });
  const knows = {} as Record<Party, number>;
  for (const p of PARTIES) knows[p] = FACTS.filter((f) => matrix[f.key][p].state === 'knows').length;

  return { rfqId, rfq, job, window, columns, matrix, knows, txids: [...txids], demo, mock, network, proxied };
}

export function describeTarget(d: InspectorData): string {
  const r = d.rfq ?? d.job;
  if (!r) return d.rfqId ? truncateMiddle(d.rfqId, 8, 6) : 'No request';
  return `${r.request.count}× ${gpuLabel(r.request.gpu)} · ${formatDuration(r.request.durationS)}`;
}
