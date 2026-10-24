// The engine's seams. Production uses the real packages; unit tests can swap any of these.
import * as protocol from '@silicr/protocol';
import { toOrchardOnly } from '@silicr/zec';
import { packBundle, unpackBundle } from '@silicr/runner';
import type { Network } from '@silicr/zec';

export type ProtocolApi = Pick<
  typeof protocol,
  | 'newRfqId'
  | 'signerFromSecret'
  | 'generateSigner'
  | 'generateX25519'
  | 'deriveRfqKeys'
  | 'encodeMemo'
  | 'decodeMemo'
  | 'deriveChannel'
  | 'encodeHeartbeat'
  | 'decodeHeartbeat'
  | 'signDirectoryEntry'
  | 'verifyDirectoryEntry'
  | 'sha256'
>;

export interface EngineDeps {
  protocol: ProtocolApi;
  /** The privacy guard: every recipient goes through this. */
  toOrchardOnly: (address: string, expected: Network) => string;
  packBundle: (dir: string, opts?: { special?: 'error' | 'skip' }) => Promise<Uint8Array>;
  unpackBundle: (bytes: Uint8Array, intoDir: string) => Promise<void>;
}

export const realDeps: EngineDeps = {
  protocol,
  toOrchardOnly,
  packBundle,
  unpackBundle,
};

export function resolveDeps(over?: Partial<EngineDeps>): EngineDeps {
  return { ...realDeps, ...(over ?? {}) };
}
