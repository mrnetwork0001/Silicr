// Feeds deal.json (real daemon DTOs from one finished deal, see generate.mts) into the store through
// the same actions the real driver uses, as if the terminal had just synced with both daemons.
import { readFileSync } from 'node:fs';
import type { LeakObservation, ProviderDto, ProviderJobDto, PublicTxViewDto, RelayObserverResponse, RfqDto, StatusDto } from '@silicr/api';
import { actions } from '../../lib/store';

export interface DealFixture {
  buyerStatus: StatusDto;
  providerStatus: StatusDto;
  providers: ProviderDto[];
  rfq: RfqDto;
  job: ProviderJobDto;
  leaks: { buyer: LeakObservation[]; provider: LeakObservation[] };
  relayObserver: RelayObserverResponse;
  chain: PublicTxViewDto[];
}

export function readDeal(): DealFixture {
  return JSON.parse(readFileSync(new URL('./deal.json', import.meta.url), 'utf8')) as DealFixture;
}

export function loadDeal(d: DealFixture = readDeal()): DealFixture {
  const urls = { buyer: 'http://127.0.0.1:7701', provider: 'http://127.0.0.1:7702', relay: 'http://127.0.0.1:7700' };
  actions.reset(urls);
  actions.setMode('real');
  for (const role of ['buyer', 'provider'] as const) {
    actions.setStatus(role, role === 'buyer' ? d.buyerStatus : d.providerStatus);
    actions.setConn(role, { status: 'online', error: null, lastOkAt: Date.now() });
  }
  actions.setConn('relay', { status: 'online', error: null, lastOkAt: Date.now() });
  actions.setRelayObserver('available');
  actions.setProviders(d.providers);
  actions.upsertRfqs([d.rfq]);
  actions.upsertJobs([d.job]);
  actions.setPolicy(null);
  actions.addLeaks([...d.leaks.buyer, ...d.leaks.provider, ...d.relayObserver.observations.map((o) => ({ ...o, party: 'relay' as const }))]);
  for (const v of d.chain) actions.setChainTx(v, v.time ? v.time * 1000 : Date.now());
  return d;
}
