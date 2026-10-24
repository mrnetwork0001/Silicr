// What buyer and provider nodes share: wallet, relay, events, leak log, chain observations.
import type { DaemonEvent, FactKey, LeakField, LeakObservation, Party, ProviderDto, PublicTxViewDto, Role, StatusDto } from '@silicr/api';
import { isLoopbackHost, type RelayClient } from '@silicr/relay';
import type { Network, Output, SendResult, ZecBackend } from '@silicr/zec';
import type { Transport } from '@silicr/protocol';
import { resolveDeps, type EngineDeps } from './deps.ts';
import { chainFields, FACTS_BY_LABEL, LeakRecorder, publicTxViewDto, field, type TxFacts } from './leaks.ts';
import { DirectoryClient } from './directory.ts';
import { TxSender, type NoteWatcher } from './chain.ts';
import { defaultProfile, type TimingProfile } from './profile.ts';
import { EngineError } from './errors.ts';
import { Emitter, errMsg } from './util.ts';
import { MemoTransport, type BlobTransport } from './memo-transport.ts';

export const ENGINE_VERSION = '0.1.0';

export interface NodeOptions {
  backend: ZecBackend;
  relay: RelayClient;
  /** This party's private data dir (seed / identity, state, results). */
  dataDir: string;
  profile?: TimingProfile;
  deps?: Partial<EngineDeps>;
  /** Every party runs on this machine (zero-setup or local demo). */
  demoMode?: boolean;
  /** Diagnostics sink. Never receives secrets, memo plaintext or job contents. */
  log?: (msg: string) => void;
  /**
   * Set when every outbound connection (the relay client and the wallet backend's light-wallet
   * server) goes through a SOCKS5 proxy such as Tor. Shown in status and in the Leak Inspector.
   */
  proxy?: ProxyInfo;
  /** Spending guard. Required when the backend's network is 'main': start() refuses otherwise. */
  spendCap?: SpendCap;
  /**
   * How job, logs, heartbeats and result travel: 'relay' (default) or 'memo' (relay-less: in
   * Zcash memos, nothing but the chain; see ARCHITECTURE.md §1 "Relay-less mode"). Negotiated per
   * RFQ with a HELLO memo; both sides must run the same mode or the provider does not bid.
   */
  blobTransport?: BlobTransport;
  /** Memo mode: largest sealed blob (job, result, log batch) sent on-chain. Default ≈ 44 KB (4 transactions). */
  memoMaxBlobBytes?: number;
}

/** StatusDto.proxy: the proxy the daemon's traffic goes through. `url` carries no credentials. */
export type ProxyInfo = NonNullable<StatusDto['proxy']>;

/**
 * Spending guard, bigint zatoshis (StatusDto.spendCap carries the same numbers as strings).
 * Buyer: perRfqZats bounds what one request may pay its provider (ACCEPT + every PAY, at the bid's
 * price); totalZats bounds payments plus fees over every request, summed from the persisted
 * requests so restarts keep the count. Provider: only fees are ever spent (BIDs, CLOSEs);
 * totalZats bounds them and perRfqZats is informational.
 */
export interface SpendCap {
  perRfqZats: bigint;
  totalZats: bigint;
}

/** Throws unless both caps are positive zatoshi amounts. */
export function checkSpendCap(cap: SpendCap): SpendCap {
  if (typeof cap.perRfqZats !== 'bigint' || typeof cap.totalZats !== 'bigint') throw new TypeError('spendCap amounts must be bigint zatoshis');
  if (cap.perRfqZats <= 0n || cap.totalZats <= 0n) throw new RangeError('spendCap amounts must be positive');
  return { perRfqZats: cap.perRfqZats, totalZats: cap.totalZats };
}

export abstract class NodeBase {
  abstract readonly role: Role;
  readonly backend: ZecBackend;
  readonly relay: RelayClient;
  readonly dataDir: string;
  readonly profile: TimingProfile;
  readonly deps: EngineDeps;
  readonly network: Network;
  readonly transport: Transport;
  readonly demoMode: boolean;
  readonly events = new Emitter<DaemonEvent>();
  readonly leaks: LeakRecorder;
  readonly directory: DirectoryClient;
  /** The SOCKS5 proxy this node's traffic goes through, or null for direct connections. */
  readonly proxy: ProxyInfo | null;
  /** The spend caps this node enforces, or null (never null on mainnet). */
  readonly spendCap: SpendCap | null;
  /** 'relay' or 'memo' (relay-less). */
  readonly blobTransport: BlobTransport;
  /** Blob mailboxes in memos for memo-mode deals; passes everything else to the relay. */
  protected readonly memo: MemoTransport;
  private readonly party: Party;
  protected readonly sender: TxSender;
  protected watcher: NoteWatcher | null = null;
  protected stopped = false;
  protected readonly log: (msg: string) => void;
  private readonly observedTx = new Map<string, string>();
  /** Transactions this node sent or received: the only ones it ever inspects. */
  protected readonly knownTx = new Set<string>();
  private defaultAddress: string | null = null;

  constructor(prefix: string, o: NodeOptions) {
    this.blobTransport = o.blobTransport ?? 'relay';
    this.memo = new MemoTransport({
      mode: this.blobTransport,
      relay: o.relay,
      backend: o.backend,
      transport: o.backend.capabilities.binaryMemos ? 'binary' : 'text',
      role: prefix === 'provider' ? 'provider' : 'buyer',
      send: (outputs, ctx) => this.send(outputs, ctx),
      capCheck: (rfqId, cost) => this.assertFeeWithinCap(rfqId, cost),
      onSpent: (rfqId, fee, value) => this.onMemoSpent(rfqId, fee, value),
      record: (i) => this.leaks.record(i),
      log: (m) => this.log(m),
      ...(o.memoMaxBlobBytes !== undefined ? { maxBlobBytes: o.memoMaxBlobBytes } : {}),
    });
    // poll() is intercepted so BLOB memos (and the HELLO next to an RFQ) are seen before the node's handlers run.
    this.backend = this.memo.wrapBackend();
    this.relay = this.memo;
    this.dataDir = o.dataDir;
    this.network = o.backend.network;
    this.profile = o.profile ?? defaultProfile(this.network);
    this.deps = resolveDeps(o.deps);
    this.transport = o.backend.capabilities.binaryMemos ? 'binary' : 'text';
    this.demoMode = o.demoMode ?? false;
    this.log = o.log ?? (() => undefined);
    this.leaks = new LeakRecorder(prefix, (obs) => this.emit({ type: 'leak', observation: obs }));
    this.sender = new TxSender(o.backend, this.profile.sendRetryS * 1000, () => undefined);
    this.directory = new DirectoryClient(o.relay, this.network, this.deps);
    this.proxy = o.proxy ?? null;
    this.spendCap = o.spendCap ? checkSpendCap(o.spendCap) : null;
    this.party = prefix === 'provider' ? 'provider' : 'buyer';
    // What the network learns about this machine: recorded once, and again as the first
    // observation of every RFQ so the Leak Inspector shows it per request.
    this.leaks.onFirstRfq = (rfqId) => this.recordNetworkPosture(rfqId);
    this.recordNetworkPosture();
  }

  /**
   * What the relay and the light-wallet server see of this party's network address. Through a
   * SOCKS5 proxy (Tor) they see the proxy's exit, not this machine. A loopback relay is reached
   * directly either way: nothing leaves the host.
   */
  protected recordNetworkPosture(rfqId?: string): void {
    const relayHost = hostOf(this.relay.baseUrl);
    const relayLocal = isLoopbackHost(relayHost);
    const ipFacts: FactKey[] = this.party === 'buyer' ? ['buyer_ip'] : [];
    const simulated = this.network === 'memory';
    let summary: string;
    let fields: LeakField[];
    if (this.proxy) {
      summary = 'network: via SOCKS5 proxy, IP not exposed to relay/light-wallet server';
      fields = [
        field('Proxy', this.proxy.url, true, false, []),
        field('Relay', relayLocal ? `${relayHost} (this machine: direct, nothing leaves the host)` : `${relayHost} (via the proxy)`, true, false, []),
        field('Light-wallet server', simulated ? 'none (simulated chain in this process)' : 'via the proxy', true, false, []),
        field('DNS', 'names are resolved by the proxy (socks5h); no lookup leaves this machine', true, false, []),
        field('IP seen by the relay and light-wallet server', "the proxy's exit address, not this machine's", false, true, ipFacts),
      ];
    } else {
      summary = 'network: direct connection, IP exposed to relay/light-wallet server';
      fields = [
        field('Proxy', 'none (silicr daemon --proxy socks5h://127.0.0.1:9050, or SILICR_PROXY, routes everything through Tor)', true, false, []),
        field('Relay', relayLocal ? `${relayHost} (this machine)` : relayHost, true, false, []),
        field('Light-wallet server', simulated ? 'none (simulated chain in this process)' : 'direct', true, false, []),
        field('IP seen by the relay and light-wallet server', relayLocal && simulated ? "this machine's own address (every party runs on this machine)" : "this machine's own address", true, true, ipFacts),
      ];
    }
    this.leaks.record({ party: this.party, event: 'network', summary, fields, ...(rfqId === undefined ? {} : { rfqId }) });
  }

  /** Everything this node has spent so far, fees included: what the total spend cap counts. */
  abstract capSpentZats(): bigint;

  /** Fees and note values a memo blob cost: subclasses add them to the RFQ's fee total. */
  protected onMemoSpent(_rfqId: string, _feeZats: bigint, _valueZats: bigint): void {}

  /** Memo-mode blobs cost fees: refuse one that would break the total cap (EngineError 'spend_cap'). */
  protected assertFeeWithinCap(rfqId: string, costZats: bigint): void {
    const cap = this.spendCap;
    if (!cap) return;
    const spent = this.capSpentZats();
    if (spent + costZats > cap.totalZats) {
      throw new EngineError(
        'spend_cap',
        `refusing to send a memo blob for ${rfqId.slice(0, 8)}: it would cost ${costZats} zats in fees and note values, more than the ${cap.totalZats - spent} zats left of the ${cap.totalZats} zats total cap`,
        400,
      );
    }
  }

  /** Mainnet needs the caps (CLAUDE.md): start() calls this before touching anything. */
  protected assertMainnetCap(): void {
    if (this.network !== 'main' || this.spendCap) return;
    throw new EngineError(
      'spend_cap',
      `refusing to start a ${this.role} on Zcash mainnet without spend caps: set spendCap { perRfqZats, totalZats } ` +
        '(silicr init --network main --cap-per-request <zec> --cap-total <zec>)',
      400,
    );
  }

  /** The public directory, signatures and addresses checked (bad entries flagged verified: false). */
  async providers(): Promise<ProviderDto[]> {
    return (await this.directory.list()).all;
  }

  on(fn: (e: DaemonEvent) => void): () => void {
    return this.events.on(fn);
  }

  protected emit(e: DaemonEvent): void {
    this.events.emit(e);
  }

  /** The privacy guard. Throws PrivacyError for anything that isn't an Orchard receiver on our network. */
  protected guard(address: string): string {
    return this.deps.toOrchardOnly(address, this.network);
  }

  protected get minOutput(): bigint {
    return this.backend.capabilities.minOutputZats;
  }

  /** Our default address in Orchard-only form (stable). */
  async address(): Promise<string> {
    if (!this.defaultAddress) this.defaultAddress = this.guard(await this.backend.address());
    return this.defaultAddress;
  }

  protected async send(outputs: Output[], ctx: { rfqId?: string; what: string; sealed: TxFacts }): Promise<SendResult> {
    const outs = outputs.map((o) => ({ ...o, to: this.guard(o.to) }));
    const r = await this.sender.send(outs);
    this.knownTx.add(r.txid.toLowerCase());
    void this.observeTx(r.txid, { rfqId: ctx.rfqId, event: 'tx-broadcast', summary: `${ctx.what}: what the public chain shows`, sealed: ctx.sealed });
    return r;
  }

  /** Mark a received transaction as ours to inspect. */
  protected received(txid: string): void {
    this.knownTx.add(txid.toLowerCase());
  }

  /**
   * Record what the public chain shows for a transaction we sent or received (once per txid).
   * A backend that doesn't know the transaction yet (testnet TxNotKnownError) is normal: our own
   * broadcasts are retried after the next polls, anything else is skipped. Never fails a flow.
   */
  protected async observeTx(txid: string, ctx: { rfqId?: string | undefined; event: string; summary: string; sealed: TxFacts }, attempt = 0): Promise<void> {
    if (!this.backend.capabilities.inspectTx || !this.backend.inspectTx || this.stopped) return;
    if (!this.knownTx.has(txid.toLowerCase())) return;
    if (attempt === 0) {
      if (this.observedTx.has(txid)) return;
      this.observedTx.set(txid, ctx.event);
      if (this.observedTx.size > 10000) this.observedTx.delete(this.observedTx.keys().next().value!);
    }
    try {
      const view = await this.backend.inspectTx(txid);
      const input = { party: 'chain' as Party, event: ctx.event, summary: ctx.summary, fields: chainFields(view, ctx.sealed), txid };
      this.leaks.record(ctx.rfqId === undefined ? input : { ...input, rfqId: ctx.rfqId });
      this.emit({ type: 'chain.tx', view: publicTxViewDto(view) });
    } catch (e) {
      const notKnown = e instanceof Error && e.name === 'TxNotKnownError';
      if (notKnown && ctx.event === 'tx-broadcast' && attempt < 5 && !this.stopped) {
        const t = setTimeout(() => void this.observeTx(txid, ctx, attempt + 1), Math.max(1000, this.profile.pollMs) * (attempt + 1));
        t.unref?.();
        return;
      }
      if (!notKnown) this.log(`inspectTx failed: ${errMsg(e)}`);
    }
  }

  /** Public view of a transaction this node sent or received (never anyone else's). */
  async inspectTx(txid: string): Promise<PublicTxViewDto> {
    if (!this.backend.capabilities.inspectTx || !this.backend.inspectTx) {
      throw new EngineError('unsupported', 'this wallet backend cannot inspect transactions', 501);
    }
    if (!/^[0-9a-fA-F]{8,128}$/.test(txid)) throw new EngineError('bad_request', 'bad txid');
    if (!this.knownTx.has(txid.toLowerCase())) throw new EngineError('not_found', 'not a transaction this node sent or received', 404);
    try {
      return publicTxViewDto(await this.backend.inspectTx(txid));
    } catch (e) {
      throw new EngineError('not_found', `the wallet holds no view of this transaction yet: ${errMsg(e)}`, 404);
    }
  }

  listLeaks(q: { rfqId?: string; after?: string; party?: Party }): LeakObservation[] {
    return this.leaks.list(q);
  }

  protected async baseStatus(): Promise<StatusDto> {
    const [height, balance, address] = await Promise.all([this.backend.height(), this.backend.balance(), this.address()]);
    return {
      role: this.role,
      network: this.network,
      height,
      address,
      balance: { spendable: balance.spendable.toString(), pending: balance.pending.toString() },
      relayUrl: this.relay.baseUrl,
      version: ENGINE_VERSION,
      demoMode: this.demoMode,
      blockTimeS: this.profile.blockTimeS,
      blobTransport: this.blobTransport,
      ...(this.proxy ? { proxy: this.proxy } : {}),
      ...(this.spendCap
        ? { spendCap: { perRfqZats: this.spendCap.perRfqZats.toString(), totalZats: this.spendCap.totalZats.toString(), spentZats: this.capSpentZats().toString() } }
        : {}),
    };
  }

  abstract status(): Promise<StatusDto>;
  abstract start(): Promise<void>;
  abstract close(): Promise<void>;

  /** Every field gets its key facts: an explicit 5th element, else by label (FACTS_BY_LABEL), else none. */
  protected recordText(
    party: Party,
    event: string,
    summary: string,
    pairs: ([string, string, boolean, boolean] | [string, string, boolean, boolean, FactKey[]])[],
    extra: { rfqId?: string; txid?: string } = {},
  ): void {
    this.leaks.record({ party, event, summary, fields: pairs.map(([l, v, r, s, f]) => field(l, v, r, s, f ?? FACTS_BY_LABEL[l] ?? [])), ...extra });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return url;
  }
}
