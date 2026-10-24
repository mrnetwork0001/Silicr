// `silicr audit <rfqId>`: a privacy receipt for one request, as a self-contained HTML file (or JSON).
//
// Fetches the buyer daemon's /api/leaks, and in demo mode the provider daemon's /api/leaks and the relay's
// /_observer feed, plus the public view of every transaction the request touched (/api/chain/tx/:txid,
// which each daemon builds from blocks its own wallet already has: nothing is looked up by txid at the
// light-wallet server). Computes the same who-knows-what matrix as the web terminal's Leak Inspector
// (apps/web/lib/facts.ts) and the MCP server (packages/mcp/src/leaks.ts), then renders the receipt.
//
// The HTML template below is a verbatim copy of apps/web/lib/receipt.ts (the terminal's "Export receipt"
// button). Both files are deliberately self-contained; keep them in step.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FactKey, LeakField, LeakObservation, Party, PublicTxViewDto, RelayObserverResponse, RfqDto, StatusDto } from '@silicr/api';
import { ENGINE_VERSION } from '@silicr/engine';
import { ApiError, DaemonClient, DEFAULT_URLS } from '../client.ts';
import { fail, kv, pc, short } from '../format.ts';

// ===========================================================================
// Receipt template (copy of apps/web/lib/receipt.ts)
// ===========================================================================


export type ReceiptParty = 'chain' | 'relay' | 'provider' | 'buyer';
export type ReceiptFact = 'buyer_identity' | 'workload' | 'price' | 'amount' | 'provider_identity' | 'buyer_ip';
export type ReceiptCellState = 'knows' | 'hidden' | 'no' | 'na';

export interface ReceiptCell {
  state: ReceiptCellState;
  /** Labels of the fields that decided the cell (a few). */
  evidence: string[];
  /** Known by definition (the buyer is the buyer). */
  self?: boolean;
  /** Hidden cells: the party holds ciphertext rather than nothing. */
  ciphertext?: boolean;
  /** Knows cells: what THREAT_MODEL.md says about it; absent = unexpected. */
  expected?: string;
  /** THREAT_MODEL.md known-limit number, when the expected leak is one. */
  limit?: number;
}

export interface ReceiptField {
  label: string;
  value: string;
  readable: boolean;
  sensitive: boolean;
  facts: ReceiptFact[];
}

export interface ReceiptObservation {
  id: string;
  at: number;
  event: string;
  summary: string;
  txid?: string;
  fields: ReceiptField[];
}

export interface ReceiptColumn {
  available: boolean;
  reason: string | null;
  source: string;
  note: string | null;
  observations: ReceiptObservation[];
}

export interface ReceiptTx {
  txid: string;
  height: number | null;
  /** Shielded (Ironwood, or legacy Orchard on an older view) action count. */
  actions: number;
  pool: 'Ironwood' | 'Orchard';
  feeZats: string | null;
  sizeBytes: number | null;
  provenance: { label: string; tone: 'ok' | 'warn' | 'neutral' };
  ciphertextSamples: string[];
  /** Which party's record it came from: 'RFQ', 'BID', 'ACCEPT', 'PAY #3', … when known. */
  role?: string;
}

export interface ReceiptInput {
  rfqId: string;
  network: string | null;
  /** 'mock' = the web terminal's scripted replay; 'memory' = simulated chain in real daemons; 'test' | 'main' = Zcash. */
  chainKind: 'mock' | 'memory' | 'test' | 'main' | 'unknown';
  demoMode: boolean;
  proxied: boolean;
  generatedAt: number;
  from: number | null;
  to: number | null;
  state: string | null;
  request: { gpu: string; count: number; durationS: number; maxPricePerHourZats: string } | null;
  providersAsked: number | null;
  paddedOutputs: number | null;
  payments: number | null;
  spentZats: string | null;
  feesZats: string | null;
  matrix: Record<ReceiptFact, Record<ReceiptParty, ReceiptCell>>;
  columns: Record<ReceiptParty, ReceiptColumn>;
  transactions: ReceiptTx[];
  /** Transactions whose public view couldn't be fetched. */
  viewsUnavailable: number;
  /** Where the receipt was produced. */
  producer: string;
}

export const RECEIPT_FACTS: readonly { key: ReceiptFact; label: string; hint: string }[] = [
  { key: 'buyer_identity', label: 'Who the buyer is', hint: 'Wallet address or identity' },
  { key: 'workload', label: 'What is being run', hint: 'Code, command, data, logs, results' },
  { key: 'price', label: 'Price', hint: 'Max price and bid prices' },
  { key: 'amount', label: 'Amounts paid', hint: 'Value of each payment' },
  { key: 'provider_identity', label: 'Which provider', hint: 'Who is asked, wins and gets paid' },
  { key: 'buyer_ip', label: 'Buyer IP', hint: "The buyer machine's network address" },
];

export const RECEIPT_PARTIES: readonly ReceiptParty[] = ['chain', 'relay', 'provider', 'buyer'];

export const RECEIPT_PARTY_META: Record<ReceiptParty, { name: string; sub: string }> = {
  chain: { name: 'Public chain', sub: 'any block explorer' },
  relay: { name: 'Silicr relay', sub: 'store-and-forward server' },
  provider: { name: 'Provider', sub: 'the GPU seller' },
  buyer: { name: 'Buyer', sub: 'the party that rented' },
};

/** THREAT_MODEL.md "Known limits (stated, not hidden)", condensed. */
export const RECEIPT_KNOWN_LIMITS: readonly { n: number; title: string; text: string }[] = [
  { n: 1, title: 'The workload is visible to the winning provider.', text: 'Hiding it would need TEE execution with attestation (future work). Buyers with secret weights should treat providers as able to see their code and data.' },
  { n: 2, title: 'Network metadata.', text: "Without a proxy, the relay sees both parties' IP addresses and the light-wallet server sees each wallet's IP and broadcasts. With --proxy (Tor) every outbound connection goes through the proxy and they see Tor's address instead. A proxy does not hide timing, a wallet's birthday height, the fact that a transaction was broadcast at that moment, or Docker image pulls." },
  { n: 3, title: 'No proof of correct computation.', text: 'Heartbeats show the job is progressing, not that it ran on the claimed GPU or produced honest outputs. Bonds and reputation discourage cheating but do not prevent it.' },
  { n: 4, title: 'Timing correlation and the payment train.', text: "The light-wallet server sees the buyer's IP broadcast one padded RFQ, then a run of uniform 2-action payments, and can link one job's transactions and infer roughly how long it ran. Random jitter blurs the cadence, not the count. Whoever runs the relay can line up blob timing with chain timing." },
  { n: 5, title: 'Losing bidders see demand.', text: 'RFQ details reach every provider asked. Buyers control this by choosing how many to ask.' },
  { n: 6, title: 'The arbiter is trusted', text: 'in the FROST bond flow (stretch only).' },
];

// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function zec(zats: string | null | undefined): string {
  if (zats === null || zats === undefined || !/^-?\d+$/.test(zats)) return 'unknown';
  const neg = zats.startsWith('-');
  const digits = (neg ? zats.slice(1) : zats).padStart(9, '0');
  const whole = digits.slice(0, -8);
  const frac = digits.slice(-8).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''} ZEC`;
}

function iso(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function duration(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${+(s / 60).toFixed(1)} min`;
  return `${+(s / 3600).toFixed(2)} h`;
}

function trunc(s: string, n = 24): string {
  return s.length > n ? `${s.slice(0, Math.ceil(n / 2))}…${s.slice(-Math.floor(n / 2) + 1)}` : s;
}

function isHexish(v: string): boolean {
  return /^(0x)?[0-9a-f]{12,}(…|\.\.\.)?$/i.test(v.replace(/\s+/g, ''));
}

function networkLabel(input: ReceiptInput): string {
  switch (input.chainKind) {
    case 'mock':
      return 'Mock replay (no chain, no daemons: the web terminal’s scripted demo)';
    case 'memory':
      return 'Simulated chain (memory network) with real relay and daemons';
    case 'test':
      return 'Zcash testnet';
    case 'main':
      return 'Zcash mainnet (real ZEC)';
    default:
      return input.network ?? 'unknown network';
  }
}

function fieldState(f: ReceiptField): { cls: string; text: string } {
  if (!f.readable) return { cls: 'sealed', text: isHexish(f.value) || /encrypt|ciphertext|sealed/i.test(f.value) ? 'ciphertext' : 'hidden' };
  return f.sensitive ? { cls: 'knows', text: 'knows' } : { cls: 'readable', text: 'readable' };
}

const CSS = `
:root{color-scheme:light dark;--bg:#f7f7f5;--panel:#ffffff;--sunken:#f0f0ed;--line:#e3e3df;--line-strong:#c9c9c3;--fg:#17181a;--muted:#5d6066;--faint:#8b8e95;--accent:#1f5eff;--accent-soft:#e6edff;--knows:#1f5eff;--knows-fg:#ffffff;--warn:#9a5b00;--warn-soft:#fff3dc;--bad:#c42b2b;--bad-soft:#fde8e8;--ok:#177245;--ok-soft:#e3f5ea;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0f1012;--panel:#17181b;--sunken:#121316;--line:#26282d;--line-strong:#3a3d44;--fg:#ebecee;--muted:#a4a7ae;--faint:#6f737b;--accent:#6b93ff;--accent-soft:#1a2440;--knows:#3f6fff;--knows-fg:#ffffff;--warn:#f0b35a;--warn-soft:#2d2411;--bad:#ff6b6b;--bad-soft:#3a1a1a;--ok:#5fcf8c;--ok-soft:#11291a}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 16px 56px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:16px;margin:28px 0 10px}h3{font-size:13.5px;margin:0 0 6px}
p{margin:6px 0}.muted{color:var(--muted)}.faint{color:var(--faint)}.mono{font-family:var(--mono);font-size:12.5px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.grid{display:grid;gap:12px}.grid-2{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:600}
.cell{display:inline-block;min-width:118px;padding:4px 9px;border-radius:6px;font-size:12px;font-weight:600;border:1px solid transparent}
.cell.knows{background:var(--knows);color:var(--knows-fg)}.cell.knows.unexpected{outline:2px solid var(--bad);outline-offset:1px}
.cell.hidden{border-color:var(--line-strong);color:var(--muted);background:repeating-linear-gradient(135deg,transparent 0 4px,var(--line) 4px 5px)}
.cell.no{color:var(--faint);font-weight:500}.cell.na{color:var(--faint);border-style:dashed;border-color:var(--line-strong);font-weight:500}
.tag{display:inline-block;font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:4px;margin-left:6px;vertical-align:middle}
.tag.limit{background:rgba(255,255,255,.22)}.tag.self{background:rgba(255,255,255,.22)}.tag.bad{background:var(--bad);color:#fff}
.chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line-strong);color:var(--muted)}
.chip.ok{border-color:var(--ok);color:var(--ok);background:var(--ok-soft)}.chip.warn{border-color:var(--warn);color:var(--warn);background:var(--warn-soft)}
.chip.neutral{background:var(--sunken)}
.party{margin-top:14px}.party .head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.obs{border-top:1px solid var(--line);padding:9px 0}.obs:first-of-type{border-top:0}.obs .sum{font-weight:600}.obs .meta{font-size:11.5px;color:var(--faint)}
.fields{margin:6px 0 0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:3px 14px}
.fields li{display:grid;grid-template-columns:minmax(120px,38%) 1fr auto;gap:8px;font-size:12.5px;align-items:baseline}
.fields .l{color:var(--muted)}.fields .v{word-break:break-all}.fields .v.sealed{color:var(--faint);font-family:var(--mono);font-size:11.5px}
.st{font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;white-space:nowrap}
.st.knows{color:var(--accent)}.st.readable{color:var(--muted)}.st.sealed{color:var(--faint)}
.notice{border-left:3px solid var(--warn);background:var(--warn-soft);padding:8px 12px;border-radius:6px}
.real{border-left:3px solid var(--bad);background:var(--bad-soft);padding:8px 12px;border-radius:6px}
footer{margin-top:36px;padding-top:14px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
ol.limits{padding-left:20px}ol.limits li{margin:5px 0}ol.limits li.used{color:var(--fg)}ol.limits li.used::marker{font-weight:700}
.samples{font-family:var(--mono);font-size:11px;color:var(--faint);word-break:break-all;margin:3px 0 0}
@media print{body{background:#fff}.card{break-inside:avoid}}
`;

function matrixTable(input: ReceiptInput): string {
  const head = RECEIPT_PARTIES.map((p) => `<th>${esc(RECEIPT_PARTY_META[p].name)}<div class="faint" style="font-weight:400;text-transform:none;letter-spacing:0">${esc(RECEIPT_PARTY_META[p].sub)}</div></th>`).join('');
  const rows = RECEIPT_FACTS.map((f) => {
    const cells = RECEIPT_PARTIES.map((p) => {
      const c = input.matrix[f.key][p];
      if (c.state === 'knows') {
        const unexpected = !c.self && !c.expected;
        const title = c.self ? `Knows by definition: it is the ${p}. ${c.expected ?? ''}` : `Knows, from “${c.evidence.join('”, “')}”. ${c.expected ?? 'Not expected by THREAT_MODEL.md: investigate.'}`;
        return `<td><span class="cell knows${unexpected ? ' unexpected' : ''}" title="${esc(title)}">Knows${c.self ? '<span class="tag self">itself</span>' : ''}${c.limit ? `<span class="tag limit">limit ${c.limit}</span>` : ''}${unexpected ? '<span class="tag bad">unexpected</span>' : ''}</span></td>`;
      }
      if (c.state === 'hidden') return `<td><span class="cell hidden" title="${esc(`Doesn't know: ${c.ciphertext ? 'it holds only ciphertext' : 'withheld from it'} (${c.evidence.join(', ')}).`)}">${c.ciphertext ? 'Ciphertext only' : 'Hidden'}</span></td>`;
      if (c.state === 'na') return `<td><span class="cell na" title="${esc(input.columns[p].reason ?? 'No data for this party')}">No data</span></td>`;
      return `<td><span class="cell no" title="Nothing in this party's data carries this fact.">Doesn’t know</span></td>`;
    }).join('');
    return `<tr><th scope="row" style="text-transform:none;letter-spacing:0;font-size:13px;color:var(--fg)">${esc(f.label)}<div class="faint" style="font-weight:400">${esc(f.hint)}</div></th>${cells}</tr>`;
  }).join('');
  return `<table aria-label="Who knows what"><thead><tr><th>Key fact</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function partySection(input: ReceiptInput, p: ReceiptParty): string {
  const col = input.columns[p];
  const meta = RECEIPT_PARTY_META[p];
  const knows = RECEIPT_FACTS.filter((f) => input.matrix[f.key][p].state === 'knows').length;
  let body: string;
  if (!col.available) body = `<p class="muted">${esc(col.reason ?? 'No data for this party.')}</p>`;
  else if (!col.observations.length) body = `<p class="muted">Nothing recorded for this request.</p>`;
  else {
    body = col.observations
      .map((o) => {
        const fields = o.fields
          .map((f) => {
            const st = fieldState(f);
            const v = isHexish(f.value) ? trunc(f.value, 40) : f.value;
            return `<li><span class="l">${esc(f.label)}</span><span class="v${f.readable ? '' : ' sealed'}" title="${esc(f.value)}">${esc(v)}</span><span class="st ${st.cls}">${st.text}</span></li>`;
          })
          .join('');
        return `<div class="obs"><div class="sum">${esc(o.summary)}</div><div class="meta mono">${esc(clock(o.at))} UTC · ${esc(o.event)}${o.txid ? ` · tx ${esc(trunc(o.txid, 20))}` : ''}</div><ul class="fields">${fields}</ul></div>`;
      })
      .join('');
  }
  return `<section class="card party" id="party-${p}"><div class="head"><h3>${esc(meta.name)} <span class="muted" style="font-weight:400">· ${esc(meta.sub)}</span></h3><span class="muted">${col.available ? `${knows}/${RECEIPT_FACTS.length} facts known · ${col.observations.length} observation${col.observations.length === 1 ? '' : 's'}` : 'no data'}</span></div>${col.note ? `<p class="muted" style="font-size:12.5px">${esc(col.note)}</p>` : ''}<p class="faint mono" style="font-size:11.5px">source: ${esc(col.source)}</p>${body}</section>`;
}

function chainSection(input: ReceiptInput): string {
  if (!input.transactions.length) return `<p class="muted">No transactions known for this request${input.viewsUnavailable ? ` (${input.viewsUnavailable} public view${input.viewsUnavailable === 1 ? '' : 's'} unavailable)` : ''}.</p>`;
  const rows = input.transactions
    .map((t) => {
      const samples = t.ciphertextSamples.slice(0, 2).map((s) => `<div class="samples">${esc(trunc(s, 64))}</div>`).join('');
      return `<tr><td class="mono" title="${esc(t.txid)}">${esc(trunc(t.txid, 22))}${t.role ? `<div class="faint">${esc(t.role)}</div>` : ''}</td><td>${t.height === null ? 'mempool' : esc(String(t.height))}</td><td>${t.actions} ${esc(t.pool)}</td><td>${esc(zec(t.feeZats))}</td><td>${t.sizeBytes === null ? 'unknown' : `${esc(String(t.sizeBytes))} B`}</td><td><span class="chip ${t.provenance.tone}">${esc(t.provenance.label)}</span></td><td>${samples || '<span class="faint">none</span>'}${t.ciphertextSamples.length > 2 ? `<div class="faint">+${t.ciphertextSamples.length - 2} more</div>` : ''}</td></tr>`;
    })
    .join('');
  const totalFee = input.transactions.reduce<bigint | null>((acc, t) => (acc === null || t.feeZats === null || !/^\d+$/.test(t.feeZats) ? null : acc + BigInt(t.feeZats)), 0n);
  return `<table aria-label="Public chain views"><thead><tr><th>txid</th><th>Block</th><th>Shielded actions</th><th>Fee</th><th>Size</th><th>Provenance</th><th>Note ciphertext (sample)</th></tr></thead><tbody>${rows}</tbody></table><p class="muted" style="font-size:12.5px">${input.transactions.length} transaction${input.transactions.length === 1 ? '' : 's'} · ${input.transactions.filter((t) => t.height !== null).length} mined · ${input.transactions.reduce((a, t) => a + t.actions, 0)} shielded actions · fees ${totalFee === null ? 'partly unknown' : esc(zec(totalFee.toString()))}${input.viewsUnavailable ? ` · ${input.viewsUnavailable} view${input.viewsUnavailable === 1 ? '' : 's'} unavailable` : ''}. Senders, recipients, amounts and memos are encrypted in every one of them.</p>`;
}

function simulatedVsReal(input: ReceiptInput): { simulated: string[]; real: string[] } {
  const simulated: string[] = [];
  const real: string[] = [];
  switch (input.chainKind) {
    case 'mock':
      simulated.push('Everything: the chain, the relay, both daemons and every observation are the web terminal’s scripted mock replay. Nothing here was broadcast anywhere.');
      break;
    case 'memory':
      simulated.push('The chain: a simulated in-process network (instant blocks, fake txids and note ciphertexts). No transaction reached Zcash.');
      real.push('The protocol: real RFQ, BID, ACCEPT, PAY and CLOSE memos, signatures and channel encryption; a real relay process and real buyer and provider daemons; the job really ran.');
      break;
    case 'test':
      real.push('The chain: Zcash testnet. Every transaction listed is a real shielded (Ironwood) transaction, readable in any testnet explorer by txid.');
      real.push('The relay, the daemons and the job are real processes.');
      break;
    case 'main':
      real.push('The chain: Zcash mainnet with real ZEC. Every transaction listed is a real shielded (Ironwood) transaction.');
      real.push('The relay, the daemons and the job are real processes.');
      break;
    default:
      real.push('Network unknown: treat the chain views as unverified.');
  }
  if (input.demoMode && input.chainKind !== 'mock') {
    simulated.push('The vantage point: in demo mode every party runs on this machine, which is how this receipt can quote the provider’s and the relay’s own records. In production those live on other machines and cannot be fetched.');
  } else if (input.chainKind !== 'mock') {
    real.push('Not in demo mode: the provider’s and the relay’s views were not fetched (they would be other machines’ data). Only this machine’s own view and the public chain are shown.');
  }
  if (input.proxied) real.push('This machine’s daemon routed its outbound traffic through a SOCKS5 proxy: any client IP in the relay’s records is the proxy’s address.');
  return { simulated, real };
}

/** Render the receipt. The result is a complete HTML document with no external references. */
export function renderReceipt(input: ReceiptInput): string {
  const limitsUsed = new Set<number>();
  const unexpected: string[] = [];
  for (const f of RECEIPT_FACTS) {
    for (const p of RECEIPT_PARTIES) {
      const c = input.matrix[f.key][p];
      if (c.state !== 'knows') continue;
      if (c.limit) limitsUsed.add(c.limit);
      if (!c.self && !c.expected) unexpected.push(`${RECEIPT_PARTY_META[p].name} knows “${f.label}”`);
    }
  }
  const verdict = unexpected.length ? 'leak' : 'private';
  const { simulated, real } = simulatedVsReal(input);
  const r = input.request;
  const title = `Silicr privacy receipt · ${input.rfqId.slice(0, 8)}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
<h1>Silicr privacy receipt</h1>
<p class="muted">What each party could learn about one GPU rental, from each party’s own records. Verdict: <strong style="color:${verdict === 'private' ? 'var(--ok)' : 'var(--bad)'}">${verdict === 'private' ? 'PRIVATE' : 'LEAK'}</strong>${verdict === 'private' ? ' — no party knows anything THREAT_MODEL.md does not already grant it.' : ` — ${esc(unexpected.join('; '))}.`}</p>
${input.chainKind === 'main' ? '<p class="real"><strong>Real ZEC.</strong> This request ran on Zcash mainnet: the amounts in the buyer and provider records are real funds.</p>' : ''}
${input.chainKind === 'mock' ? '<p class="notice"><strong>Mock data.</strong> This receipt was generated from the web terminal’s scripted replay, not from daemons or a chain.</p>' : ''}
<div class="card" style="margin-top:12px">
<dl>
<dt>Request</dt><dd class="mono">${esc(input.rfqId)}</dd>
<dt>Network</dt><dd>${esc(networkLabel(input))}${input.network ? ` <span class="faint mono">(${esc(input.network)})</span>` : ''}</dd>
<dt>State</dt><dd>${esc(input.state ?? 'unknown')}</dd>
${r ? `<dt>Rented</dt><dd>${r.count}× ${esc(r.gpu)} for ${esc(duration(r.durationS))}, max ${esc(zec(r.maxPricePerHourZats))}/h</dd>` : ''}
${input.providersAsked !== null ? `<dt>Providers asked</dt><dd>${input.providersAsked}${input.paddedOutputs !== null ? ` <span class="muted">(RFQ padded to ${input.paddedOutputs} outputs on chain)</span>` : ''}</dd>` : ''}
${input.payments !== null ? `<dt>Payments</dt><dd>${input.payments}${input.spentZats !== null ? ` · ${esc(zec(input.spentZats))} to the provider` : ''}${input.feesZats !== null ? ` · ${esc(zec(input.feesZats))} fees and protocol outputs` : ''}</dd>` : ''}
<dt>Window</dt><dd>${esc(iso(input.from))} → ${esc(iso(input.to))}</dd>
<dt>Generated</dt><dd>${esc(iso(input.generatedAt))} by ${esc(input.producer)}</dd>
</dl>
</div>
</header>

<h2>Who knows what</h2>
<div class="card" style="overflow-x:auto">${matrixTable(input)}</div>
<p class="muted" style="font-size:12.5px">Every cell is computed from the observations below: a field that is readable <em>and</em> sensitive means that party knows the fact. “Ciphertext only” means the party holds the sealed bytes; “Hidden” means it was withheld. A “Knows” cell is marked <em>unexpected</em> when THREAT_MODEL.md does not grant that party that fact.</p>

<h2>Public chain</h2>
<div class="card" style="overflow-x:auto">${chainSection(input)}</div>

<h2>What each party holds</h2>
${RECEIPT_PARTIES.map((p) => partySection(input, p)).join('\n')}

<h2>Known limits (THREAT_MODEL.md)</h2>
<div class="card">
<p class="muted" style="font-size:12.5px">Stated, not hidden. Limits exercised by this request are in bold.</p>
<ol class="limits">
${RECEIPT_KNOWN_LIMITS.map((l) => `<li class="${limitsUsed.has(l.n) ? 'used' : 'muted'}"><strong>${esc(l.title)}</strong> ${esc(l.text)}${limitsUsed.has(l.n) ? ' <span class="chip warn">seen in this request</span>' : ''}</li>`).join('\n')}
</ol>
<p class="muted" style="font-size:12.5px"><strong>Not a column: the light-wallet server.</strong> It has no observer feed. It learns ${input.proxied ? 'the proxy’s address instead of this wallet’s IP, plus' : 'each wallet’s IP address,'} every transaction it broadcasts and when, the wallet’s birthday height and any transaction fetched by txid; not memo contents, amounts, recipients or which notes belong to the wallet. Silicr never fetches another party’s transaction by txid.</p>
</div>

<footer>
<h3>What was simulated, what was real</h3>
${simulated.length ? `<p><strong>Simulated:</strong></p><ul>${simulated.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p><strong>Simulated:</strong> nothing.</p>'}
${real.length ? `<p><strong>Real:</strong></p><ul>${real.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
<p class="faint">This file is self-contained: inline styles, no scripts, no external requests. It quotes each party’s own records verbatim (ciphertext truncated); it contains no seeds, secret keys, memo plaintext of other parties or job contents beyond what the quoted party already held.</p>
</footer>
</main>
</body>
</html>
`;
}

// ===========================================================================
// The matrix (same rules as apps/web/lib/facts.ts and packages/mcp/src/leaks.ts)
// ===========================================================================

const PARTIES: readonly Party[] = ['chain', 'relay', 'provider', 'buyer'];
const FACT_KEYS = new Set<string>(RECEIPT_FACTS.map((f) => f.key));

function taggedFacts(f: LeakField): FactKey[] | undefined {
  const facts = (f as { facts?: unknown }).facts;
  return Array.isArray(facts) ? facts.filter((x): x is FactKey => typeof x === 'string' && FACT_KEYS.has(x)) : undefined;
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
const RELAY_BLOB = /\b(contents?|payload|blob|ciphertext|bytes|stores?)\b/i;

export function classifyField(f: LeakField, party: Party, buyerAddress: string | null): FactKey[] {
  const tagged = taggedFacts(f);
  const out = new Set<FactKey>(tagged ?? []);
  if (!tagged) {
    const label = f.label;
    if (IP_LABEL.test(label)) {
      const own = SELF_LABEL.test(label) || /provider/i.test(label);
      if (party === 'buyer' || (!own && (party !== 'provider' || /\b(buyer|client|peer|remote)\b/i.test(label)))) out.add('buyer_ip');
    } else {
      for (const [fact, re] of RULES) if (re.test(label)) out.add(fact);
      if (party === 'relay' && !f.readable && RELAY_BLOB.test(label)) out.add('workload');
    }
  }
  if (f.readable && buyerAddress && buyerAddress.length > 20 && f.value.includes(buyerAddress)) out.add('buyer_identity');
  return [...out];
}

const SELF_FACTS: Partial<Record<Party, FactKey[]>> = { buyer: ['buyer_identity', 'buyer_ip'], provider: ['provider_identity'] };

/** What THREAT_MODEL.md says each party may learn (annotation only; the cells come from the data). */
const EXPECTED: Record<Party, Partial<Record<FactKey, { note: string; limit?: number }>>> = {
  chain: {},
  relay: { buyer_ip: { note: 'The relay sees the IP address of every party that connects to it.', limit: 2 } },
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

function looksLikeHex(v: string): boolean {
  return /^(0x)?[0-9a-f]{12,}(…|\.\.\.)?$/i.test(v.replace(/\s+/g, ''));
}

function labels(fields: ReceiptField[], max = 4): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (!out.includes(f.label)) out.push(f.label);
    if (out.length >= max) break;
  }
  return out;
}

export function computeMatrix(columns: Record<Party, ReceiptColumn>): ReceiptInput['matrix'] {
  const m = {} as ReceiptInput['matrix'];
  for (const f of RECEIPT_FACTS) {
    m[f.key] = {} as Record<Party, ReceiptCell>;
    for (const p of PARTIES) {
      const col = columns[p];
      if (!col.available) {
        m[f.key][p] = { state: 'na', evidence: [] };
        continue;
      }
      const fields = col.observations.flatMap((o) => o.fields);
      const matching = fields.filter((cf) => cf.facts.includes(f.key));
      const known = matching.filter((cf) => cf.readable && cf.sensitive);
      const exp = EXPECTED[p][f.key];
      if (known.length) {
        const cell: ReceiptCell = { state: 'knows', evidence: labels(known) };
        if (exp) {
          cell.expected = exp.note;
          if (exp.limit !== undefined) cell.limit = exp.limit;
        }
        m[f.key][p] = cell;
        continue;
      }
      if (SELF_FACTS[p]?.includes(f.key)) {
        m[f.key][p] = { state: 'knows', evidence: [], self: true, ...(exp ? { expected: exp.note } : {}) };
        continue;
      }
      const hidden = matching.filter((cf) => !cf.readable);
      m[f.key][p] = hidden.length
        ? { state: 'hidden', evidence: labels(hidden), ciphertext: hidden.some((h) => looksLikeHex(h.value) || /encrypt|ciphertext|sealed/i.test(h.value)) }
        : { state: 'no', evidence: [] };
    }
  }
  return m;
}

// ===========================================================================
// Chain views → receipt rows, and an observation synthesized from a public view
// ===========================================================================

function provenance(v: PublicTxViewDto): ReceiptTx['provenance'] {
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
      return partial ? { label: 'partial view', tone: 'warn' } : { label: 'daemon view', tone: 'neutral' };
  }
}

function estimates(v: PublicTxViewDto): (k: 'fee' | 'value' | 'size' | 'transparent' | 'sapling' | 'orchard') => boolean {
  const ALIASES: Record<string, string[]> = {
    fee: ['feeZats', 'fee'],
    value: ['valueBalances', 'valueBalanceZats', 'valueBalance', 'ironwood.valueBalanceZats', 'orchard.valueBalanceZats'],
    size: ['sizeBytes', 'size'],
    transparent: ['transparent'],
    sapling: ['sapling'],
    orchard: ['orchard'],
  };
  const set = new Set(v.estimated ?? []);
  return (k) => ALIASES[k]!.some((n) => set.has(n));
}

export function receiptTx(v: PublicTxViewDto, role?: string): ReceiptTx {
  const shielded = v.ironwood ?? v.orchard;
  const est = estimates(v);
  return {
    txid: v.txid,
    height: v.height,
    actions: shielded.actions,
    pool: v.ironwood ? 'Ironwood' : 'Orchard',
    feeZats: est('fee') ? null : v.feeZats,
    sizeBytes: est('size') ? null : v.sizeBytes,
    provenance: provenance(v),
    ciphertextSamples: [...(shielded.ciphertextSamples ?? [])],
    ...(role ? { role } : {}),
  };
}

/** The literal public view as an observation of the chain party (for txids the daemons recorded nothing about). */
export function chainObservation(v: PublicTxViewDto): LeakObservation {
  const shielded = v.ironwood ?? v.orchard;
  const pool = v.ironwood ? 'Ironwood' : 'Orchard';
  const samples = shielded.ciphertextSamples ?? [];
  const est = estimates(v);
  const plain = (label: string, value: string): LeakField => ({ label, value, readable: true, sensitive: false, facts: [] });
  const cipher = (label: string, value: string): LeakField => ({ label, value, readable: false, sensitive: false, facts: [] });
  const absent = (label: string, value: string, facts: FactKey[]): LeakField => ({ label, value, readable: false, sensitive: true, facts });
  const fields: LeakField[] = [
    plain('Transaction id', v.txid),
    plain('Block height', v.height === null ? 'mempool (unmined)' : String(v.height)),
    plain(`Shielded (${pool}) actions`, String(shielded.actions)),
    plain('Fee', est('fee') || v.feeZats === null ? 'unknown' : `${v.feeZats} zats`),
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
    at: v.time ? v.time * 1000 : 0,
    txid: v.txid,
    event: v.height === null ? 'tx-mempool' : 'tx-mined',
    summary: `Shielded transaction: ${shielded.actions} ${pool} action(s), ${v.height === null ? 'in the mempool' : `block ${v.height}`}`,
    fields,
  };
}

// ===========================================================================
// Assembling the receipt from what the daemons and the relay hold
// ===========================================================================

const NOT_DEMO =
  "Not in demo mode: each party runs on its own machine, so this terminal can't fetch this party's view, and shouldn't be able to. Only this machine's own view and the public chain are shown.";
const CLOSED = new Set<RfqDto['state']>(['closed', 'expired', 'failed']);

export interface AuditSources {
  rfq: RfqDto;
  status: StatusDto;
  /** Buyer daemon leak log for the request (every party it recorded: 'buyer' and 'chain'). */
  buyerLeaks: LeakObservation[];
  provider: { available: boolean; source: string; reason?: string; observations: LeakObservation[] };
  relay: { available: boolean; source: string; reason?: string; observations: LeakObservation[] };
  chainSource: string;
  views: PublicTxViewDto[];
  viewErrors: number;
  providerAlias?: string;
  proxied: boolean;
  now?: number;
}

export function requestTxids(rfq: RfqDto, ...observations: LeakObservation[][]): string[] {
  const txids = new Set<string>();
  const add = (t: string | undefined) => {
    if (t && /^[0-9a-fA-F]{8,128}$/.test(t)) txids.add(t.toLowerCase());
  };
  add(rfq.rfqTxid);
  for (const t of rfq.rfqTxids ?? []) add(t);
  for (const b of rfq.bids) add(b.txid);
  for (const p of rfq.payments) add(p.txid);
  for (const list of observations) for (const o of list) add(o.txid);
  return [...txids];
}

function toReceiptObs(o: LeakObservation, buyerAddress: string | null): ReceiptObservation {
  return {
    id: o.id,
    at: o.at,
    event: o.event,
    summary: o.summary,
    ...(o.txid ? { txid: o.txid } : {}),
    fields: (o.fields ?? []).map((f) => ({ label: f.label, value: f.value, readable: f.readable, sensitive: f.sensitive, facts: classifyField(f, o.party, buyerAddress) })),
  };
}

function chronological(list: ReceiptObservation[]): ReceiptObservation[] {
  return list.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** Pure: builds the receipt from already-fetched sources (tested directly). */
export function buildReceiptInput(src: AuditSources): ReceiptInput {
  const { rfq, status } = src;
  const now = src.now ?? Date.now();
  const buyerAddress = status.address ?? null;
  const buyerObs = src.buyerLeaks.filter((o) => o.party === 'buyer');
  const providerObs = src.provider.observations.filter((o) => o.party === 'provider');
  const daemonChain = [...src.buyerLeaks, ...src.provider.observations].filter((o) => o.party === 'chain');

  // Time window: the relay can't link blobs to a request, so it gets the request's lifetime.
  const times = [rfq.createdAt, ...rfq.payments.map((p) => p.at), ...rfq.bids.map((b) => b.receivedAt), ...rfq.heartbeats.map((h) => h.at), ...buyerObs.map((o) => o.at), ...providerObs.map((o) => o.at)];
  const start = Math.min(...times) - 5000;
  const end = CLOSED.has(rfq.state) ? (rfq.closedAt ?? Math.max(...times)) + 8000 : now + 1000;

  // Chain: the daemons' own chain observation per txid (best copy), else one synthesized from the public view.
  const txids = new Set(requestTxids(rfq, buyerObs, providerObs, daemonChain));
  const byTx = new Map<string, LeakObservation>();
  const loose: LeakObservation[] = [];
  for (const o of daemonChain) {
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
  const views = new Map(src.views.map((v) => [v.txid.toLowerCase(), v]));
  const chainObs: LeakObservation[] = [...loose];
  for (const txid of txids) {
    const o = byTx.get(txid);
    const v = views.get(txid);
    if (o) chainObs.push(o);
    else if (v) chainObs.push(chainObservation(v));
  }
  const relayObs = src.relay.available ? src.relay.observations.filter((o) => o.party === 'relay' && o.at >= start && o.at <= end) : [];

  const roles = new Map<string, string>();
  if (rfq.rfqTxid) roles.set(rfq.rfqTxid.toLowerCase(), 'RFQ');
  for (const t of rfq.rfqTxids ?? []) roles.set(t.toLowerCase(), 'RFQ (split)');
  for (const b of rfq.bids) if (b.txid) roles.set(b.txid.toLowerCase(), `BID from ${b.alias}`);
  for (const p of rfq.payments) if (p.txid) roles.set(p.txid.toLowerCase(), p.kind === 'accept' ? 'ACCEPT (interval #0)' : `PAY #${p.seq}`);
  const transactions: ReceiptTx[] = [];
  let viewsUnavailable = src.viewErrors;
  for (const txid of txids) {
    const v = views.get(txid);
    if (v) transactions.push(receiptTx(v, roles.get(txid)));
    else if (!byTx.has(txid)) viewsUnavailable++;
  }
  transactions.sort((a, b) => (a.height ?? Number.MAX_SAFE_INTEGER) - (b.height ?? Number.MAX_SAFE_INTEGER) || a.txid.localeCompare(b.txid));

  const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  const columns: Record<Party, ReceiptColumn> = {
    chain: {
      available: true,
      reason: null,
      source: src.chainSource,
      note: `What any block explorer shows. It can't tell these are Silicr transactions: they're listed because the buyer and provider know their txids.${viewsUnavailable ? ` ${viewsUnavailable} public view(s) unavailable from the daemon.` : ''}`,
      observations: chronological(chainObs.map((o) => toReceiptObs(o, buyerAddress))),
    },
    relay: {
      available: src.relay.available,
      reason: src.relay.available ? null : (src.relay.reason ?? NOT_DEMO),
      source: src.relay.source,
      note: src.relay.available ? `The relay can't link blobs to a request. This is everything it saw from ${fmt(start)} to ${fmt(Math.min(end, now))} UTC.${src.proxied ? ' This machine connected through a SOCKS5 proxy, so the client IP it logged is the proxy’s, not this machine’s.' : ''}` : null,
      observations: chronological(relayObs.map((o) => toReceiptObs(o, buyerAddress))),
    },
    provider: {
      available: src.provider.available,
      reason: src.provider.available ? null : (src.provider.reason ?? NOT_DEMO),
      source: src.provider.source,
      note: src.provider.available ? `The provider daemon on this machine${src.providerAlias ? ` (${src.providerAlias})` : ''}.` : null,
      observations: chronological(providerObs.map((o) => toReceiptObs(o, buyerAddress))),
    },
    buyer: {
      available: true,
      reason: null,
      source: `${src.chainSource.replace(/\/api\/chain\/tx\/:txid$/, '')}/api/leaks`,
      note: 'The buyer daemon: its own request, bids, job and payments.',
      observations: chronological(buyerObs.map((o) => toReceiptObs(o, buyerAddress))),
    },
  };

  const network = status.network;
  const chainKind: ReceiptInput['chainKind'] = network === 'memory' ? 'memory' : network === 'test' || network === 'regtest' ? 'test' : network === 'main' ? 'main' : 'unknown';
  return {
    rfqId: rfq.rfqId,
    network,
    chainKind,
    demoMode: !!status.demoMode,
    proxied: src.proxied,
    generatedAt: now,
    from: start,
    to: Math.min(end, now),
    state: rfq.state === 'closed' && rfq.closeReason ? `${rfq.state} (${rfq.closeReason})` : rfq.state,
    request: { gpu: rfq.request.gpu, count: rfq.request.count, durationS: rfq.request.durationS, maxPricePerHourZats: rfq.request.maxPricePerHourZats },
    providersAsked: rfq.providersAsked,
    paddedOutputs: rfq.paddedOutputs,
    payments: rfq.payments.length,
    spentZats: rfq.spentZats,
    feesZats: rfq.feesZats,
    matrix: computeMatrix(columns),
    columns,
    transactions,
    viewsUnavailable,
    producer: `silicr audit ${ENGINE_VERSION}`,
  };
}

export function receiptVerdict(input: ReceiptInput): { verdict: 'private' | 'leak'; unexpected: string[]; knows: Record<ReceiptParty, number> } {
  const unexpected: string[] = [];
  const knows = { chain: 0, relay: 0, provider: 0, buyer: 0 };
  for (const f of RECEIPT_FACTS) {
    for (const p of RECEIPT_PARTIES) {
      const c = input.matrix[f.key][p];
      if (c.state !== 'knows') continue;
      knows[p]++;
      if (!c.self && !c.expected) unexpected.push(`${RECEIPT_PARTY_META[p].name} knows “${f.label}”`);
    }
  }
  return { verdict: unexpected.length ? 'leak' : 'private', unexpected, knows };
}

// ===========================================================================
// Fetching
// ===========================================================================

async function fetchViews(buyer: DaemonClient, provider: DaemonClient | null, txids: string[]): Promise<{ views: PublicTxViewDto[]; errors: number }> {
  const views: PublicTxViewDto[] = [];
  let errors = 0;
  const queue = [...txids];
  const worker = async () => {
    for (let txid = queue.shift(); txid !== undefined; txid = queue.shift()) {
      try {
        views.push(await buyer.get<PublicTxViewDto>(`/api/chain/tx/${txid}`));
      } catch (e) {
        if (provider && e instanceof ApiError && e.status === 404) {
          try {
            views.push(await provider.get<PublicTxViewDto>(`/api/chain/tx/${txid}`));
            continue;
          } catch {
            // fall through
          }
        }
        errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, txids.length)) }, worker));
  return { views, errors };
}

export async function fetchAuditSources(o: { rfqId: string; buyer: DaemonClient; provider: DaemonClient | null; relayUrl?: string }): Promise<AuditSources> {
  const id = await o.buyer.resolveRfq(o.rfqId);
  const [rfq, status, buyerLeaks] = await Promise.all([
    o.buyer.get<RfqDto>(`/api/rfqs/${id}`),
    o.buyer.get<StatusDto>('/api/status'),
    o.buyer.get<LeakObservation[]>(`/api/leaks?rfqId=${id}`),
  ]);
  const demo = !!status.demoMode;

  let provider: AuditSources['provider'] = { available: false, source: o.provider?.base ?? 'none', reason: 'no provider daemon configured (--provider)', observations: [] };
  let providerAlias: string | undefined;
  if (o.provider) {
    const source = `${o.provider.base}/api/leaks`;
    if (!demo) provider = { available: false, source, reason: NOT_DEMO, observations: [] };
    else {
      try {
        const [obs, ps] = await Promise.all([o.provider.get<LeakObservation[]>(`/api/leaks?rfqId=${id}`), o.provider.get<StatusDto>('/api/status').catch(() => null)]);
        provider = { available: true, source, observations: obs };
        providerAlias = ps?.alias;
      } catch (e) {
        provider = { available: false, source, reason: `provider daemon not reachable: ${e instanceof ApiError ? e.message : String(e)}`, observations: [] };
      }
    }
  }

  const relayUrl = (o.relayUrl ?? status.relayUrl).replace(/\/+$/, '');
  let relay: AuditSources['relay'] = { available: false, source: `${relayUrl}/_observer`, reason: NOT_DEMO, observations: [] };
  if (demo) {
    try {
      const res = await fetch(`${relayUrl}/_observer?limit=5000`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 404 ? ' (observer feed disabled: start the relay with --observer)' : ''}`);
      const body = (await res.json()) as RelayObserverResponse;
      relay = { available: true, source: `${relayUrl}/_observer`, observations: body.observations };
    } catch (e) {
      relay = { available: false, source: `${relayUrl}/_observer`, reason: `relay observer feed not reachable: ${e instanceof Error ? e.message : String(e)}`, observations: [] };
    }
  }

  const txids = requestTxids(rfq, buyerLeaks, provider.observations);
  const { views, errors } = await fetchViews(o.buyer, provider.available ? o.provider : null, txids);
  return { rfq, status, buyerLeaks, provider, relay, chainSource: `${o.buyer.base}/api/chain/tx/:txid`, views, viewErrors: errors, providerAlias, proxied: !!status.proxy };
}

// ===========================================================================
// The command
// ===========================================================================

export interface AuditOptions {
  buyer?: string;
  provider?: string;
  relay?: string;
  out?: string;
  json?: boolean;
}

export async function audit(rfqId: string, o: AuditOptions): Promise<void> {
  const buyer = new DaemonClient(o.buyer ?? process.env.SILICR_BUYER_URL ?? DEFAULT_URLS.buyer);
  const provider = new DaemonClient(o.provider ?? process.env.SILICR_PROVIDER_URL ?? DEFAULT_URLS.provider);
  let sources: AuditSources;
  try {
    sources = await fetchAuditSources({ rfqId, buyer, provider, relayUrl: o.relay ?? process.env.SILICR_RELAY_URL });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const input = buildReceiptInput(sources);
  const { verdict, unexpected, knows } = receiptVerdict(input);

  if (o.json) {
    console.log(JSON.stringify({ verdict, unexpected, knows, ...input }, null, 2));
    if (!o.out) return;
  }
  const out = resolve(o.out ?? `silicr-receipt-${input.rfqId.slice(0, 8)}.html`);
  const html = renderReceipt(input);
  await writeFile(out, html, 'utf8');
  if (o.json) return;

  console.log(`\n  ${pc.bold('privacy receipt')} ${pc.dim(short(input.rfqId, 16))}  ${verdict === 'private' ? pc.green('PRIVATE') : pc.red('LEAK')}`);
  const rows: [string, string][] = [
    ['network', input.network ?? 'unknown'],
    ['state', input.state ?? 'unknown'],
    ['facts known', RECEIPT_PARTIES.map((p) => `${p} ${knows[p]}/${RECEIPT_FACTS.length}`).join(' · ')],
    ['views', `${input.transactions.length} transaction(s)${input.viewsUnavailable ? `, ${input.viewsUnavailable} unavailable` : ''}`],
    ['provider view', input.columns.provider.available ? `${input.columns.provider.observations.length} observations` : pc.dim(input.columns.provider.reason ?? 'unavailable')],
    ['relay view', input.columns.relay.available ? `${input.columns.relay.observations.length} observations` : pc.dim(input.columns.relay.reason ?? 'unavailable')],
    ['written', `${out} ${pc.dim(`(${(html.length / 1024).toFixed(0)} kB, self-contained, no scripts)`)}`],
  ];
  if (unexpected.length) rows.splice(3, 0, ['unexpected', pc.red(unexpected.join('; '))]);
  kv(rows);
  console.log();
}
