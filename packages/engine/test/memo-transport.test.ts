// Relay-less mode: job, logs, heartbeats and result in Zcash memos. Memory chain (40 outputs per
// transaction, as on testnet/mainnet), real protocol, real process-mode runner and bundles, and a
// relay client that THROWS if any blob is ever appended to or read from it. Ephemeral everything.
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NewRfqRequest } from '@silicr/api';
import { createRunner, unpackBundle } from '@silicr/runner';
import type { RelayClient } from '@silicr/relay';
import { createMemoryNetwork, type MemoryNetwork, type PublicTxView } from '@silicr/zec';
import { deriveChannel, generateSigner, generateX25519, maxBlobBytes, newRfqId } from '@silicr/protocol';
import { BuyerNode } from '../src/buyer.ts';
import { ProviderNode } from '../src/provider.ts';
import { MemoTransport, DEFAULT_MAX_MEMO_BLOB_BYTES, type BlobTransport } from '../src/memo-transport.ts';
import { EngineError } from '../src/errors.ts';
import { withOverrides } from '../src/profile.ts';
import { hex } from '../src/util.ts';
import { TEST_PROFILE, tempDir, waitFor } from './helpers.ts';

const MAX_OUTPUTS = 40;

/** The directory still lives on the relay; every blob mailbox call is a test failure. */
class ThrowingRelay implements RelayClient {
  readonly baseUrl = 'http://relay-must-not-be-used.invalid';
  readonly directory = new Map<string, unknown>();
  calls = 0;
  async append(mailbox: string): Promise<number> {
    this.calls++;
    throw new Error(`relay.append(${mailbox}) called in relay-less mode`);
  }
  async read(mailbox: string): Promise<{ seq: number; data: Uint8Array }[]> {
    this.calls++;
    throw new Error(`relay.read(${mailbox}) called in relay-less mode`);
  }
  async listDirectory(): Promise<unknown[]> {
    return [...this.directory.values()].map((e) => structuredClone(e));
  }
  async publishDirectory(entry: unknown): Promise<void> {
    this.directory.set((entry as { providerId: string }).providerId, structuredClone(entry));
  }
}

// A ~2 KB job: prints progress and writes a small result. The comment block pads it to the size a
// real small script has, so the sealed job needs several memos.
const SCRIPT = `#!/usr/bin/env python3
"""A tiny relay-less Silicr job.

Incompressible padding, so the sealed job is really about 2 KB after gzip, like a real small job:
${randomBytes(1800).toString('base64')}
"""
import os, sys, time
out = os.environ.get("SILICR_OUTPUT_DIR", "output")
os.makedirs(out, exist_ok=True)
for step in range(1, 13):
    print(f"step {step} loss {1.0 / step:.3f}", flush=True)
    print(f"SILICR_PROGRESS step={step}", flush=True)
    time.sleep(0.12)
with open(os.path.join(out, "result.txt"), "w") as f:
    f.write("MEMO-RESULT-MARKER steps=12\\n")
print("done", flush=True)
`;

const PROFILE = withOverrides(TEST_PROFILE, { name: 'memo-test', intervalS: 1, startWithinS: 10, jobFetchTimeoutS: 8, closeWaitS: 8 });

interface World {
  network: MemoryNetwork;
  relay: ThrowingRelay;
  buyer: BuyerNode;
  provider: ProviderNode;
  jobDir: string;
  close(): Promise<void>;
}

async function world(buyerMode: BlobTransport, providerMode: BlobTransport): Promise<World> {
  const root = await tempDir('silicr-memo-');
  const network = createMemoryNetwork({ blockTimeMs: 100, capabilities: { maxOutputsPerTx: MAX_OUTPUTS } });
  const relay = new ThrowingRelay();
  const runner = await createRunner({ mode: 'process', workDir: join(root, 'runner') });
  const provider = new ProviderNode({
    backend: network.wallet('provider', { fundZats: 100_000_000n }),
    relay,
    dataDir: join(root, 'provider'),
    profile: PROFILE,
    runner,
    blobTransport: providerMode,
    policy: { gpus: [{ model: 'cpu', count: 1, vramGb: 0 }], minPricePerHourZats: 36_000_000n },
  });
  await provider.start();
  const buyer = new BuyerNode({
    backend: network.wallet('buyer', { fundZats: 1_000_000_000n }),
    relay,
    dataDir: join(root, 'buyer'),
    profile: PROFILE,
    blobTransport: buyerMode,
  });
  await buyer.start();
  const jobDir = join(root, 'job');
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, 'job.py'), SCRIPT);
  return {
    network,
    relay,
    buyer,
    provider,
    jobDir,
    async close() {
      await buyer.close();
      await provider.close();
      network.stop();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

function request(jobDir: string): NewRfqRequest {
  return {
    gpu: 'cpu',
    count: 1,
    durationS: 4,
    maxPricePerHourZats: '80000000',
    job: { path: jobDir, command: ['python3', 'job.py'] },
    autoAccept: { rule: 'cheapest', waitBlocks: 1 },
  };
}

const shielded = (v: PublicTxView) => v.ironwood ?? v.orchard;

let w: World | null = null;
afterEach(async () => {
  await w?.close();
  w = null;
});

describe('relay-less (memo) transport', () => {
  it('runs a whole deal with nothing but the chain: HELLO, job, heartbeats, logs and result in memos; the relay is never touched', async () => {
    w = await world('memo', 'memo');
    const { rfqId } = await w.buyer.createRfq(request(w.jobDir));
    await waitFor(() => ['closed', 'failed', 'expired'].includes(w!.buyer.getRfq(rfqId).state), 'the deal to finish', 40_000, 50);
    const r = w.buyer.getRfq(rfqId);
    expect(r.error).toBeUndefined();
    expect(r.state).toBe('closed');
    expect(w.relay.calls).toBe(0);

    // RFQ + HELLO per provider, still inside the 4-output bucket
    expect(r.providersAsked).toBe(1);
    expect(r.paddedOutputs).toBe(4);
    expect(r.bids).toHaveLength(1);
    expect(r.closeReason).toBe('done');
    expect(r.resultVerified).toBe(true);
    expect(r.heartbeats.length).toBeGreaterThan(1);
    expect(r.heartbeats[0]!.status).toBe('finished');
    expect(r.payments.filter((p) => p.kind === 'pay').length).toBeGreaterThanOrEqual(1);
    expect(r.logTail.some((l) => /loss/.test(l))).toBe(true);
    const job = w.provider.getJob(rfqId);
    expect(job.state).toBe('done');
    expect(job.resultDigest).toBe(r.result!.digest);

    // the result really is the script's output, reassembled from memos
    const out = await tempDir('silicr-memo-out-');
    await unpackBundle(await w.buyer.resultBytes(rfqId), out);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(out, 'result.txt'), 'utf8')).toContain('MEMO-RESULT-MARKER');

    // what the public chain shows: only shielded (Ironwood) actions, no transparent or Sapling parts anywhere
    const txs = w.network.explorer();
    expect(txs.length).toBeGreaterThan(6);
    for (const v of txs) {
      expect(v.transparent).toEqual({ inputs: 0, outputs: 0 });
      expect(v.sapling.spends + v.sapling.outputs).toBe(0);
      expect(shielded(v).actions).toBeGreaterThanOrEqual(2);
      expect(shielded(v).actions).toBeLessThanOrEqual(MAX_OUTPUTS + 1);
    }
    // the sealed job (~2.1 KB + manifest) took several memos in one transaction: its action count is the only trace
    const jobTx = txs.find((v) => shielded(v).actions >= 7 && shielded(v).actions <= MAX_OUTPUTS + 1);
    expect(jobTx).toBeDefined();
    const observerLeaks = w.buyer.listLeaks({ rfqId, party: 'buyer' }).filter((o) => o.event === 'memo-blob-sent');
    expect(observerLeaks).toHaveLength(1);
    expect(observerLeaks[0]!.summary).toMatch(/job blob sent on-chain/);
    const providerSent = w.provider.listLeaks({ rfqId, party: 'provider' }).filter((o) => o.event === 'memo-blob-sent');
    expect(providerSent.some((o) => /result blob/.test(o.summary))).toBe(true);
    expect(providerSent.some((o) => /heartbeat blob/.test(o.summary))).toBe(true);

    // heartbeats went once per interval (plus status changes), not every 100 ms
    const hbs = providerSent.filter((o) => /heartbeat blob/.test(o.summary)).length;
    expect(hbs).toBeLessThanOrEqual(12);

    // fees: every memo output is an action; both sides' fee totals include their blobs
    const buyerFees = BigInt(r.feesZats);
    const providerFees = BigInt(job.feesZats);
    expect(buyerFees).toBeGreaterThan(0n);
    expect(providerFees).toBeGreaterThan(0n);
    const chainFees = txs.reduce((n, v) => n + (v.feeZats ?? 0n), 0n);
    // chain fees = buyer's (RFQ, ACCEPT, PAYs, CLOSE, job blob) + provider's (BID, CLOSE, blobs); values moved count on neither side's fee total exactly, so compare loosely
    expect(chainFees).toBeGreaterThanOrEqual(buyerFees + providerFees - 100_000n);
    // eslint-disable-next-line no-console
    console.log(`memo-mode deal: ${txs.length} transactions, chain fees ${chainFees} zats, buyer fees ${buyerFees}, provider fees ${providerFees}`);
  }, 60_000);

  it('refuses to bid when the transports disagree, with a clear reason', async () => {
    w = await world('memo', 'relay');
    const { rfqId } = await w.buyer.createRfq(request(w.jobDir));
    const noBid = await waitFor(() => w!.provider.listLeaks({ rfqId }).find((o) => o.event === 'no-bid'), 'the provider to refuse', 10_000, 50);
    expect(noBid.summary).toMatch(/relay-less/);
    expect(noBid.summary).toMatch(/--transport memo/);
    expect(w.provider.listJobs().find((j) => j.rfqId === rfqId)).toBeUndefined();
    expect(w.buyer.getRfq(rfqId).bids).toHaveLength(0);
    await w.close();

    w = await world('relay', 'memo');
    const second = await w.buyer.createRfq(request(w.jobDir));
    const refused = await waitFor(() => w!.provider.listLeaks({ rfqId: second.rfqId }).find((o) => o.event === 'no-bid'), 'the memo provider to refuse', 10_000, 50);
    expect(refused.summary).toMatch(/uses the relay/);
  }, 40_000);

  it('refuses blobs beyond the cap and points at the relay', async () => {
    w = await world('memo', 'memo');
    const network = w.network;
    const relay = w.relay;
    const backend = network.wallet('x', { fundZats: 10_000_000n });
    const t = new MemoTransport({ mode: 'memo', relay, backend, transport: 'binary', role: 'buyer', send: () => Promise.reject(new Error('unused')) });
    const a = generateX25519();
    const b = generateX25519();
    const rfqId = newRfqId();
    const ch = deriveChannel(a.secretKey, b.publicKey, rfqId);
    t.register(hex(rfqId), ch, { to: await backend.address(), signer: generateSigner().signer });
    expect(DEFAULT_MAX_MEMO_BLOB_BYTES).toBe(maxBlobBytes(160));
    expect(DEFAULT_MAX_MEMO_BLOB_BYTES).toBeGreaterThan(40 * 1024);
    const tooBig = ch.seal('job', new Uint8Array(DEFAULT_MAX_MEMO_BLOB_BYTES));
    let err: unknown;
    await t.append(ch.mailboxes.job, tooBig).catch((e) => (err = e));
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe('blob_too_large');
    expect((err as EngineError).message).toMatch(/use the relay/);
    expect(relay.calls).toBe(0);
    // an unregistered mailbox goes to the relay (a relay-mode deal on the same node)
    await expect(t.append('0'.repeat(32), new Uint8Array(1))).rejects.toThrow(/relay\.append/);

    // a job too large for memos is refused up front by the buyer, before anything is sent
    const big = join(w.jobDir, 'weights.bin');
    await writeFile(big, randomBytes(DEFAULT_MAX_MEMO_BLOB_BYTES));
    await expect(w.buyer.createRfq(request(w.jobDir))).rejects.toThrow(/relay-less \(memo\) transport carries at most/);
  }, 20_000);

  it('status reports the transport', async () => {
    w = await world('memo', 'memo');
    expect((await w.buyer.status()).blobTransport).toBe('memo');
    expect((await w.provider.status()).blobTransport).toBe('memo');
  });
});
