// The Silicr MCP server: silicr_* tools over the local buyer daemon's HTTP API. It holds no keys.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DaemonClient } from './client.ts';
import { SpendingCap } from './cap.ts';
import { registerTools, type ToolContext } from './tools.ts';
import { formatZec } from './zec.ts';

export const MCP_VERSION = '0.1.0';

export interface SilicrMcpOptions {
  buyerUrl: string;
  /** Provider daemon, used only for the Leak Inspector in demo mode. null = none. */
  providerUrl?: string | null;
  /** Relay observer feed. null = the URL the buyer daemon reports. */
  relayUrl?: string | null;
  /** The most this session may commit, in zatoshis. */
  maxTotalZats: bigint;
  /** Where result bundles are saved. */
  outDir: string;
  /** Diagnostics (stderr). Never receives secrets or job contents. */
  log?: (line: string) => void;
}

export interface SilicrMcp {
  server: McpServer;
  context: ToolContext;
}

export const SERVER_INSTRUCTIONS = [
  'Silicr is a private GPU-compute market on Zcash: sealed requests, signed bids, metered payments in shielded ZEC, and a Leak Inspector that shows what every party could learn.',
  'Typical flow: silicr_status → silicr_list_providers → silicr_estimate → silicr_request_compute → silicr_wait(until="running") → silicr_wait(until="closed") → silicr_download_result → silicr_leak_report.',
  'Money is ZEC. A per-session spending cap bounds what you can commit; the buyer daemon may add its own cap. On Zcash mainnet payments are real: keep requests small and read the cap in silicr_status first.',
  'The whole job directory is sent (encrypted) to the winning provider, who must see it to run it; never point job_path at a directory with secrets.',
].join('\n');

export function createSilicrServer(o: SilicrMcpOptions): SilicrMcp {
  const context: ToolContext = {
    buyer: new DaemonClient(o.buyerUrl),
    provider: o.providerUrl ? new DaemonClient(o.providerUrl) : null,
    relayUrl: o.relayUrl ?? null,
    cap: new SpendingCap(o.maxTotalZats),
    outDir: o.outDir,
    log: o.log ?? (() => undefined),
  };
  const server = new McpServer({ name: 'silicr', version: MCP_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, context);
  context.log(`cap ${formatZec(o.maxTotalZats)} ZEC per session`);
  return { server, context };
}
