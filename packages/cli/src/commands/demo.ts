// `silicr demo [--network test]`: relay + buyer + provider on Zcash testnet, in this one process,
// with the funded demo wallets in .silicr/wallets/test-buyer and test-provider, then one
// tiny-train deal. Mainnet is refused: the demo spends from shared wallets without a go-ahead.
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import type { NewRfqRequest, RfqDto } from '@silicr/api';
import { WEB_PORT, ProviderNode } from '@silicr/engine';
import { startRelay, type RunningRelay } from '@silicr/relay';
import { DaemonClient } from '../client.ts';
import { readConfig, repoRoot } from '../config.ts';
import { follow } from '../follow.ts';
import { duration, fail, kv, pc, zec } from '../format.ts';
import { resolveProxy, startParty, type StartedParty } from './node.ts';

export interface DemoOptions {
  /** 'test' (default). 'main' is refused. */
  network?: string;
  /** Default true; --no-run only starts the stack. */
  run?: boolean;
  runner?: 'auto' | 'process' | 'docker';
  keep?: boolean;
  /** relay = base, buyer = base + 1, provider = base + 2. Default 7700. */
  portBase?: string;
  /** Wallet dirs (default .silicr/wallets/test-buyer and test-provider). */
  buyerData?: string;
  providerData?: string;
  /** Relay data dir (wiped at start). Default .silicr/demo-test. */
  data?: string;
  server?: string;
  proxy?: string;
  /** memo = relay-less: every blob of the deal travels in memos; the relay only serves the directory. */
  transport?: 'relay' | 'memo';
}

/** The demo provider's offer: 0.06 TAZ/h, so the whole deal costs a few thousandths of a testnet coin. */
const DEMO_POLICY = {
  gpus: [
    { model: 'a100', count: 1, vramGb: 80 },
    { model: 'cpu', count: 8, vramGb: 0 },
  ],
  minPricePerHourZats: 6_000_000n,
};

/** Refuse anything but testnet, before any wallet is touched. */
export function checkDemoNetwork(n: string | undefined): 'test' {
  const v = (n ?? 'test').toLowerCase();
  if (v === 'main' || v === 'mainnet') {
    fail('`silicr demo` runs on Zcash testnet only: it spends from shared demo wallets without asking, so mainnet (real ZEC) is refused. For mainnet, run `silicr daemon --network main` and `silicr run` (docs/MAINNET.md).');
  }
  if (v !== 'test' && v !== 'testnet') fail(`--network must be test (got ${n}); the demo runs on Zcash testnet`);
  return 'test';
}

async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolveP, reject) => {
    const srv = createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => reject(Object.assign(e, { port })));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolveP()));
  });
}

export async function demo(o: DemoOptions): Promise<void> {
  const network = checkDemoNetwork(o.network);
  const root = repoRoot();
  const base = Number(o.portBase ?? 7700);
  if (!Number.isInteger(base) || base < 1024 || base > 65530) fail('--port-base must be a port number between 1024 and 65530');
  const buyerDir = resolve(o.buyerData ?? join(root, '.silicr', 'wallets', 'test-buyer'));
  const providerDir = resolve(o.providerData ?? join(root, '.silicr', 'wallets', 'test-provider'));
  const relayDir = resolve(o.data ?? join(root, '.silicr', 'demo-test'));
  const tinyTrain = join(root, 'examples', 'tiny-train');
  const run = o.run !== false;

  for (const [role, dir] of [['buyer', buyerDir], ['provider', providerDir]] as const) {
    const cfg = await readConfig(dir);
    if (!existsSync(join(dir, 'wallet.json')) && !existsSync(join(dir, 'data.sqlite'))) {
      fail(
        `no testnet ${role} wallet in ${dir}. Create and fund one first:\n` +
          `  pnpm silicr init --role ${role} --network test --data ${relative(process.cwd(), dir) || dir}\n` +
          '  then send it shielded (Orchard) testnet ZEC from a faucet or another testnet wallet.',
      );
    }
    if (cfg && cfg.network !== 'test') fail(`${dir} is a ${cfg.network} data dir; the demo only uses testnet wallets`);
    if (cfg && cfg.role !== role) fail(`${dir} is a ${cfg.role} data dir, not a ${role}`);
  }
  if (run && !existsSync(join(tinyTrain, 'train.py'))) fail(`examples/tiny-train/train.py is missing (looked in ${tinyTrain})`);
  try {
    for (const p of [base, base + 1, base + 2]) await assertPortFree(p);
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { port?: number };
    fail(`port ${err.port ?? `${base}-${base + 2}`} is already in use. Is another stack running? Use --port-base to pick other ports.`);
  }

  const bcfg = await readConfig(buyerDir);
  const pcfg = await readConfig(providerDir);
  const proxy = resolveProxy(o.proxy, bcfg?.proxy);
  const server = o.server ?? bcfg?.server ?? pcfg?.server;

  console.log();
  console.log(`  ${pc.bold('Silicr demo')}  ${pc.dim('· Zcash testnet · relay, buyer and provider in this one process')}`);
  console.log(`  ${pc.dim('Testnet coins only (no real ZEC). Opening the demo wallets; the first sync can take a minute.')}`);
  console.log();

  const parties: StartedParty[] = [];
  let relay: RunningRelay | null = null;
  let closing = false;
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    for (const p of parties.reverse()) await p.close().catch(() => undefined);
    await relay?.close().catch(() => undefined);
    process.exit(code);
  };
  process.on('SIGINT', () => {
    console.log(pc.dim('\n  stopping…'));
    void shutdown(130);
  });
  process.on('SIGTERM', () => void shutdown(143));

  await rm(relayDir, { recursive: true, force: true });
  relay = await startRelay({ port: base, host: '127.0.0.1', dataDir: join(relayDir, 'relay'), observer: true });
  const common = {
    network,
    relayUrl: relay.url,
    server,
    proxy,
    spendCap: null,
    blobTransport: o.transport ?? 'relay',
    demoMode: true,
  } as const;
  const provider = await startParty({ ...common, role: 'provider', dataDir: providerDir, port: base + 2, runner: o.runner ?? 'auto', policy: DEMO_POLICY });
  parties.push(provider);
  const buyer = await startParty({ ...common, role: 'buyer', dataDir: buyerDir, port: base + 1 });
  parties.push(buyer);

  const pnode = provider.node as ProviderNode;
  const [bs, ps] = await Promise.all([buyer.node.status(), pnode.status()]);
  const runner = (ps as typeof ps & { runner?: { mode: string; sandboxed: boolean; warning?: string } }).runner;
  const policy = pnode.getPolicy();
  kv([
    ['network', `Zcash testnet ${pc.dim(`(height ${bs.height}, ~${bs.blockTimeS} s blocks)`)}`],
    ['relay', `${relay.url}   ${pc.dim('ciphertext-only store · observer feed at /_observer')}`],
    ['buyer', `${buyer.daemon.url}   ${zec(bs.balance.spendable)} spendable, ${zec(bs.balance.pending)} pending ${pc.dim(`(${relative(process.cwd(), buyerDir) || buyerDir})`)}`],
    [
      'provider',
      `${provider.daemon.url}   ${pc.bold(pnode.alias)} · ${policy.gpus.map((g) => `${g.count}× ${g.model}`).join(' + ')} · min ${zec(policy.minPricePerHourZats)}/h · ${zec(ps.balance.spendable)} spendable`,
    ],
    [
      'runner',
      runner?.sandboxed
        ? `${pc.green('docker sandbox')} ${pc.dim('(python:3.12-slim, no network, read-only)')}`
        : `${pc.red(`${runner?.mode ?? 'process'} mode: NOT a sandbox`)} ${pc.dim('(start Docker or Colima for sandboxed jobs)')}`,
    ],
    [
      'transport',
      o.transport === 'memo'
        ? `${pc.green('memo (relay-less)')}   ${pc.dim('job, logs, heartbeats and result travel in shielded memos; the relay only serves the directory')}`
        : `relay   ${pc.dim('blobs as ciphertext on the relay; try --transport memo for a relay-less deal')}`,
    ],
    ['web', `http://localhost:${WEB_PORT}   ${pc.dim(base === 7700 ? 'Leak Inspector; start it with: pnpm --filter @silicr/web dev' : `point the web terminal at ${buyer.daemon.url} and ${provider.daemon.url} (NEXT_PUBLIC_BUYER_URL / NEXT_PUBLIC_PROVIDER_URL)`)}`],
  ]);
  console.log(`  ${pc.dim("The demo GPU is a label: jobs actually run on this machine's CPU.")}`);
  console.log();

  if (!run) {
    const daemonFlag = base === 7700 ? '' : ` --daemon ${buyer.daemon.url}`;
    console.log(`  ${pc.green('ready')}. Try: ${pc.bold(`pnpm silicr run${daemonFlag} --gpu a100 --hours 0.15 --max 0.08 --auto examples/tiny-train -- python3 train.py`)}`);
    console.log(`  ${pc.dim('Ctrl-C to stop.')}`);
    await new Promise(() => undefined);
    return;
  }

  const buyerClient = new DaemonClient(buyer.daemon.url);
  const providerClient = new DaemonClient(provider.daemon.url);
  const req: NewRfqRequest = {
    gpu: 'a100',
    count: 1,
    durationS: 600,
    maxPricePerHourZats: (8_000_000n).toString(),
    providerIds: [pnode.providerId],
    job: { path: tinyTrain, command: ['python3', 'train.py'], env: { SILICR_STEPS: '200', SILICR_STEP_DELAY_MS: '100' } },
    autoAccept: { rule: 'cheapest', waitBlocks: 1 },
  };
  console.log(
    `  ${pc.bold('Buyer')}: rent 1× a100 from ${pc.bold(pnode.alias)} for up to ${duration(req.durationS)} at ≤ ${zec(req.maxPricePerHourZats)}/h (testnet) to run ${pc.bold('examples/tiny-train')} ` +
      `(${pc.dim('python3 train.py')}), auto-accepting the cheapest signed bid. Testnet blocks take ~${bs.blockTimeS} s, so this takes a few minutes.`,
  );
  console.log();
  let final: RfqDto;
  try {
    const { rfqId } = await buyerClient.post<{ rfqId: string }>('/api/rfqs', req);
    final = await follow({ buyer: buyerClient, provider: providerClient, rfqId });
  } catch (e) {
    console.error(pc.red(`  ${(e as Error).message}`));
    return shutdown(1);
  }
  console.log();
  if (final.state === 'closed' && final.result) {
    const file = join(buyerDir, 'results', `${final.rfqId}.tar.gz`);
    const txids = new Set([...final.payments.map((p) => p.txid)]);
    kv([
      ['result', `${relative(process.cwd(), file) || file}  ${pc.dim('(tar.gz with model.json, metrics.json, sample.txt)')}`],
      ['paid', `${final.payments.length} shielded testnet payments, ${zec(final.spentZats)} to the provider + ${zec(final.feesZats)} fees and dust${o.transport === 'memo' ? ' (memo transport included)' : ''}`],
      ['chain', `${txids.size} payment transactions on Zcash testnet, all shielded (Orchard): amounts, senders and recipients hidden`],
      ['inspect', `${buyer.daemon.url}/api/leaks?rfqId=${final.rfqId}  ·  relay: ${relay.url}/_observer`],
    ]);
  }
  console.log();
  if (o.keep) {
    console.log(`  ${pc.green('still running')} for the web terminal (http://localhost:${WEB_PORT}). Ctrl-C to stop.`);
    await new Promise(() => undefined);
    return;
  }
  await shutdown(final.state === 'closed' ? 0 : 1);
}
