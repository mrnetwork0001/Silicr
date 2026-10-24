// `silicr audit` against a real in-process stack (memory chain, relay with observer feed, both daemons in demo mode).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_PROFILE, startLocalStack, withOverrides, type LocalStack } from '@silicr/engine';
import { buildProgram } from '../src/program.ts';
import { buildReceiptInput, fetchAuditSources, receiptVerdict, renderReceipt } from '../src/commands/audit.ts';
import { DaemonClient } from '../src/client.ts';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const TINY = join(REPO, 'examples', 'tiny-train');

let stack: LocalStack;
let tmp: string;
let rfqId: string;

async function silicr(...args: string[]): Promise<string> {
  const out: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  try {
    await buildProgram().exitOverride().parseAsync(args, { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  // eslint-disable-next-line no-control-regex
  return out.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'silicr-audit-'));
  stack = await startLocalStack({
    rootDir: join(tmp, 'stack'),
    fresh: true,
    blockTimeMs: 100,
    profile: withOverrides(FAST_PROFILE, { blockTimeS: 0.1, pollMs: 50, bidWindowBlocks: 50, intervalS: 1, heartbeatS: 0.2, heartbeatTimeoutS: 3, relayWaitS: 1 }),
    ports: { relay: 0, buyer: 0, provider: 0 },
    runnerMode: 'process',
    demoMode: true,
    relayObserver: true,
    providerPolicy: { gpus: [{ model: 'a100', count: 1, vramGb: 80 }], minPricePerHourZats: 60_000_000n },
  });
  const text = await silicr(
    'run', '--daemon', stack.buyerDaemon.url, '--gpu', 'a100', '--hours', '0.1', '--max', '0.8', '--auto',
    '--env', 'SILICR_STEPS=40', '--env', 'SILICR_STEP_DELAY_MS=30', TINY, '--', 'python3', 'train.py',
  );
  expect(text).toMatch(/CLOSE +done/);
  rfqId = stack.buyer.listRfqs()[0]!.rfqId;
}, 90_000);

afterAll(async () => {
  await stack?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('silicr audit', () => {
  it('is registered', () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain('audit');
  });

  it('writes a self-contained HTML receipt with every party, the matrix and the chain views', async () => {
    const out = join(tmp, 'receipt.html');
    const text = await silicr('audit', rfqId.slice(0, 10), '--buyer', stack.buyerDaemon.url, '--provider', stack.providerDaemon!.url, '--relay', stack.relay.url, '--out', out);
    expect(text).toMatch(/privacy receipt .*PRIVATE/);
    expect(text).toMatch(/provider view +\d+ observations/);
    expect(text).toMatch(/relay view +\d+ observations/);
    expect(text).toContain(out);
    expect(existsSync(out)).toBe(true);
    const html = await readFile(out, 'utf8');

    // Self-contained: no scripts, no external requests, both themes.
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\b(src|href)=["']?(https?:)?\/\//i);
    expect(html).toContain('prefers-color-scheme:dark');

    // Header.
    expect(html).toContain(rfqId);
    expect(html).toContain('Simulated chain (memory network)');
    expect(html).toContain('closed (done)');
    expect(html).toContain(`by silicr audit`);

    // Matrix: the provider knows the workload (known limit 1), nothing unexpected, chain knows nothing.
    expect(html).toMatch(/class="cell knows"[^>]*>Knows<span class="tag limit">limit 1<\/span>/);
    expect(html).not.toContain('unexpected</span>');
    expect(html).toContain('>PRIVATE<');
    expect(html).toContain('Ciphertext only');

    // Chain views: action counts, fee, provenance chip, ciphertext samples.
    expect(html).toContain('Shielded actions');
    expect(html).toMatch(/\d+ Ironwood<\/td>/);
    expect(html).toMatch(/<span class="chip (ok|warn|neutral)">/);
    expect(html).toMatch(/class="samples">[0-9a-f…]+/);
    expect(html).toContain('ACCEPT (interval #0)');
    expect(html).toMatch(/PAY #1/);

    // Party records with field states.
    for (const p of ['chain', 'relay', 'provider', 'buyer']) expect(html).toContain(`id="party-${p}"`);
    expect(html).toContain('class="st knows"');
    expect(html).toContain('class="st sealed"');
    expect(html).toContain(stack.provider!.alias);

    // Known limits and the footer.
    expect(html).toContain('Known limits (THREAT_MODEL.md)');
    expect(html).toContain('seen in this request');
    expect(html).toContain('What was simulated, what was real');
    expect(html).toContain('No transaction reached Zcash');
    expect(html).toContain('every party runs on this machine');
  }, 30_000);

  it('--json prints the receipt data', async () => {
    const text = await silicr('audit', rfqId, '--buyer', stack.buyerDaemon.url, '--provider', stack.providerDaemon!.url, '--relay', stack.relay.url, '--json');
    const data = JSON.parse(text) as ReturnType<typeof buildReceiptInput> & ReturnType<typeof receiptVerdict>;
    expect(data.verdict).toBe('private');
    expect(data.rfqId).toBe(rfqId);
    expect(data.chainKind).toBe('memory');
    expect(data.matrix.workload.provider.state).toBe('knows');
    expect(data.matrix.workload.provider.limit).toBe(1);
    expect(data.matrix.buyer_identity.provider.state).not.toBe('knows');
    expect(data.matrix.buyer_identity.chain.state).toBe('hidden');
    expect(data.columns.relay.available).toBe(true);
    expect(data.columns.relay.observations.length).toBeGreaterThan(0);
    expect(data.columns.provider.observations.length).toBeGreaterThan(0);
    expect(data.transactions.length).toBeGreaterThanOrEqual(3);
    expect(data.transactions.every((t) => t.pool === 'Ironwood' && t.actions > 0)).toBe(true);
    expect(data.knows.chain).toBe(0);
  }, 30_000);

  it('outside demo mode the provider and relay views are not fetched, and that is stated', async () => {
    const sources = await fetchAuditSources({ rfqId, buyer: new DaemonClient(stack.buyerDaemon.url), provider: new DaemonClient(stack.providerDaemon!.url), relayUrl: stack.relay.url });
    const input = buildReceiptInput({
      ...sources,
      status: { ...sources.status, demoMode: false },
      provider: { available: false, source: sources.provider.source, reason: 'Not in demo mode: other machines’ data', observations: [] },
      relay: { available: false, source: sources.relay.source, reason: 'Not in demo mode: other machines’ data', observations: [] },
    });
    expect(input.columns.provider.available).toBe(false);
    expect(input.matrix.workload.provider.state).toBe('na');
    expect(input.matrix.workload.buyer.state).toBe('knows');
    const html = renderReceipt(input);
    expect(html).toContain('>No data<');
    expect(html).toContain('Not in demo mode');
    expect(receiptVerdict(input).verdict).toBe('private');
  }, 30_000);

  it('fails clearly for an unknown request', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      await expect(silicr('audit', 'ffffffff', '--buyer', stack.buyerDaemon.url)).rejects.toThrow('exit');
    } finally {
      exit.mockRestore();
    }
  });
});
