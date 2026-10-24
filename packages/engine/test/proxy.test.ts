// The proxy setting threads through to status and to the Leak Inspector: each daemon records what
// the network learns about its address, once globally and again as the first observation of every RFQ.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryNetwork, type MemoryNetwork } from '@silicr/zec';
import { BuyerNode } from '../src/buyer.ts';
import { ProviderNode } from '../src/provider.ts';
import { FakeRelay, FakeRunner, TEST_PROFILE, fakeBundles, tempDir } from './helpers.ts';

const PROXY = { url: 'socks5h://127.0.0.1:9050', kind: 'socks5' as const };
const ON = 'network: via SOCKS5 proxy, IP not exposed to relay/light-wallet server';
const OFF = 'network: direct connection, IP exposed to relay/light-wallet server';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function nodes(o: { proxy?: typeof PROXY; relayUrl?: string } = {}) {
  const root = await tempDir();
  const network: MemoryNetwork = createMemoryNetwork({ blockTimeMs: 1000 });
  cleanups.push(() => network.stop());
  const relay = new FakeRelay();
  if (o.relayUrl) (relay as { baseUrl: string }).baseUrl = o.relayUrl;
  const extra = o.proxy ? { proxy: o.proxy } : {};
  const buyer = new BuyerNode({ backend: network.wallet('buyer', { fundZats: 1_000_000n }), relay, dataDir: join(root, 'buyer'), profile: TEST_PROFILE, deps: fakeBundles, ...extra });
  const provider = new ProviderNode({
    backend: network.wallet('provider', { fundZats: 1_000_000n }),
    relay,
    dataDir: join(root, 'provider'),
    profile: TEST_PROFILE,
    deps: fakeBundles,
    runner: new FakeRunner(join(root, 'runner'), { steps: 1, stepMs: 10 }),
    policy: { gpus: [{ model: 'a100', count: 1, vramGb: 80 }], minPricePerHourZats: 36_000_000n },
    ...extra,
  });
  cleanups.push(async () => {
    await buyer.close().catch(() => undefined);
    await provider.close().catch(() => undefined);
  });
  return { buyer, provider };
}

describe('network posture', () => {
  it('reports the proxy in status and records that the IP is not exposed', async () => {
    const { buyer, provider } = await nodes({ proxy: PROXY });
    expect((await buyer.status()).proxy).toEqual(PROXY);
    expect((await provider.status()).proxy).toEqual(PROXY);
    for (const [node, party] of [[buyer, 'buyer'], [provider, 'provider']] as const) {
      const first = node.listLeaks({})[0]!;
      expect(first.party).toBe(party);
      expect(first.event).toBe('network');
      expect(first.summary).toBe(ON);
      expect(first.rfqId).toBeUndefined();
      expect(first.fields.find((f) => f.label === 'Proxy')).toMatchObject({ value: PROXY.url, readable: true, sensitive: false });
      expect(first.fields.find((f) => f.label === 'Relay')?.value).toBe('fake-relay.invalid (via the proxy)');
      const ip = first.fields.find((f) => f.label === 'IP seen by the relay and light-wallet server')!;
      expect(ip).toMatchObject({ readable: false, sensitive: true, facts: party === 'buyer' ? ['buyer_ip'] : [] });
    }
  });

  it('says so when there is no proxy, and knows a loopback relay is this machine', async () => {
    const { buyer } = await nodes({ relayUrl: 'http://127.0.0.1:7700' });
    expect((await buyer.status()).proxy).toBeUndefined();
    const first = buyer.listLeaks({})[0]!;
    expect(first.summary).toBe(OFF);
    expect(first.fields.find((f) => f.label === 'Proxy')?.value).toMatch(/^none/);
    expect(first.fields.find((f) => f.label === 'Relay')?.value).toBe('127.0.0.1 (this machine)');
    const ip = first.fields.find((f) => f.label === 'IP seen by the relay and light-wallet server')!;
    expect(ip).toMatchObject({ readable: true, sensitive: true, facts: ['buyer_ip'] });
    expect(ip.value).toMatch(/this machine's own address/);
  });

  it('is the first observation of every RFQ, exactly once', async () => {
    const { buyer } = await nodes({ proxy: PROXY });
    const rfqId = 'ab'.repeat(16);
    buyer.leaks.record({ party: 'buyer', event: 'tx-broadcast', summary: 'RFQ sent', fields: [], rfqId });
    buyer.leaks.record({ party: 'buyer', event: 'memo-received', summary: 'BID', fields: [], rfqId });
    const forRfq = buyer.listLeaks({ rfqId });
    expect(forRfq.map((o) => o.event)).toEqual(['network', 'tx-broadcast', 'memo-received']);
    expect(forRfq[0]!.summary).toBe(ON);
    expect(forRfq[0]!.rfqId).toBe(rfqId);
    // Ids stay sequential: the network observation was stored before the one that triggered it.
    const ids = forRfq.map((o) => Number(o.id.replace('buyer-', '')));
    expect(ids).toEqual([ids[0], ids[0]! + 1, ids[0]! + 2]);
    // Another RFQ gets its own.
    const other = 'cd'.repeat(16);
    buyer.leaks.record({ party: 'buyer', event: 'tx-broadcast', summary: 'RFQ sent', fields: [], rfqId: other });
    expect(buyer.listLeaks({ rfqId: other }).map((o) => o.event)).toEqual(['network', 'tx-broadcast']);
    expect(buyer.listLeaks({}).filter((o) => o.event === 'network')).toHaveLength(3);
  });
});
