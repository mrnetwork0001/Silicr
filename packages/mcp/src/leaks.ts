// The who-knows-what matrix: the same rules as the web terminal's Leak Inspector (apps/web/lib/facts.ts
// and inspector.ts), computed here from the daemons' leak logs, the relay observer feed and the public
// view of every transaction. A party "knows" a fact only if one of its fields carries that fact with
// readable && sensitive. Fields are classified by their explicit `facts` tag; untagged fields (the
// relay's) fall back to label rules that err on the side of flagging a leak, never on hiding one.
import type { FactKey, LeakField, LeakObservation, Party, PublicTxViewDto, RfqDto } from '@silicr/api';
import { formatZec, zatsOf } from './zec.ts';

export interface FactDef {
  key: FactKey;
  label: string;
  hint: string;
}

export const FACTS: readonly FactDef[] = [
  { key: 'buyer_identity', label: 'Who the buyer is', hint: 'Wallet address or identity' },
  { key: 'workload', label: 'What is being run', hint: 'Code, command, data, logs, results' },
  { key: 'price', label: 'Price', hint: 'Max price and bid prices' },
  { key: 'amount', label: 'Amounts paid', hint: 'Value of each payment' },
  { key: 'provider_identity', label: 'Which provider', hint: 'Who is asked, wins and gets paid' },
  { key: 'buyer_ip', label: 'Buyer IP', hint: "The buyer machine's network address" },
];

/** The five facts about the deal itself; buyer_ip is network metadata (THREAT_MODEL.md known limit 2). */
export const DEAL_FACTS: readonly FactKey[] = ['buyer_identity', 'workload', 'price', 'amount', 'provider_identity'];

export const PARTIES: readonly Party[] = ['chain', 'relay', 'provider', 'buyer'];

const FACT_KEYS = new Set<string>(FACTS.map((f) => f.key));

function taggedFacts(f: LeakField): FactKey[] | undefined {
  const facts = (f as { facts?: unknown }).facts;
  return Array.isArray(facts) ? facts.filter((x): x is FactKey => typeof x === 'string' && FACT_KEYS.has(x)) : undefined;
}

export interface ClassifyContext {
  /** The buyer's real wallet address (demo mode): any readable copy of it is identity. */
  buyerAddress?: string | null;
}

const IP_LABEL = /\b(ip|ips|ip address|remote|remote addr(ess)?|client addr(ess)?|peer|source addr(ess)?)\b/i;
const SELF_LABEL = /\b(your|own|self|local|this machine)\b/i;

const RULES: [FactKey, RegExp][] = [
  ['price', /\b(price|prices|rate|bid|bids|per hour|per interval|zec\/h|max|memo|memos)\b/i],
  ['amount', /\b(amount|amounts|paid|payment|payments|value|received|spent|earned|earnings|transfer|zats)\b/i],
  ['provider_identity', /\b(provider|providers|alias|recipient|recipients|pay-?to|winner|seller|signed as)\b/i],
  ['workload', /\b(job|command|cmd|argv|workload|bundle|image|script|code|log|logs|line|stdout|stderr|output|outputs|result|results|dataset|files?|model|weights)\b/i],
  ['buyer_identity', /\b(buyer|sender|from|wallet|identity|account|owner|reply|reply-to)\b/i],
];

/** On the relay every blob is job, log, heartbeat or result data. */
const RELAY_BLOB = /\b(contents?|payload|blob|ciphertext|bytes|stores?)\b/i;

/** Which matrix facts a field carries (in the clear if readable, sealed if not). */
export function classifyField(f: LeakField, party: Party, ctx: ClassifyContext = {}): FactKey[] {
  const tagged = taggedFacts(f);
  const out = new Set<FactKey>(tagged ?? []);
  if (!tagged) {
    const label = f.label;
    if (IP_LABEL.test(label)) {
      // An IP field is only an IP fact. A provider's or relay's own address isn't the buyer's.
      const own = SELF_LABEL.test(label) || /provider/i.test(label);
      if (party === 'buyer' || (!own && (party !== 'provider' || /\b(buyer|client|peer|remote)\b/i.test(label)))) out.add('buyer_ip');
    } else {
      for (const [fact, re] of RULES) if (re.test(label)) out.add(fact);
      if (party === 'relay' && !f.readable && RELAY_BLOB.test(label)) out.add('workload');
    }
  }
  const addr = ctx.buyerAddress;
  if (f.readable && addr && addr.length > 20 && f.value.includes(addr)) out.add('buyer_identity');
  return [...out];
}

export type CellState = 'knows' | 'hidden' | 'no' | 'na';

export interface Cell {
  state: CellState;
  /** Labels of the fields that decided the cell (at most 4). */
  evidence: string[];
  /** The party is the subject of the fact (the buyer is the buyer): known by definition, not from data. */
  self?: true;
  /** For hidden cells: the party holds ciphertext (as opposed to nothing at all). */
  ciphertext?: boolean;
  /** For knows cells: THREAT_MODEL.md says this is expected, and why. */
  expected?: string;
  /** THREAT_MODEL.md "Known limits" item number, when the expected leak is one. */
  knownLimit?: number;
}

export type Matrix = Record<FactKey, Record<Party, Cell>>;

export interface ClassifiedField {
  field: LeakField;
  facts: FactKey[];
  event: string;
}

/** Facts a party knows by definition: they are about itself. */
export const SELF_FACTS: Partial<Record<Party, FactKey[]>> = {
  buyer: ['buyer_identity', 'buyer_ip'],
  provider: ['provider_identity'],
};

export interface Expectation {
  note: string;
  limit?: number;
}

/** What THREAT_MODEL.md says each party may learn. Cells come from the data; this only annotates them. */
export const EXPECTED: Record<Party, Partial<Record<FactKey, Expectation>>> = {
  chain: {},
  relay: {
    buyer_ip: { note: 'The relay sees the IP address of every party that connects to it.', limit: 2 },
  },
  provider: {
    workload: { note: 'The winning provider must see the job to run it.', limit: 1 },
    price: { note: 'Providers sent the RFQ see the request and its max price; the winner set its own price.' },
    amount: { note: 'It receives the payments.' },
    provider_identity: { note: 'It is the provider.' },
  },
  buyer: {
    buyer_identity: { note: 'Its own wallet.' },
    workload: { note: 'Its own job.' },
    price: { note: 'Every bid it received.' },
    amount: { note: 'Its own payments.' },
    provider_identity: { note: 'It chose the provider.' },
    buyer_ip: { note: 'Its own IP address.' },
  },
};

export const KNOWN_LIMITS: Record<number, string> = {
  1: 'The workload is visible to the winning provider. Hiding it needs TEE execution with attestation (future work).',
  2: "Network metadata: without a proxy, the relay sees both parties' IP addresses and the light-wallet server sees each wallet's IP and broadcasts. With --proxy (Tor) they see the proxy's address instead; timing is still visible.",
};

export function classifyObservation(o: LeakObservation, ctx: ClassifyContext = {}): ClassifiedField[] {
  return (o.fields ?? []).map((field) => ({ field, facts: classifyField(field, o.party, ctx), event: o.event }));
}

function looksLikeHex(v: string): boolean {
  return /^(0x)?[0-9a-f]{12,}(…|\.\.\.)?$/i.test(v.replace(/\s+/g, ''));
}

function labels(fields: ClassifiedField[], max = 4): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (!out.includes(f.field.label)) out.push(f.field.label);
    if (out.length >= max) break;
  }
  return out;
}

export function computeMatrix(columns: Record<Party, { available: boolean; fields: ClassifiedField[] }>): Matrix {
  const m = {} as Matrix;
  for (const f of FACTS) {
    m[f.key] = {} as Record<Party, Cell>;
    for (const p of PARTIES) {
      const col = columns[p];
      if (!col.available) {
        m[f.key][p] = { state: 'na', evidence: [] };
        continue;
      }
      const matching = col.fields.filter((cf) => cf.facts.includes(f.key));
      const known = matching.filter((cf) => cf.field.readable && cf.field.sensitive);
      const exp = EXPECTED[p][f.key];
      if (known.length) {
        const cell: Cell = { state: 'knows', evidence: labels(known) };
        if (exp) {
          cell.expected = exp.note;
          if (exp.limit !== undefined) cell.knownLimit = exp.limit;
        }
        m[f.key][p] = cell;
        continue;
      }
      if (SELF_FACTS[p]?.includes(f.key)) {
        m[f.key][p] = { state: 'knows', evidence: [], self: true, ...(exp ? { expected: exp.note } : {}) };
        continue;
      }
      const hidden = matching.filter((cf) => !cf.field.readable);
      m[f.key][p] = hidden.length
        ? { state: 'hidden', evidence: labels(hidden), ciphertext: hidden.some((h) => looksLikeHex(h.field.value) || /encrypt|ciphertext|sealed/i.test(h.field.value)) }
        : { state: 'no', evidence: [] };
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Chain: an observation synthesized from the literal public view of a transaction

const plain = (label: string, value: string): LeakField => ({ label, value, readable: true, sensitive: false, facts: [] });
/** Ciphertext the chain stores: unreadable, and not itself a fact. */
const cipher = (label: string, value: string): LeakField => ({ label, value, readable: false, sensitive: false, facts: [] });
/** A fact the chain does not have, by construction of a fully shielded transaction. */
const absent = (label: string, value: string, facts: FactKey[]): LeakField => ({ label, value, readable: false, sensitive: true, facts });

const EST_ALIASES: Record<string, string[]> = {
  fee: ['feeZats', 'fee'],
  value: ['valueBalances', 'valueBalanceZats', 'valueBalance', 'ironwood.valueBalanceZats', 'orchard.valueBalanceZats'],
  size: ['sizeBytes', 'size'],
  transparent: ['transparent'],
  sapling: ['sapling'],
  orchard: ['orchard'],
};

export function chainObservation(v: PublicTxViewDto, seenAt?: number): LeakObservation {
  const shielded = v.ironwood ?? v.orchard;
  const pool = v.ironwood ? 'Ironwood' : 'Orchard';
  const samples = shielded.ciphertextSamples ?? [];
  const estimated = new Set(v.estimated ?? []);
  const est = (k: keyof typeof EST_ALIASES) => EST_ALIASES[k]!.some((n) => estimated.has(n));
  const fee = est('fee') ? null : v.feeZats;
  const fields: LeakField[] = [
    plain('Transaction id', v.txid),
    plain('Block height', v.height === null ? 'mempool (unmined)' : String(v.height)),
    plain(`Shielded (${pool}) actions`, String(shielded.actions)),
    plain('Fee', fee === null ? 'unknown' : `${formatZec(zatsOf(fee))} ZEC`),
    plain(`${pool} value balance`, est('value') ? 'unknown' : `${shielded.valueBalanceZats} zats (net pool flow, equals the fee)`),
    plain('Transparent inputs / outputs', est('transparent') ? 'unknown' : `${v.transparent.inputs} / ${v.transparent.outputs}`),
    plain('Sapling spends / outputs', est('sapling') ? 'unknown' : `${v.sapling.spends} / ${v.sapling.outputs}`),
    ...(v.ironwood ? [plain('Legacy Orchard actions', est('orchard') ? 'unknown' : String(v.orchard.actions))] : []),
    plain('Size', est('size') ? `≈ ${v.sizeBytes} bytes` : `${v.sizeBytes} bytes`),
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
    summary: `Shielded transaction: ${shielded.actions} ${pool} action(s), ${v.height === null ? 'in the mempool' : `block ${v.height}`}`,
    fields,
  };
}

// ---------------------------------------------------------------------------
// The report

export interface ColumnInput {
  available: boolean;
  /** Where the data came from, e.g. "http://127.0.0.1:7701/api/leaks". */
  source: string;
  /** Why the column is unavailable. */
  reason?: string;
  observations: LeakObservation[];
}

export interface LeakReportInput {
  rfq: RfqDto;
  buyerAddress?: string | null;
  /** The buyer daemon's own (party: 'buyer') observations for this request. */
  buyer: ColumnInput;
  /** The provider daemon's own (party: 'provider') observations for this request. */
  provider: ColumnInput;
  /** Everything the relay observer feed holds; it is windowed to the request's lifetime here. */
  relay: ColumnInput;
  chain: {
    available: boolean;
    source: string;
    reason?: string;
    /** 'chain' observations recorded by the daemons (one per transaction they sent or received). */
    daemonObservations: LeakObservation[];
    /** Public views fetched from /api/chain/tx/:txid. */
    views: PublicTxViewDto[];
    viewErrors?: number;
  };
  now?: number;
}

export interface PartyReport {
  available: boolean;
  source: string;
  reason?: string;
  observations: number;
  knows: FactKey[];
  hidden: FactKey[];
  examples: { event: string; label: string; value: string; facts: FactKey[]; readable: boolean; sensitive: boolean }[];
}

export interface LeakReport {
  rfqId: string;
  state: RfqDto['state'];
  closeReason?: string;
  /** 'private' when no party knows anything THREAT_MODEL.md does not already grant it. */
  verdict: 'private' | 'leak';
  summary: string;
  facts: FactDef[];
  matrix: Matrix;
  counts: Record<Party, { knows: number; dealFactsKnown: number; hidden: number; no: number; na: number; observations: number }>;
  unexpected: { fact: FactKey; party: Party; evidence: string[] }[];
  knownLimits: { fact: FactKey; party: Party; note: string; limit: number; text: string }[];
  parties: Record<Party, PartyReport>;
  chain: {
    transactions: number;
    mined: number;
    shieldedActions: number;
    transparentParts: number;
    saplingParts: number;
    legacyOrchardActions: number;
    feesZec: string;
    viewsUnavailable: number;
  };
  relayWindow: { from: string; to: string } | null;
}

const CLOSED = new Set<RfqDto['state']>(['closed', 'expired', 'failed']);
const PLACEHOLDER_TXID = /unknown/i;

function clip(s: string, n = 72): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function requestTxids(rfq: RfqDto): Set<string> {
  const txids = new Set<string>();
  const add = (t: string | undefined) => {
    if (t && !PLACEHOLDER_TXID.test(t) && /^[0-9a-fA-F]{8,128}$/.test(t)) txids.add(t.toLowerCase());
  };
  add(rfq.rfqTxid);
  for (const t of rfq.rfqTxids ?? []) add(t);
  for (const b of rfq.bids) add(b.txid);
  for (const p of rfq.payments) add(p.txid);
  return txids;
}

export function buildLeakReport(input: LeakReportInput): LeakReport {
  const { rfq } = input;
  const now = input.now ?? Date.now();
  const ctx: ClassifyContext = { buyerAddress: input.buyerAddress ?? null };

  // Every transaction the request touched, plus whatever the daemons observed under its id.
  const txids = requestTxids(rfq);
  for (const o of [...input.buyer.observations, ...input.provider.observations, ...input.chain.daemonObservations]) if (o.txid) txids.add(o.txid.toLowerCase());

  // The relay can't link blobs to a request: show what it saw during the request's lifetime.
  const times: number[] = [rfq.createdAt, ...rfq.payments.map((p) => p.at), ...rfq.bids.map((b) => b.receivedAt), ...rfq.heartbeats.map((h) => h.at)];
  for (const o of [...input.buyer.observations, ...input.provider.observations]) times.push(o.at);
  const start = Math.min(...times) - 5000;
  const end = CLOSED.has(rfq.state) ? (rfq.closedAt ?? Math.max(...times)) + 8000 : now + 1000;
  const window: [number, number] = [start, end];

  // Chain column: the daemons' own chain observations (one per txid, best copy), then synthesized
  // views for txids without one.
  const byTx = new Map<string, LeakObservation>();
  const loose: LeakObservation[] = [];
  for (const o of input.chain.daemonObservations) {
    if (!(o.rfqId === rfq.rfqId || (o.txid && txids.has(o.txid.toLowerCase())))) continue;
    if (!o.txid) {
      loose.push(o);
      continue;
    }
    const key = o.txid.toLowerCase();
    txids.add(key);
    const prev = byTx.get(key);
    if (!prev || o.fields.length > prev.fields.length || (o.fields.length === prev.fields.length && o.at < prev.at)) byTx.set(key, o);
  }
  const views = new Map(input.chain.views.map((v) => [v.txid.toLowerCase(), v]));
  const chainObs: LeakObservation[] = [...loose];
  for (const txid of txids) {
    const o = byTx.get(txid);
    const v = views.get(txid);
    if (o) chainObs.push(o);
    else if (v) chainObs.push(chainObservation(v));
  }
  const relayObs = input.relay.available ? input.relay.observations.filter((o) => o.at >= window[0] && o.at <= window[1]) : [];

  const columns: Record<Party, { available: boolean; fields: ClassifiedField[]; observations: LeakObservation[] }> = {
    chain: { available: input.chain.available, observations: chainObs, fields: chainObs.flatMap((o) => classifyObservation(o, ctx)) },
    relay: { available: input.relay.available, observations: relayObs, fields: relayObs.flatMap((o) => classifyObservation(o, ctx)) },
    provider: { available: input.provider.available, observations: input.provider.observations, fields: input.provider.observations.flatMap((o) => classifyObservation(o, ctx)) },
    buyer: { available: input.buyer.available, observations: input.buyer.observations, fields: input.buyer.observations.flatMap((o) => classifyObservation(o, ctx)) },
  };
  const matrix = computeMatrix(columns);

  const counts = {} as LeakReport['counts'];
  const unexpected: LeakReport['unexpected'] = [];
  const knownLimits: LeakReport['knownLimits'] = [];
  const parties = {} as Record<Party, PartyReport>;
  for (const p of PARTIES) {
    const c = { knows: 0, dealFactsKnown: 0, hidden: 0, no: 0, na: 0, observations: columns[p].observations.length };
    const knows: FactKey[] = [];
    const hidden: FactKey[] = [];
    for (const f of FACTS) {
      const cell = matrix[f.key][p];
      c[cell.state] += 1;
      if (cell.state === 'knows') {
        knows.push(f.key);
        if (DEAL_FACTS.includes(f.key)) c.dealFactsKnown += 1;
        if (!cell.self && !EXPECTED[p][f.key]) unexpected.push({ fact: f.key, party: p, evidence: cell.evidence });
        if (cell.knownLimit !== undefined) knownLimits.push({ fact: f.key, party: p, note: cell.expected ?? '', limit: cell.knownLimit, text: KNOWN_LIMITS[cell.knownLimit] ?? '' });
      }
      if (cell.state === 'hidden') hidden.push(f.key);
    }
    counts[p] = c;
    const col = columns[p];
    const evidence = col.fields.filter((cf) => cf.facts.length > 0 && cf.field.readable && cf.field.sensitive);
    const sealed = col.fields.filter((cf) => cf.facts.length > 0 && !cf.field.readable);
    const examples: PartyReport['examples'] = [];
    const seen = new Set<string>();
    for (const cf of [...evidence, ...sealed]) {
      const key = `${cf.field.label}|${cf.field.readable}`;
      if (seen.has(key)) continue;
      seen.add(key);
      examples.push({ event: cf.event, label: cf.field.label, value: clip(cf.field.value), facts: cf.facts, readable: cf.field.readable, sensitive: cf.field.sensitive });
      if (examples.length >= 6) break;
    }
    const src = p === 'chain' ? input.chain : input[p];
    parties[p] = { available: col.available, source: src.source, ...(src.reason ? { reason: src.reason } : {}), observations: col.observations.length, knows, hidden, examples };
  }

  // Chain totals from the public views: fully shielded means zero transparent and Sapling parts.
  let shieldedActions = 0;
  let transparentParts = 0;
  let saplingParts = 0;
  let legacyOrchardActions = 0;
  let mined = 0;
  let fees = 0n;
  for (const v of input.chain.views) {
    const bundle = v.ironwood ?? v.orchard;
    shieldedActions += bundle.actions;
    if (v.ironwood) legacyOrchardActions += v.orchard.actions;
    transparentParts += v.transparent.inputs + v.transparent.outputs;
    saplingParts += v.sapling.spends + v.sapling.outputs;
    if (v.height !== null) mined += 1;
    if (v.feeZats !== null && !(v.estimated ?? []).includes('feeZats')) fees += zatsOf(v.feeZats);
  }

  const verdict: LeakReport['verdict'] = unexpected.length ? 'leak' : 'private';
  const describe = (p: Party): string => {
    const col = parties[p];
    if (!col.available) return `${p}: view unavailable (${col.reason ?? 'no data'})`;
    const c = counts[p];
    const limits = knownLimits.filter((k) => k.party === p).map((k) => `${k.fact}: known limit ${k.limit}`);
    const extra = p === 'buyer' ? ' (its own deal)' : p === 'provider' ? ` (${col.knows.join(', ') || 'nothing'}${col.knows.length ? ': all expected' : ''})` : limits.length ? ` (${limits.join('; ')})` : '';
    return `${p} knows ${c.knows}/${FACTS.length} facts${extra}`;
  };
  const summary =
    `${PARTIES.map(describe).join('; ')}. ` +
    (verdict === 'private'
      ? `No unexpected leaks: ${input.chain.views.length} shielded transaction(s) with ${transparentParts} transparent and ${saplingParts} Sapling parts.`
      : `UNEXPECTED: ${unexpected.map((u) => `${u.party} knows ${u.fact} (${u.evidence.join(', ')})`).join('; ')}.`);

  return {
    rfqId: rfq.rfqId,
    state: rfq.state,
    ...(rfq.closeReason ? { closeReason: rfq.closeReason } : {}),
    verdict,
    summary,
    facts: [...FACTS],
    matrix,
    counts,
    unexpected,
    knownLimits,
    parties,
    chain: {
      transactions: input.chain.views.length,
      mined,
      shieldedActions,
      transparentParts,
      saplingParts,
      legacyOrchardActions,
      feesZec: formatZec(fees),
      viewsUnavailable: input.chain.viewErrors ?? 0,
    },
    relayWindow: input.relay.available ? { from: new Date(window[0]).toISOString(), to: new Date(Math.min(window[1], now)).toISOString() } : null,
  };
}
