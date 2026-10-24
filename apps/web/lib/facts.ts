/**
 * Leak Inspector facts: which key facts a field carries, and the summary matrix
 * computed from observations (readable && sensitive ⇒ the party knows it).
 *
 * Fields are classified by their explicit `facts` tag (local contract extension)
 * when present, otherwise from the label. Label heuristics err on the side of
 * flagging a leak, never on hiding one.
 */

import type { LeakField, LeakObservation, Party } from '@silicr/api';
import { fieldFacts, type FactKey } from './contract-ext';
import { looksLikeHex } from './format';

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

export const PARTIES: readonly Party[] = ['chain', 'relay', 'provider', 'buyer'];

export interface ClassifyContext {
  /** The buyer's real wallet address, if known (demo mode): any readable copy of it is identity. */
  buyerAddress?: string | null;
}

const IP_LABEL = /\b(ip|ips|ip address|remote|remote addr(ess)?|client addr(ess)?|peer|source addr(ess)?)\b/i;
const SELF_LABEL = /\b(your|own|self|local|this machine)\b/i;

const RULES: [FactKey, RegExp][] = [
  // Memos carry the RFQ/BID/PAY bodies, prices included.
  ['price', /\b(price|prices|rate|bid|bids|per hour|per interval|zec\/h|max|memo|memos)\b/i],
  ['amount', /\b(amount|amounts|paid|payment|payments|value|received|spent|earned|earnings|transfer|zats)\b/i],
  ['provider_identity', /\b(provider|providers|alias|recipient|recipients|pay-?to|winner|seller|signed as)\b/i],
  ['workload', /\b(job|command|cmd|argv|workload|bundle|image|script|code|log|logs|line|stdout|stderr|output|outputs|result|results|dataset|files?|model|weights)\b/i],
  // A reply address belongs to the buyer; whether it's sensitive is the daemon's call.
  ['buyer_identity', /\b(buyer|sender|from|wallet|identity|account|owner|reply|reply-to)\b/i],
];

/** On the relay every blob is job, log, heartbeat or result data. */
const RELAY_BLOB = /\b(contents?|payload|blob|ciphertext|bytes|stores?)\b/i;

/** Which matrix facts a field carries (in the clear if readable, sealed if not). */
export function classifyField(f: LeakField, party: Party, ctx: ClassifyContext = {}): FactKey[] {
  const tagged = fieldFacts(f);
  const out = new Set<FactKey>(tagged ?? []);
  if (!tagged) {
    const label = f.label;
    if (IP_LABEL.test(label)) {
      // An IP field is only an IP fact. A provider's or relay's own address isn't the buyer's.
      const own = SELF_LABEL.test(label) || /provider/i.test(label);
      if (party === 'buyer' || (!own && (party !== 'provider' || /\b(buyer|client|peer|remote)\b/i.test(label)))) {
        out.add('buyer_ip');
      }
    } else {
      for (const [fact, re] of RULES) if (re.test(label)) out.add(fact);
      if (party === 'relay' && !f.readable && RELAY_BLOB.test(label)) out.add('workload');
    }
  }
  // Value correlation (demo mode): the buyer's real wallet address showing up anywhere is identity.
  const addr = ctx.buyerAddress;
  if (f.readable && addr && addr.length > 20 && f.value.includes(addr)) out.add('buyer_identity');
  return [...out];
}

export type CellState = 'knows' | 'hidden' | 'no' | 'na';

export interface Cell {
  state: CellState;
  /** Field keys (`${observationId}#${index}`) that decided the cell. */
  evidence: string[];
  /** For hidden cells: true if what the party holds looks like ciphertext (vs. nothing at all). */
  ciphertext: boolean;
  /** The party is the subject of the fact (the buyer is the buyer): known by definition, not from data. */
  self?: boolean;
}

/** Facts a party knows by definition: they are about itself. */
export const SELF_FACTS: Partial<Record<Party, FactKey[]>> = {
  buyer: ['buyer_identity', 'buyer_ip'],
  provider: ['provider_identity'],
};

export type Matrix = Record<FactKey, Record<Party, Cell>>;

export interface ClassifiedField {
  key: string;
  field: LeakField;
  facts: FactKey[];
}

export function fieldKey(obsId: string, index: number): string {
  return `${obsId}#${index}`;
}

export function classifyObservation(o: LeakObservation, ctx: ClassifyContext): ClassifiedField[] {
  return (o.fields ?? []).map((field, i) => ({ key: fieldKey(o.id, i), field, facts: classifyField(field, o.party, ctx) }));
}

export function computeMatrix(
  columns: Record<Party, { available: boolean; fields: ClassifiedField[] }>,
): Matrix {
  const m = {} as Matrix;
  for (const f of FACTS) {
    m[f.key] = {} as Record<Party, Cell>;
    for (const p of PARTIES) {
      const col = columns[p];
      if (!col.available) {
        m[f.key][p] = { state: 'na', evidence: [], ciphertext: false };
        continue;
      }
      const matching = col.fields.filter((cf) => cf.facts.includes(f.key));
      const known = matching.filter((cf) => cf.field.readable && cf.field.sensitive);
      if (known.length) {
        m[f.key][p] = { state: 'knows', evidence: known.map((k) => k.key), ciphertext: false };
        continue;
      }
      if (SELF_FACTS[p]?.includes(f.key)) {
        m[f.key][p] = { state: 'knows', evidence: [], ciphertext: false, self: true };
        continue;
      }
      const hidden = matching.filter((cf) => !cf.field.readable);
      m[f.key][p] = hidden.length
        ? {
            state: 'hidden',
            evidence: hidden.map((k) => k.key),
            ciphertext: hidden.some((h) => looksLikeHex(h.field.value) || /encrypt|ciphertext|sealed/i.test(h.field.value)),
          }
        : { state: 'no', evidence: [], ciphertext: false };
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// What THREAT_MODEL.md says each party may learn. Used only to annotate cells
// ("known limit", "unexpected"); the cells themselves come from the data.

export interface Expectation {
  note: string;
  /** THREAT_MODEL.md "Known limits" item number. */
  limit?: number;
}

export const EXPECTED: Record<Party, Partial<Record<FactKey, Expectation>>> = {
  chain: {},
  relay: {
    buyer_ip: { note: 'The relay sees the IP address of every party that connects to it.', limit: 2 },
  },
  provider: {
    workload: { note: 'The winning provider must see the job to run it.', limit: 1 },
    price: { note: 'The winner set its own bid price and knows the agreed price. It sees the buyer’s max only if the buyer chose to disclose it; by default the RFQ says “undisclosed”.' },
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

export function expectationFor(party: Party, fact: FactKey): Expectation | null {
  return EXPECTED[party][fact] ?? null;
}
