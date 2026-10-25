// `silicr init`, `silicr daemon` and `silicr relay`: set up and run one party.
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { BuyerNode, ProviderNode, PUBLIC_DEMO_DEFAULTS, PUBLIC_DEMO_INTERVAL_S, aliasFor, defaultProfile, maxExposureIntervals, parseZec, payLeadFor, startDaemon, type NodeBase, type SpendCap } from '@silicr/engine';
import { generateSigner, signerFromSecret } from '@silicr/protocol';
import { parseProxyUrl, relayClient, startRelay } from '@silicr/relay';
import { createRunner } from '@silicr/runner';
import { createMemoryNetwork, openBackend, type BackendConfig, type ZecBackend } from '@silicr/zec';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { DEFAULT_URLS } from '../client.ts';
import { defaultDataDir, readConfig, writeConfig, type NodeConfig } from '../config.ts';
import { MAINNET_TAG } from '../confirm.ts';
import { fail, kv, pc, zec } from '../format.ts';

type Role = 'buyer' | 'provider';
type Net = NodeConfig['network'];

function checkRole(role: string | undefined): Role {
  if (role !== 'buyer' && role !== 'provider') fail('--role must be buyer or provider');
  return role;
}

/** A resolved proxy setting: `raw` is what the user wrote (may hold credentials), `url` is safe to show. */
export interface ResolvedProxy {
  raw: string;
  url: string;
}

/**
 * The proxy to use: --proxy, else $SILICR_PROXY, else config.json. "none" / "off" / "direct" (or an
 * empty value) means direct connections. Anything that is not a SOCKS5 url is an error, not a no-op.
 */
export function resolveProxy(flag: string | undefined, fromConfig: string | undefined): ResolvedProxy | null {
  const env = process.env['SILICR_PROXY'];
  const pick = flag ?? (env && env.trim() !== '' ? env : undefined) ?? fromConfig;
  if (pick === undefined || pick.trim() === '' || /^(none|off|direct)$/i.test(pick.trim())) return null;
  try {
    return { raw: pick.trim(), url: parseProxyUrl(pick).url };
  } catch (e) {
    return fail(`--proxy: ${(e as Error).message}`);
  }
}

const proxyRow = (p: ResolvedProxy | null): [string, string] => [
  'proxy',
  p ? pc.green(`${p.url} (SOCKS5: IP hidden from the relay and light-wallet server)`) : pc.yellow('none: direct connections, IP visible to the relay and light-wallet server'),
];

/**
 * The simulated chain is test infrastructure: the CLI's own tests set SILICR_TEST_MEMORY_NETWORK=1
 * to run `init`/`daemon` against it. Users only ever get Zcash testnet or mainnet.
 */
export const memoryNetworkAllowed = (): boolean => process.env['SILICR_TEST_MEMORY_NETWORK'] === '1';

/** main = Zcash mainnet (real ZEC, only with spend caps), test = Zcash testnet. */
export function checkNetwork(n: string | undefined): Net {
  if (n === 'mainnet') n = 'main';
  if (n === 'testnet') n = 'test';
  if (n === 'memory' && memoryNetworkAllowed()) return n;
  if (n !== 'main' && n !== 'test') fail('--network must be test (Zcash testnet) or main (Zcash mainnet, real ZEC)');
  return n;
}

const networkRow = (n: Net): [string, string] => [
  'network',
  n === 'memory' ? `${pc.yellow('memory')} (test harness: simulated chain, private to the daemon process)` : n === 'main' ? pc.red(MAINNET_TAG) : 'Zcash testnet',
];

const capRow = (cap: SpendCap | null): [string, string] => [
  'spend cap',
  cap
    ? `per request ≤ ${zec(cap.perRfqZats)} · total ${zec(cap.totalZats)} ${pc.dim('(payments and fees, over every request this data dir makes)')}`
    : pc.dim('none (fine on testnet; mainnet requires one)'),
];

/**
 * The spend caps for a party: flags, else config.json. Mainnet needs them (CLAUDE.md), checked
 * here before any wallet is opened. A provider only ever spends fees, so its per-request cap
 * defaults to its total.
 */
export function resolveCaps(network: Net, role: Role, perFlag: string | undefined, totalFlag: string | undefined, fromConfig: NodeConfig['spendCap'] | undefined): SpendCap | null {
  const parse = (flag: string | undefined, name: string): bigint | undefined => {
    if (flag === undefined) return undefined;
    let z: bigint;
    try {
      z = parseZec(flag);
    } catch (e) {
      return fail(`${name}: ${(e as Error).message}`);
    }
    if (z <= 0n) fail(`${name} must be a positive amount of ZEC`);
    return z;
  };
  let per = parse(perFlag, '--cap-per-request');
  let total = parse(totalFlag, '--cap-total');
  if (per === undefined && total === undefined && fromConfig) {
    if (!/^\d+$/.test(String(fromConfig.perRfqZats)) || !/^\d+$/.test(String(fromConfig.totalZats))) fail('config.json: spendCap amounts must be decimal zatoshi strings');
    per = BigInt(fromConfig.perRfqZats);
    total = BigInt(fromConfig.totalZats);
  }
  if (per === undefined && total === undefined) {
    if (network === 'main') {
      fail(
        `Zcash mainnet needs spend caps: add --cap-total <zec>${role === 'buyer' ? ' and --cap-per-request <zec>' : ''} ` +
          '(real ZEC is at stake; the daemon refuses to start on mainnet without them; see docs/MAINNET.md)',
      );
    }
    return null;
  }
  if (total === undefined) fail('--cap-per-request needs --cap-total too (the most this party may ever spend, payments and fees)');
  if (per === undefined) {
    if (role === 'buyer') fail('--cap-total needs --cap-per-request too (the most one request may pay its provider)');
    per = total;
  }
  if (per > total) fail('--cap-per-request cannot exceed --cap-total');
  return { perRfqZats: per, totalZats: total };
}

/** The real-chain wallet (zec-sidecar) for a network: an explicit `network`, nothing defaults to mainnet. */
function sidecarConfig(network: 'main' | 'test', dataDir: string, server: string | undefined, proxy: string | null): BackendConfig {
  return { kind: 'sidecar', network, dataDir, ...(server ? { server } : {}), proxy };
}

export interface InitOptions {
  role: string;
  network: string;
  /** Default: defaultDataDir(role, network). */
  data?: string;
  relay?: string;
  port?: string;
  server?: string;
  proxy?: string;
  capPerRequest?: string;
  capTotal?: string;
  /** relay (default) or memo (relay-less). */
  transport?: string;
}

function checkTransport(t: string | undefined): 'relay' | 'memo' | undefined {
  if (t === undefined) return undefined;
  if (t !== 'relay' && t !== 'memo') fail('--transport must be relay or memo');
  return t;
}

const transportRow = (t: 'relay' | 'memo'): [string, string] => [
  'transport',
  t === 'memo'
    ? `${pc.green('memo (relay-less)')} ${pc.dim('job, logs, heartbeats and result in shielded memos; small jobs only (≈ 44 KB sealed), fees per memo; the relay only serves the directory')}`
    : `relay ${pc.dim('(job, logs and result as ciphertext on the relay; --transport memo for a relay-less deal)')}`,
];

export async function init(o: InitOptions): Promise<void> {
  const role = checkRole(o.role);
  const network = checkNetwork(o.network);
  const proxy = resolveProxy(o.proxy, undefined);
  const spendCap = resolveCaps(network, role, o.capPerRequest, o.capTotal, undefined);
  const dataDir = resolve(o.data ?? defaultDataDir(role, network));
  const cfg: NodeConfig = {
    v: 1,
    role,
    network,
    relayUrl: o.relay ?? DEFAULT_URLS.relay,
    port: o.port ? Number(o.port) : role === 'buyer' ? 7701 : 7702,
  };
  if (o.server) cfg.server = o.server;
  if (proxy) cfg.proxy = proxy.raw;
  if (spendCap) cfg.spendCap = { perRfqZats: spendCap.perRfqZats.toString(), totalZats: spendCap.totalZats.toString() };
  const transport = checkTransport(o.transport);
  if (transport) cfg.transport = transport;
  await writeConfig(dataDir, cfg);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const rows: [string, string][] = [
    ['role', role],
    networkRow(network),
    ['data dir', `${dataDir} ${pc.dim('(keys and the wallet live here; never commit it)')}`],
    ['relay', cfg.relayUrl],
    ['port', String(cfg.port)],
    proxyRow(proxy),
    transportRow(transport ?? 'relay'),
  ];
  if (spendCap || network === 'main') rows.push(capRow(spendCap));
  if (role === 'buyer') {
    const seed = join(dataDir, 'master.seed');
    if (!existsSync(seed)) {
      const s = new Uint8Array(32);
      crypto.getRandomValues(s);
      await writeFile(seed, s, { mode: 0o600 });
    }
    rows.push(['keys', 'master seed for per-RFQ signing and channel keys (master.seed)']);
  } else {
    const idPath = join(dataDir, 'identity.key');
    let pub: Uint8Array;
    if (existsSync(idPath)) {
      pub = signerFromSecret(new Uint8Array(await readFile(idPath))).publicKey;
    } else {
      const g = generateSigner();
      await writeFile(idPath, g.secret, { mode: 0o600 });
      pub = g.signer.publicKey;
    }
    rows.push(['provider', `${pc.bold(aliasFor(pub))} ${pc.dim(Buffer.from(pub).toString('hex'))}`]);
  }
  if (network !== 'memory') {
    try {
      // The sidecar's wallet files (data.sqlite, wallet.seed) live in the data dir itself, next to ours.
      const backend = await openBackend(sidecarConfig(network, dataDir, cfg.server, proxy?.raw ?? null));
      rows.push(['address', await backend.address()]);
      await backend.close();
    } catch (e) {
      rows.push(['wallet', pc.yellow(`not created yet: ${(e as Error).message}`)]);
    }
  }
  console.log(`\n  ${pc.green('initialised')} ${role}\n`);
  kv(rows);
  console.log();
  if (network === 'main') {
    console.log(`  ${pc.red(MAINNET_TAG)}. Fund it with a ${pc.bold('small')} amount of ${pc.bold('shielded ZEC')} from any shielded wallet: the address has an Orchard`);
    console.log(`  ${pc.dim('receiver only, so nothing can arrive transparent. Funds are spendable after 10 confirmations (about 13 minutes).')}`);
    console.log(`  ${pc.dim('Keep the balance small: unaudited software. A demo costs under 0.002 ZEC in fees (docs/MAINNET.md).')}`);
  } else if (network === 'test') {
    console.log(`  Fund it with ${pc.bold('shielded (Orchard) testnet ZEC only')}. Transparent and Sapling funds are refused:`);
    console.log(`  ${pc.dim('they would publish amounts and link this wallet to its funding source.')}`);
  }
  console.log(`  Next: ${pc.bold(`silicr daemon --data ${o.data ?? dataDir}`)}\n`);
}

export interface DaemonCmdOptions {
  role?: string;
  /** Default: defaultDataDir(--role, --network). */
  data?: string;
  network?: string;
  relay?: string;
  port?: string;
  server?: string;
  runner?: string;
  demoMode?: boolean;
  proxy?: string;
  capPerRequest?: string;
  capTotal?: string;
  transport?: string;
  /** Public testnet demo rules (refused on mainnet). */
  publicDemo?: boolean;
  /** Extra allowed Origins (and Host names) for a hosted deployment behind a reverse proxy. */
  publicOrigin?: string[];
  /** Use X-Forwarded-For (last entry) as the client IP for the public-demo rate limit. */
  trustProxy?: boolean;
  /** Bind address (default 127.0.0.1; anything else needs --public-origin). */
  host?: string;
}

/** A started party: its wallet, node and daemon, and how to shut all three down. */
export interface StartedParty {
  role: Role;
  network: Net;
  node: BuyerNode | ProviderNode;
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  backend: ZecBackend;
  close(): Promise<void>;
}

export interface PartyOptions {
  role: Role;
  network: Net;
  dataDir: string;
  relayUrl: string;
  port: number;
  server?: string | undefined;
  proxy: ResolvedProxy | null;
  spendCap: SpendCap | null;
  blobTransport: 'relay' | 'memo';
  runner?: 'auto' | 'process' | 'docker';
  demoMode: boolean;
  policy?: ConstructorParameters<typeof ProviderNode>[0]['policy'];
  daemon?: Omit<Parameters<typeof startDaemon>[0], 'node' | 'port'>;
  log?: (m: string) => void;
}

/**
 * Open the wallet, start the node and its HTTP daemon: what `silicr daemon` runs, and what
 * `silicr demo` runs twice (buyer and provider) next to a relay.
 */
export async function startParty(o: PartyOptions): Promise<StartedParty> {
  const { role, network, dataDir } = o;
  let backend: ZecBackend;
  let stopNet = () => undefined as void;
  if (network !== 'memory') {
    try {
      backend = await openBackend(sidecarConfig(network, dataDir, o.server, o.proxy?.raw ?? null));
    } catch (e) {
      return fail(
        `the Zcash ${network === 'main' ? 'mainnet' : 'testnet'} backend is not available: ${(e as Error).message}\n` +
          '  It needs the zec-sidecar wallet (see packages/zec and docs/ZCASH_SETUP.md).',
      );
    }
  } else {
    const net = createMemoryNetwork({ blockTimeMs: 1000 });
    stopNet = () => net.stop();
    backend = net.wallet(role, { fundZats: 1_000_000_000n });
    console.log(pc.yellow('  memory network (test harness): a private simulated chain inside this process.'));
  }

  const relay = relayClient(o.relayUrl, o.proxy ? { proxy: o.proxy.raw } : {});
  const profile = defaultProfile(network);
  const common = {
    backend,
    relay,
    dataDir,
    profile,
    demoMode: o.demoMode,
    log: o.log ?? ((m: string) => console.error(pc.dim(`  [${role}] ${m}`))),
    ...(o.proxy ? { proxy: { url: o.proxy.url, kind: 'socks5' as const } } : {}),
    ...(o.spendCap ? { spendCap: o.spendCap } : {}),
    blobTransport: o.blobTransport,
  };
  let node: BuyerNode | ProviderNode;
  if (role === 'buyer') {
    node = new BuyerNode(common);
  } else {
    const runner = await createRunner({ mode: o.runner ?? 'auto', workDir: join(dataDir, 'runner') });
    node = new ProviderNode({ ...common, runner, ...(o.policy ? { policy: o.policy } : {}) });
  }
  try {
    await node.start();
  } catch (e) {
    await backend.close().catch(() => undefined);
    stopNet();
    return fail(`could not start the ${role}: ${(e as Error).message}`);
  }
  let d: Awaited<ReturnType<typeof startDaemon>>;
  try {
    d = await startDaemon({ ...(o.daemon ?? {}), node, port: o.port });
  } catch (e) {
    await (node as NodeBase).close().catch(() => undefined);
    await backend.close().catch(() => undefined);
    stopNet();
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') return fail(`port ${o.port} is in use (another daemon?)`);
    return fail(`could not start the ${role} daemon: ${(e as Error).message}`);
  }
  return {
    role,
    network,
    node,
    daemon: d,
    backend,
    async close() {
      await d.close().catch(() => undefined);
      await (node as NodeBase).close().catch(() => undefined);
      await backend.close().catch(() => undefined);
      stopNet();
    },
  };
}

export async function daemon(o: DaemonCmdOptions): Promise<void> {
  if (!o.data && !o.role) fail('give --data <dir> (from `silicr init`), or --role and --network to use the default data dir');
  const dataDir = resolve(o.data ?? defaultDataDir(checkRole(o.role), checkNetwork(o.network ?? 'test')));
  const cfg = await readConfig(dataDir);
  // e.g. `silicr daemon --network test --data .silicr/wallets/buyer` with no config: infer the role.
  const inferred = /(buyer|provider)$/.exec(basename(dataDir))?.[1];
  const role = checkRole(o.role ?? cfg?.role ?? inferred);
  const network = checkNetwork(o.network ?? cfg?.network ?? 'test');
  const relayUrl = o.relay ?? cfg?.relayUrl ?? DEFAULT_URLS.relay;
  const port = Number(o.port ?? cfg?.port ?? (role === 'buyer' ? 7701 : 7702));
  const server = o.server ?? cfg?.server;
  // One setting for every outbound connection: the relay client and the wallet's light-wallet server.
  const proxy = resolveProxy(o.proxy, cfg?.proxy);
  // Mainnet without caps stops here, before any wallet is opened (the node checks again in start()).
  const spendCap = resolveCaps(network, role, o.capPerRequest, o.capTotal, cfg?.spendCap);
  const blobTransport = checkTransport(o.transport) ?? checkTransport(cfg?.transport) ?? 'relay';
  if (network === 'main') console.log(`\n  ${pc.red(MAINNET_TAG)}  ${pc.dim('real funds: every send is bounded by the spend caps below and needs your go-ahead in `silicr run`')}`);
  // Checked here too, before any wallet is opened (startDaemon refuses as well).
  if (o.publicDemo && network === 'main') fail('--public-demo is refused on Zcash mainnet: a public demo lets anyone spend a shared wallet. Run it with --network test.');
  const publicOrigins = o.publicOrigin ?? [];
  if (o.host && !['127.0.0.1', '::1', 'localhost'].includes(o.host) && publicOrigins.length === 0) {
    fail(`--host ${o.host} is not loopback: a non-loopback bind needs --public-origin <url> (a hosted deployment behind a reverse proxy)`);
  }
  const party = await startParty({
    role,
    network,
    dataDir,
    relayUrl,
    port,
    server,
    proxy,
    spendCap,
    blobTransport,
    runner: (o.runner ?? cfg?.runner ?? 'auto') as 'auto' | 'process' | 'docker',
    demoMode: !!o.demoMode,
    // Public demo provider: 60 s intervals, so a judge sees a PAY train (several txids) inside one short job.
    ...(o.publicDemo && role === 'provider' ? { policy: { intervalS: PUBLIC_DEMO_INTERVAL_S } } : {}),
    daemon: {
      ...(o.host ? { host: o.host } : {}),
      ...(publicOrigins.length ? { publicOrigins } : {}),
      ...(o.trustProxy ? { trustProxy: true } : {}),
      ...(o.publicDemo ? { publicDemo: true } : {}),
    },
  });
  const { node, daemon: d } = party;
  const profile = defaultProfile(network);
  const s = await node.status();
  console.log(`\n  ${pc.green(`${role} daemon`)} listening on ${pc.bold(d.url)} ${pc.dim(o.host && o.host !== '127.0.0.1' ? `(bound to ${o.host})` : '(loopback only)')}\n`);
  const rows: [string, string][] = [
    networkRow(network),
    ['height', String(s.height)],
    ['address', s.address],
    ['balance', `${zec(s.balance.spendable)} spendable, ${zec(s.balance.pending)} pending`],
    ['relay', relayUrl],
    proxyRow(proxy),
    transportRow(blobTransport),
  ];
  if (spendCap || network === 'main') rows.push(capRow(spendCap));
  if (o.publicDemo) {
    rows.push(['public demo', `${pc.yellow('on')} ${pc.dim(`presets only (examples/tiny-train) · ≤ 15 min · 1 GPU · one live request · 3 requests per IP per hour · unaccepted requests expire after ${PUBLIC_DEMO_DEFAULTS.acceptWindowBlocks} blocks · withdraw, policy, migrate and provider stop disabled`)}`]);
  }
  if (publicOrigins.length) rows.push(['origins', `${publicOrigins.join(', ')} ${pc.dim(o.trustProxy ? '(X-Forwarded-For trusted for rate limits)' : '')}`]);
  if (network !== 'memory') {
    const intervalS = node instanceof ProviderNode ? node.getPolicy().intervalS : profile.intervalS;
    rows.push([
      'timing',
      `${intervalS} s intervals · PAY ${payLeadFor(profile, intervalS)} s ahead · at most ${+maxExposureIntervals(profile, intervalS).toFixed(3)} intervals at risk · ~${s.blockTimeS} s blocks`,
    ]);
  }
  if (node instanceof ProviderNode) {
    rows.push(['provider', `${pc.bold(node.alias)} ${pc.dim(node.providerId)}`]);
    const st = (await node.status()) as typeof s & { runner: { sandboxed: boolean; warning?: string; mode: string } };
    rows.push(['runner', st.runner.sandboxed ? pc.green('docker sandbox') : pc.red(`${st.runner.mode} mode: NOT a sandbox`)]);
  }
  kv(rows);
  console.log(`\n  ${pc.dim('Ctrl-C to stop.')}`);
  const stop = async () => {
    await party.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  await new Promise(() => undefined);
}

export async function relay(o: { port?: string; data?: string; observer?: boolean; host?: string }): Promise<void> {
  const r = await startRelay({ port: Number(o.port ?? 7700), host: o.host ?? '127.0.0.1', dataDir: resolve(o.data ?? '.silicr/relay'), observer: !!o.observer });
  console.log(`\n  ${pc.green('relay')} on ${pc.bold(r.url)} ${o.observer ? pc.dim('(observer feed on: /_observer)') : ''}\n  ${pc.dim('Ctrl-C to stop.')}`);
  const stop = async () => {
    await r.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  await new Promise(() => undefined);
}
