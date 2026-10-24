// Regenerates deal.json: real daemon DTOs from one finished deal on an in-process stack.
// The simulated chain exists only here (test infrastructure): statuses are relabelled as Zcash
// testnet, the only kind of network the web terminal runs against besides mainnet.
//   pnpm exec tsx apps/web/test/fixtures/generate.mts   (from the repo root)
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_PROFILE, startLocalStack } from '../../../../packages/engine/src/index.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..', '..', '..');
const rootDir = join(tmpdir(), `silicr-web-fixture-${process.pid}`);
const stack = await startLocalStack({
  rootDir,
  fresh: true,
  blockTimeMs: 250,
  profile: FAST_PROFILE,
  ports: { relay: 0, buyer: 0, provider: 0 },
  runnerMode: 'process',
  providerPolicy: { gpus: [{ model: 'a100', count: 1, vramGb: 80 }], minPricePerHourZats: 60_000_000n },
});
const get = async (base: string, path: string) => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
};
const b = stack.buyerDaemon.url;
const p = stack.providerDaemon!.url;
try {
  const res = await fetch(`${b}/api/rfqs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gpu: 'a100',
      count: 1,
      durationS: 60,
      maxPricePerHourZats: '80000000',
      job: { path: join(root, 'examples', 'tiny-train'), command: ['python3', 'train.py'], env: { SILICR_STEPS: '40', SILICR_STEP_DELAY_MS: '60' } },
      autoAccept: { rule: 'cheapest', waitBlocks: 1 },
    }),
  });
  const { rfqId } = (await res.json()) as { rfqId: string };
  for (let i = 0; i < 600; i++) {
    const r = (await get(b, `/api/rfqs/${rfqId}`)) as { state: string };
    if (['closed', 'expired', 'failed'].includes(r.state)) break;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  await new Promise((ok) => setTimeout(ok, 1500));
  const rfq = (await get(b, `/api/rfqs/${rfqId}`)) as { state: string; payments: { txid: string }[]; bids: { txid: string }[] };
  if (rfq.state !== 'closed') throw new Error(`deal ended ${rfq.state}`);
  const asTestnet = (s: Record<string, unknown>) => ({ ...s, network: 'test', blockTimeS: 25 });
  const buyerLeaks = (await get(b, `/api/leaks?rfqId=${rfqId}`)) as { fields: { value: string }[] }[];
  const providerLeaks = (await get(p, `/api/leaks?rfqId=${rfqId}`)) as unknown[];
  const relay = await get(stack.relay.url, '/_observer');
  const txids = new Set<string>();
  for (const x of [...rfq.payments, ...rfq.bids]) if (/^[0-9a-f]{64}$/.test(x.txid)) txids.add(x.txid);
  for (const o of [...buyerLeaks, ...(providerLeaks as typeof buyerLeaks)]) for (const f of o.fields) for (const m of f.value.matchAll(/\b[0-9a-f]{64}\b/g)) txids.add(m[0]);
  const chain = [];
  for (const t of txids) {
    const r = await fetch(`${b}/api/chain/tx/${t}`);
    // The simulated chain stamps blocks with whole seconds, which can fall a few ms before the RFQ
    // that went into them; round up so block times follow broadcasts as on a real chain.
    if (r.ok) {
      const v = (await r.json()) as { time: number | null };
      chain.push(v.time ? { ...v, time: v.time + 1 } : v);
    }
  }
  const fixture = {
    buyerStatus: asTestnet((await get(b, '/api/status')) as Record<string, unknown>),
    providerStatus: asTestnet((await get(p, '/api/status')) as Record<string, unknown>),
    providers: await get(b, '/api/providers'),
    rfq,
    job: await get(p, `/api/jobs/${rfqId}`),
    leaks: { buyer: buyerLeaks, provider: providerLeaks },
    relayObserver: relay,
    chain,
  };
  // No machine paths in a committed fixture.
  const text = JSON.stringify(fixture).split(rootDir).join('/home/demo/.silicr').split(root).join('/home/demo/silicr');
  await writeFile(join(here, 'deal.json'), text + '\n');
  console.log(`deal.json: rfq ${rfqId}, ${chain.length} chain views`);
} finally {
  await stack.close();
}
