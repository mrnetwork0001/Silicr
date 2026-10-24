// One process, every party: simulated chain + relay + provider + buyer, each with its daemon.
// Test harness only: the end-to-end tests and `pnpm verify` (users run testnet or mainnet).
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createMemoryNetwork, type MemoryNetwork, type MemoryNetworkOptions } from '@silicr/zec';
import { relayClient, startRelay, type RunningRelay } from '@silicr/relay';
import { createRunner, type Runner, type RunnerMode } from '@silicr/runner';
import { BuyerNode } from './buyer.ts';
import { ProviderNode, type ProviderPolicy } from './provider.ts';
import { startDaemon, type RunningDaemon } from './daemon.ts';
import { FAST_PROFILE, MEMORY_PROFILE, withOverrides, type TimingProfile } from './profile.ts';
import type { EngineDeps } from './deps.ts';
import type { BlobTransport } from './memo-transport.ts';

export interface LocalStackOptions {
  /** Parent of relay/, buyer/ and provider/ data dirs, e.g. .silicr/demo */
  rootDir: string;
  /** Delete rootDir first (the simulated chain starts empty every time, so old state is meaningless). */
  fresh?: boolean;
  blockTimeMs?: number;
  profile?: TimingProfile;
  /** 0 = ephemeral. Defaults: relay 7700, buyer 7701, provider 7702. */
  ports?: { relay?: number; buyer?: number; provider?: number };
  buyerFundZats?: bigint;
  providerFundZats?: bigint;
  providerPolicy?: Partial<ProviderPolicy>;
  runner?: Runner;
  runnerMode?: RunnerMode | 'auto';
  jobEnv?: Record<string, string>;
  memory?: Omit<MemoryNetworkOptions, 'blockTimeMs'>;
  demoMode?: boolean;
  /** Start the provider (and publish its directory entry). Default true. */
  withProvider?: boolean;
  relayObserver?: boolean;
  deps?: Partial<EngineDeps>;
  log?: (line: string) => void;
  /** 'memo' = relay-less: job, logs, heartbeats and result in Zcash memos for both parties (the relay still serves the directory). */
  blobTransport?: BlobTransport;
}

export interface LocalStack {
  network: MemoryNetwork;
  profile: TimingProfile;
  relay: RunningRelay;
  buyer: BuyerNode;
  provider: ProviderNode | null;
  buyerDaemon: RunningDaemon;
  providerDaemon: RunningDaemon | null;
  runner: Runner | null;
  close(): Promise<void>;
}

export function profileForBlockTime(blockTimeMs: number): TimingProfile {
  if (blockTimeMs === 1000) return MEMORY_PROFILE;
  if (blockTimeMs === 250) return FAST_PROFILE;
  const base = blockTimeMs < 1000 ? FAST_PROFILE : MEMORY_PROFILE;
  return withOverrides(base, { name: `memory-${blockTimeMs}ms`, blockTimeS: blockTimeMs / 1000 });
}

/** Throws EADDRINUSE (with .port) if a fixed port is taken, before anything is touched. */
async function assertPortsFree(ports: number[]): Promise<void> {
  for (const port of ports) {
    if (port === 0) continue;
    await new Promise<void>((resolveP, reject) => {
      const srv = createServer();
      srv.once('error', (e: NodeJS.ErrnoException) => reject(Object.assign(e, { port })));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolveP()));
    });
  }
}

/** Refuse to wipe a data dir another live stack is using. */
async function assertNotInUse(rootDir: string): Promise<void> {
  const raw = await readFile(join(rootDir, 'stack.pid'), 'utf8').catch(() => '');
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return; // stale lock
  }
  throw new Error(`another Silicr stack (pid ${pid}) is using ${rootDir}; pick another --data dir`);
}

export async function startLocalStack(o: LocalStackOptions): Promise<LocalStack> {
  const blockTimeMs = o.blockTimeMs ?? 1000;
  const profile = o.profile ?? profileForBlockTime(blockTimeMs);
  const ports = { relay: o.ports?.relay ?? 7700, buyer: o.ports?.buyer ?? 7701, provider: o.ports?.provider ?? 7702 };
  // Check before wiping anything: a second demo must never destroy a running one's data.
  await assertPortsFree([ports.relay, ports.buyer, ports.provider]);
  await assertNotInUse(o.rootDir);
  if (o.fresh) await rm(o.rootDir, { recursive: true, force: true });
  await mkdir(o.rootDir, { recursive: true, mode: 0o700 });
  await writeFile(join(o.rootDir, 'stack.pid'), `${process.pid}\n`, { mode: 0o600 });

  const cleanups: (() => Promise<void> | void)[] = [];
  const closeAll = async () => {
    const todo = cleanups.splice(0, cleanups.length).reverse();
    for (const c of todo) {
      try {
        await c();
      } catch {
        // keep closing the rest
      }
    }
  };
  cleanups.push(() => rm(join(o.rootDir, 'stack.pid'), { force: true }));
  try {
    const network = createMemoryNetwork({ ...(o.memory ?? {}), blockTimeMs });
    cleanups.push(() => network.stop());

    const relay = await startRelay({ port: ports.relay, host: '127.0.0.1', dataDir: join(o.rootDir, 'relay'), observer: o.relayObserver ?? true });
    cleanups.push(() => relay.close());

    let provider: ProviderNode | null = null;
    let providerDaemon: RunningDaemon | null = null;
    let runner: Runner | null = null;
    if (o.withProvider !== false) {
      runner = o.runner ?? (await createRunner({ mode: o.runnerMode ?? 'auto', workDir: join(o.rootDir, 'provider', 'runner') }));
      const pOpts: ConstructorParameters<typeof ProviderNode>[0] = {
        backend: network.wallet('provider', { fundZats: o.providerFundZats ?? 100_000_000n }),
        relay: relayClient(relay.url),
        dataDir: join(o.rootDir, 'provider'),
        profile,
        runner,
        demoMode: o.demoMode ?? true,
      };
      if (o.providerPolicy) pOpts.policy = o.providerPolicy;
      if (o.jobEnv) pOpts.jobEnv = o.jobEnv;
      if (o.deps) pOpts.deps = o.deps;
      if (o.log) pOpts.log = o.log;
      if (o.blobTransport) pOpts.blobTransport = o.blobTransport;
      provider = new ProviderNode(pOpts);
      await provider.start();
      const p = provider;
      cleanups.push(() => p.close());
      providerDaemon = await startDaemon({ node: provider, port: ports.provider });
      const pd = providerDaemon;
      cleanups.push(() => pd.close());
    }

    const bOpts: ConstructorParameters<typeof BuyerNode>[0] = {
      backend: network.wallet('buyer', { fundZats: o.buyerFundZats ?? 1_000_000_000n }),
      relay: relayClient(relay.url),
      dataDir: join(o.rootDir, 'buyer'),
      profile,
      demoMode: o.demoMode ?? true,
    };
    if (o.deps) bOpts.deps = o.deps;
    if (o.log) bOpts.log = o.log;
    if (o.blobTransport) bOpts.blobTransport = o.blobTransport;
    const buyer = new BuyerNode(bOpts);
    await buyer.start();
    cleanups.push(() => buyer.close());
    const buyerDaemon = await startDaemon({ node: buyer, port: ports.buyer });
    cleanups.push(() => buyerDaemon.close());

    return { network, profile, relay, buyer, provider, buyerDaemon, providerDaemon, runner, close: closeAll };
  } catch (e) {
    await closeAll();
    throw e;
  }
}
