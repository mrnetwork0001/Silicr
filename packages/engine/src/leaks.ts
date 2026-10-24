// Leak Inspector bookkeeping: what THIS party actually holds, recorded from real data.
import type { FactKey, LeakField, LeakObservation, Party, PublicTxViewDto } from '@silicr/api';
import type { PublicTxView } from '@silicr/zec';

export function field(label: string, value: string, readable: boolean, sensitive: boolean, facts: FactKey[] = []): LeakField {
  return { label, value, readable, sensitive, facts: [...facts] };
}

/**
 * Key facts carried by the engine's own observation fields, by label (every label is fixed).
 * One-time and fresh addresses and per-RFQ keys carry none: they can't be linked to anyone.
 */
export const FACTS_BY_LABEL: Record<string, FactKey[]> = {
  GPU: ['workload'],
  Duration: ['workload'],
  'Job command': ['workload'],
  Command: ['workload'],
  Image: ['workload'],
  'Job bundle': ['workload'],
  Bundle: ['workload'],
  'Intervals bought (max)': ['workload'],
  'Intervals (max)': ['workload'],
  'Result size': ['workload'],
  Size: ['workload'],
  'What the relay stores': ['workload'],
  'Max price': ['price'],
  'Buyer budget': ['price'],
  Price: ['price'],
  'Min price': ['price'],
  Amount: ['amount'],
  'Paid now': ['amount'],
  'Received with it': ['amount'],
  'Total paid to provider': ['amount'],
  Earned: ['amount'],
  Notes: ['amount'],
  Provider: ['provider_identity'],
  'Providers asked': ['provider_identity'],
  'Claimed provider': ['provider_identity'],
  Pseudonym: ['provider_identity'],
  'Provider key': ['provider_identity'],
  'RFQ address (Orchard-only)': ['provider_identity'],
  'Other providers asked': ['provider_identity'],
  'Buyer identity': ['buyer_identity'],
  'Buyer wallet address': ['buyer_identity'],
  'Anything about buyers': ['buyer_identity'],
};

/** What one transaction's encrypted parts seal, by message type (the chain only ever holds these sealed). */
export interface TxFacts {
  memo: FactKey[];
  sender: FactKey[];
  recipients: FactKey[];
}

export const TX_FACTS: Record<'rfq' | 'bid' | 'accept' | 'pay' | 'buyerClose' | 'providerClose' | 'selfSend', TxFacts> = {
  rfq: { memo: ['price', 'workload'], sender: ['buyer_identity'], recipients: ['provider_identity'] },
  bid: { memo: ['price', 'provider_identity'], sender: ['provider_identity'], recipients: [] },
  accept: { memo: ['price', 'workload', 'provider_identity'], sender: ['buyer_identity'], recipients: [] },
  pay: { memo: [], sender: ['buyer_identity'], recipients: [] },
  buyerClose: { memo: [], sender: ['buyer_identity'], recipients: [] },
  providerClose: { memo: [], sender: ['provider_identity'], recipients: [] },
  selfSend: { memo: [], sender: ['buyer_identity'], recipients: [] },
};

/** Ciphertext as truncated hex: what a party holding only ciphertext literally sees. */
export function cipherPreview(bytes: Uint8Array | string, n = 24): string {
  const h = typeof bytes === 'string' ? bytes : Array.from(bytes.subarray(0, n), (x) => x.toString(16).padStart(2, '0')).join('');
  return h.length > n * 2 ? `${h.slice(0, n * 2)}…` : `${h}…`;
}

export interface LeakInput {
  party: Party;
  event: string;
  summary: string;
  fields: LeakField[];
  rfqId?: string;
  txid?: string;
  at?: number;
}

export class LeakRecorder {
  private readonly prefix: string;
  private readonly cap: number;
  private readonly onRecord: (o: LeakObservation) => void;
  private items: LeakObservation[] = [];
  private n = 0;
  /** Called once per distinct rfqId, just before the first observation carrying it is stored (it may record first). */
  onFirstRfq: ((rfqId: string) => void) | null = null;
  private readonly seenRfqs = new Set<string>();

  constructor(prefix: string, onRecord: (o: LeakObservation) => void, cap = 5000) {
    this.prefix = prefix;
    this.onRecord = onRecord;
    this.cap = cap;
  }

  record(input: LeakInput): LeakObservation {
    if (input.rfqId !== undefined && !this.seenRfqs.has(input.rfqId)) {
      this.seenRfqs.add(input.rfqId);
      if (this.seenRfqs.size > 10000) this.seenRfqs.delete(this.seenRfqs.values().next().value!);
      this.onFirstRfq?.(input.rfqId);
    }
    this.n += 1;
    const o: LeakObservation = {
      id: `${this.prefix}-${this.n}`,
      party: input.party,
      at: input.at ?? Date.now(),
      event: input.event,
      summary: input.summary,
      fields: input.fields,
    };
    if (input.rfqId !== undefined) o.rfqId = input.rfqId;
    if (input.txid !== undefined) o.txid = input.txid;
    this.items.push(o);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
    this.onRecord(o);
    return o;
  }

  /** `after` is an observation id (or its numeric suffix); only later observations are returned. */
  list(q: { rfqId?: string; after?: string; party?: Party } = {}): LeakObservation[] {
    let after = -1;
    if (q.after !== undefined && q.after !== '') {
      const m = /(\d+)$/.exec(q.after);
      if (m) after = Number(m[1]);
    }
    return this.items.filter((o) => {
      if (after >= 0 && Number(o.id.slice(this.prefix.length + 1)) <= after) return false;
      if (q.rfqId && o.rfqId !== q.rfqId) return false;
      if (q.party && o.party !== q.party) return false;
      return true;
    });
  }

  get size(): number {
    return this.items.length;
  }
}

export function publicTxViewDto(v: PublicTxView): PublicTxViewDto {
  return {
    txid: v.txid,
    height: v.height,
    time: v.time,
    version: v.version,
    sizeBytes: v.sizeBytes,
    feeZats: v.feeZats === null ? null : v.feeZats.toString(),
    transparent: { inputs: v.transparent.inputs, outputs: v.transparent.outputs },
    sapling: { spends: v.sapling.spends, outputs: v.sapling.outputs, valueBalanceZats: v.sapling.valueBalanceZats.toString() },
    orchard: {
      actions: v.orchard.actions,
      valueBalanceZats: v.orchard.valueBalanceZats.toString(),
      ciphertextSamples: [...v.orchard.ciphertextSamples],
    },
    ...(v.source !== undefined ? { source: v.source } : {}),
    ...(v.complete !== undefined ? { complete: v.complete } : {}),
    ...(v.estimated !== undefined ? { estimated: [...v.estimated] } : {}),
    ...(v.ironwood
      ? {
          ironwood: {
            actions: v.ironwood.actions,
            valueBalanceZats: v.ironwood.valueBalanceZats.toString(),
            ciphertextSamples: [...v.ironwood.ciphertextSamples],
          },
        }
      : {}),
  };
}

/** The bundle Silicr's actions live in: Ironwood since NU6.3, else Orchard. Never a sum of the two. */
export function shieldedBundle(v: { orchard: { actions: number }; ironwood?: { actions: number } }): { pool: 'Ironwood' | 'Orchard'; actions: number } {
  return v.ironwood ? { pool: 'Ironwood', actions: v.ironwood.actions } : { pool: 'Orchard', actions: v.orchard.actions };
}

const SOURCE_TEXT: Record<string, string> = {
  broadcast: 'our own broadcast (exact bytes held locally)',
  wallet: "the wallet's stored copy (exact bytes held locally)",
  mempool: 'the mempool stream the wallet already watches',
  'compact-block': 'a compact block the wallet scanned anyway (fee and value balances unknown)',
  simulated: 'the simulated chain',
};

/**
 * The chain's view of one transaction: counts, fee and ciphertext. Never amounts or recipients.
 * Fields the backend lists in `estimated` (or a null fee) are shown as "unknown", never as 0.
 */
export function chainFields(v: PublicTxView, sealed: TxFacts = { memo: [], sender: [], recipients: [] }): LeakField[] {
  const est = new Set(v.estimated ?? []);
  const bundle = v.ironwood ?? v.orchard;
  const pool = v.ironwood ? 'Ironwood' : 'Orchard';
  const fee = v.feeZats === null || est.has('feeZats') ? 'unknown' : `${v.feeZats} zats`;
  const balance = est.has('valueBalances') ? 'unknown' : `${bundle.valueBalanceZats} zats (net pool flow, equals the fee)`;
  const fields: LeakField[] = [
    field('Transaction id', v.txid, true, false),
    field('Block height', v.height === null ? 'mempool (unmined)' : String(v.height), true, false),
    field(`Shielded (${pool}) actions`, String(bundle.actions), true, false),
    field('Fee', fee, true, false),
    field(`${pool} value balance`, balance, true, false),
  ];
  if (v.ironwood) fields.push(field('Legacy Orchard actions', String(v.orchard.actions), true, false));
  fields.push(
    field('Transparent inputs / outputs', est.has('transparent') ? 'unknown' : `${v.transparent.inputs} / ${v.transparent.outputs}`, true, false),
    field('Sapling spends / outputs', `${v.sapling.spends} / ${v.sapling.outputs}`, true, false),
    field('Size', est.has('sizeBytes') ? `≈ ${v.sizeBytes} bytes` : `${v.sizeBytes} bytes`, true, false),
  );
  if (v.source) fields.push(field('View built from', SOURCE_TEXT[v.source] ?? v.source, true, false));
  if (v.complete === false) fields.push(field('Completeness', `partial view; unknown: ${[...est].join(', ') || 'some fields'}`, true, false));
  // Each action's ciphertext seals a note: its value, its memo and its recipient.
  const inCiphertext = [...new Set<FactKey>(['amount', ...sealed.memo, ...sealed.recipients])];
  bundle.ciphertextSamples.slice(0, 4).forEach((c, i) => {
    fields.push(field(`Action ${i + 1} note ciphertext`, cipherPreview(c), false, false, inCiphertext));
  });
  fields.push(
    field('Sender', 'hidden: Orchard spends reveal only nullifiers', false, true, sealed.sender),
    field('Recipients', 'hidden: encrypted inside each note', false, true, sealed.recipients),
    field('Amounts', 'hidden: encrypted inside each note', false, true, ['amount']),
    field('Memos', 'hidden: one 512-byte encrypted memo per output', false, true, sealed.memo),
  );
  return fields;
}
