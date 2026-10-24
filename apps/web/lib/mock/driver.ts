/**
 * Mock driver: the scripted replay behind the same Driver interface the real
 * daemons use. Small artificial latencies make the UI's loading states visible.
 */

import type { BuyerFault, NewRfqRequest, ProviderFault, ProviderPolicyDto, RfqDto } from '@silicr/api';
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

  async replayDemo(): Promise<string> {
    const { rfqId } = await this.createRfq(this.world.demoRequest());
    return rfqId;
  }
}
