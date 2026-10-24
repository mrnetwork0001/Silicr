/**
 * Runtime configuration. NEXT_PUBLIC_* values are inlined by Next at build time,
 * so each must be referenced literally (no dynamic process.env lookups).
 */

import type { NetworkName } from '@silicr/api';

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/**
 * Daemon base URLs may carry a path prefix behind a reverse proxy, e.g.
 * NEXT_PUBLIC_BUYER_URL=https://host/buyer → https://host/buyer/api/status.
 */
export const config = {
  buyerUrl: trimSlash(process.env.NEXT_PUBLIC_BUYER_URL || 'http://127.0.0.1:7701'),
  providerUrl: trimSlash(process.env.NEXT_PUBLIC_PROVIDER_URL || 'http://127.0.0.1:7702'),
  relayUrl: trimSlash(process.env.NEXT_PUBLIC_RELAY_URL || 'http://127.0.0.1:7700'),
  /** The public landing page; the logo in the header links back to it. Empty disables the link. */
  landingUrl: process.env.NEXT_PUBLIC_LANDING_URL ?? 'http://127.0.0.1:7704',
  /**
   * Block-explorer link templates, one per real network; `{txid}` is replaced. Explorers are
   * third parties: opening a link tells them which txid you're looking at, from your browser's
   * IP (a daemon-side SOCKS5 proxy does not cover the browser). No link on any other network.
   */
  explorerTxUrlMain: process.env.NEXT_PUBLIC_EXPLORER_TX_URL_MAIN || 'https://mainnet.zcashexplorer.app/transactions/{txid}',
  /** NEXT_PUBLIC_EXPLORER_TX_URL is the older name for the testnet template; still honoured. */
  explorerTxUrlTest:
    process.env.NEXT_PUBLIC_EXPLORER_TX_URL_TEST || process.env.NEXT_PUBLIC_EXPLORER_TX_URL || 'https://zexplorer.app/testnet/tx/{txid}',
} as const;

/** The explorer template for a network, or null where no public explorer exists (memory, regtest). */
export function explorerTxUrlFor(network: NetworkName | null | undefined): string | null {
  switch (network) {
    case 'main':
      return config.explorerTxUrlMain;
    case 'test':
      return config.explorerTxUrlTest;
    default:
      return null;
  }
}

/** Explorer link for a txid on the given network, or null when there is no explorer for it. */
export function explorerTxLink(txid: string, network: NetworkName | null | undefined): string | null {
  const template = explorerTxUrlFor(network);
  if (!template || !txid) return null;
  return template.replace('{txid}', encodeURIComponent(txid));
}

/** "127.0.0.1:7701" from "http://127.0.0.1:7701"; "host/buyer" from "https://host/buyer" (path prefix kept). */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}
