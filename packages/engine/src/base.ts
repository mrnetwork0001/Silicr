// What buyer and provider nodes share: wallet, relay, events, leak log, chain observations.
import type { DaemonEvent, FactKey, LeakField, LeakObservation, Party, ProviderDto, PublicTxViewDto, Role, StatusDto, WalletDto, WithdrawConfirmDto, WithdrawRequest, WithdrawResultDto } from '@silicr/api';
import { isLoopbackHost, type RelayClient } from '@silicr/relay';
import type { Network, Output, SendResult, ZecBackend } from '@silicr/zec';
import type { Transport } from '@silicr/protocol';
import { resolveDeps, type EngineDeps } from './deps.ts';
import { chainFields, FACTS_BY_LABEL, LeakRecorder, publicTxViewDto, field, type TxFacts } from './leaks.ts';
import { DirectoryClient } from './directory.ts';
import { TxSender, isInsufficientFunds, type NoteEvent, type NoteWatcher } from './chain.ts';
import { defaultProfile, profileAtHeight, type TimingProfile } from './profile.ts';
import { EngineError } from './errors.ts';
import { Emitter, errMsg, hex, randomBytes } from './util.ts';
import { formatZec, parseZats, parseZec } from './zats.ts';
import { MemoTransport, type BlobTransport } from './memo-transport.ts';

export const ENGINE_VERSION = '0.1.0';

export interface NodeOptions {
  backend: ZecBackend;
  relay: RelayClient;
  /** This party's private data dir (seed / identity, state, results). */
  dataDir: string;
  profile?: TimingProfile;
  deps?: Partial<EngineDeps>;
  /** Every party runs on this machine (`silicr demo` on testnet, or the test harness). */
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
  /** Transactions this node broadcast (so its own change and padding never look like deposits). */
  private readonly sentTx = new Set<string>();
  private rawAddress: string | null = null;
  private lastIncoming: { txid: string; zats: bigint; height: number | null; indexes: Set<number> } | null = null;
  private readonly withdrawConfirms = new Map<string, { to: string; amount: string; force: boolean; expiresAt: number }>();

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

  protected async send(outputs: Output[], ctx: { rfqId?: string; what: string; sealed: TxFacts; retryMs?: number }): Promise<SendResult> {
    const outs = outputs.map((o) => ({ ...o, to: this.guard(o.to) }));
    const r = await this.sender.send(outs, ctx.retryMs === undefined ? {} : { retryMs: ctx.retryMs });
    this.knownTx.add(r.txid.toLowerCase());
    this.sentTx.add(r.txid.toLowerCase());
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
      blockTimeS: profileAtHeight(this.profile, height).blockTimeS,
      blobTransport: this.blobTransport,
      ...(this.proxy ? { proxy: this.proxy } : {}),
      ...(this.spendCap
        ? { spendCap: { perRfqZats: this.spendCap.perRfqZats.toString(), totalZats: this.spendCap.totalZats.toString(), spentZats: this.capSpentZats().toString() } }
        : {}),
    };
  }

  // ------------------------------------------------------------------ wallet connection

  /** A request or job is live: withdrawing now could starve it. */
  abstract busy(): boolean;

  /**
   * Subclasses call this for every note their watcher delivers. A deposit is a note paid to the
   * default address that isn't a Silicr message and wasn't sent by this node. Never logged.
   */
  protected trackIncoming(e: NoteEvent): void {
    if (e.decoded || e.note.pool !== 'orchard') return;
    const txid = e.note.txid.toLowerCase();
    if (this.sentTx.has(txid)) return;
    if (e.note.memo[0] === 0xff) return; // arbitrary-data memos are Silicr traffic (BLOBs, padding), never a wallet's deposit
    if (this.rawAddress === null || e.note.toAddress !== this.rawAddress) return;
    const cur = this.lastIncoming;
    if (cur && cur.txid === txid) {
      if (!cur.indexes.has(e.note.index)) {
        cur.indexes.add(e.note.index);
        cur.zats += e.note.zats;
      }
      if (e.note.height !== null) cur.height = e.note.height;
      return;
    }
    if (!e.firstSeen) return;
    this.lastIncoming = { txid, zats: e.note.zats, height: e.note.height, indexes: new Set([e.note.index]) };
  }

  /** Called from start(): remember the raw default address deposits arrive at. */
  protected async initWallet(): Promise<void> {
    this.rawAddress = await this.backend.address();
    for (const t of this.knownTx) this.sentTx.add(t);
  }

  /** Confirmations before notes are spendable: ZIP 315 untrusted (10) for received funds, trusted for change. */
  confirmationsRequired(): { received: number; change: number } {
    return { received: this.network === 'memory' ? 1 : RECEIVED_CONFIRMATIONS, change: this.profile.changeConfirmations };
  }

  /** GET /api/wallet. `amount` is decimal ZEC (ZIP 321), echoed into the URI. */
  async wallet(amount?: string | null): Promise<WalletDto> {
    let amountZats: bigint | null = null;
    if (amount !== undefined && amount !== null && amount !== '') {
      if (!/^\d{1,8}(\.\d{1,8})?$/.test(amount)) throw new EngineError('bad_request', 'amount must be decimal ZEC with at most 8 decimals, e.g. 0.05');
      amountZats = parseZec(amount);
      if (amountZats <= 0n) amountZats = null;
    }
    if (this.rawAddress === null) this.rawAddress = await this.backend.address();
    const [height, balance, address] = await Promise.all([this.backend.height(), this.backend.balance(), this.address()]);
    const li = this.lastIncoming;
    return {
      role: this.role,
      network: this.network,
      height,
      address,
      zip321Uri: zip321Uri(address, amountZats),
      balance: { spendable: balance.spendable.toString(), pending: balance.pending.toString() },
      confirmationsRequired: this.confirmationsRequired(),
      feeEstimateZats: feeForActions(2).toString(),
      busy: this.busy(),
      ...(li
        ? { lastIncoming: { txid: li.txid, zats: li.zats.toString(), height: li.height, confirmations: li.height === null ? 0 : Math.max(0, height - li.height + 1) } }
        : {}),
    };
  }

  /**
   * POST /api/wallet/withdraw: the user moving their own funds out, to an Orchard receiver only.
   * Not counted against the spend cap. Mainnet needs a confirm token echoed within 60 s.
   */
  async withdraw(req: WithdrawRequest): Promise<WithdrawResultDto> {
    if (!req || typeof req !== 'object') throw new EngineError('bad_request', 'body must be { to, amountZats, confirm? }');
    if (typeof req.to !== 'string' || req.to.trim() === '') throw new EngineError('bad_request', 'to must be a unified address');
    const to = this.guard(req.to.trim()); // PrivacyError → 400 'privacy', with the guard's message
    const all = req.amountZats === 'all';
    let amount: bigint | null = null;
    if (!all) {
      try {
        amount = parseZats(req.amountZats, 'amountZats');
      } catch (e) {
        throw new EngineError('bad_request', `${errMsg(e)} or "all"`);
      }
      if (amount < this.minOutput || amount <= 0n) throw new EngineError('bad_request', `amountZats must be at least ${this.minOutput > 0n ? this.minOutput : 1n}`);
    }
    const force = req.force === true;
    if (this.busy() && !force) {
      throw new EngineError('busy', `a ${this.role === 'buyer' ? 'request' : 'job'} is live: withdrawing now could leave it without funds. Wait for it to finish, or pass force: true`, 409);
    }
    const balance = await this.backend.balance();
    const fee = feeForActions(2);
    const zats = all ? balance.spendable - fee : amount!;
    if (zats <= 0n || zats < this.minOutput) {
      throw new EngineError('insufficient_funds', `nothing to withdraw: ${formatZec(balance.spendable)} ZEC spendable, the fee is about ${formatZec(fee)} ZEC` + (balance.pending > 0n ? ` (${formatZec(balance.pending)} ZEC still confirming)` : ''), 402);
    }
    if (!all && zats + fee > balance.spendable) {
      throw new EngineError('insufficient_funds', `withdrawing ${formatZec(zats)} ZEC needs about ${formatZec(zats + fee)} ZEC with the fee; ${formatZec(balance.spendable)} ZEC is spendable` + (balance.pending > 0n ? ` (${formatZec(balance.pending)} ZEC still confirming)` : ''), 402);
    }
    const amountKey = all ? 'all' : zats.toString();

    if (this.network === 'main') {
      const now = Date.now();
      for (const [k, v] of this.withdrawConfirms) if (v.expiresAt < now) this.withdrawConfirms.delete(k);
      const pending = typeof req.confirm === 'string' ? this.withdrawConfirms.get(req.confirm) : undefined;
      if (!pending || pending.to !== to || pending.amount !== amountKey || pending.force !== force) {
        const token = hex(randomBytes(16));
        const expiresAt = now + WITHDRAW_CONFIRM_MS;
        this.withdrawConfirms.set(token, { to, amount: amountKey, force, expiresAt });
        const summary: WithdrawConfirmDto['summary'] = { to, zats: zats.toString(), feeZats: fee.toString(), network: this.network, all };
        throw new EngineError(
          'confirm_required',
          `${req.confirm ? 'confirm token unknown, expired or for a different withdraw. ' : ''}Withdrawing ${formatZec(zats)} ZEC of REAL ZEC (fee about ${formatZec(fee)} ZEC) on mainnet: send the same request again with confirm within 60 s`,
          409,
          { confirm: token, expiresAt, summary },
        );
      }
      this.withdrawConfirms.delete(req.confirm!);
    }

    const r = all ? await this.sweep(to, balance.spendable) : await this.sendWithdraw(to, zats);
    this.log(`withdraw sent: ${formatZec(r.zats)} ZEC, fee ${formatZec(r.feeZats)} ZEC`);
    const party: Party = this.party;
    this.leaks.record({
      party,
      event: 'withdraw',
      txid: r.txid,
      summary: `withdraw: ${formatZec(r.zats)} ZEC moved out of this wallet to the owner's own shielded address`,
      fields: [
        field('Destination', shortAddr(to), true, true, []),
        field('Amount', `${formatZec(r.zats)} ZEC`, true, true, ['amount']),
        field('Fee', `${formatZec(r.feeZats)} ZEC`, true, false, []),
        field('Pool', 'Ironwood shielded to an Orchard receiver: no turnstile, amount hidden on-chain', true, false, []),
      ],
    });
    return { txid: r.txid, zats: r.zats.toString(), feeZats: r.feeZats.toString(), network: this.network };
  }

  private async sendWithdraw(to: string, zats: bigint): Promise<{ txid: string; zats: bigint; feeZats: bigint }> {
    const r = await this.send([{ to, zats, memo: emptyMemo() }], { what: 'withdraw', sealed: WITHDRAW_FACTS });
    return { txid: r.txid, zats, feeZats: r.feeZats };
  }

  /** Sweep: no change output, so the fee must be exact. ZIP 317 grows with the notes spent; try upwards. */
  private async sweep(to: string, spendable: bigint): Promise<{ txid: string; zats: bigint; feeZats: bigint }> {
    let last: unknown = null;
    for (let actions = 2; actions <= MAX_SWEEP_ACTIONS; actions++) {
      const fee = feeForActions(actions);
      const zats = spendable - fee;
      if (zats <= 0n || zats < this.minOutput) break;
      try {
        const r = await this.send([{ to, zats, memo: emptyMemo() }], { what: 'withdraw', sealed: WITHDRAW_FACTS, retryMs: 0 });
        return { txid: r.txid, zats, feeZats: r.feeZats };
      } catch (e) {
        if (!isInsufficientFunds(e)) throw e;
        last = e;
      }
    }
    throw last ?? new EngineError('insufficient_funds', 'nothing to withdraw after the fee', 402);
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

/** ZIP 315 untrusted confirmations (the sidecar's default) before received notes are spendable. */
const RECEIVED_CONFIRMATIONS = 10;
const WITHDRAW_CONFIRM_MS = 60_000;
const MAX_SWEEP_ACTIONS = 40;
/** ZIP 317 marginal fee per logical action. */
const MARGINAL_FEE_ZATS = 5000n;
/** A withdraw's memo is empty and its recipient is the owner: it carries none of the key facts. */
const WITHDRAW_FACTS: TxFacts = { memo: [], sender: [], recipients: [] };

/** ZIP 317: marginal fee × max(2, logical actions). */
export function feeForActions(actions: number): bigint {
  return MARGINAL_FEE_ZATS * BigInt(Math.max(2, actions));
}

/** ZIP 302 "no memo": 0xF6 followed by zeros. */
function emptyMemo(): Uint8Array {
  const m = new Uint8Array(512);
  m[0] = 0xf6;
  return m;
}

/** ZIP 321 payment URI for one Orchard-only UA, amount in decimal ZEC. */
export function zip321Uri(address: string, amountZats: bigint | null = null): string {
  return amountZats && amountZats > 0n ? `zcash:${address}?amount=${formatZec(amountZats)}` : `zcash:${address}`;
}

function shortAddr(a: string): string {
  return a.length > 24 ? `${a.slice(0, 14)}…${a.slice(-8)}` : a;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return url;
  }
}
