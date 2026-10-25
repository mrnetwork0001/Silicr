/**
 * Zcash sidecar backend for Silicr: mainnet or testnet, one wallet per `zec-sidecar` process.
 *
 * Wraps `zec-sidecar` (Rust, librustzcash): one sidecar process per wallet, JSON lines over
 * stdio. The sidecar holds the wallet (zcash_client_sqlite in `dataDir`), syncs compact blocks
 * from a public lightwalletd, watches the mempool, and builds/proves/broadcasts transactions.
 *
 * Privacy (enforced twice: here via toOrchardOnly, and inside the sidecar):
 * - every recipient is reduced to its Orchard receiver; transparent, TEX and Sapling are refused;
 * - only Ironwood notes are spent and all outputs/change go to Ironwood. Ironwood is the
 *   Orchard-protocol pool that, since NU6.3 (mainnet 3,428,143 / testnet 4,134,000), receives
 *   everything paid to Orchard receivers; legacy Orchard is withdraw-only and leaving it reveals
 *   the amount, so those funds are never touched. No transparent inputs/outputs, no Sapling, no
 *   pool crossing;
 * - the proposal and the finished transaction are both checked before broadcast.
 *
 * Networks: `{ kind: 'sidecar', network: 'main' | 'test' }`; `{ kind: 'testnet' }` is the old spelling
 * of `network: 'test'`. Nothing defaults to mainnet. The sidecar refuses a server whose reported
 * chain is not the requested network, and a wallet directory created on the other network.
 */
import {
  MEMO_SIZE,
  ReadOnlyError,
  type BackendCapabilities,
  type BackendConfig,
  type Network,
  type Output,
  type ZecBackend,
} from '../contract.ts';
import { toOrchardOnly } from '../guard.ts';
import {
  memoToHex,
  parseBalance,
  parseFreshness,
  parseLedger,
  parsePollResult,
  parseSendResult,
  parseTxView,
  parseViewingKey,
  type Freshness,
  type Ledger,
  type SendReport,
  type TestnetBalance,
  type TestnetPublicTxView,
  type TestnetReceivedNote,
} from './parse.ts';
import { DEFAULT_SERVERS, Sidecar, defaultSidecarPath, type ReadyEvent, type SidecarNetwork, type SidecarOptions } from './sidecar.ts';

export * from './parse.ts';
export { exportViewingKeyOffline, type OfflineExportOptions } from './keys.ts';
export {
  DEFAULT_SERVER,
  DEFAULT_MAINNET_SERVER,
  DEFAULT_SERVERS,
  SidecarExitedError,
  SidecarMissingError,
  SidecarTimeoutError,
  defaultSidecarPath,
  isLoopbackHost,
  serverHost,
} from './sidecar.ts';
export type { SidecarNetwork } from './sidecar.ts';

/** Config for the sidecar backend: `kind: 'sidecar'` with an explicit network, or the old `kind: 'testnet'`. */
export type SidecarConfig = Extract<BackendConfig, { kind: 'testnet' | 'sidecar' }>;
/** The old spelling: `{ kind: 'testnet' }` is `{ kind: 'sidecar', network: 'test' }`. */
export type TestnetConfig = Extract<BackendConfig, { kind: 'testnet' }>;

/**
 * Options read from the sidecar BackendConfig (all optional except dataDir, and network for kind 'sidecar'):
 * - network: 'main' or 'test' (kind 'testnet' fixes it to 'test'). Never defaults to 'main'.
 * - server: lightwalletd host:port (default by network: testnet.zec.rocks:443 / zec.rocks:443)
 * - proxy: SOCKS5 proxy url (socks5h://host:port, e.g. Tor on 127.0.0.1:9050) for every connection to
 *   the server; names are resolved by the proxy and there is no direct fallback. Default: $SILICR_PROXY.
 *   null (or '') means direct even when the variable is set. Loopback servers always connect directly.
 * - create: create the wallet if dataDir has none (default true)
 * - birthday: birthday height for a new wallet (default tip - 100)
 * - sidecarPath: zec-sidecar binary (default $SILICR_ZEC_SIDECAR, else <repo>/zec-sidecar/target/release/zec-sidecar)
 * - startupTimeoutMs (180000), requestTimeoutMs (20000), sendTimeoutMs (300000). The sidecar bounds
 *   its own syncs well inside requestTimeoutMs and answers poll()/height() from local state (flagged
 *   stale, see `chainHealth`) while the light-wallet server is unreachable, so a server outage never
 *   hangs the caller.
 * - syncIntervalMs (15000): background sync cadence; poll() also syncs if the last sync is > 2 s old
 * - trustedConfirmations (3) / untrustedConfirmations (10): ZIP 315 spendability policy
 * - targetNoteCount (4), minSplitZats (1000000): change splitting so back-to-back sends don't wait on change
 * - onLog(line): receives sidecar log lines; logFile (default <dataDir>/sidecar.log, null to disable)
 * - guard(address, network): recipient guard, default toOrchardOnly (tests may inject one)
 * - viewingKey: a UFVK (uview1… / uviewtest1…) to create or open a watch-only wallet from; send() then
 *   throws ReadOnlyError and the backend never holds a seed
 */
export interface ResolvedOptions {
  network: SidecarNetwork;
  dataDir: string;
  server: string;
  proxy?: string;
  create: boolean;
  viewingKey?: string;
  birthday?: number;
  sidecarPath: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  sendTimeoutMs: number;
  syncIntervalMs?: number;
  trustedConfirmations?: number;
  untrustedConfirmations?: number;
  targetNoteCount: number;
  minSplitZats?: bigint;
  onLog?: (line: string) => void;
  logFile?: string | null;
  guard: (address: string, expected: Network) => string;
}
/** Old name of ResolvedOptions. */
export type TestnetOptions = ResolvedOptions;

export const SIDECAR_CAPABILITIES: BackendCapabilities = Object.freeze({
  // Memos are carried as raw 512-byte MemoBytes end to end (ZIP 302 0xFF arbitrary data included).
  binaryMemos: true,
  // RFQ buckets go up to 16. 40 payments (+ up to 4 change notes) stays within what testnet has
  // been seen to mine (a 41-action, 132 KB v6 Ironwood tx); the sidecar's hard cap is 50.
  maxOutputsPerTx: 40,
  diversifiedAddresses: true,
  // Zero-value shielded outputs are valid on-chain, but 1 zat matches the memory backend.
  minOutputZats: 1n,
  mempoolNotes: true,
  inspectTx: true,
});
/** Old name of SIDECAR_CAPABILITIES (same on both networks). */
export const TESTNET_CAPABILITIES = SIDECAR_CAPABILITIES;

/** Change is split into up to this many notes by default (the buyer splits on purpose; see docs/ZCASH_SETUP.md §5). */
export const DEFAULT_TARGET_NOTE_COUNT = 4;

/** Only SOCKS5 can carry the sidecar's gRPC/TLS stream; anything else is refused here, before the sidecar starts. */
const SOCKS5_URL = /^socks5h?:\/\/[^\s/?#]+$/i;

function optString(c: SidecarConfig, k: string): string | undefined {
  const v = c[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new TypeError(`sidecar config: ${k} must be a string`);
  return v;
}

function optNumber(c: SidecarConfig, k: string): number | undefined {
  const v = c[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError(`sidecar config: ${k} must be a non-negative number`);
  return v;
}

/** The network a config asks for. Explicit for kind 'sidecar'; kind 'testnet' is testnet and refuses anything else. */
export function resolveNetwork(config: SidecarConfig): SidecarNetwork {
  const network = config['network'];
  if (config.kind === 'sidecar') {
    if (network !== 'main' && network !== 'test') {
      throw new Error(`sidecar config: network must be 'main' or 'test' (got ${JSON.stringify(network)}); nothing defaults to mainnet`);
    }
    return network;
  }
  if (network !== undefined && network !== 'test') {
    throw new Error(`testnet config refuses network ${JSON.stringify(network)}: use { kind: 'sidecar', network: 'main' } for mainnet`);
  }
  return 'test';
}

export function resolveOptions(config: SidecarConfig): ResolvedOptions {
  if (typeof config.dataDir !== 'string' || config.dataDir === '') throw new TypeError('sidecar config: dataDir is required');
  const network = resolveNetwork(config);
  const serverRaw = config['server'];
  if (serverRaw !== undefined && (typeof serverRaw !== 'string' || serverRaw.trim() === '')) throw new TypeError('sidecar config: server must be a non-empty string');
  // Which chain the server really serves is checked by the sidecar (GetLightdInfo.chainName must match).
  const server = serverRaw ?? DEFAULT_SERVERS[network];
  const create = config['create'];
  if (create !== undefined && typeof create !== 'boolean') throw new TypeError('sidecar config: create must be a boolean');
  const minSplit = config['minSplitZats'];
  if (minSplit !== undefined && typeof minSplit !== 'bigint') throw new TypeError('sidecar config: minSplitZats must be a bigint');
  const onLog = config['onLog'];
  if (onLog !== undefined && typeof onLog !== 'function') throw new TypeError('sidecar config: onLog must be a function');
  const logFile = config['logFile'];
  if (logFile !== undefined && logFile !== null && typeof logFile !== 'string') throw new TypeError('sidecar config: logFile must be a string or null');
  const guard = config['guard'];
  if (guard !== undefined && typeof guard !== 'function') throw new TypeError('sidecar config: guard must be a function');
  const proxyRaw = config['proxy'];
  if (proxyRaw !== undefined && proxyRaw !== null && typeof proxyRaw !== 'string') throw new TypeError('sidecar config: proxy must be a string or null');
  const proxy = proxyRaw === undefined ? process.env['SILICR_PROXY'] || undefined : proxyRaw || undefined;
  if (proxy !== undefined && !SOCKS5_URL.test(proxy)) {
    throw new Error(`sidecar config: proxy must be a SOCKS5 url like socks5h://127.0.0.1:9050 (got ${JSON.stringify(proxy)}; HTTP proxies are not supported)`);
  }

  const opts: ResolvedOptions = {
    network,
    dataDir: config.dataDir,
    server,
    create: create ?? true,
    sidecarPath: optString(config, 'sidecarPath') ?? process.env['SILICR_ZEC_SIDECAR'] ?? defaultSidecarPath(),
    startupTimeoutMs: optNumber(config, 'startupTimeoutMs') ?? 180_000,
    requestTimeoutMs: optNumber(config, 'requestTimeoutMs') ?? 20_000,
    sendTimeoutMs: optNumber(config, 'sendTimeoutMs') ?? 300_000,
    targetNoteCount: optNumber(config, 'targetNoteCount') ?? DEFAULT_TARGET_NOTE_COUNT,
    guard: (guard as ResolvedOptions['guard'] | undefined) ?? toOrchardOnly,
  };
  if (!Number.isSafeInteger(opts.targetNoteCount) || opts.targetNoteCount < 1) {
    throw new TypeError('sidecar config: targetNoteCount must be a positive integer');
  }
  if (proxy !== undefined) opts.proxy = proxy;
  const viewingKey = optString(config, 'viewingKey');
  if (viewingKey !== undefined) {
    const hrp = network === 'main' ? 'uview1' : 'uviewtest1';
    if (!viewingKey.trim().startsWith(hrp)) {
      throw new Error(`sidecar config: viewingKey must be a ${hrp}… unified full viewing key for ${network === 'main' ? 'mainnet' : 'testnet'} (a seed phrase or spending key is never accepted)`);
    }
    opts.viewingKey = viewingKey.trim();
  }
  const birthday = optNumber(config, 'birthday');
  if (birthday !== undefined) opts.birthday = birthday;
  const syncIntervalMs = optNumber(config, 'syncIntervalMs');
  if (syncIntervalMs !== undefined) opts.syncIntervalMs = syncIntervalMs;
  const trusted = optNumber(config, 'trustedConfirmations');
  if (trusted !== undefined) opts.trustedConfirmations = trusted;
  const untrusted = optNumber(config, 'untrustedConfirmations');
  if (untrusted !== undefined) opts.untrustedConfirmations = untrusted;
  if (minSplit !== undefined) opts.minSplitZats = minSplit;
  if (onLog !== undefined) opts.onLog = onLog as (line: string) => void;
  if (logFile !== undefined) opts.logFile = logFile as string | null;
  return opts;
}

function sidecarOptions(o: ResolvedOptions, create: boolean): SidecarOptions {
  const s: SidecarOptions = {
    binary: o.sidecarPath,
    network: o.network,
    dataDir: o.dataDir,
    server: o.server,
    create,
    startupTimeoutMs: o.startupTimeoutMs,
    targetNoteCount: o.targetNoteCount,
  };
  if (o.proxy !== undefined) s.proxy = o.proxy;
  if (o.viewingKey !== undefined) s.viewingKey = o.viewingKey;
  if (o.birthday !== undefined) s.birthday = o.birthday;
  if (o.syncIntervalMs !== undefined) s.syncIntervalMs = o.syncIntervalMs;
  if (o.trustedConfirmations !== undefined) s.trustedConfirmations = o.trustedConfirmations;
  if (o.untrustedConfirmations !== undefined) s.untrustedConfirmations = o.untrustedConfirmations;
  if (o.minSplitZats !== undefined) s.minSplitZats = o.minSplitZats;
  if (o.onLog !== undefined) s.onLog = o.onLog;
  if (o.logFile !== undefined) s.logFile = o.logFile;
  return s;
}

/** Validates outputs and reduces every recipient to its Orchard-only UA on `network`. Throws PrivacyError via the guard. */
export function prepareOutputs(
  outputs: Output[],
  guard: ResolvedOptions['guard'],
  caps: BackendCapabilities = SIDECAR_CAPABILITIES,
  network: SidecarNetwork = 'test',
): { to: string; zats: string; memoHex: string }[] {
  if (!Array.isArray(outputs) || outputs.length === 0) throw new RangeError('send() needs at least one output');
  if (outputs.length > caps.maxOutputsPerTx) {
    throw new RangeError(`send() supports at most ${caps.maxOutputsPerTx} outputs per transaction, got ${outputs.length}`);
  }
  return outputs.map((o, i) => {
    if (typeof o.zats !== 'bigint' || o.zats < caps.minOutputZats) {
      throw new RangeError(`output ${i}: zats must be a bigint >= ${caps.minOutputZats}`);
    }
    if (!(o.memo instanceof Uint8Array) || o.memo.length !== MEMO_SIZE) {
      throw new RangeError(`output ${i}: memo must be exactly ${MEMO_SIZE} bytes`);
    }
    // The privacy guard: throws PrivacyError for transparent, Sapling, non-Orchard or wrong-network addresses.
    const to = guard(o.to, network);
    return { to, zats: o.zats.toString(), memoHex: memoToHex(o.memo) };
  });
}

export class SidecarBackend implements ZecBackend {
  readonly network: Network;
  readonly capabilities: BackendCapabilities = SIDECAR_CAPABILITIES;
  private sidecar: Sidecar;
  private readonly opts: ResolvedOptions;
  private readonly defaultAddress: string;
  private restarting: Promise<Sidecar> | null = null;
  private lastRestart = 0;
  private closed = false;
  private health: ChainHealth = { stale: false, syncError: null, since: 0 };

  constructor(opts: ResolvedOptions, sidecar: Sidecar) {
    this.opts = opts;
    this.network = opts.network;
    this.sidecar = sidecar;
    // Every address we hand out goes through the same guard as every recipient.
    this.defaultAddress = opts.guard(sidecar.ready.address, this.network);
  }

  /** The sidecar's ready event: birthday, initial sync time and tip. */
  get startup(): ReadyEvent {
    return this.sidecar.ready;
  }

  /** The SOCKS5 proxy every connection to the light-wallet server goes through, or null (direct). */
  get proxy(): string | null {
    return this.sidecar.ready.proxy ?? null;
  }

  /** The lightwalletd / Zaino endpoint this wallet syncs from. */
  get server(): string {
    return this.opts.server;
  }

  /** Watch-only: opened from a viewing key. It sees everything and can send nothing. */
  get readOnly(): boolean {
    return this.opts.viewingKey !== undefined || this.sidecar.ready.viewOnly === true;
  }

  /**
   * Whether the last poll()/height() answer came from local state because the light-wallet
   * server was unreachable (`stale`), with the sidecar's last error. Logged on every change.
   */
  get chainHealth(): ChainHealth {
    return { ...this.health };
  }

  private noteFreshness(f: Freshness): void {
    if (f.stale === this.health.stale && f.syncError === this.health.syncError) return;
    const was = this.health.stale;
    this.health = { stale: f.stale, syncError: f.syncError, since: Date.now() };
    if (f.stale) this.opts.onLog?.(`[silicr] wallet answering from local state (light-wallet server unreachable): ${f.syncError ?? 'unknown error'}`);
    else if (was) this.opts.onLog?.('[silicr] light-wallet server reachable again; wallet answers are fresh');
  }

  private async live(): Promise<Sidecar> {
    if (this.closed) throw new Error('sidecar backend is closed');
    if (this.sidecar.alive) return this.sidecar;
    if (!this.restarting) {
      const wait = Math.max(0, this.lastRestart + 10_000 - Date.now());
      this.restarting = (async () => {
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastRestart = Date.now();
        this.opts.onLog?.('[silicr] zec-sidecar exited; restarting');
        const s = await Sidecar.start(sidecarOptions(this.opts, false));
        this.sidecar = s;
        return s;
      })().finally(() => {
        this.restarting = null;
      });
    }
    return this.restarting;
  }

  private async call(method: string, params: Record<string, unknown> = {}, timeoutMs = this.opts.requestTimeoutMs): Promise<unknown> {
    const s = await this.live();
    return s.request(method, params, timeoutMs);
  }

  async address(): Promise<string> {
    return this.defaultAddress;
  }

  async newAddress(): Promise<string> {
    const r = (await this.call('newAddress')) as { address?: unknown };
    if (typeof r.address !== 'string') throw new Error('newAddress: sidecar returned no address');
    return this.opts.guard(r.address, this.network);
  }

  async balance(): Promise<TestnetBalance> {
    return parseBalance(await this.call('balance'));
  }

  /** The chain tip; the last known one (flagged in `chainHealth`) while the server is unreachable. */
  async height(): Promise<number> {
    const raw = await this.call('height');
    const r = raw as { height?: unknown };
    if (typeof r.height !== 'number') throw new Error('height: sidecar returned no height');
    this.noteFreshness(parseFreshness(raw));
    return r.height;
  }

  async send(outputs: Output[]): Promise<SendReport> {
    if (this.readOnly) {
      throw new ReadOnlyError('send: this wallet is watch-only (opened from a viewing key): it can see every payment but holds no spending key');
    }
    const prepared = prepareOutputs(outputs, this.opts.guard, this.capabilities, this.opts.network);
    return parseSendResult(await this.call('send', { outputs: prepared }, this.opts.sendTimeoutMs));
  }

  /**
   * Notes the wallet holds (mined since `sinceHeight`, plus every unconfirmed one). Never waits on
   * the light-wallet server: a failed or slow sync answers from local state, flagged in `chainHealth`.
   */
  async poll(sinceHeight: number): Promise<TestnetReceivedNote[]> {
    if (!Number.isSafeInteger(sinceHeight) || sinceHeight < 0) throw new RangeError('poll: sinceHeight must be a non-negative integer');
    const raw = await this.call('poll', { sinceHeight });
    const notes = parsePollResult(raw);
    this.noteFreshness(parseFreshness(raw));
    // Label notes with the guard's canonical encoding, the same form address()/newAddress() return.
    for (const n of notes) n.toAddress = this.opts.guard(n.toAddress, this.network);
    return notes;
  }

  /**
   * Public view of a transaction, built only from data this wallet already holds (see
   * TestnetPublicTxView.source). Never asks the light-wallet server: throws TxNotKnownError for
   * transactions this wallet did not broadcast, receive or see in the mempool stream.
   */
  async inspectTx(txid: string): Promise<TestnetPublicTxView> {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new RangeError('inspectTx: txid must be 64 hex characters');
    return parseTxView(await this.call('inspectTx', { txid: txid.toLowerCase() }));
  }

  /**
   * The wallet's unified full viewing key, Orchard component only (`uview1…` / `uviewtest1…`).
   * Whoever holds it sees every payment this wallet ever sent or received, with amounts and
   * memos, and can link all of its addresses; it can never spend. Never log the result.
   */
  async exportViewingKey(): Promise<string> {
    return parseViewingKey(await this.call('exportViewingKey'), this.opts.network);
  }

  /**
   * The audit ledger: every mined note received (and change), and every payment sent, with
   * amounts, memos and the Silicr message type of each memo. Syncs first if the last sync is stale.
   */
  async ledger(): Promise<Ledger> {
    return parseLedger(await this.call('ledger', {}, Math.max(this.opts.requestTimeoutMs, 300_000)));
  }

  /** Forces a sync now. */
  async sync(): Promise<{ tip: number; scannedBlocks: number; fullyScanned: number | null; ms: number }> {
    return (await this.call('sync', {}, Math.max(this.opts.requestTimeoutMs, 300_000))) as {
      tip: number;
      scannedBlocks: number;
      fullyScanned: number | null;
      ms: number;
    };
  }

  /** Health check: server, tip, last sync age, mempool watcher state. */
  async info(): Promise<Record<string, unknown>> {
    return (await this.call('info')) as Record<string, unknown>;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.restarting?.catch(() => undefined);
    await this.sidecar.close();
  }
}
/** SidecarBackend.chainHealth: stale answers while the light-wallet server is unreachable. */
export interface ChainHealth {
  stale: boolean;
  syncError: string | null;
  /** When this state began (unix ms); 0 if nothing has been observed yet. */
  since: number;
}

/** Old name of SidecarBackend. */
export const TestnetBackend = SidecarBackend;
export type TestnetBackend = SidecarBackend;

/** Opens (or creates) the wallet in config.dataDir on the configured network and returns a ZecBackend for it. */
export async function createSidecarBackend(config: SidecarConfig): Promise<SidecarBackend> {
  const opts = resolveOptions(config);
  const sidecar = await Sidecar.start(sidecarOptions(opts, opts.create));
  // Belt and braces: the sidecar checked the server's chain; we check the sidecar's answer.
  if (sidecar.ready.network !== opts.network) {
    await sidecar.close();
    throw new Error(`zec-sidecar reports network ${JSON.stringify(sidecar.ready.network)} but ${opts.network} was requested; refusing`);
  }
  return new SidecarBackend(opts, sidecar);
}

/** The old entry point: `{ kind: 'testnet' }` configs (always testnet). */
export async function createTestnetBackend(config: SidecarConfig): Promise<SidecarBackend> {
  return createSidecarBackend(config);
}
