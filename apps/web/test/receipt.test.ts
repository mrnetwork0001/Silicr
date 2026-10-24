import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARTIES } from '../lib/facts';
import { buildInspector, defaultTarget } from '../lib/inspector';
import { MockWorld } from '../lib/mock/world';
import { receiptFilename, receiptFromInspector } from '../lib/receipt-from-inspector';
import { RECEIPT_KNOWN_LIMITS, renderReceipt, type ReceiptInput } from '../lib/receipt';
import { actions, getState } from '../lib/store';

let world: MockWorld;
let rfqId: string;
let input: ReceiptInput;
let html: string;

beforeAll(() => {
  actions.setMode('mock', 'forced');
  world = new MockWorld();
  world.start();
  rfqId = defaultTarget(getState(), '/')!;
  const s = getState();
  input = receiptFromInspector(buildInspector(s, rfqId, Date.now()), s, Date.UTC(2026, 9, 22, 12, 0, 0));
  html = renderReceipt(input);
});

afterAll(() => world.stop());

describe('receiptFromInspector', () => {
  it('carries the request, every party and the public views', () => {
    expect(input.rfqId).toBe(rfqId);
    expect(input.chainKind).toBe('mock');
    expect(input.demoMode).toBe(true);
    for (const p of PARTIES) expect(input.columns[p].available).toBe(true);
    expect(input.columns.buyer.observations.length).toBeGreaterThan(3);
    expect(input.columns.relay.observations.length).toBeGreaterThan(3);
    expect(input.transactions.length).toBeGreaterThan(3);
    expect(input.transactions.some((t) => t.role === 'RFQ')).toBe(true);
    expect(input.transactions.some((t) => /^PAY #/.test(t.role ?? ''))).toBe(true);
    expect(input.transactions.every((t) => t.pool === 'Ironwood' && t.ciphertextSamples.length === t.actions)).toBe(true);
    // Observations are chronological in the receipt (the panel shows newest first).
    for (const p of PARTIES) {
      const at = input.columns[p].observations.map((o) => o.at);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });

  it('reproduces the Leak Inspector verdict: provider knows the workload (limit 1), chain knows nothing', () => {
    expect(input.matrix.workload.provider.state).toBe('knows');
    expect(input.matrix.workload.provider.limit).toBe(1);
    expect(input.matrix.workload.provider.evidence.length).toBeGreaterThan(0);
    for (const f of Object.keys(input.matrix) as (keyof typeof input.matrix)[]) expect(input.matrix[f].chain.state).not.toBe('knows');
    expect(input.matrix.buyer_identity.buyer.state).toBe('knows');
    expect(input.matrix.buyer_ip.buyer.state).toBe('knows');
    expect(input.matrix.buyer_identity.provider.state).not.toBe('knows');
    expect(input.matrix.workload.relay.state).toBe('hidden');
    expect(input.matrix.workload.relay.ciphertext).toBe(true);
  });

  it('names the file after the request', () => {
    expect(receiptFilename(rfqId)).toBe(`silicr-receipt-${rfqId.slice(0, 8)}.html`);
  });
});

describe('renderReceipt', () => {
  it('is a complete, self-contained document in both themes', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\b(src|href)=["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain("default-src 'none'");
  });

  it('has the header, matrix, chain views, party records, known limits and the footer', () => {
    expect(html).toContain(rfqId);
    expect(html).toContain('Mock replay');
    expect(html).toContain('2026-10-22 12:00:00 UTC');
    expect(html).toContain('Who knows what');
    expect(html).toMatch(/class="cell knows"[^>]*>Knows<span class="tag limit">limit 1<\/span>/);
    expect(html).not.toContain('unexpected</span>');
    expect(html).toContain('PRIVATE');
    expect(html).toContain('Ciphertext only');
    expect(html).toContain('exact (own broadcast)');
    expect(html).toContain('Shielded actions');
    for (const p of PARTIES) expect(html).toContain(`id="party-${p}"`);
    for (const l of RECEIPT_KNOWN_LIMITS) expect(html).toContain(l.title);
    expect(html).toContain('seen in this request');
    expect(html).toContain('What was simulated, what was real');
    expect(html).toContain('scripted mock replay');
  });

  it('leaks no 64-hex value in the clear that is not a txid, a public key or a digest the chain already carries', () => {
    const s = getState();
    // Public by construction: txids, note ciphertexts, provider ids, digests. Sealed values (readable=false)
    // are ciphertext the party holds, not plaintext.
    const allowed = new Set<string>();
    for (const t of input.transactions) {
      allowed.add(t.txid.toLowerCase());
      for (const c of t.ciphertextSamples) allowed.add(c.toLowerCase());
    }
    for (const txid of Object.keys(s.chainTx)) allowed.add(txid.toLowerCase());
    for (const p of s.providers ?? []) allowed.add(p.providerId.toLowerCase());
    for (const p of PARTIES) {
      for (const o of input.columns[p].observations) {
        for (const f of o.fields) {
          const publicLabel = /checkpoint|digest|sha-?256|txid|transaction id|provider id|public key|\bkey\b/i.test(f.label) && !/secret|spending|private|seed/i.test(f.label);
          if (!f.readable || publicLabel) {
            for (const m of f.value.matchAll(/[0-9a-f]{64}/gi)) allowed.add(m[0].toLowerCase());
          }
        }
      }
    }
    const hexes = [...html.matchAll(/[0-9a-f]{64}/gi)].map((m) => m[0].toLowerCase());
    expect(hexes.length).toBeGreaterThan(0);
    expect(hexes.filter((h) => !allowed.has(h))).toEqual([]);
    expect(html).not.toMatch(/<span class="l">[^<]*(seed|secret|spending key)/i); // no party's record labels a secret
    expect(html).not.toContain(world.buyerAddress.slice(0, 40) + '…'); // addresses are quoted whole or not at all
  });

  it('marks unexpected knowledge and real funds', () => {
    const leaky: ReceiptInput = structuredClone(input);
    leaky.chainKind = 'main';
    leaky.network = 'main';
    leaky.matrix.buyer_identity.relay = { state: 'knows', evidence: ['Reply address'] };
    const out = renderReceipt(leaky);
    expect(out).toContain('LEAK');
    expect(out).toContain('Silicr relay knows “Who the buyer is”');
    expect(out).toContain('class="cell knows unexpected"');
    expect(out).toContain('Real ZEC');
    expect(out).toContain('Zcash mainnet');
  });

  it('escapes what parties hold', () => {
    const hostile: ReceiptInput = structuredClone(input);
    hostile.columns.buyer.observations[0]!.fields.push({ label: '<img src=x onerror=alert(1)>', value: '"><script>alert(1)</script>', readable: true, sensitive: false, facts: [] });
    const out = renderReceipt(hostile);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;script&gt;');
  });
});
