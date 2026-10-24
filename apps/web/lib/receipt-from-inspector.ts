/**
 * Builds a ReceiptInput from the Leak Inspector's data (the same observations, matrix and
 * public views the panel shows), so "Export receipt" writes exactly what the judge saw.
 */

import type { Party, PublicTxViewDto } from '@silicr/api';
import { expectationFor, FACTS, PARTIES } from './facts';
import type { InspectorData, InspField } from './inspector';
import { viewProvenance } from './inspector';
import type { ReceiptCell, ReceiptColumn, ReceiptFact, ReceiptInput, ReceiptTx } from './receipt';
import type { State } from './store';

function labelsOf(keys: string[], index: Map<string, InspField>, max = 4): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const f = index.get(k);
    if (f && !out.includes(f.field.label)) out.push(f.field.label);
    if (out.length >= max) break;
  }
  return out;
}

function txRoles(data: InspectorData): Map<string, string> {
  const roles = new Map<string, string>();
  const r = data.rfq;
  if (r) {
    if (r.rfqTxid) roles.set(r.rfqTxid.toLowerCase(), 'RFQ');
    for (const t of r.rfqTxids ?? []) roles.set(t.toLowerCase(), 'RFQ (split)');
    for (const b of r.bids) if (b.txid) roles.set(b.txid.toLowerCase(), `BID from ${b.alias}`);
    for (const p of r.payments) if (p.txid) roles.set(p.txid.toLowerCase(), p.kind === 'accept' ? 'ACCEPT (interval #0)' : `PAY #${p.seq}`);
  }
  const j = data.job;
  if (j) {
    if (j.bid.txid) roles.set(j.bid.txid.toLowerCase(), 'BID (this provider)');
    for (const p of j.paymentsReceived) if (p.txid && !roles.has(p.txid.toLowerCase())) roles.set(p.txid.toLowerCase(), p.kind === 'accept' ? 'ACCEPT received' : `PAY #${p.seq} received`);
  }
  return roles;
}

export function receiptTx(v: PublicTxViewDto, role?: string): ReceiptTx {
  const shielded = v.ironwood ?? v.orchard;
  const estimated = new Set(v.estimated ?? []);
  const feeUnknown = estimated.has('feeZats') || estimated.has('fee') || v.feeZats === null;
  const sizeUnknown = estimated.has('sizeBytes') || estimated.has('size');
  return {
    txid: v.txid,
    height: v.height,
    actions: shielded.actions,
    pool: v.ironwood ? 'Ironwood' : 'Orchard',
    feeZats: feeUnknown ? null : v.feeZats,
    sizeBytes: sizeUnknown ? null : v.sizeBytes,
    provenance: viewProvenance(v) ?? { label: 'daemon view', tone: 'neutral' },
    ciphertextSamples: [...(shielded.ciphertextSamples ?? [])],
    ...(role ? { role } : {}),
  };
}

export function receiptFromInspector(data: InspectorData, state: State, generatedAt = Date.now()): ReceiptInput {
  const index = new Map<string, InspField>();
  for (const p of PARTIES) for (const o of data.columns[p].observations) for (const f of o.fields) index.set(f.key, f);

  const matrix = {} as ReceiptInput['matrix'];
  for (const f of FACTS) {
    matrix[f.key] = {} as Record<Party, ReceiptCell>;
    for (const p of PARTIES) {
      const c = data.matrix[f.key][p];
      const exp = expectationFor(p, f.key);
      const cell: ReceiptCell = { state: c.state, evidence: labelsOf(c.evidence, index) };
      if (c.self) cell.self = true;
      if (c.state === 'hidden') cell.ciphertext = c.ciphertext;
      if (c.state === 'knows' && exp) {
        cell.expected = exp.note;
        if (exp.limit !== undefined) cell.limit = exp.limit;
      }
      matrix[f.key as ReceiptFact][p] = cell;
    }
  }

  const columns = {} as Record<Party, ReceiptColumn>;
  for (const p of PARTIES) {
    const col = data.columns[p];
    columns[p] = {
      available: col.available,
      reason: col.reason,
      source: col.source,
      note: col.note,
      observations: [...col.observations]
        .sort((a, b) => a.obs.at - b.obs.at)
        .map((o) => ({
          id: o.obs.id,
          at: o.obs.at,
          event: o.obs.event,
          summary: o.obs.summary,
          ...(o.obs.txid ? { txid: o.obs.txid } : {}),
          fields: o.fields.map((f) => ({ label: f.field.label, value: f.field.value, readable: f.field.readable, sensitive: f.field.sensitive, facts: f.facts })),
        })),
    };
  }

  const roles = txRoles(data);
  const transactions: ReceiptTx[] = [];
  let viewsUnavailable = 0;
  for (const txid of data.txids) {
    const v = state.chainTx[txid];
    if (v) transactions.push(receiptTx(v, roles.get(txid.toLowerCase())));
    else viewsUnavailable++;
  }
  transactions.sort((a, b) => (a.height ?? Number.MAX_SAFE_INTEGER) - (b.height ?? Number.MAX_SAFE_INTEGER) || a.txid.localeCompare(b.txid));

  const r = data.rfq;
  const network = data.network;
  const chainKind: ReceiptInput['chainKind'] = network === 'test' ? 'test' : network === 'main' ? 'main' : 'unknown';
  const request = r?.request ?? data.job?.request ?? null;
  return {
    rfqId: data.rfqId ?? 'unknown',
    network,
    chainKind,
    demoMode: data.demo,
    proxied: data.proxied,
    generatedAt,
    from: data.window?.[0] ?? null,
    to: data.window ? Math.min(data.window[1], generatedAt) : null,
    state: r ? (r.state === 'closed' && r.closeReason ? `${r.state} (${r.closeReason})` : r.state) : data.job ? `provider job: ${data.job.state}` : null,
    request: request ? { gpu: request.gpu, count: request.count, durationS: request.durationS, maxPricePerHourZats: request.maxPricePerHourZats } : null,
    providersAsked: r?.providersAsked ?? null,
    paddedOutputs: r?.paddedOutputs ?? null,
    payments: r ? r.payments.length : data.job ? data.job.paymentsReceived.length : null,
    spentZats: r?.spentZats ?? null,
    feesZats: r?.feesZats ?? null,
    matrix,
    columns,
    transactions,
    viewsUnavailable,
    producer: 'Silicr web terminal (Leak Inspector)',
  };
}

export function receiptFilename(rfqId: string | null): string {
  return `silicr-receipt-${rfqId ? rfqId.slice(0, 8) : 'unknown'}.html`;
}
