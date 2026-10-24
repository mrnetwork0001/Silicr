/**
 * @silicr/zec: the only way the rest of Silicr touches Zcash.
 *
 * - contract.ts: ZecBackend and the shared types (lead-owned).
 * - ua.ts: ZIP 316 unified address codec (decodeUnifiedAddress, encodeUnifiedAddress).
 * - guard.ts: the Orchard-only privacy guard (toOrchardOnly, isOrchardOnly).
 * - memory.ts: createMemoryNetwork, the in-process simulated chain.
 * - testnet/: the zec-sidecar backend (Zcash mainnet or testnet), loaded on demand by openBackend.
 */
export * from './contract.ts';

import type { BackendConfig, ZecBackend } from './contract.ts';

export { decodeUnifiedAddress, encodeUnifiedAddress, UnifiedAddressError } from './ua.ts';
export { isOrchardOnly, randomOrchardAddress, toOrchardOnly } from './guard.ts';
export { createMemoryNetwork } from './memory.ts';
// Viewing keys for auditors: a one-shot `zec-sidecar export-ufvk`, with no wallet process or server.
export { exportViewingKeyOffline, type OfflineExportOptions } from './testnet/keys.ts';

export async function openBackend(config: BackendConfig): Promise<ZecBackend> {
  if (config.kind === 'memory') {
    return config.network.wallet(config.wallet, config.fundZats === undefined ? {} : { fundZats: config.fundZats });
  }
  if (config.kind !== 'testnet' && config.kind !== 'sidecar') {
    throw new Error(`unknown backend kind "${String((config as { kind?: unknown }).kind)}"`);
  }
  const m = await import('./testnet/index.ts');
  return m.createSidecarBackend(config);
}
