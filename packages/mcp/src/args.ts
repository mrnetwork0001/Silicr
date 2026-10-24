// Command line of `silicr-mcp`.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { formatZec, parseZec } from './zec.ts';

export const DEFAULT_BUYER_URL = 'http://127.0.0.1:7701';
export const DEFAULT_PROVIDER_URL = 'http://127.0.0.1:7702';
/** Small on purpose: on mainnet this is real ZEC. Raise it per session with --max-total-zec. */
export const DEFAULT_MAX_TOTAL_ZEC = '0.05';
export const DEFAULT_OUT_DIR = '.silicr/mcp-results';

export interface McpCliOptions {
  buyerUrl: string;
  /** null = don't talk to a provider daemon (only the buyer's view then). */
  providerUrl: string | null;
  /** null = use the relay URL the buyer daemon reports (demo mode only). */
  relayUrl: string | null;
  maxTotalZats: bigint;
  outDir: string;
  help: boolean;
}

export function usage(): string {
  return [
    'usage: silicr-mcp [--buyer URL] [--provider URL|none] [--relay URL|none] [--max-total-zec ZEC] [--out-dir DIR]',
    '',
    'An MCP server (stdio) that lets an AI agent rent GPU compute on Silicr through the local buyer daemon.',
    '',
    `  --buyer URL           buyer daemon (default ${DEFAULT_BUYER_URL}, env SILICR_BUYER_URL)`,
    `  --provider URL|none   provider daemon, for the Leak Inspector in demo mode (default ${DEFAULT_PROVIDER_URL}, env SILICR_PROVIDER_URL)`,
    '  --relay URL|none      relay observer feed, for the Leak Inspector in demo mode (default: the URL the buyer daemon reports, env SILICR_RELAY_URL)',
    `  --max-total-zec ZEC   the most this session may commit, in ZEC (default ${DEFAULT_MAX_TOTAL_ZEC}, env SILICR_MCP_MAX_TOTAL_ZEC)`,
    `  --out-dir DIR         where result bundles are saved (default ${DEFAULT_OUT_DIR}, env SILICR_MCP_OUT_DIR)`,
    '  -h, --help            this text',
    '',
    'The server holds no keys and never leaves this machine: it can only do what the buyer daemon allows.',
    '',
  ].join('\n');
}

function url(name: string, raw: string): string {
  const s = raw.trim();
  if (!/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(s)) throw new Error(`${name} must be an http(s) URL like http://127.0.0.1:7701, got "${raw}"`);
  return s.replace(/\/+$/, '');
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): McpCliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      buyer: { type: 'string' },
      provider: { type: 'string' },
      relay: { type: 'string' },
      'max-total-zec': { type: 'string' },
      'out-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  const buyerUrl = url('--buyer', values.buyer ?? env.SILICR_BUYER_URL ?? DEFAULT_BUYER_URL);
  const providerRaw = values.provider ?? env.SILICR_PROVIDER_URL ?? DEFAULT_PROVIDER_URL;
  const relayRaw = values.relay ?? env.SILICR_RELAY_URL ?? 'none';
  const capRaw = values['max-total-zec'] ?? env.SILICR_MCP_MAX_TOTAL_ZEC ?? DEFAULT_MAX_TOTAL_ZEC;
  let maxTotalZats: bigint;
  try {
    maxTotalZats = parseZec(capRaw);
  } catch (e) {
    throw new Error(`--max-total-zec: ${(e as Error).message}`);
  }
  return {
    buyerUrl,
    providerUrl: providerRaw.trim().toLowerCase() === 'none' ? null : url('--provider', providerRaw),
    relayUrl: relayRaw.trim().toLowerCase() === 'none' ? null : url('--relay', relayRaw),
    maxTotalZats,
    outDir: resolve(cwd, values['out-dir'] ?? env.SILICR_MCP_OUT_DIR ?? DEFAULT_OUT_DIR),
    help: values.help === true,
  };
}

export function describeOptions(o: McpCliOptions): string {
  return `buyer ${o.buyerUrl}, provider ${o.providerUrl ?? 'none'}, relay ${o.relayUrl ?? 'as reported by the buyer daemon'}, cap ${formatZec(o.maxTotalZats)} ZEC per session, results in ${o.outDir}`;
}
