/**
 * Mock driver: the scripted replay behind the same Driver interface the real
 * daemons use. Small artificial latencies make the UI's loading states visible.
 */

import type { BuyerFault, NewRfqRequest, ProviderFault, ProviderPolicyDto, RfqDto, WalletDto, WithdrawConfirmDto, WithdrawRequest, WithdrawResultDto } from '@silicr/api';
import { ApiError } from '../client';
import { saveBlob, type Driver, type InspectorTarget } from '../driver';
import { actions, getState } from '../store';
import { MockWorld } from './world';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MockDriver implements Driver {
  readonly kind = 'mock' as const;
  private readonly world = new MockWorld();

  start(): void {
    this.world.start();
  }

  stop(): void {
    this.world.stop();
  }

  async createRfq(req: NewRfqRequest): Promise<{ rfqId: string }> {
    await delay(450);
    return { rfqId: this.world.createRfq(req) };
  }

  async accept(rfqId: string, providerId: string): Promise<RfqDto> {
    await delay(350);
    return this.world.accept(rfqId, providerId);
  }

  async stopRfq(rfqId: string): Promise<RfqDto> {
    await delay(300);
    return this.world.stopRfq(rfqId);
  }

  async downloadResult(rfqId: string): Promise<void> {
    await delay(200);
    saveBlob(this.world.resultBlob(rfqId), `silicr-result-${rfqId.slice(0, 12)}.MOCK.txt`);
  }

  async updatePolicy(patch: Partial<ProviderPolicyDto>): Promise<ProviderPolicyDto> {
    await delay(250);
    return this.world.updatePolicy(patch);
  }

  async loadRfq(rfqId: string): Promise<void> {
    if (!getState().rfqs[rfqId]) actions.setRfqError(rfqId, 'not_found');
  }

  async refreshInspector(_target: InspectorTarget): Promise<void> {
    // Everything is already in the store.
  }

  async buyerFault(rfqId: string, fault: BuyerFault): Promise<void> {
    await delay(200);
    this.world.setPaying(rfqId, fault === 'resume_paying');
  }

  async providerFault(rfqId: string, fault: ProviderFault): Promise<void> {
    await delay(200);
    this.world.setHeartbeats(rfqId, fault === 'resume_heartbeats');
  }

  async stopJob(rfqId: string): Promise<void> {
    await delay(300);
    this.world.stopJob(rfqId);
  }

  /** Fake wallet data from the replay's status: nothing is ever sent. */
  async getWallet(role: 'buyer' | 'provider'): Promise<WalletDto> {
    await delay(120);
    const st = role === 'buyer' ? getState().buyerStatus : getState().providerStatus;
    const address = st?.address ?? MOCK_ADDRESS;
    const network = st?.network ?? 'memory';
    return {
      role,
      network,
      height: st?.height ?? 0,
      address,
      zip321Uri: `zcash:${address}`,
      balance: st?.balance ?? { spendable: '0', pending: '0' },
      confirmationsRequired: { received: network === 'memory' ? 1 : 10, change: network === 'memory' ? 1 : 3 },
      feeEstimateZats: '10000',
      busy: false,
      lastIncoming: { txid: 'f1'.repeat(32), zats: '50000000', height: st ? st.height - 2 : null, confirmations: 3 },
    };
  }

  async withdraw(_role: 'buyer' | 'provider', req: WithdrawRequest): Promise<WithdrawResultDto | WithdrawConfirmDto> {
    await delay(400);
    if (!/^u(test|regtest)?1[0-9a-z]{20,}$/.test(req.to.trim())) {
      throw new ApiError('Refusing this address: Silicr pays only to unified addresses with an Orchard receiver (MOCK)', 400, 'privacy');
    }
    const zats = req.amountZats === 'all' ? '49990000' : req.amountZats;
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    return { txid: hex, zats, feeZats: '10000', network: 'memory' };
  }

  async replayDemo(): Promise<string> {
    const { rfqId } = await this.createRfq(this.world.demoRequest());
    return rfqId;
  }
}

const MOCK_ADDRESS = 'uregtest1mockmockmockmockmockmockmockmockmockmockmockmockmockmockmock';
