/**
 * `pnpm verify`: the judges' verification kit (see docs/JUDGES.md).
 *
 * Starts a complete Silicr stack inside this process on ephemeral ports: the simulated chain
 * (@silicr/zec memory backend), the real relay with its observer feed, the real memo protocol and
 * channel crypto, the process-mode runner and a buyer and a provider with their HTTP daemons. It runs
 * one real deal on examples/tiny-train, then a series of named checks against what each party
 * actually holds, prints ✓/✗ per check with the evidence, and exits non-zero on any failure.
 *
 * It never touches .silicr/, the demo ports (7700–7704) or a real chain: everything lives in a
 * fresh temp dir that is deleted at the end (keep it with --keep).
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { ErrorDto, NewRfqRequest, ProviderJobDto, PublicTxViewDto, RelayObserverResponse, RfqDto } from '../packages/api/src/index.ts';
import {
  EngineError,
  FAST_PROFILE,
  ProviderNode,
  checkJobPath,
  formatZec,
  maxExposureIntervals,
  padBucket,
  payLeadFor,
  perInterval,
  startDaemon,
  startLocalStack,
  withOverrides,
  type BuyerRfq,
  type LocalStack,
} from '../packages/engine/src/index.ts';
import {
  decodeMemo,
  deriveChannel,
  encodeHeartbeat,
  encodeMemo,
  generateSigner,
  generateX25519,
  signDirectoryEntry,
  signerFromSecret,
  verifyDirectoryEntry,
  type Bid,
  type DecodedMemo,
  type DirectoryEntry,
  type Heartbeat,
  type MemoMessage,
  type Rfq,
  type Signer,
} from '../packages/protocol/src/index.ts';
import { relayClient } from '../packages/relay/src/index.ts';
import { createRunner, unpackBundle } from '../packages/runner/src/index.ts';
import {
  InsufficientFundsError,
  PrivacyError,
  decodeUnifiedAddress,
  encodeUnifiedAddress,
  randomOrchardAddress,
  toOrchardOnly,
  type Output,
  type PublicTxView,
  type ReceivedNote,
  type ZecBackend,
} from '../packages/zec/src/index.ts';

// ---------------------------------------------------------------------------- settings

const { values: args } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TINY_TRAIN = join(REPO, 'examples', 'tiny-train');
const WEB_ORIGIN = 'http://localhost:7703';
const TOTAL_TIMEOUT_MS = 170_000;

/** FAST_PROFILE (250 ms blocks, 2 s intervals) tightened the way the engine's end-to-end test does, so a run takes well under two minutes. */
const PROFILE = withOverrides(FAST_PROFILE, {
  name: 'fast-verify',
  blockTimeS: 0.1,
  pollMs: 50,
  bidWindowBlocks: 50,
  intervalS: 1,
  heartbeatS: 0.2,
  heartbeatTimeoutS: 3,
  graceS: 2,
  startWithinS: 20,
  relayWaitS: 1,
  closeWaitS: 15,
  jobFetchTimeoutS: 15,
});
const BLOCK_MS = 100;

// Distinctive amounts, so a substring search for them cannot hit a size, a height or a timestamp.
const MIN_PER_HOUR = 17_555_554_800n; // the provider's minimum: exactly 4_876_543 zats per 1 s interval
const PER_INTERVAL = perInterval(MIN_PER_HOUR, 1).toString();
const MAX_PER_HOUR = '19876543210'; // the buyer's ceiling
const JOB_COMMAND = ['python3', 'train.py'];

// Address fixtures for the shielded-only guard.
// A valid testnet transparent P2PKH address: Base58Check(0x1d25 || 20 × 0x42), the same construction as packages/zec/test/guard.test.ts.
const TRANSPARENT_TESTNET = 'tmFkhJaNXuoMeKKBHp8EE9oiFW4uXKAPWnH';
// A Sapling testnet address (the fixture zec-sidecar/src/addr.rs refuses too).
const SAPLING_TESTNET = 'ztestsapling1v6wh0dawepflf7yx5722fr77yatrl22hmg0ffd2tdxfl9rr356fper8gznajnl6ww3tuj67zv60';

// ---------------------------------------------------------------------------- output capture

/** Everything this process writes to stdout/stderr, scanned for secrets at the end (check 8). */
const captured: string[] = [];
function captureStream(stream: NodeJS.WriteStream): void {
  const orig = stream.write.bind(stream) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
  (stream as unknown as { write: unknown }).write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return orig(chunk, ...rest);
  };
}
captureStream(process.stdout);
captureStream(process.stderr);
const out = (s = ''): void => void process.stdout.write(`${s}\n`);

/** Diagnostics the engine nodes emit (never secrets, by contract); scanned in check 8. */
const nodeLogs: string[] = [];
const log = (line: string): void => void nodeLogs.push(line);

// ---------------------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (s: string, n = 12) => (s.length > n ? `${s.slice(0, n)}…` : s);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const nowS = () => Math.floor(Date.now() / 1000);
const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 10_000, everyMs = 20): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
      last = undefined;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await sleep(everyMs);
  }
}

/** send() that waits out "change not confirmed yet" (the engine's TxSender does the same). */
async function sendRetry(backend: ZecBackend, outputs: Output[]): Promise<string> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return (await backend.send(outputs)).txid;
    } catch (e) {
      if (!(e instanceof InsufficientFundsError) || Date.now() > deadline) throw e;
      await sleep(30);
    }
  }
}

async function sendMemo(from: ZecBackend, to: string, msg: MemoMessage, signer: Signer, zats = 1n): Promise<string> {
  return sendRetry(from, [{ to, zats, memo: encodeMemo(msg, signer, 'binary') }]);
}

async function api<T = unknown>(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] ??= 'application/json';
  }
  const res = await fetch(`${base}${path}`, init);
  const ct = res.headers.get('content-type') ?? '';
  const parsed = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: parsed as T, headers: res.headers };
}

/** fetch() refuses to set Host, so the DNS-rebinding probe uses node:http. */
function statusWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolveP, reject) => {
    const req = httpRequest(url, { headers: { Host: host } }, (res) => {
      res.resume();
      resolveP(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function readTree(dir: string): Promise<{ path: string; data: Buffer }[]> {
  const found: { path: string; data: Buffer }[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...(await readTree(p)));
    else if (e.isFile()) found.push({ path: p, data: await readFile(p) });
  }
  return found;
}

interface Needle {
  label: string;
  value: string | Uint8Array;
}
const asBuffer = (v: string | Uint8Array) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v));
const contains = (hay: Buffer, n: Needle) => hay.includes(asBuffer(n.value));

async function mode(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8).padStart(4, '0');
}

// ---------------------------------------------------------------------------- the report

interface CheckResult {
  num: number;
  name: string;
  ok: boolean;
  evidence: string[];
  error?: string;
  ms: number;
}
const results: CheckResult[] = [];

async function check(num: number, name: string, fn: (ev: (line: string) => void) => Promise<void>): Promise<void> {
  const evidence: string[] = [];
  const t = Date.now();
  let ok = true;
  let error: string | undefined;
  try {
    await fn((line) => evidence.push(line));
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : String(e);
  }
  const r: CheckResult = { num, name, ok, evidence, ms: Date.now() - t };
  if (error !== undefined) r.error = error;
  results.push(r);
  out(`${ok ? '✓' : '✗'} ${String(num).padStart(2)}  ${name}`);
  for (const line of evidence) out(`       ${line}`);
  if (error !== undefined) out(`       FAILED: ${error}`);
  out();
}

// ---------------------------------------------------------------------------- main

/** Secrets created or read during the run; check 8 proves none of them was printed or reached the relay. */
const secrets: { label: string; bytes: Uint8Array }[] = [];
/** 64-hex strings that may legitimately appear in output: transaction ids and public keys. */
const publicHex = new Set<string>();

function rememberSigner(label: string): { signer: Signer; secret: Uint8Array } {
  const g = generateSigner();
  secrets.push({ label, bytes: g.secret });
  publicHex.add(hex(g.signer.publicKey));
  return g;
}

async function main(): Promise<number> {
  const t0 = Date.now();
  if (!existsSync(join(TINY_TRAIN, 'train.py'))) throw new Error(`examples/tiny-train/train.py is missing (looked in ${TINY_TRAIN})`);

  const root = await mkdtemp(join(tmpdir(), 'silicr-verify-'));
  const requestFor = (env: Record<string, string>, extra: Partial<NewRfqRequest> = {}): NewRfqRequest => ({
    gpu: 'cpu',
    count: 1,
    durationS: 120,
    maxPricePerHourZats: MAX_PER_HOUR,
    job: { path: TINY_TRAIN, command: JOB_COMMAND, env },
    autoAccept: { rule: 'cheapest', waitBlocks: 2 },
    ...extra,
  });

  out();
  out('Silicr privacy verification');
  out('===========================');
  out(`data dir   ${root}${args.keep ? '  (kept)' : '  (deleted at the end; --keep to inspect it)'}`);
  out(`chain      SIMULATED: the @silicr/zec memory backend (shielded-only Ironwood rules, ZIP 317 fees, ${BLOCK_MS} ms blocks). No real ZEC.`);
  out(`relay      real @silicr/relay over HTTP, observer feed on, on an ephemeral port`);
  out(`crypto     real @silicr/protocol: Ed25519 memos, X25519 + HKDF + XChaCha20-Poly1305 channel`);
  out(`runner     process mode (NOT a sandbox: the job runs as your user; Docker isolation is covered by packages/runner/test/docker.test.ts)`);
  out(`job        examples/tiny-train, ${JOB_COMMAND.join(' ')}, a real training run on this CPU`);
  out(`profile    ${PROFILE.name}: ${PROFILE.intervalS} s intervals, pay lead ${payLeadFor(PROFILE, 1)} s, grace ${PROFILE.graceS} s, heartbeat timeout ${PROFILE.heartbeatTimeoutS} s`);
  out();

  const stack: LocalStack = await startLocalStack({
    rootDir: root,
    fresh: true,
    blockTimeMs: BLOCK_MS,
    profile: PROFILE,
    ports: { relay: 0, buyer: 0, provider: 0 },
    runnerMode: 'process',
    providerPolicy: { gpus: [{ model: 'cpu', count: 8, vramGb: 0 }], minPricePerHourZats: MIN_PER_HOUR },
    relayObserver: true,
    demoMode: true,
    log,
  });
  const provider = stack.provider!;
  const providerDaemon = stack.providerDaemon!;
  const buyer = stack.buyer;
  const buyerUrl = stack.buyerDaemon.url;
  const providerUrl = providerDaemon.url;
  const relayUrl = stack.relay.url;
  const network = stack.network;
  publicHex.add(provider.providerId);
  const extraNodes: ProviderNode[] = [];
  const cleanup = async () => {
    for (const n of extraNodes) await n.close().catch(() => undefined);
    await stack.close().catch(() => undefined);
    if (!args.keep) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  };
  process.once('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });

  try {
    out(`stack      relay ${relayUrl} · buyer ${buyerUrl} · provider ${providerUrl} (${provider.alias})`);
    out();

    // ------------------------------------------------------------------ the deal
    out('Running one complete deal (sealed RFQ → signed bid → ACCEPT → metered PAYs → result → CLOSE)…');
    const buyerAddr = await buyer.address();
    const providerAddr = await provider.address();
    const created = await api<{ rfqId: string }>(buyerUrl, 'POST', '/api/rfqs', requestFor({ SILICR_STEPS: '120', SILICR_STEP_DELAY_MS: '25' }));
    assert(created.status === 201, `POST /api/rfqs answered ${created.status}: ${JSON.stringify(created.body)}`);
    const rfqId = created.body.rfqId;
    await waitFor(() => ['closed', 'failed', 'expired'].includes(buyer.getRfq(rfqId).state), 'the deal to finish', 90_000, 50);
    const deal = buyer.getRfq(rfqId);
    assert(deal.state === 'closed' && !deal.error, `deal ended ${deal.state}: ${deal.error ?? deal.closeReason}`);
    assert(deal.closeReason === 'done' && deal.resultVerified === true, `deal closed with ${deal.closeReason}, resultVerified=${deal.resultVerified}`);
    const dealRecord = buyer.record(rfqId)!;
    const dealJob = provider.getJob(rfqId);
    assert(dealJob.state === 'done' && dealJob.earnedZats === deal.spentZats, `provider job is ${dealJob.state}, earned ${dealJob.earnedZats} vs paid ${deal.spentZats}`);
    const unpacked = join(root, 'verify-result');
    await unpackBundle(await buyer.resultBytes(rfqId), unpacked);
    const metrics = JSON.parse(await readFile(join(unpacked, 'metrics.json'), 'utf8')) as { completed: boolean; steps_completed: number };
    assert(metrics.completed && metrics.steps_completed === 120, `result metrics: ${JSON.stringify(metrics)}`);
    for (const t of deal.rfqTxids ?? []) publicHex.add(t);
    const pays = deal.payments.filter((p) => p.kind === 'pay').length;
    out(`  rfq ${rfqId}: ${deal.providersAsked} provider asked, ${deal.paddedOutputs} outputs after padding, 1 signed bid (${deal.bids[0]!.alias}, ${formatZec(BigInt(deal.bids[0]!.pricePerHourZats))} ZEC/h)`);
    out(`  RFQ transaction ${deal.rfqTxid}`);
    out(`  ACCEPT + ${pays} PAYs = ${formatZec(BigInt(deal.spentZats))} ZEC to the provider, ${formatZec(BigInt(deal.feesZats))} ZEC fees and dust; ${deal.heartbeats.length} signed heartbeats kept`);
    out(`  result ${deal.result!.sizeBytes} bytes, sha256 ${short(deal.result!.digest, 16)} matches the provider's signed CLOSE; metrics.json: ${metrics.steps_completed} steps completed`);
    out(`  took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    out();

    const payTo = dealRecord.accepted!.payTo;
    const replyTo = dealRecord.replyTo;

    // ------------------------------------------------------------------ 1. relay
    await check(1, 'Relay sees only ciphertext', async (ev) => {
      const relayDir = join(root, 'relay');
      const blobs = await readTree(join(relayDir, 'mailboxes'));
      const blobBytes = blobs.reduce((n, f) => n + f.data.length, 0);
      const feed = await (await fetch(`${relayUrl}/_observer?limit=5000`)).text();
      const feedObs = (JSON.parse(feed) as RelayObserverResponse).observations;
      const directory = await readFile(join(relayDir, 'directory.json'), 'utf8');
      assert(blobs.length >= 10, `expected a job, logs, heartbeats and a result in the relay store, found ${blobs.length} blobs`);
      assert(feedObs.some((o) => o.event === 'blob-stored') && feedObs.some((o) => o.event === 'blob-fetched'), 'observer feed has no blob traffic');
      const logLine = dealRecord.logTail.find((l) => /^tiny-train/.test(l)) ?? dealRecord.logTail[0]!;
      const lossLine = dealRecord.logTail.find((l) => /loss/.test(l))!;
      assert(logLine && lossLine, 'the buyer decrypted no job log lines');
      const dealNeedles: Needle[] = [
        { label: 'job command "python3"', value: 'python3' },
        { label: 'job file "train.py"', value: 'train.py' },
        { label: 'job env name SILICR_STEPS', value: 'SILICR_STEPS' },
        { label: 'rfqId as hex', value: rfqId },
        { label: 'rfqId as raw bytes', value: unhex(rfqId) },
        { label: `bid price ${PER_INTERVAL} zats/interval`, value: PER_INTERVAL },
        { label: `max price ${MAX_PER_HOUR} zats/h`, value: MAX_PER_HOUR },
        { label: `price as ZEC "${formatZec(BigInt(PER_INTERVAL))}"`, value: formatZec(BigInt(PER_INTERVAL)) },
        { label: 'buyer wallet address', value: buyerAddr },
        { label: 'one-time reply address', value: replyTo },
        { label: 'fresh pay-to address', value: payTo },
        { label: `job log line "${short(logLine, 28)}"`, value: logLine },
        { label: `job log line "${short(lossLine, 28)}"`, value: lossLine },
        { label: 'job bundle sha256', value: dealRecord.bundleSha256 },
      ];
      // Public by design (THREAT_MODEL "Directory host"): the provider's signed entry. Never in a blob or the feed.
      const providerPublic: Needle[] = [
        { label: `provider min price ${MIN_PER_HOUR} zats/h`, value: MIN_PER_HOUR.toString() },
        { label: 'provider wallet address', value: providerAddr },
        { label: `provider alias "${provider.alias}"`, value: provider.alias },
      ];
      const pathsText = Buffer.from(blobs.map((b) => b.path).join('\n'));
      const feedBuf = Buffer.from(feed);
      const dirBuf = Buffer.from(directory);
      const hits: string[] = [];
      for (const n of [...dealNeedles, ...providerPublic]) {
        for (const b of blobs) if (contains(b.data, n)) hits.push(`${n.label} in blob ${b.path.slice(relayDir.length + 1)}`);
        if (contains(pathsText, n)) hits.push(`${n.label} in a mailbox id`);
        if (contains(feedBuf, n)) hits.push(`${n.label} in the observer feed`);
      }
      for (const n of dealNeedles) if (contains(dirBuf, n)) hits.push(`${n.label} in directory.json`);
      assert(hits.length === 0, `plaintext reached the relay: ${hits.join('; ')}`);
      const mailboxes = new Set(blobs.map((b) => b.path.slice(relayDir.length + 1).split('/')[1]));
      for (const m of mailboxes) assert(/^[0-9a-f]{32}$/.test(m ?? ''), `mailbox id ${m} is not 32 hex chars`);
      const feedLabels = new Set(feedObs.flatMap((o) => o.fields.map((f) => f.label)));
      const allowed = ['mailbox', 'seq', 'size', 'sha256', 'first 24 bytes', 'client ip', 'time', 'providerId', 'entries', 'reason'];
      for (const l of feedLabels) assert(allowed.includes(l), `observer feed exposes an unexpected field "${l}"`);
      const dirEntries = JSON.parse(directory) as DirectoryEntry[];
      assert(dirEntries.every((e) => verifyDirectoryEntry(e)), 'directory.json holds an entry that does not verify');
      ev(`scanned ${blobs.length} stored blobs (${kb(blobBytes)}) in ${mailboxes.size} mailboxes, the ${feedObs.length}-entry /_observer feed and directory.json`);
      ev(`none of ${dealNeedles.length + providerPublic.length} plaintext needles found: ${[...dealNeedles, ...providerPublic].map((n) => n.label).join(', ')}`);
      ev(`observer fields are only: ${[...feedLabels].join(', ')} (the first 24 bytes of a blob are its random nonce)`);
      ev(`directory.json: ${dirEntries.length} signed provider entr${dirEntries.length === 1 ? 'y' : 'ies'} (alias, Orchard-only address, min price: public by design); nothing about the buyer or the deal`);
    });

    // ------------------------------------------------------------------ 2. chain
    await check(2, 'Chain views reveal nothing', async (ev) => {
      // A transaction between two strangers: the daemons must refuse to look it up.
      const strangerA = network.wallet('stranger-a', { fundZats: 10_000_000n });
      const strangerB = network.wallet('stranger-b');
      const quietMemo = new Uint8Array(512);
      quietMemo[0] = 0xf6;
      const { txid: foreign } = await strangerA.send([{ to: await strangerB.address(), zats: 1000n, memo: quietMemo }]);
      const views: PublicTxView[] = network.explorer();
      for (const v of views) publicHex.add(v.txid);
      assert(views.length >= 8, `only ${views.length} transactions on the chain`);
      const byActions = new Map<number, number>();
      for (const v of views) {
        const pool = v.ironwood;
        assert(pool !== undefined, `${short(v.txid)} has no Ironwood bundle`);
        assert(v.transparent.inputs === 0 && v.transparent.outputs === 0, `${short(v.txid)} has transparent parts`);
        assert(v.sapling.spends === 0 && v.sapling.outputs === 0 && v.sapling.valueBalanceZats === 0n, `${short(v.txid)} has Sapling parts`);
        assert(v.orchard.actions === 0 && v.orchard.valueBalanceZats === 0n, `${short(v.txid)} touches the legacy Orchard pool`);
        assert(pool.actions >= 2 && v.version === 6, `${short(v.txid)}: ${pool.actions} actions, version ${v.version}`);
        assert(v.feeZats === 5000n * BigInt(pool.actions), `${short(v.txid)}: fee ${v.feeZats} is not ZIP 317 for ${pool.actions} actions`);
        byActions.set(pool.actions, (byActions.get(pool.actions) ?? 0) + 1);
      }
      const chainJson = JSON.stringify(views, big);
      const forbidden: Needle[] = [
        { label: 'any address (uregtest1…)', value: 'uregtest1' },
        { label: `bid price ${PER_INTERVAL}`, value: PER_INTERVAL },
        { label: `max price ${MAX_PER_HOUR}`, value: MAX_PER_HOUR },
        { label: `min price ${MIN_PER_HOUR}`, value: MIN_PER_HOUR.toString() },
        { label: 'memo magic "SLC1"', value: 'SLC1' },
        { label: 'job command', value: 'python3' },
        { label: 'rfqId', value: rfqId },
        { label: 'provider alias', value: provider.alias },
      ];
      const leaks = forbidden.filter((n) => contains(Buffer.from(chainJson), n)).map((n) => n.label);
      assert(leaks.length === 0, `the chain view contains: ${leaks.join(', ')}`);
      const rfqView = views.find((v) => v.txid === deal.rfqTxid)!;
      assert(rfqView.ironwood!.actions === deal.paddedOutputs + 1, `RFQ tx has ${rfqView.ironwood!.actions} actions, expected ${deal.paddedOutputs} padded outputs + 1 change`);
      // The daemon shows the same view for its own transactions, and refuses everyone else's.
      const viaApi = await api<PublicTxViewDto>(buyerUrl, 'GET', `/api/chain/tx/${deal.rfqTxid}`);
      assert(viaApi.status === 200 && viaApi.body.ironwood?.actions === rfqView.ironwood!.actions && viaApi.body.transparent.outputs === 0, `GET /api/chain/tx: ${viaApi.status}`);
      const acceptTxid = deal.payments[0]!.txid;
      const providerView = await api<PublicTxViewDto>(providerUrl, 'GET', `/api/chain/tx/${acceptTxid}`);
      assert(providerView.status === 200, `provider daemon could not show the ACCEPT it received: ${providerView.status}`);
      const refused = await api<ErrorDto>(buyerUrl, 'GET', `/api/chain/tx/${foreign}`);
      assert(refused.status === 404 && /not a transaction this node sent or received/.test(refused.body.error), `foreign txid lookup answered ${refused.status}: ${JSON.stringify(refused.body)}`);
      const dist = [...byActions.entries()].sort((a, b) => a[0] - b[0]).map(([a, n]) => `${n} × ${a} actions`).join(', ');
      ev(`${views.length} transactions on the chain (funding, RFQ, BID, ACCEPT, ${pays} PAYs, 2 CLOSEs, 1 stranger payment): ${dist}`);
      ev(`every one: version 6, 0 transparent inputs/outputs, 0 Sapling spends/outputs, 0 legacy-Orchard actions, only an Ironwood bundle; the only visible amount is the ZIP 317 fee (5000 zats × actions)`);
      ev(`the serialised views contain no address, price, rfqId, alias or memo bytes; an action's ciphertext sample is all an observer gets`);
      ev(`RFQ ${short(deal.rfqTxid!)} shows ${rfqView.ironwood!.actions} actions = ${deal.paddedOutputs} padded outputs + 1 change, whatever the provider count ≤ 4`);
      ev(`GET /api/chain/tx/<own txid> → 200 (same counts); GET /api/chain/tx/<a stranger's txid> → 404 "${refused.body.error}" (never looked up)`);
    });

    // ------------------------------------------------------------------ 3. padding
    await check(3, 'Padding hides the provider count', async (ev) => {
      const runner2 = await createRunner({ mode: 'process', workDir: join(root, 'provider2', 'runner') });
      const p2 = new ProviderNode({
        backend: network.wallet('provider2', { fundZats: 100_000_000n }),
        relay: relayClient(relayUrl),
        dataDir: join(root, 'provider2'),
        profile: PROFILE,
        runner: runner2,
        demoMode: true,
        policy: { gpus: [{ model: 'cpu', count: 8, vramGb: 0 }], minPricePerHourZats: MIN_PER_HOUR },
        log,
      });
      await p2.start();
      extraNodes.push(p2);
      publicHex.add(p2.providerId);
      const ask = async (ids: string[]) => {
        const { rfqId: id } = await buyer.createRfq(requestFor({}, { durationS: 60, providerIds: ids, autoAccept: null }));
        await waitFor(() => buyer.getRfq(id).rfqTxid, `RFQ to ${ids.length} provider(s) to be broadcast`, 15_000, 20);
        await sleep(BLOCK_MS * 3); // let it mine, so the next RFQ spends settled notes the way a real wallet would
        const r = buyer.getRfq(id);
        const view = network.explorer().find((v) => v.txid === r.rfqTxid)!;
        publicHex.add(view.txid);
        return { id, r, actions: view.ironwood!.actions };
      };
      const one = await ask([provider.providerId]);
      const two = await ask([provider.providerId, p2.providerId]);
      await buyer.stop(one.id);
      await buyer.stop(two.id);
      assert(one.r.providersAsked === 1 && two.r.providersAsked === 2, 'provider counts');
      assert(one.r.paddedOutputs === 4 && two.r.paddedOutputs === 4, `padded outputs ${one.r.paddedOutputs} / ${two.r.paddedOutputs}`);
      assert(one.actions === two.actions, `the two RFQs show different action counts: ${one.actions} vs ${two.actions}`);
      assert(one.actions >= 5 && one.actions <= 8, `RFQ action count ${one.actions} is outside the 4-output bucket's 5–8 range`);
      const table = [1, 2, 3, 4, 5, 8, 9, 16, 17].map((n) => `${n}→${padBucket(n)}`).join(' ');
      ev(`RFQ asking 1 provider: ${one.r.paddedOutputs} outputs, ${one.actions} actions on chain (tx ${short(one.r.rfqTxid!)})`);
      ev(`RFQ asking 2 providers: ${two.r.paddedOutputs} outputs, ${two.actions} actions on chain (tx ${short(two.r.rfqTxid!)}): identical shape`);
      ev(`padBucket(n) outputs: ${table}; real outputs are shuffled among dummy outputs to fresh addresses of the buyer's own`);
      ev(`THREAT_MODEL: a chain observer sees the bucket (5–8, 9–12 or 17–20 actions), not how many providers were asked`);
    });

    // ------------------------------------------------------------------ 4. directory forgery
    await check(4, 'Directory forgery rejected', async (ev) => {
      const before = (await relayClient(relayUrl).listDirectory()) as DirectoryEntry[];
      const honest = before.find((e) => e.providerId === provider.providerId);
      assert(honest && verifyDirectoryEntry(honest), 'the honest provider entry is not listed or does not verify');
      const attacker = rememberSigner('directory attacker');
      const forged: unknown[] = [
        { ...signDirectoryEntry({ ...honest, alias: 'not-the-victim', updatedAt: nowS() + 7 * 86400 }, attacker.signer), providerId: provider.providerId },
        { ...signDirectoryEntry({ ...honest, alias: 'not-the-victim', updatedAt: nowS() + 60 }, attacker.signer), providerId: provider.providerId },
        { ...honest, alias: 'evil', minPricePerHourZats: '1', updatedAt: Number.MAX_SAFE_INTEGER, sig: 'cd'.repeat(64) },
        { ...honest, alias: 'evil', updatedAt: honest.updatedAt + 60 },
      ];
      const statuses: string[] = [];
      for (const f of forged) {
        const r = await api<ErrorDto>(relayUrl, 'POST', '/directory', f);
        assert(r.status === 400, `forged entry accepted with ${r.status}`);
        statuses.push(`${r.status} ${r.body.code}`);
      }
      const after = (await relayClient(relayUrl).listDirectory()) as DirectoryEntry[];
      const still = after.find((e) => e.providerId === provider.providerId);
      assert(still && JSON.stringify(still) === JSON.stringify(honest), 'the honest entry changed');
      assert(after.length === before.length, 'the directory gained or lost an entry');
      // The engine checks every entry again on read.
      const listed = await buyer.providers();
      assert(listed.every((p) => p.verified), 'the buyer lists an unverified entry');
      ev(`attacker's own signed entry with the victim's providerId and updatedAt +7 days → ${statuses[0]}`);
      ev(`attacker's own signed entry with the victim's providerId and a plausible updatedAt → ${statuses[1]}`);
      ev(`victim's entry with a changed price, updatedAt = MAX_SAFE_INTEGER and a garbage signature → ${statuses[2]}`);
      ev(`victim's entry re-dated 60 s later without re-signing → ${statuses[3]}`);
      ev(`GET /directory still lists the honest entry byte for byte (${after.length} entries); the buyer re-verifies signatures on read`);
    });

    // ------------------------------------------------------------------ 5. lying provider
    await check(5, "Lying provider can't pull payments early (buyer-clock settlement)", async (ev) => {
      const evil = rememberSigner('evil provider identity');
      const wallet = network.wallet('evil', { fundZats: 100_000_000n });
      const evilId = hex(evil.signer.publicKey);
      await relayClient(relayUrl).publishDirectory(
        signDirectoryEntry(
          {
            v: 1,
            providerId: evilId,
            alias: 'evil-eel-1',
            address: toOrchardOnly(await wallet.address(), 'memory'),
            gpus: [{ model: 'cpu', count: 1, vramGb: 0 }],
            minPricePerHourZats: '36000000',
            updatedAt: nowS(),
          },
          evil.signer,
        ),
      );
      const seen = new Set<string>();
      const next = async (pred: (d: DecodedMemo) => boolean): Promise<{ note: ReceivedNote; d: DecodedMemo }> => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          for (const n of await wallet.poll(0)) {
            const key = `${n.txid}:${n.index}`;
            if (seen.has(key)) continue;
            const d = decodeMemo(n.memo);
            if (d && pred(d)) {
              seen.add(key);
              return { note: n, d };
            }
          }
          await sleep(20);
        }
        throw new Error('evil provider: timed out waiting for a memo');
      };
      const intervals = 10;
      const { rfqId: id } = await buyer.createRfq({
        gpu: 'cpu',
        count: 1,
        durationS: intervals,
        maxPricePerHourZats: '72000000',
        job: { path: TINY_TRAIN, command: JOB_COMMAND },
        providerIds: [evilId],
        autoAccept: { rule: 'cheapest', waitBlocks: 0 },
      });
      const rfq = (await next((d) => d.msg.t === 'RFQ')).d.msg as Rfq;
      const eph = generateX25519();
      secrets.push({ label: 'evil provider channel secret', bytes: eph.secretKey });
      const evilPayTo = await wallet.newAddress();
      const bid: Bid = { t: 'BID', rfqId: rfq.rfqId, providerId: evil.signer.publicKey, pricePerIntervalZats: perInterval(36_000_000n, 1), intervalS: 1, startWithinS: 5, providerEph: eph.publicKey, payTo: evilPayTo };
      await sendRetry(wallet, [{ to: rfq.replyTo, zats: 1n, memo: encodeMemo(bid, evil.signer, 'binary') }]);
      await next((d) => d.msg.t === 'ACCEPT');
      const ch = deriveChannel(eph.secretKey, rfq.buyerEph, rfq.rfqId);
      secrets.push({ label: 'evil provider channel key', bytes: ch.key });
      const relay = relayClient(relayUrl);
      let hbSeq = 0;
      const heartbeat = (status: Heartbeat['status'], servingSeq: number) => {
        hbSeq += 1;
        const hb: Heartbeat = { rfqId: rfq.rfqId, seq: hbSeq, ts: Date.now(), step: hbSeq * 100, checkpointDigest: new Uint8Array(32), status, servingSeq };
        return relay.append(ch.mailboxes.heartbeat, ch.seal('heartbeat', encodeHeartbeat(hb, evil.signer)));
      };
      const I = 1000;
      const lead = payLeadFor(PROFILE, 1) * 1000;
      let stop = false;
      let claimedNineAt = 0;
      const flood = (async () => {
        for (let i = 1; !stop; i++) {
          await heartbeat('running', Math.min(i, intervals - 1));
          if (i === intervals - 1) claimedNineAt = Date.now();
          await sleep(20);
        }
      })();
      const start = Date.now();
      let samples = 0;
      let maxPaid = 0;
      let paidWhenClaimedNine = -1;
      const violations: string[] = [];
      while (Date.now() - start < 3500) {
        const rec: BuyerRfq = buyer.record(id)!;
        const paid = rec.payments.length;
        const now = Date.now();
        const bound = rec.jobStart === undefined ? 1 : 1 + Math.max(0, Math.floor((now - rec.jobStart + lead) / I));
        if (paid > bound) violations.push(`paid ${paid} intervals at t = ${now - (rec.jobStart ?? now)} ms after jobStart (bound ${bound})`);
        if (claimedNineAt && paidWhenClaimedNine < 0) paidWhenClaimedNine = paid;
        maxPaid = Math.max(maxPaid, paid);
        samples++;
        await sleep(10);
      }
      stop = true;
      await flood;
      const rec = buyer.record(id)!;
      assert(violations.length === 0, violations.slice(0, 3).join('; '));
      assert(samples > 100, `only ${samples} samples`);
      assert(rec.jobStart !== undefined && rec.jobStart >= rec.accepted!.at, 'jobStart precedes the ACCEPT');
      const offsets = rec.payments.filter((p) => p.seq > 0).map((p) => p.at - (rec.jobStart! + p.seq * I - lead));
      for (const o of offsets) assert(o >= 0, `a PAY went out ${-o} ms before its window opened`);
      assert(rec.payments.length <= 5, `${rec.payments.length} intervals paid in 3.5 s`);
      assert(rec.payments.length >= 3, `only ${rec.payments.length} intervals paid in 3.5 s (the buyer should keep paying an apparently alive provider on schedule)`);
      await buyer.stop(id).catch(() => undefined);
      ev(`evil provider signed ${hbSeq} heartbeats in 3.5 s, claiming interval ${intervals - 1} of ${intervals} served ${claimedNineAt - rec.jobStart!} ms after the job start; the buyer had paid ${paidWhenClaimedNine} interval(s) by then`);
      ev(`${samples} samples: intervals paid ≤ 1 + floor((t − jobStart + ${lead} ms) / ${I} ms) at every one; ${rec.payments.length} paid by 3.5 s (the honest schedule), never ahead of the buyer's clock`);
      ev(`each PAY left ${offsets.map((o) => `${o}`).join(' / ')} ms after its window opened (windows open ${lead} ms before each interval, send time randomised inside)`);
      ev(`worst case at risk: ${maxExposureIntervals(PROFILE, 1)} intervals (THREAT_MODEL: ≤ 1.25; 1.2 on testnet with 5-minute intervals)`);
    });

    // ------------------------------------------------------------------ 6. buyer stops paying
    await check(6, 'Buyer stops paying → provider pauses, then stops within grace, no unpaid work', async (ev) => {
      // Pinned to the first provider (its daemon is the one polled below); a second provider has been in the directory since check 3.
      const created2 = await api<{ rfqId: string }>(buyerUrl, 'POST', '/api/rfqs', requestFor({ SILICR_STEPS: '100000', SILICR_STEP_DELAY_MS: '20' }, { providerIds: [provider.providerId] }));
      assert(created2.status === 201, `POST /api/rfqs answered ${created2.status}`);
      const id = created2.body.rfqId;
      const rfqVia = async () => (await api<RfqDto>(buyerUrl, 'GET', `/api/rfqs/${id}`)).body;
      const jobVia = async () => (await api<ProviderJobDto>(providerUrl, 'GET', `/api/jobs/${id}`)).body;
      /** What both sides say about this job, for a timeout message a reader can act on. */
      const describe = async (): Promise<string> => {
        const j = await jobVia().catch(() => null);
        const r = await rfqVia().catch(() => null);
        const events = provider.listLeaks({ rfqId: id }).filter((o) => /watchdog|fault|memo-rejected|job-started|tx-broadcast/.test(o.event)).slice(-6).map((o) => o.summary);
        return `provider job: ${j ? `${j.state}${j.stopReason ? ` (${j.stopReason})` : ''}, serving ${j.servingSeq}, paid ${j.paymentsReceived.map((p) => p.seq).join(',')}, watchdog ${JSON.stringify(j.watchdog ?? null)}${j.error ? `, error "${j.error}"` : ''}` : '?'}; buyer rfq: ${r ? `${r.state}${r.closeReason ? ` (${r.closeReason})` : ''}, paid ${r.payments.map((p) => p.seq).join(',')}, last heartbeat ${r.heartbeats[0] ? `${r.heartbeats[0].status} seq ${r.heartbeats[0].seq} serving ${r.heartbeats[0].servingSeq}` : 'none'}${r.error ? `, error "${r.error}"` : ''}` : '?'}; provider events: ${events.join(' | ')}`;
      };
      const waitState = async (want: ProviderJobDto['state'], what: string, timeoutMs: number) => {
        try {
          await waitFor(async () => (await jobVia()).state === want, what, timeoutMs, 10);
        } catch (e) {
          throw new Error(`${e instanceof Error ? e.message : String(e)} — ${await describe()}`);
        }
      };
      await waitFor(async () => (await rfqVia()).payments.some((p) => p.seq === 1), 'PAY 1', 40_000, 25);
      const fault = await api<RfqDto & { paymentsWithheld: boolean }>(buyerUrl, 'POST', `/api/rfqs/${id}/fault`, { fault: 'stop_paying' });
      assert(fault.status === 200 && fault.body.paymentsWithheld === true, `fault endpoint answered ${fault.status}`);
      const faultAt = Date.now();
      await waitState('paused', 'the provider to pause', 15_000);
      const pausedAt = Date.now();
      const stepAtPause = (await rfqVia()).heartbeats[0]?.step ?? 0;
      const pausedJob = await jobVia();
      await waitState('stopped', 'the provider to stop', 15_000);
      const stoppedAt = Date.now();
      const job = await jobVia();
      const graceMs = PROFILE.graceS * 1000;
      assert(job.stopReason === 'unpaid', `stop reason ${job.stopReason}`);
      assert(stoppedAt - pausedAt >= graceMs - 300 && stoppedAt - pausedAt < graceMs + 1500, `stopped ${stoppedAt - pausedAt} ms after pausing (grace ${graceMs} ms)`);
      const paidSeqs = job.paymentsReceived.map((p) => p.seq);
      const highestPaid = Math.max(...paidSeqs);
      assert(job.servingSeq === highestPaid, `served interval ${job.servingSeq} but the highest paid interval is ${highestPaid}`);
      await waitFor(async () => (await rfqVia()).state === 'closed', 'the buyer to close', 15_000, 25);
      const r = await rfqVia();
      assert(r.closeReason === 'unpaid', `buyer closed with ${r.closeReason}`);
      const pausedHbs = r.heartbeats.filter((h) => h.status === 'paused');
      assert(pausedHbs.length > 0, 'no paused heartbeats reached the buyer');
      for (const h of pausedHbs) assert(h.step <= stepAtPause + 60, `the job advanced to step ${h.step} while unpaid (was ${stepAtPause} at the pause)`);
      for (const p of job.paymentsReceived) publicHex.add(p.txid);
      ev(`POST /api/rfqs/${short(id)}/fault {stop_paying} after PAY 1; provider paused ${pausedAt - faultAt} ms later at the first unpaid boundary (watchdog: ${pausedJob.watchdog?.state}, paid through interval ${pausedJob.watchdog?.paidThroughSeq})`);
      ev(`stopped ${stoppedAt - pausedAt} ms after pausing (grace ${graceMs} ms) with CLOSE(unpaid); intervals paid ${paidSeqs.join(',')} = intervals served 0..${job.servingSeq}`);
      ev(`${pausedHbs.length} signed "paused" heartbeats show the job frozen at step ≈ ${stepAtPause} (SIGSTOP on the process group); the buyer closed with reason "${r.closeReason}" and received no result`);
    });

    // ------------------------------------------------------------------ 7. forged bids
    await check(7, 'Forged, overpriced and unasked bids ignored', async (ev) => {
      const { rfqId: id } = await buyer.createRfq(requestFor({}, { durationS: 60, providerIds: [provider.providerId], autoAccept: null }));
      await waitFor(() => buyer.getRfq(id).bids.length === 1, 'the honest bid', 15_000);
      const rec = buyer.record(id)!;
      const mallory = network.wallet('mallory', { fundZats: 100_000_000n });
      const malloryAddr = await mallory.address();
      const base: Bid = {
        t: 'BID',
        rfqId: unhex(id),
        providerId: unhex(provider.providerId),
        pricePerIntervalZats: 1n,
        intervalS: 1,
        startWithinS: 1,
        providerEph: generateX25519().publicKey,
        payTo: malloryAddr,
      };
      const providerKey = signerFromSecret(new Uint8Array(await readFile(join(root, 'provider', 'identity.key'))));
      const impostor = rememberSigner('impostor');
      const stranger = rememberSigner('stranger');
      // 1) claims to be the provider but is signed by another key
      publicHex.add(await sendMemo(mallory, rec.replyTo, base, impostor.signer));
      // 2) really signed by the provider's directory key, but priced above the buyer's max
      publicHex.add(await sendMemo(mallory, rec.replyTo, { ...base, pricePerIntervalZats: 1_000_000_000n }, providerKey));
      // 3) validly self-signed by a provider nobody asked
      publicHex.add(await sendMemo(mallory, rec.replyTo, { ...base, providerId: stranger.signer.publicKey }, stranger.signer));
      await waitFor(() => buyer.getRfq(id).rejectedBids === 3, 'three rejections', 10_000);
      const r = buyer.getRfq(id);
      assert(r.bids.length === 1 && r.bids[0]!.providerId === provider.providerId, 'the bid list changed');
      assert(buyer.record(id)!.bids.every((b) => b.payTo !== malloryAddr), "mallory's pay-to address got in");
      const reasons = buyer.listLeaks({ rfqId: id }).filter((o) => o.event === 'bid-rejected').map((o) => o.summary);
      assert(reasons.some((s) => /signature/.test(s)) && reasons.some((s) => /above the max/.test(s)) && reasons.some((s) => /not asked/.test(s)), `reasons: ${reasons.join(' | ')}`);
      const accepted = await buyer.accept(id, hex(stranger.signer.publicKey)).then(() => null, (e: Error) => e.message);
      assert(accepted && /no valid bid/.test(accepted), `accepting the stranger: ${accepted}`);
      await buyer.stop(id);
      for (const s of reasons) ev(s);
      ev(`bid list unchanged: 1 bid, from ${r.bids[0]!.alias}; rejectedBids = ${r.rejectedBids}; accepting the stranger fails: "${accepted}"`);
    });

    // ------------------------------------------------------------------ 9. daemon hardening
    await check(9, 'Daemon hardening: foreign Origin 403, foreign Host 403, non-JSON POST 415, loopback only', async (ev) => {
      for (const [name, url] of [['buyer', buyerUrl], ['provider', providerUrl]] as const) {
        const evil = await api<ErrorDto>(url, 'GET', '/api/status', undefined, { Origin: 'https://evil.example' });
        assert(evil.status === 403 && evil.headers.get('access-control-allow-origin') === null, `${name}: Origin evil.example → ${evil.status}`);
        const neighbour = await api<ErrorDto>(url, 'GET', '/api/status', undefined, { Origin: 'http://localhost:3000' });
        assert(neighbour.status === 403, `${name}: Origin localhost:3000 → ${neighbour.status}`);
        const host = await statusWithHost(`${url}/api/status`, 'attacker.example:7701');
        assert(host === 403, `${name}: Host attacker.example → ${host}`);
        const path = name === 'buyer' ? '/api/rfqs' : '/api/policy';
        const text = await api<ErrorDto>(url, name === 'buyer' ? 'POST' : 'PUT', path, 'x=1', { 'Content-Type': 'text/plain' });
        assert(text.status === 415, `${name}: text/plain body → ${text.status}`);
        const ok = await api<unknown>(url, 'GET', '/api/status', undefined, { Origin: WEB_ORIGIN });
        assert(ok.status === 200 && ok.headers.get('access-control-allow-origin') === WEB_ORIGIN, `${name}: the web terminal origin → ${ok.status}`);
        ev(`${name} daemon: Origin https://evil.example → ${evil.status}, Origin http://localhost:3000 → ${neighbour.status}, Host attacker.example → ${host}, text/plain body → ${text.status}; Origin ${WEB_ORIGIN} → ${ok.status} with CORS`);
      }
      const bind = await startDaemon({ node: buyer, port: 0, host: '0.0.0.0' }).then(() => null, (e: Error) => e.message);
      assert(bind && /loopback/.test(bind), `binding to 0.0.0.0: ${bind}`);
      ev(`startDaemon(host 0.0.0.0) refused: "${bind}"`);
    });

    // ------------------------------------------------------------------ 10. job path guard
    await check(10, 'Job-path guard: $HOME, key directories and wallet data are refused (code "privacy")', async (ev) => {
      const rfqsBefore = buyer.listRfqs().length;
      const txsBefore = network.explorer().length;
      const tryPath = async (path: string) => {
        const r = await api<ErrorDto>(buyerUrl, 'POST', '/api/rfqs', requestFor({}, { job: { path, command: JOB_COMMAND } }));
        assert(r.status === 400 && r.body.code === 'privacy', `job.path ${path} → ${r.status} ${JSON.stringify(r.body)}`);
        return r.body.error.replace(/^refusing to send \S+ to a provider: /, '');
      };
      ev(`job.path = $HOME → 400 privacy: "${await tryPath(homedir())}"`);
      const ssh = join(homedir(), '.ssh');
      if (existsSync(ssh)) ev(`job.path = ~/.ssh → 400 privacy: "${await tryPath(ssh)}"`);
      else ev('job.path = ~/.ssh: skipped, ~/.ssh does not exist here (covered below with a fake home)');
      const withWallet = join(root, 'job-with-wallet');
      await mkdir(join(withWallet, '.silicr', 'wallets'), { recursive: true });
      await writeFile(join(withWallet, 'train.py'), 'print(1)\n');
      ev(`job.path = a project containing .silicr/ → 400 privacy: "${await tryPath(withWallet)}"`);
      // The same function with a fake home, so the rest is checked on every machine.
      const home = join(root, 'fake-home');
      for (const d of ['.ssh/keys', '.gnupg', '.aws', '.config/gcloud', 'work/job', 'seedy']) await mkdir(join(home, d), { recursive: true });
      await writeFile(join(home, 'seedy', 'master.seed'), new Uint8Array(32));
      await writeFile(join(home, 'work', 'job', 'train.py'), 'print(1)\n');
      await symlink(join(home, '.aws'), join(home, 'innocent'));
      const refusal = async (p: string, re: RegExp) => {
        const e = await checkJobPath(p, home).then(() => null, (x: unknown) => x);
        assert(e instanceof EngineError && e.code === 'privacy' && re.test(e.message), `${p}: ${e instanceof Error ? e.message : 'accepted'}`);
        return e.message.replace(/^refusing to send \S+ to a provider: /, '');
      };
      const lines = [
        `~/.ssh/keys: "${await refusal(join(home, '.ssh', 'keys'), /inside ~\/\.ssh/)}"`,
        `~/.gnupg: "${await refusal(join(home, '.gnupg'), /inside ~\/\.gnupg/)}"`,
        `~/.config (contains gcloud): "${await refusal(join(home, '.config'), /contains ~\/\.config\/gcloud/)}"`,
        `a dir holding master.seed: "${await refusal(join(home, 'seedy'), /master\.seed/)}"`,
        `a symlink to ~/.aws: "${await refusal(join(home, 'innocent'), /inside ~\/\.aws/)}"`,
      ];
      ev(`checkJobPath() with a fake $HOME: ${lines.join('; ')}`);
      assert((await checkJobPath(join(home, 'work', 'job'), home)).endsWith(join('work', 'job')), 'an ordinary job dir was refused');
      assert(buyer.listRfqs().length === rfqsBefore && network.explorer().length === txsBefore, 'a refused request still created an RFQ or a transaction');
      ev(`an ordinary job directory is accepted; the refused requests created no RFQ and no transaction (${rfqsBefore} RFQs, ${txsBefore} transactions before and after)`);
    });

    // ------------------------------------------------------------------ 11. shielded-only guard
    await check(11, 'Shielded-only guard: transparent, Sapling and wrong-network recipients refused', async (ev) => {
      const refusal = (addr: string, re: RegExp) => {
        const e = ((): unknown => {
          try {
            toOrchardOnly(addr, 'memory');
            return null;
          } catch (x) {
            return x;
          }
        })();
        assert(e instanceof PrivacyError && re.test(e.message), `${short(addr, 16)}: ${e instanceof Error ? e.message : 'accepted'}`);
        return e.message;
      };
      ev(`transparent tm…: "${refusal(TRANSPARENT_TESTNET, /^Refusing transparent address \(tm…\)/)}"`);
      ev(`Sapling ztestsapling1…: "${refusal(SAPLING_TESTNET, /^Refusing Sapling address/)}"`);
      ev(`mainnet u1… on the simulated chain: "${refusal(randomOrchardAddress('main'), /^Refusing mainnet address/)}"`);
      const orchard = decodeUnifiedAddress(randomOrchardAddress('memory')).receivers[0]!;
      const multi = encodeUnifiedAddress('regtest', [
        { typecode: 0, kind: 'p2pkh', data: new Uint8Array(20).fill(0x42) },
        { typecode: 2, kind: 'sapling', data: new Uint8Array(43).fill(1) },
        orchard,
      ]);
      const stripped = decodeUnifiedAddress(toOrchardOnly(multi, 'memory'));
      assert(stripped.receivers.length === 1 && stripped.receivers[0]!.typecode === 3, 'the guard did not strip the non-Orchard receivers');
      ev(`a UA with transparent + Sapling + Orchard receivers is reduced to its Orchard receiver before any send (${short(multi, 20)} → ${short(toOrchardOnly(multi, 'memory'), 20)})`);
      // The backend refuses on its own too (defence in depth), and a refused send leaves no trace on the chain.
      const probe = network.wallet('guard-probe', { fundZats: 10_000_000n });
      const txsBefore = network.explorer().length;
      const memo = new Uint8Array(512);
      memo[0] = 0xf6;
      const sendErr = await probe.send([{ to: TRANSPARENT_TESTNET, zats: 1000n, memo }]).then(() => null, (e: unknown) => e);
      assert(sendErr instanceof PrivacyError && network.explorer().length === txsBefore, 'the backend accepted a transparent recipient');
      ev(`the wallet backend's send() refuses the same address with PrivacyError and records nothing (${txsBefore} transactions before and after)`);
      // A provider cannot even list a Sapling address in the directory.
      const sap = rememberSigner('sapling-address provider');
      const entry = signDirectoryEntry(
        { v: 1, providerId: hex(sap.signer.publicKey), alias: 'sapling-seller', address: SAPLING_TESTNET, gpus: [{ model: 'cpu', count: 1, vramGb: 0 }], minPricePerHourZats: '1', updatedAt: nowS() },
        sap.signer,
      );
      const r = await api<ErrorDto>(relayUrl, 'POST', '/directory', entry);
      assert(r.status === 400, `the relay accepted a directory entry with a Sapling address: ${r.status}`);
      ev(`a correctly signed directory entry whose address is Sapling → relay ${r.status} ${r.body.code} (addresses must be unified addresses; clients then reduce them to the Orchard receiver)`);
      ev(`not exercised here: the Rust sidecar repeats the check on the proposal and on the built transaction (zec-sidecar/src/wallet.rs check_proposal / check_built_tx; cargo test)`);
    });

    // ------------------------------------------------------------------ 8. secrets (last: it scans everything above)
    await check(8, 'Secrets never printed or sent to the relay; secrets at rest are owner-only', async (ev) => {
      const masterSeed = new Uint8Array(await readFile(join(root, 'buyer', 'master.seed')));
      const identity = new Uint8Array(await readFile(join(root, 'provider', 'identity.key')));
      const identity2 = new Uint8Array(await readFile(join(root, 'provider2', 'identity.key')));
      assert(masterSeed.length === 32 && identity.length === 32 && identity2.length === 32, 'seed or identity files are not 32 bytes');
      secrets.push({ label: 'buyer master.seed', bytes: masterSeed }, { label: 'provider identity.key', bytes: identity }, { label: 'provider2 identity.key', bytes: identity2 });
      // The provider's per-job channel secrets live only in its own state file; derive the channel keys from them.
      const providerState = JSON.parse(await readFile(join(root, 'provider', 'provider-state.json'), 'utf8')) as { jobs: { rfqId: string; bid: { ephSecret: string }; rfq: { buyerEph: string } }[] };
      for (const j of providerState.jobs) {
        secrets.push({ label: `provider channel secret for ${short(j.rfqId)}`, bytes: unhex(j.bid.ephSecret) });
        secrets.push({ label: `channel key for ${short(j.rfqId)}`, bytes: deriveChannel(unhex(j.bid.ephSecret), unhex(j.rfq.buyerEph), unhex(j.rfqId)).key });
      }
      const needles: Needle[] = secrets.flatMap((s) => [
        { label: `${s.label} (hex)`, value: hex(s.bytes) },
        { label: `${s.label} (base64)`, value: Buffer.from(s.bytes).toString('base64') },
        { label: `${s.label} (raw bytes)`, value: s.bytes },
      ]);
      const outputText = Buffer.from(captured.join(''));
      const logText = Buffer.from(nodeLogs.join('\n'));
      const relayFiles = await readTree(join(root, 'relay'));
      const feed = Buffer.from(await (await fetch(`${relayUrl}/_observer?limit=5000`)).text());
      const hits: string[] = [];
      for (const n of needles) {
        if (contains(outputText, n)) hits.push(`${n.label} in this script's output`);
        if (contains(logText, n)) hits.push(`${n.label} in the node logs`);
        if (contains(feed, n)) hits.push(`${n.label} in the observer feed`);
        for (const f of relayFiles) if (contains(f.data, n)) hits.push(`${n.label} in relay file ${f.path.slice(root.length + 1)}`);
      }
      assert(hits.length === 0, hits.join('; '));
      // Every 64-hex word printed anywhere must be a transaction id or a public key.
      const words = new Set([...`${captured.join('')}\n${nodeLogs.join('\n')}`.matchAll(/\b[0-9a-f]{64}\b/g)].map((m) => m[0]));
      const unexplained = [...words].filter((w) => !publicHex.has(w));
      assert(unexplained.length === 0, `64-hex strings in the output that are neither txids nor public keys: ${unexplained.map((w) => short(w, 16)).join(', ')}`);
      const modes = {
        'buyer/master.seed': await mode(join(root, 'buyer', 'master.seed')),
        'provider/identity.key': await mode(join(root, 'provider', 'identity.key')),
        'buyer/buyer-state.json': await mode(join(root, 'buyer', 'buyer-state.json')),
        'provider/provider-state.json': await mode(join(root, 'provider', 'provider-state.json')),
        'buyer/': await mode(join(root, 'buyer')),
        'provider/': await mode(join(root, 'provider')),
      };
      for (const [p, m] of Object.entries(modes)) assert(m === (p.endsWith('/') ? '0700' : '0600'), `${p} has mode ${m}`);
      ev(`${secrets.length} secrets (seeds, identity keys, X25519 channel secrets, derived channel keys) searched as hex, base64 and raw bytes`);
      ev(`not found in ${kb(outputText.length)} of this script's stdout/stderr, ${nodeLogs.length} node log lines, the observer feed or ${relayFiles.length} relay files (${kb(relayFiles.reduce((n, f) => n + f.data.length, 0))})`);
      ev(`${words.size} distinct 64-hex string${words.size === 1 ? ' was' : 's were'} printed; every one is a transaction id or a public key`);
      ev(`at rest: ${Object.entries(modes).map(([p, m]) => `${p} ${m}`).join(', ')}`);
    });
  } finally {
    await cleanup();
  }
  if (process.env.SILICR_VERIFY_DEBUG) out(`debug: active resources after cleanup: ${JSON.stringify(process.getActiveResourcesInfo())}`);

  // ------------------------------------------------------------------ summary
  const failed = results.filter((r) => !r.ok);
  out('Summary');
  out('-------');
  for (const r of [...results].sort((a, b) => a.num - b.num)) out(`${r.ok ? '✓' : '✗'} ${String(r.num).padStart(2)}  ${r.name}${r.ok ? '' : `  (${r.error ?? 'failed'})`}`);
  out();
  out(`${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  out();
  return failed.length === 0 ? 0 : 1;
}

const watchdog = setTimeout(() => {
  out(`\nFAIL: the verification did not finish within ${TOTAL_TIMEOUT_MS / 1000} s`);
  process.exit(2);
}, TOTAL_TIMEOUT_MS);

/**
 * Exit explicitly once stdout has drained: a finished job leaves a 30 s timer behind in the engine
 * (the `sleep(30_000)` side of finishJob's Promise.race in packages/engine/src/provider.ts), which
 * would otherwise keep this process alive for half a minute after the summary.
 */
function exitAfterFlush(code: number): void {
  clearTimeout(watchdog);
  process.stdout.write('', () => process.exit(code));
}

main()
  .then((code) => exitAfterFlush(code))
  .catch((e: unknown) => {
    out(`\nFAIL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    exitAfterFlush(1);
  });
