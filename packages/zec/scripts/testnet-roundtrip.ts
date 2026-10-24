/**
 * Testnet round trip: buyer → provider, ONE shielded transaction with TWO outputs, each with its
 * own 512-byte binary memo; one to provider.address(), one to a fresh provider.newAddress().
 * Then polls the provider until both notes are seen (mempool, then mined) and prints the
 * latencies, the memo check and the public view of the transaction.
 *
 *   cd zec-sidecar && cargo build --release && cd ..
 *   npx tsx packages/zec/scripts/testnet-roundtrip.ts            # prints addresses + balances; sends if funded
 *   npx tsx packages/zec/scripts/testnet-roundtrip.ts --no-send  # never sends
 *
 * Options: --amount <zats> (per output, default 50000), --server host:port,
 *          --timeout-min <n> (default 30), --wallets <dir> (default <repo>/.silicr/wallets)
 *
 * Wallets live in <repo>/.silicr/wallets/{buyer,provider} (gitignored). Seeds are never printed.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MEMO_SIZE, ZATS_PER_ZEC } from '../src/contract.ts';
import { InsufficientFundsError, isOrchardOnly } from '../src/index.ts';
import {
  createTestnetBackend,
  type TestnetBackend,
  type TestnetReceivedNote,
} from '../src/testnet/index.ts';

// Checked 2026-10-01. Both pay Orchard receivers into Ironwood (NU6.3-aware).
const FAUCETS = [
  'https://fauzec.com  (1 TAZ per address per 24 h; Turnstile check; accepts utest1 unified addresses)',
  'https://faucet.testnet.valargroup.dev  (0.125 TAZ per claim; global cap of 100 claims per 24 h)',
  'https://zcashfaucet.jinolabs.xyz  (0.1 TAZ; was down on 2026-10-01)',
  'or ask on https://forum.zcashcommunity.com (e.g. the "Requesting testnet TAZ" threads)',
];

const { values: args } = parseArgs({
  options: {
    amount: { type: 'string', default: '50000' },
    server: { type: 'string' },
    'timeout-min': { type: 'string', default: '30' },
    wallets: { type: 'string' },
    'no-send': { type: 'boolean', default: false },
  },
});

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const walletsDir = args.wallets ?? join(repoRoot, '.silicr', 'wallets');
const amount = BigInt(args.amount);
const timeoutMs = Number(args['timeout-min']) * 60_000;

function zec(z: bigint): string {
  const neg = z < 0n;
  const a = neg ? -z : z;
  return `${neg ? '-' : ''}${a / ZATS_PER_ZEC}.${(a % ZATS_PER_ZEC).toString().padStart(8, '0')} TAZ`;
}

function hexPrefix(b: Uint8Array, n = 16): string {
  return Buffer.from(b.subarray(0, n)).toString('hex');
}

/** A ZIP 302 arbitrary-data memo (0xFF prefix) with every byte value present, unique per output. */
function binaryMemo(tag: string, nonce: Uint8Array): Uint8Array {
  const m = new Uint8Array(MEMO_SIZE);
  m[0] = 0xff;
  m.set(new TextEncoder().encode(`SLCRT1:${tag}:`), 1);
  m.set(nonce, 32);
  for (let i = 64; i < MEMO_SIZE; i++) m[i] = (i * 151 + nonce[i % nonce.length]!) & 0xff;
  return m;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function open(name: string): Promise<TestnetBackend> {
  const t = Date.now();
  const cfg: Parameters<typeof createTestnetBackend>[0] = { kind: 'testnet', dataDir: join(walletsDir, name), create: true };
  if (args.server) cfg.server = args.server;
  const b = await createTestnetBackend(cfg);
  console.log(
    `[${name}] wallet ready in ${Date.now() - t} ms (birthday ${b.startup.birthday}, tip ${b.startup.tip}, initial sync ${b.startup.scannedBlocks} blocks in ${b.startup.syncMs} ms)`,
  );
  return b;
}

async function main(): Promise<void> {
  console.log(`Silicr testnet round trip — wallets in ${walletsDir}\n`);
  const buyer = await open('buyer');
  const provider = await open('provider');
  try {
    const [ba, pa] = [await buyer.address(), await provider.address()];
    const [bb, pb] = [await buyer.balance(), await provider.balance()];
    if (!isOrchardOnly(ba) || !isOrchardOnly(pa)) throw new Error('wallet address is not Orchard-only');
    console.log(`\nbuyer    address  ${ba}`);
    console.log(`         balance  spendable ${zec(bb.spendable)}, pending ${zec(bb.pending)}`);
    console.log(`provider address  ${pa}`);
    console.log(`         balance  spendable ${zec(pb.spendable)}, pending ${zec(pb.pending)}\n`);

    const need = amount * 2n + 30_000n;
    if (args['no-send']) return;
    if (bb.spendable < need) {
      console.log(`Buyer needs at least ${zec(need)} spendable to run the round trip.`);
      if (bb.pending > 0n) console.log('Some funds are pending: received notes become spendable after 10 confirmations (ZIP 315).');
      console.log('Fund the buyer address above with testnet ZEC (TAZ):');
      for (const f of FAUCETS) console.log(`  - ${f}`);
      process.exitCode = 2;
      return;
    }

    const fresh = await provider.newAddress();
    const nonce = randomBytes(32);
    const memos = [binaryMemo('A', nonce), binaryMemo('B', nonce)];
    const targets = [pa, fresh];
    const since = await provider.height();
    console.log(`sending 2 outputs of ${zec(amount)} each\n  #0 → provider.address()    ${pa}\n  #1 → provider.newAddress() ${fresh}`);

    const t0 = Date.now();
    let sent;
    try {
      sent = await buyer.send(targets.map((to, i) => ({ to, zats: amount, memo: memos[i]! })));
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        console.log(`not enough spendable funds yet: ${e.message}`);
        process.exitCode = 2;
        return;
      }
      throw e;
    }
    const sendMs = Date.now() - t0;
    console.log(
      `\ntxid ${sent.txid}\n  fee ${sent.feeZats} zats, ${sent.actions} Ironwood actions, propose ${sent.proposeMs} ms, prove+sign ${sent.proveMs} ms, broadcast ${sent.broadcastMs} ms, send() total ${sendMs} ms`,
    );

    const seenMempool = new Map<number, number>();
    const seenMined = new Map<number, { ms: number; note: TestnetReceivedNote }>();
    const byAddress = new Map<string, number>(targets.map((a, i) => [a, i]));
    const deadline = t0 + timeoutMs;
    while (seenMined.size < 2 && Date.now() < deadline) {
      const notes = (await provider.poll(since)).filter((n) => n.txid === sent.txid);
      for (const n of notes) {
        const i = byAddress.get(n.toAddress);
        if (i === undefined) throw new Error(`note ${n.txid}:${n.index} labelled with unknown address ${n.toAddress}`);
        if (n.height === null && !seenMempool.has(i)) {
          seenMempool.set(i, Date.now() - t0);
          console.log(`  output #${i} seen in MEMPOOL after ${Date.now() - t0} ms (note index ${n.index}, ${n.valuePool})`);
        }
        if (n.height !== null && !seenMined.has(i)) {
          seenMined.set(i, { ms: Date.now() - t0, note: n });
          console.log(`  output #${i} seen MINED at height ${n.height} after ${Date.now() - t0} ms`);
        }
      }
      if (seenMined.size < 2) await new Promise((r) => setTimeout(r, 1000));
    }
    if (seenMined.size < 2) throw new Error(`timed out after ${args['timeout-min']} min waiting for both notes to be mined`);

    console.log('\nmemo check:');
    let allOk = true;
    for (const [i, { note }] of [...seenMined.entries()].sort((a, b) => a[0] - b[0])) {
      const ok = eq(note.memo, memos[i]!) && note.zats === amount && note.toAddress === targets[i];
      allOk &&= ok;
      console.log(
        `  #${i} ${ok ? 'OK ' : 'BAD'} ${note.zats} zats to ${note.toAddress === targets[i] ? 'the right address' : 'WRONG address'}; memo prefix ${hexPrefix(note.memo)} (sent ${hexPrefix(memos[i]!)}), all 512 bytes ${eq(note.memo, memos[i]!) ? 'identical' : 'DIFFERENT'}`,
      );
    }

    const view = await buyer.inspectTx(sent.txid);
    console.log('\npublic view (what any chain observer sees):');
    console.log(
      JSON.stringify(view, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );

    const summary = {
      txid: sent.txid,
      feeZats: sent.feeZats.toString(),
      actions: sent.actions,
      proveMs: sent.proveMs,
      sendMs,
      mempoolSeenMs: Object.fromEntries(seenMempool),
      minedSeenMs: Object.fromEntries([...seenMined].map(([i, v]) => [i, v.ms])),
      minedHeight: [...seenMined.values()][0]?.note.height,
      memosIdentical: allOk,
    };
    console.log(`\nsummary ${JSON.stringify(summary)}`);
    if (!allOk) process.exitCode = 1;
  } finally {
    await Promise.allSettled([buyer.close(), provider.close()]);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exitCode = 1;
});
