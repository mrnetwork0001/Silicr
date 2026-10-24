// `silicr demo [--run] [--fast]`: every party in one process on a simulated chain.
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { NewRfqRequest, RfqDto } from '@silicr/api';
import { startLocalStack, WEB_PORT, type LocalStack } from '@silicr/engine';
import { DaemonClient } from '../client.ts';
import { repoRoot } from '../config.ts';
import { follow } from '../follow.ts';
import { duration, fail, kv, pc, zec } from '../format.ts';

export interface DemoOptions {
  run?: boolean;
  fast?: boolean;
  runner?: 'auto' | 'process' | 'docker';
  keep?: boolean;
  /** relay = base, buyer = base + 1, provider = base + 2. Default 7700. */
  portBase?: string;
  /** Data dir (wiped at start). Default .silicr/demo. */
  data?: string;
  /** memo = relay-less: every blob of the deal travels in memos; the relay only serves the directory. */
  transport?: 'relay' | 'memo';
}

const ZEC = 100_000_000n;

export async function demo(o: DemoOptions): Promise<void> {
  const root = repoRoot();
  const dataRoot = o.data ? resolve(o.data) : join(root, '.silicr', 'demo');
  const base = Number(o.portBase ?? 7700);
  if (!Number.isInteger(base) || base < 1024 || base > 65530) fail('--port-base must be a port number between 1024 and 65530');
  const blockTimeMs = o.fast ? 250 : 1000;
  const tinyTrain = join(root, 'examples', 'tiny-train');

  console.log();
  console.log(`  ${pc.bold('Silicr demo')}  ${pc.dim('· every party runs in this one process')}`);
  console.log(
    `  ${pc.bgYellow(pc.black(' SIMULATED CHAIN '))} ${pc.yellow(
      `in-memory stand-in for Zcash: shielded-only (Ironwood) rules, ZIP 317 fees, ${blockTimeMs / 1000} s blocks. Not testnet, no real ZEC.`,
    )}`,
  );
  console.log();

  let stack: LocalStack;
  try {
    stack = await startLocalStack({
      rootDir: dataRoot,
      fresh: true,
      blockTimeMs,
      ports: { relay: base, buyer: base + 1, provider: base + 2 },
      runnerMode: o.runner ?? 'auto',
      buyerFundZats: 10n * ZEC,
      providerFundZats: 1n * ZEC,
      providerPolicy: {
        gpus: [
          { model: 'a100', count: 1, vramGb: 80 },
          { model: 'cpu', count: 8, vramGb: 0 },
        ],
        minPricePerHourZats: 60_000_000n,
      },
      demoMode: true,
      ...(o.transport === 'memo' ? { blobTransport: 'memo' as const } : {}),
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { port?: number };
    if (err.code === 'EADDRINUSE') {
      fail(`port ${err.port ?? `${base}-${base + 2}`} is already in use. Is another \`silicr demo\` running? Use --port-base and --data to run a second one.`);
    }
    fail((e as Error).message);
  }

  const provider = stack.provider!;
  const runner = stack.runner!;
  const sandboxed = runner.sandboxed ?? runner.mode === 'docker';
  const policy = provider.getPolicy();
  kv([
    ['relay', `${stack.relay.url}   ${pc.dim('ciphertext-only store · observer feed at /_observer')}`],
    ['buyer', `${stack.buyerDaemon.url}   ${pc.dim('wallet funded with 10 ZEC (simulated)')}`],
    [
      'provider',
      `${stack.providerDaemon!.url}   ${pc.bold(provider.alias)} · ${policy.gpus.map((g) => `${g.count}× ${g.model}`).join(' + ')} · min ${zec(policy.minPricePerHourZats)}/h`,
    ],
    [
      'runner',
      sandboxed
        ? `${pc.green('docker sandbox')} ${pc.dim('(python:3.12-slim, no network, read-only)')}`
        : `${pc.red('process mode: NOT a sandbox')} ${pc.dim('(Docker is not reachable; start Docker or Colima for sandboxed jobs)')}`,
    ],
    [
      'transport',
      o.transport === 'memo'
        ? `${pc.green('memo (relay-less)')}   ${pc.dim('job, logs, heartbeats and result travel in shielded memos; the relay only serves the directory')}`
        : `relay   ${pc.dim('blobs as ciphertext on the relay; try --transport memo for a relay-less deal')}`,
    ],
    ['web', `http://localhost:${WEB_PORT}   ${pc.dim('Leak Inspector; start it with: pnpm --filter @silicr/web dev')}`],
    ['data', `${relative(process.cwd(), dataRoot) || dataRoot}   ${pc.dim('(wiped at every start)')}`],
  ]);
  if (!sandboxed && runner.notice) for (const line of wrap(runner.notice, 96)) console.log(`  ${' '.repeat(10)}${pc.dim(line)}`);
  console.log(`  ${pc.dim("The demo GPU is simulated: jobs actually run on this machine's CPU.")}`);
  console.log();

  let closing = false;
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    await stack.close().catch(() => undefined);
    process.exit(code);
  };
  process.on('SIGINT', () => {
    console.log(pc.dim('\n  stopping…'));
    void shutdown(130);
  });
  process.on('SIGTERM', () => void shutdown(143));

  if (!o.run) {
    const daemonFlag = base === 7700 ? '' : ` --daemon ${stack.buyerDaemon.url}`;
    console.log(`  ${pc.green('ready')}. Try: ${pc.bold(`pnpm silicr run${daemonFlag} --gpu a100 --hours 0.2 --max 0.8 --auto examples/tiny-train -- python3 train.py`)}`);
    console.log(`  ${pc.dim('Ctrl-C to stop.')}`);
    await new Promise(() => undefined);
    return;
  }

  if (!existsSync(join(tinyTrain, 'train.py'))) fail(`examples/tiny-train/train.py is missing (looked in ${tinyTrain})`);
  const buyer = new DaemonClient(stack.buyerDaemon.url);
  const providerClient = new DaemonClient(stack.providerDaemon!.url);
  const env = o.fast ? { SILICR_STEPS: '200', SILICR_STEP_DELAY_MS: '30' } : { SILICR_STEPS: '200', SILICR_STEP_DELAY_MS: '100' };
  const req: NewRfqRequest = {
    gpu: 'a100',
    count: 1,
    durationS: 600,
    maxPricePerHourZats: (80_000_000n).toString(),
    job: { path: tinyTrain, command: ['python3', 'train.py'], env } as NewRfqRequest['job'],
    autoAccept: { rule: 'cheapest', waitBlocks: 2 },
  };
  console.log(
    `  ${pc.bold('Buyer')}: rent 1× a100 for up to ${duration(req.durationS)} at ≤ ${zec(req.maxPricePerHourZats)}/h to run ${pc.bold('examples/tiny-train')} ` +
      `(${pc.dim('python3 train.py')}), auto-accepting the cheapest signed bid.`,
  );
  console.log();
  const { rfqId } = await buyer.post<{ rfqId: string }>('/api/rfqs', req);
  let final: RfqDto;
  try {
    final = await follow({ buyer, provider: providerClient, rfqId });
  } catch (e) {
    console.error(pc.red(`  lost the event stream: ${(e as Error).message}`));
    return shutdown(1);
  }
  console.log();
  if (final.state === 'closed' && final.result) {
    const file = join(dataRoot, 'buyer', 'results', `${rfqId}.tar.gz`);
    kv([
      ['result', `${relative(process.cwd(), file) || file}  ${pc.dim('(tar.gz with model.json, metrics.json, sample.txt)')}`],
      ['paid', `${final.payments.length} shielded payments, ${zec(final.spentZats)} to the provider + ${zec(final.feesZats)} fees and dust${o.transport === 'memo' ? ' (memo transport included)' : ''}`],
      ['chain', chainSummary(stack)],
      ['inspect', `${stack.buyerDaemon.url}/api/leaks?rfqId=${rfqId}  ·  relay: ${stack.relay.url}/_observer`],
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

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** What the simulated block explorer holds after the run: every transaction fully shielded. */
function chainSummary(stack: LocalStack): string {
  const txs = stack.network.explorer();
  const transparent = txs.reduce((n, v) => n + v.transparent.inputs + v.transparent.outputs + v.sapling.spends + v.sapling.outputs, 0);
  return `${txs.length} transactions on the simulated chain, ${transparent} transparent or Sapling parts; amounts, senders and recipients hidden in all of them`;
}
