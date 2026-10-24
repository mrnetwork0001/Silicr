/**
 * Real driver: talks to the buyer and provider daemons (REST + SSE) and to the
 * relay's observer feed. Daemons that are down are re-probed with backoff and
 * picked up automatically when they come back.
 */

import type {
  BuyerFault,
  DaemonEvent,
  LeakObservation,
  NewRfqRequest,
  ProviderDto,
  ProviderFault,
  ProviderJobDto,
  ProviderPolicyDto,
  PublicTxViewDto,
  RelayObserverResponse,
  RfqDto,
  StatusDto,
  WalletDto,
  WithdrawConfirmDto,
  WithdrawRequest,
  WithdrawResultDto,
} from '@silicr/api';
import { ApiError, DaemonClient, errorMessage } from './client';
import { config } from './config';
import { saveBlob, type Driver, type InspectorTarget, type ProbeResult } from './driver';
import { actions, getState } from './store';

type Role = 'buyer' | 'provider';

const STATUS_EVERY_MS = 5000;
const LISTS_EVERY_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export class RealDriver implements Driver {
  readonly kind = 'real' as const;
  private readonly clients: Record<Role, DaemonClient>;
  private readonly relay: DaemonClient;
  private readonly probe: ProbeResult;
  private readonly online: Record<Role, boolean> = { buyer: false, provider: false };
  private readonly nextProbeAt: Record<Role, number> = { buyer: 0, provider: 0 };
  private readonly backoff: Record<Role, number> = { buyer: STATUS_EVERY_MS, provider: STATUS_EVERY_MS };
  private readonly sseStop: Partial<Record<Role, () => void>> = {};
  private readonly leakCursor = new Map<string, { id: string; at: number }>();
  private relayCursor: { id: string; at: number } | null = null;
  private readonly chainFetchedAt = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private listTick = 0;
  private stopped = false;

  constructor(probe: ProbeResult) {
    this.probe = probe;
    this.clients = { buyer: new DaemonClient(config.buyerUrl), provider: new DaemonClient(config.providerUrl) };
    this.relay = new DaemonClient(config.relayUrl);
  }

  start(): void {
    for (const role of ['buyer', 'provider'] as const) {
      const p = this.probe[role];
      if (p.ok) this.markOnline(role, p.status);
      else this.markOffline(role, p.error);
    }
    actions.setConn('relay', { status: this.probe.relay.ok ? 'online' : 'offline', error: this.probe.relay.error, lastOkAt: this.probe.relay.ok ? Date.now() : null });
    this.timers.push(setInterval(() => void this.pollStatus(), 1000));
    this.timers.push(setInterval(() => void this.pollLists(), LISTS_EVERY_MS));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const role of ['buyer', 'provider'] as const) {
      this.sseStop[role]?.();
      delete this.sseStop[role];
    }
  }

  // -------------------------------------------------------------------------
  // Connectivity

  private markOnline(role: Role, status: StatusDto): void {
    const was = this.online[role];
    this.online[role] = true;
    this.backoff[role] = STATUS_EVERY_MS;
    this.nextProbeAt[role] = Date.now() + STATUS_EVERY_MS;
    actions.setStatus(role, status);
    actions.setConn(role, { status: 'online', error: null, lastOkAt: Date.now() });
    if (!was) {
      void this.loadAll(role);
      this.openSse(role);
    }
  }

  private markOffline(role: Role, error: string): void {
    this.online[role] = false;
    this.nextProbeAt[role] = Date.now() + this.backoff[role];
    this.backoff[role] = Math.min(MAX_BACKOFF_MS, Math.round(this.backoff[role] * 1.6));
    actions.setConn(role, { status: 'offline', error });
    // Close SSE while down so the browser doesn't retry in parallel with our probes.
    this.sseStop[role]?.();
    delete this.sseStop[role];
    actions.setConn(role, { sse: 'off' });
  }

  private async pollStatus(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    await Promise.all(
      (['buyer', 'provider'] as const).map(async (role) => {
        if (now < this.nextProbeAt[role]) return;
        this.nextProbeAt[role] = now + 60_000; // guard against overlapping probes
        try {
          const s = await this.clients[role].get<StatusDto>('/api/status', { timeoutMs: 4000 });
          if (!this.stopped) this.markOnline(role, s);
        } catch (e) {
          if (!this.stopped) this.markOffline(role, errorMessage(e));
        }
      }),
    );
  }

  private openSse(role: Role): void {
    if (this.sseStop[role]) return;
    this.sseStop[role] = this.clients[role].openEvents({
      onEvent: (ev) => this.handleEvent(role, ev),
      onState: (sse) => actions.setConn(role, { sse }),
      onOpen: () => void this.loadAll(role, true),
    });
  }

  private handleEvent(role: Role, ev: DaemonEvent): void {
    switch (ev.type) {
      case 'status':
        if (ev.status && typeof ev.status === 'object') actions.setStatus(role, ev.status);
        break;
      case 'rfq.updated':
        if (ev.rfq?.rfqId) actions.upsertRfq(ev.rfq);
        break;
      case 'job.updated':
        if (ev.job?.rfqId) actions.upsertJob(ev.job);
        break;
      case 'log':
        if (ev.rfqId && Array.isArray(ev.lines)) actions.appendLogs(role, ev.rfqId, ev.lines);
        break;
      case 'leak':
        if (ev.observation?.id) actions.addLeaks([ev.observation]);
        break;
      case 'chain.tx':
        if (ev.view?.txid) actions.setChainTx(ev.view);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Data loading

  private async loadAll(role: Role, resync = false): Promise<void> {
    if (role === 'buyer') {
      await Promise.all([this.loadProviders('buyer'), this.loadRfqs()]);
    } else {
      const tasks: Promise<void>[] = [this.loadJobs(), this.loadPolicy()];
      if (!this.online.buyer) tasks.push(this.loadProviders('provider'));
      await Promise.all(tasks);
    }
    if (resync) {
      // Refresh the RFQs we are looking at in detail after a reconnect.
      const ids = Object.keys(getState().rfqs).slice(0, 10);
      if (role === 'buyer') await Promise.all(ids.map((id) => this.loadRfq(id).catch(() => undefined)));
    }
  }

  private async pollLists(): Promise<void> {
    if (this.stopped) return;
    this.listTick++;
    const tasks: Promise<void>[] = [];
    if (this.online.buyer) {
      tasks.push(this.loadRfqs());
      if (this.listTick % 3 === 0) tasks.push(this.loadProviders('buyer'));
    } else if (this.online.provider && this.listTick % 3 === 0) {
      tasks.push(this.loadProviders('provider'));
    }
    if (this.online.provider) tasks.push(this.loadJobs());
    if (getState().inspector.open || this.listTick % 3 === 0) tasks.push(this.probeRelay());
    await Promise.all(tasks);
  }

  private async loadProviders(role: Role): Promise<void> {
    try {
      const list = await this.clients[role].get<ProviderDto[]>('/api/providers');
      actions.setProviders(Array.isArray(list) ? list : [], null);
    } catch (e) {
      actions.setProviders(null, errorMessage(e));
    }
  }

  private async loadRfqs(): Promise<void> {
    try {
      const list = await this.clients.buyer.get<RfqDto[]>('/api/rfqs');
      actions.upsertRfqs(Array.isArray(list) ? list.filter((r) => r && r.rfqId) : []);
    } catch {
      actions.setRfqsLoaded();
    }
  }

  private async loadJobs(): Promise<void> {
    try {
      const list = await this.clients.provider.get<ProviderJobDto[]>('/api/jobs');
      actions.upsertJobs(Array.isArray(list) ? list.filter((j) => j && j.rfqId) : []);
    } catch (e) {
      actions.setJobsError(errorMessage(e));
    }
  }

  private async loadPolicy(): Promise<void> {
    try {
      actions.setPolicy(await this.clients.provider.get<ProviderPolicyDto>('/api/policy'));
    } catch {
      // keep the last known policy
    }
  }

  private async probeRelay(): Promise<void> {
    try {
      await this.relay.get<unknown>('/health', { timeoutMs: 3000 });
      actions.setConn('relay', { status: 'online', error: null, lastOkAt: Date.now() });
    } catch (e) {
      actions.setConn('relay', { status: 'offline', error: errorMessage(e) });
    }
  }

  // -------------------------------------------------------------------------
  // Commands

  private requireBuyer(): DaemonClient {
    if (!this.online.buyer) throw new ApiError(`Buyer daemon not connected (${config.buyerUrl})`, 0, 'offline');
    return this.clients.buyer;
  }

  private requireProvider(): DaemonClient {
    if (!this.online.provider) throw new ApiError(`Provider daemon not connected (${config.providerUrl})`, 0, 'offline');
    return this.clients.provider;
  }

  async getWallet(role: Role): Promise<WalletDto> {
    return this.clients[role].get<WalletDto>('/api/wallet', { timeoutMs: 8000 });
  }

  async withdraw(role: Role, req: WithdrawRequest): Promise<WithdrawResultDto | WithdrawConfirmDto> {
    try {
      // Building and proving a shielded transaction takes a while on a real chain.
      return await this.clients[role].post<WithdrawResultDto>('/api/wallet/withdraw', req, { timeoutMs: 180_000 });
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as Partial<WithdrawConfirmDto> | null) : null;
      if (e instanceof ApiError && e.code === 'confirm_required' && body && typeof body.confirm === 'string' && body.summary) return body as WithdrawConfirmDto;
      throw e;
    }
  }

  async createRfq(req: NewRfqRequest): Promise<{ rfqId: string }> {
    // Building and proving a shielded transaction can take a while on a real chain.
    const res = await this.requireBuyer().post<{ rfqId: string }>('/api/rfqs', req, { timeoutMs: 120_000 });
    if (!res?.rfqId) throw new ApiError('Buyer daemon returned no rfqId', 0, 'bad_response');
    void this.loadRfq(res.rfqId).catch(() => undefined);
    return res;
  }

  async accept(rfqId: string, providerId: string): Promise<RfqDto> {
    const rfq = await this.requireBuyer().post<RfqDto>(`/api/rfqs/${encodeURIComponent(rfqId)}/accept`, { providerId }, { timeoutMs: 120_000 });
    if (rfq?.rfqId) actions.upsertRfq(rfq);
    return rfq;
  }

  async stopRfq(rfqId: string): Promise<RfqDto> {
    const rfq = await this.requireBuyer().post<RfqDto>(`/api/rfqs/${encodeURIComponent(rfqId)}/stop`, {}, { timeoutMs: 60_000 });
    if (rfq?.rfqId) actions.upsertRfq(rfq);
    return rfq;
  }

  async downloadResult(rfqId: string): Promise<void> {
    const blob = await this.requireBuyer().blob(`/api/rfqs/${encodeURIComponent(rfqId)}/result`);
    saveBlob(blob, `silicr-result-${rfqId.slice(0, 12)}.tar.gz`);
  }

  async updatePolicy(patch: Partial<ProviderPolicyDto>): Promise<ProviderPolicyDto> {
    const policy = await this.requireProvider().put<ProviderPolicyDto>('/api/policy', patch);
    actions.setPolicy(policy);
    return policy;
  }

  async buyerFault(rfqId: string, fault: BuyerFault): Promise<void> {
    const rfq = await this.requireBuyer().post<RfqDto>(`/api/rfqs/${encodeURIComponent(rfqId)}/fault`, { fault }, { timeoutMs: 30_000 });
    if (rfq?.rfqId) actions.upsertRfq(rfq);
  }

  async providerFault(rfqId: string, fault: ProviderFault): Promise<void> {
    const job = await this.requireProvider().post<ProviderJobDto>(`/api/jobs/${encodeURIComponent(rfqId)}/fault`, { fault }, { timeoutMs: 30_000 });
    if (job?.rfqId) actions.upsertJob(job);
  }

  async stopJob(rfqId: string): Promise<void> {
    const job = await this.requireProvider().post<ProviderJobDto>(`/api/jobs/${encodeURIComponent(rfqId)}/stop`, {}, { timeoutMs: 60_000 });
    if (job?.rfqId) actions.upsertJob(job);
  }

  async loadRfq(rfqId: string): Promise<void> {
    if (!this.online.buyer) {
      actions.setRfqError(rfqId, 'offline');
      return;
    }
    try {
      const rfq = await this.clients.buyer.get<RfqDto>(`/api/rfqs/${encodeURIComponent(rfqId)}`);
      if (rfq?.rfqId) actions.upsertRfq(rfq);
    } catch (e) {
      actions.setRfqError(rfqId, e instanceof ApiError && e.status === 404 ? 'not_found' : errorMessage(e));
    }
  }

  // -------------------------------------------------------------------------
  // Leak Inspector

  /** True only if every connected daemon says all parties run on this machine. */
  private demoMode(): boolean {
    const s = getState();
    const statuses = [this.online.buyer ? s.buyerStatus : null, this.online.provider ? s.providerStatus : null].filter(
      (x): x is StatusDto => !!x,
    );
    return statuses.length > 0 && statuses.every((x) => x.demoMode === true);
  }

  async refreshInspector(target: InspectorTarget): Promise<void> {
    if (this.stopped) return;
    const demo = this.demoMode();
    const tasks: Promise<void>[] = [];
    if (this.online.buyer) tasks.push(this.fetchLeaks('buyer', target.rfqId));
    // Outside demo mode only this machine's "home" party is shown.
    if (this.online.provider && (demo || !this.online.buyer)) tasks.push(this.fetchLeaks('provider', target.rfqId));
    if (demo) tasks.push(this.fetchRelayObserver());
    tasks.push(this.fetchChain(target.txids));
    await Promise.allSettled(tasks);
  }

  private async fetchLeaks(role: Role, rfqId: string | null): Promise<void> {
    const key = `${role}:${rfqId ?? '*'}`;
    const cursor = this.leakCursor.get(key);
    const qs = new URLSearchParams();
    if (rfqId) qs.set('rfqId', rfqId);
    if (cursor) qs.set('after', cursor.id);
    try {
      const query = qs.toString();
      const list = await this.clients[role].get<LeakObservation[]>(`/api/leaks${query ? `?${query}` : ''}`, { timeoutMs: 6000 });
      const obs = Array.isArray(list) ? list.filter((o) => o && typeof o.id === 'string') : [];
      actions.addLeaks(obs);
      actions.setLeakError(role, null);
      const latest = latestOf(obs);
      if (latest && (!cursor || latest.at >= cursor.at)) this.leakCursor.set(key, latest);
    } catch (e) {
      actions.setLeakError(role, errorMessage(e));
    }
  }

  private async fetchRelayObserver(): Promise<void> {
    const qs = this.relayCursor ? `?after=${encodeURIComponent(this.relayCursor.id)}` : '';
    try {
      const res = await this.relay.get<RelayObserverResponse>(`/_observer${qs}`, { timeoutMs: 6000 });
      const obs = Array.isArray(res?.observations) ? res.observations.filter((o) => o && typeof o.id === 'string') : [];
      actions.addLeaks(obs.map((o) => (o.party === 'relay' ? o : { ...o, party: 'relay' as const })));
      actions.setRelayObserver('available');
      actions.setLeakError('relay', null);
      const latest = latestOf(obs);
      if (latest && (!this.relayCursor || latest.at >= this.relayCursor.at)) this.relayCursor = latest;
    } catch (e) {
      const notEnabled = e instanceof ApiError && (e.status === 404 || e.status === 403);
      actions.setRelayObserver('unavailable', notEnabled ? 'Observer feed disabled on this relay (start it with observer: true)' : errorMessage(e));
    }
  }

  private async fetchChain(txids: string[]): Promise<void> {
    const client = this.online.buyer ? this.clients.buyer : this.online.provider ? this.clients.provider : null;
    if (!client) return;
    const s = getState();
    const now = Date.now();
    const todo = [...new Set(txids)].filter((txid) => {
      const view = s.chainTx[txid];
      const last = this.chainFetchedAt.get(txid) ?? 0;
      if (view && view.height !== null) return false; // mined views don't change
      if (s.chainErrors[txid] && now - last < 30_000) return false;
      return now - last > 6000;
    });
    for (const batch of chunks(todo.slice(0, 24), 4)) {
      await Promise.all(
        batch.map(async (txid) => {
          this.chainFetchedAt.set(txid, Date.now());
          try {
            const view = await client.get<PublicTxViewDto>(`/api/chain/tx/${encodeURIComponent(txid)}`, { timeoutMs: 8000 });
            if (view?.txid) actions.setChainTx(view);
          } catch (e) {
            actions.setChainError(txid, errorMessage(e));
          }
        }),
      );
    }
  }
}

function latestOf(obs: LeakObservation[]): { id: string; at: number } | null {
  let best: LeakObservation | null = null;
  for (const o of obs) if (!best || (o.at ?? 0) >= (best.at ?? 0)) best = o;
  return best ? { id: best.id, at: best.at ?? 0 } : null;
}

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
