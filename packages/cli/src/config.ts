// Per-party data dir config (written by `silicr init`) and repo discovery.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NodeConfig {
  v: 1;
  role: 'buyer' | 'provider';
  /** main = Zcash mainnet (real ZEC; needs spendCap), test = Zcash testnet, memory = simulated. */
  network: 'main' | 'test' | 'memory';
  relayUrl: string;
  port: number;
  /** lightwalletd / Zaino for testnet or mainnet. */
  server?: string;
  /**
   * Spending guard, decimal zatoshi strings. Required on mainnet: the daemon refuses to start there
   * without it. perRfqZats bounds one request's payments; totalZats bounds payments plus fees over
   * every request the data dir ever made (a provider only ever spends fees).
   */
  spendCap?: { perRfqZats: string; totalZats: string };
  runner?: 'auto' | 'process' | 'docker';
  /** SOCKS5 proxy (socks5h://host:port, e.g. Tor) for every outbound connection; overridden by $SILICR_PROXY and --proxy. */
  proxy?: string;
  /** 'memo' = relay-less: job, logs, heartbeats and result travel in Zcash memos (small jobs only). Default 'relay'. */
  transport?: 'relay' | 'memo';
}

export async function readConfig(dataDir: string): Promise<NodeConfig | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as NodeConfig;
  } catch {
    return null;
  }
}

export async function writeConfig(dataDir: string, cfg: NodeConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/** The repo root (where pnpm-workspace.yaml lives), else the current directory. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve('.');
}

/** Where a party's data dir goes when --data is not given: mainnet and testnet wallets under .silicr/wallets/. */
export function defaultDataDir(role: 'buyer' | 'provider', network: NodeConfig['network'] = 'memory'): string {
  if (network === 'main') return join(repoRoot(), '.silicr', 'wallets', `main-${role}`);
  if (network === 'test') return join(repoRoot(), '.silicr', 'wallets', role);
  return join(repoRoot(), '.silicr', role);
}
