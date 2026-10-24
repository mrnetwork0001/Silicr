/** Wallet connection helpers (pure): client-side address checks and ZIP 321 URIs. */

import type { NetworkName } from '@silicr/api';
import { networkLabel, zecString } from './format';

/** The unified-address prefix each network uses. */
export const UA_PREFIX: Record<NetworkName, string> = { main: 'u1', test: 'utest1', regtest: 'uregtest1', memory: 'uregtest1' };

/** Client-side check only: the daemon's Orchard-only guard is authoritative. */
export function destinationError(to: string, network: NetworkName): string | null {
  const s = to.trim();
  if (!s) return null;
  if (/^(t1|t3|tm|t2|tex1|textest1)/i.test(s)) return 'Transparent addresses are refused: they publish sender, recipient and amount. Use a unified address.';
  if (/^(zs1|ztestsapling1|zregtestsapling1|zc|zt)/i.test(s)) return 'Sapling and Sprout addresses are refused: crossing pools publishes the amount. Use a unified address.';
  if (/^uview|^uivk/i.test(s)) return 'That is a viewing key, not an address. Keep it private.';
  const prefix = UA_PREFIX[network];
  if (!s.startsWith(prefix)) return `Expected a ${networkLabel(network)} unified address starting with ${prefix}…`;
  if (!/^[0-9a-z]+$/.test(s) || s.length < prefix.length + 40) return 'This does not look like a complete unified address.';
  return null;
}

/** "zcash:<ua>?amount=<ZEC>" (ZIP 321); the daemon's base URI plus the typed amount. */
export function zip321With(baseUri: string, amountZats: bigint | null): string {
  const base = baseUri.split('?')[0] ?? baseUri;
  return amountZats && amountZats > 0n ? `${base}?amount=${zecString(amountZats, { group: false })}` : base;
}

