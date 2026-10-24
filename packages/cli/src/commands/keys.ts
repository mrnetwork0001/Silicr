// `silicr export-viewing-key` and `silicr watch`: viewing keys for auditors.
//
// A unified full viewing key (ZIP 316 UFVK, uview1… on mainnet, uviewtest1… on testnet) lets its
// holder see every payment the wallet ever sent or received, with amounts and memos, and link all
// of the wallet's addresses to each other. It can never spend. Silicr exports the Orchard
// component only, matching its Orchard-receiver-only addresses. The key goes to stdout once, on
// request, and nowhere else: not to a log, not to a file, not to the daemon.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { exportViewingKeyOffline, openBackend, type ZecBackend } from '@silicr/zec';
import { readConfig } from '../config.ts';
import { isInteractive, MAINNET_TAG } from '../confirm.ts';
import { fail, kv, pc, table, zec } from '../format.ts';
import { resolveProxy } from './node.ts';

type Chain = 'main' | 'test';

export const SCOPE_WARNING =
  'A viewing key reveals the WHOLE wallet: every payment it ever sent or received, amounts, memos, and which addresses belong together. ' +
  'It never includes spending authority. Use one wallet per audit scope (one client, one period), and hand the key over on a private channel.';

function checkChain(n: string | undefined, what: string): Chain {
  if (n === 'mainnet') n = 'main';
  if (n === 'testnet') n = 'test';
  if (n !== 'main' && n !== 'test') fail(`${what}: --network must be main or test (a memory-network wallet has no viewing key)`);
  return n;
}

/** The network a wallet dir was made on: --network, else config.json, else the sidecar's wallet.json. */
export async function walletNetwork(dataDir: string, flag: string | undefined): Promise<Chain> {
  if (flag !== undefined) return checkChain(flag, 'network');
  const cfg = await readConfig(dataDir);
  if (cfg?.network === 'memory') fail(`${dataDir} is a memory-network data dir: its simulated chain has no viewing key`);
  if (cfg?.network) return checkChain(cfg.network, 'config.json');
  try {
    const meta = JSON.parse(await readFile(join(dataDir, 'wallet.json'), 'utf8')) as { network?: string };
    if (meta.network) return checkChain(meta.network, 'wallet.json');
  } catch {
    /* no wallet.json */
  }
  return fail(`no wallet found in ${dataDir} (looked for config.json and wallet.json); give --data from \`silicr init\` and, if needed, --network`);
}

export interface ExportOptions {
  data: string;
  network?: string;
  yes?: boolean;
  /** Test hook: answers the terminal prompt. */
  ask?: () => Promise<string>;
}

/** Prints the wallet's Orchard-only UFVK to stdout, after a loud warning and a go-ahead. */
export async function exportViewingKey(o: ExportOptions): Promise<void> {
  const dataDir = resolve(o.data);
  const network = await walletNetwork(dataDir, o.network);
  const viewOnly = await isWatchOnly(dataDir);
  console.error(`\n  ${pc.red(pc.bold('VIEWING KEY EXPORT'))}  ${network === 'main' ? pc.red(MAINNET_TAG) : 'Zcash testnet'}${viewOnly ? pc.dim('  (this wallet is itself watch-only)') : ''}`);
  console.error(`  ${pc.yellow(SCOPE_WARNING)}`);
  console.error(`  ${pc.dim(`wallet: ${dataDir}`)}`);
  if (!o.yes) {
    if (!isInteractive() && !o.ask) fail('re-run with --yes to acknowledge the warning above (no terminal to ask on); nothing was printed');
    let answer: string;
    if (o.ask) {
      answer = await o.ask();
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        answer = await rl.question('  Print the viewing key? [y/N] ');
      } finally {
        rl.close();
      }
    }
    if (!/^y(es)?$/i.test(answer.trim())) fail('cancelled: nothing was printed');
  }
  let key: string;
  try {
    key = await exportViewingKeyOffline({ dataDir, network });
  } catch (e) {
    return fail(`could not export the viewing key: ${(e as Error).message}`);
  }
  // The key itself is the only thing on stdout, so it can be piped or copied cleanly.
  console.log(key);
  console.error(`\n  ${pc.dim(`Watch it with: silicr watch --network ${network} --data <new dir> --viewing-key <the key above>`)}\n`);
}

async function isWatchOnly(dataDir: string): Promise<boolean> {
  try {
    const meta = JSON.parse(await readFile(join(dataDir, 'wallet.json'), 'utf8')) as { viewOnly?: boolean };
    return meta.viewOnly === true;
  } catch {
    return false;
  }
}

export interface WatchOptions {
  viewingKey?: string;
  network: string;
  data: string;
  server?: string;
  proxy?: string;
  birthday?: string;
  json?: boolean;
  /** Test hook: the backend to use instead of opening the sidecar. */
  backend?: ZecBackend;
}

/** A ledger entry as `silicr watch --json` prints it (zats as decimal strings, memo as hex). */
export interface LedgerRowJson {
  txid: string;
  height: number;
  time: number | null;
  direction: 'received' | 'sent' | 'change';
  zats: string;
  address: string | null;
  memoType: string;
  memoHex: string;
  feeZats: string | null;
  valuePool: string;
}

type WatchBackend = ZecBackend & {
  readOnly?: boolean;
  ledger?: () => Promise<{
    entries: { txid: string; height: number; time: number | null; direction: 'received' | 'sent' | 'change'; zats: bigint; address: string | null; memoType: string; memo: Uint8Array; feeZats: bigint | null; valuePool: string }[];
    tip: number | null;
    birthday: number;
    viewOnly: boolean;
  }>;
};

/** Text-memo preview: printable UTF-8 up to the first zero byte, trimmed to `n` chars. */
function memoPreview(memoType: string, memo: Uint8Array, n = 24): string {
  if (memoType !== 'text') return '';
  let end = memo.indexOf(0);
  if (end < 0) end = memo.length;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(memo.subarray(0, end)).replace(/[\p{C}]/gu, '');
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function when(time: number | null): string {
  return time === null ? '-' : new Date(time * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Opens (or re-opens) a watch-only wallet from a viewing key, syncs it, and prints the ledger:
 * every received note and every sent payment, with amounts, heights, txids and the Silicr memo
 * type. `--json` prints the rows as one JSON array. The wallet in --data holds no seed and can
 * never spend; it is still private data (it records the whole history), so keep it to yourself.
 */
export async function watch(o: WatchOptions): Promise<void> {
  const network = checkChain(o.network, 'watch');
  const dataDir = resolve(o.data);
  const existing = existsSync(join(dataDir, 'wallet.json'));
  if (!o.viewingKey && !existing) fail('--viewing-key <uview…> is needed to create a watch-only wallet (re-opening an existing one in --data needs no key)');
  const hrp = network === 'main' ? 'uview1' : 'uviewtest1';
  if (o.viewingKey && !o.viewingKey.trim().startsWith(hrp)) {
    fail(`--viewing-key must be a ${hrp}… unified full viewing key for ${network === 'main' ? 'mainnet' : 'testnet'}; seed phrases and spending keys are refused`);
  }
  let backend: WatchBackend;
  if (o.backend) {
    backend = o.backend;
  } else {
    // Same proxy rules as the daemon: --proxy, else $SILICR_PROXY; "none" forces direct; never a silent fallback.
    const cfg: Record<string, unknown> = { kind: 'sidecar', network, dataDir, proxy: resolveProxy(o.proxy, undefined)?.raw ?? null };
    if (o.server) cfg['server'] = o.server;
    if (o.birthday) cfg['birthday'] = Number(o.birthday);
    // A watch-only wallet is always opened with its key: the sidecar checks it matches the one stored.
    if (o.viewingKey) cfg['viewingKey'] = o.viewingKey.trim();
    else cfg['viewingKey'] = await storedViewingKey(dataDir, network);
    try {
      backend = (await openBackend(cfg as Parameters<typeof openBackend>[0])) as WatchBackend;
    } catch (e) {
      return fail(`could not open the watch-only wallet: ${(e as Error).message}`);
    }
  }
  try {
    if (backend.readOnly !== true) fail('refusing: the backend is not watch-only (it would hold a spending key)');
    if (!backend.ledger) fail('this backend has no ledger');
    const ledger = await backend.ledger();
    const rows: LedgerRowJson[] = ledger.entries.map((e) => ({
      txid: e.txid,
      height: e.height,
      time: e.time,
      direction: e.direction,
      zats: e.zats.toString(),
      address: e.address,
      memoType: e.memoType,
      memoHex: Buffer.from(e.memo).toString('hex'),
      feeZats: e.feeZats === null ? null : e.feeZats.toString(),
      valuePool: e.valuePool,
    }));
    if (o.json) {
      console.log(JSON.stringify({ network, address: await backend.address(), birthday: ledger.birthday, tip: ledger.tip, viewOnly: ledger.viewOnly, entries: rows }, null, 2));
      return;
    }
    const received = ledger.entries.filter((e) => e.direction === 'received').reduce((a, e) => a + e.zats, 0n);
    const sent = ledger.entries.filter((e) => e.direction === 'sent').reduce((a, e) => a + e.zats, 0n);
    const fees = [...new Map(ledger.entries.filter((e) => e.direction === 'sent' && e.feeZats !== null).map((e) => [e.txid, e.feeZats!])).values()].reduce((a, f) => a + f, 0n);
    console.log(`\n  ${pc.green('watch-only wallet')}  ${network === 'main' ? pc.red(MAINNET_TAG) : 'Zcash testnet'}  ${pc.dim('no spending key: sees everything, sends nothing')}\n`);
    kv([
      ['address', await backend.address()],
      ['data dir', `${dataDir} ${pc.dim('(no seed; still private: it holds the whole history)')}`],
      ['scanned', `birthday ${ledger.birthday} → tip ${ledger.tip ?? '?'}`],
      ['received', `${zec(received)} in ${ledger.entries.filter((e) => e.direction === 'received').length} notes`],
      ['sent', `${zec(sent)} in ${ledger.entries.filter((e) => e.direction === 'sent').length} payments, ${zec(fees)} fees`],
    ]);
    console.log();
    if (ledger.entries.length === 0) {
      console.log(`  ${pc.dim('no payments yet (nothing received or sent since the birthday height)')}`);
    } else {
      table(
        ['height', 'time (UTC)', 'dir', 'amount', 'memo', 'txid', 'to/from'],
        ledger.entries.map((e) => [
          String(e.height),
          when(e.time),
          e.direction === 'received' ? pc.green('in') : e.direction === 'sent' ? pc.yellow('out') : pc.dim('change'),
          zec(e.zats),
          e.memoType === 'text' ? `text ${pc.dim(JSON.stringify(memoPreview(e.memoType, e.memo)))}` : e.memoType,
          `${e.txid.slice(0, 12)}…`,
          e.address ? `${e.address.slice(0, 14)}…` : '-',
        ]),
      );
    }
    console.log(`\n  ${pc.yellow(SCOPE_WARNING)}\n`);
  } finally {
    await backend.close().catch(() => undefined);
  }
}

/** Re-opening an existing watch-only dir: the key is in the sidecar's wallet database; ask the sidecar for it offline. */
async function storedViewingKey(dataDir: string, network: Chain): Promise<string> {
  try {
    return await exportViewingKeyOffline({ dataDir, network });
  } catch (e) {
    return fail(`could not read the watch-only wallet in ${dataDir}: ${(e as Error).message}`);
  }
}
