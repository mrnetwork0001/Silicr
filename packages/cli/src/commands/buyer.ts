// Buyer commands; they all talk to the local buyer daemon.
import { stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { MigrateRequest, NewRfqRequest, RfqDto, StatusDto } from '@silicr/api';
import { parseZec } from '@silicr/engine';
import { ApiError, DaemonClient, DEFAULT_URLS } from '../client.ts';
import { confirmMainnet } from '../confirm.ts';
import { follow, printBids } from '../follow.ts';
import { duration, fail, kv, pc, short, table, zec } from '../format.ts';

export function buyerClient(url?: string): DaemonClient {
  return new DaemonClient(url ?? process.env.SILICR_BUYER_URL ?? DEFAULT_URLS.buyer);
}

async function ensureBuyer(c: DaemonClient): Promise<StatusDto> {
  let s: StatusDto;
  try {
    s = await c.get<StatusDto>('/api/status');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unreachable') {
      fail(`no buyer daemon at ${c.base}. Start one with \`silicr daemon --role buyer --data <dir>\`, or run \`silicr demo\`.`);
    }
    throw e;
  }
  if (s.role !== 'buyer') fail(`${c.base} is a ${s.role} daemon, not a buyer`);
  return s;
}

export interface RunOptions {
  gpu: string;
  count: string;
  hours: string;
  max: string;
  /** Put the max in the RFQ memo (default: keep it private, 0 on the wire). */
  discloseMax?: boolean;
  auto?: boolean;
  waitBlocks: string;
  image?: string;
  env?: string[];
  providers?: string;
  daemon?: string;
  out?: string;
  follow?: boolean;
  /** Mainnet: skip the interactive go-ahead (required off a terminal). */
  yes?: boolean;
}

/** `silicr run … <dir|file.py> -- <command…>` */
export async function run(target: string, command: string[], o: RunOptions): Promise<void> {
  const c = buyerClient(o.daemon);
  const s = await ensureBuyer(c);
  const abs = resolve(target);
  const st = await stat(abs).catch(() => null);
  if (!st) fail(`${target} does not exist`);
  let dir = abs;
  let cmd = command;
  if (st.isFile()) {
    dir = dirname(abs);
    if (cmd.length === 0) {
      const name = basename(abs);
      if (name.endsWith('.py')) cmd = ['python3', name];
      else if (name.endsWith('.sh')) cmd = ['sh', name];
      else fail(`give the command to run after --, e.g. silicr run ... ${target} -- ./${name}`);
    }
  } else if (cmd.length === 0) {
    if (existsSync(join(abs, 'train.py'))) cmd = ['python3', 'train.py'];
    else fail('give the command to run after --, e.g. silicr run ... ./job -- python3 train.py');
  }
  let max: bigint;
  try {
    max = parseZec(o.max);
  } catch (e) {
    fail(`--max: ${(e as Error).message}`);
  }
  const hours = Number(o.hours);
  if (!Number.isFinite(hours) || hours <= 0) fail('--hours must be a positive number');
  const count = Number(o.count);
  const env: Record<string, string> = {};
  for (const kvp of o.env ?? []) {
    const i = kvp.indexOf('=');
    if (i <= 0) fail(`--env expects NAME=value, got ${kvp}`);
    env[kvp.slice(0, i)] = kvp.slice(i + 1);
  }
  const job = { path: dir, command: cmd, ...(o.image ? { image: o.image } : {}), ...(Object.keys(env).length ? { env } : {}) } as NewRfqRequest['job'];
  const req: NewRfqRequest = {
    gpu: o.gpu.toLowerCase(),
    count,
    durationS: Math.max(1, Math.round(hours * 3600)),
    maxPricePerHourZats: max.toString(),
    discloseMax: !!o.discloseMax,
    job,
    autoAccept: o.auto ? { rule: 'cheapest', waitBlocks: Number(o.waitBlocks) } : null,
  };
  if (o.providers) req.providerIds = o.providers.split(',').map((x) => x.trim()).filter(Boolean);
  // Mainnet: say what this could cost and get a go-ahead (or --yes) before anything is sent.
  const worst = (max * BigInt(req.durationS) + 3599n) / 3600n;
  await confirmMainnet(s, `This commits up to ${zec(worst)} of real funds (${zec(max)}/h for ${duration(req.durationS)}) plus ~0.0001 ZEC per transaction in fees`, o.yes);
  let rfqId: string;
  try {
    ({ rfqId } = await c.post<{ rfqId: string }>('/api/rfqs', req));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'spend_cap') {
      fail(`${e.message}\n  Lower --hours or --max, or raise the caps (silicr init --cap-per-request / --cap-total, or the same flags on silicr daemon) if you mean it.`);
    }
    if (e instanceof ApiError && e.code === 'insufficient_funds') {
      const st = await c.get<StatusDto>('/api/status').catch(() => null);
      fail(`${e.message}.${st ? `\n  Send shielded (Orchard-receiver) ZEC to ${st.address}` : ''}`);
    }
    fail(e instanceof ApiError ? `${e.message}${e.code === 'privacy' ? ' (privacy guard)' : ''}` : (e as Error).message);
  }
  console.log(
    `\n  RFQ ${pc.bold(short(rfqId, 12))}: ${count}× ${req.gpu} for ${duration(req.durationS)} at ≤ ${zec(max)}/h, job ${pc.dim(cmd.join(' '))} in ${dir}\n` +
      `  ${req.discloseMax ? pc.yellow('budget disclosed to providers (--disclose-max)') : pc.green('budget undisclosed to providers')}: ` +
      `${req.discloseMax ? 'the RFQ memo carries the max' : 'the RFQ memo carries 0; bids above your max are dropped locally'}\n`,
  );
  if (o.follow === false) {
    console.log(`  Follow it with: silicr bids ${short(rfqId, 12)}`);
    return;
  }
  const final = await follow({ buyer: c, rfqId, untilBidWindow: !o.auto });
  if (!o.auto && final.state === 'collecting') {
    console.log(`\n  Bid window closed. Bids, cheapest first:\n`);
    printBids(final.bids);
    if (final.bids.length) console.log(`\n  Accept one with: ${pc.bold(`silicr accept ${rfqId.slice(0, 12)} ${final.bids[0]!.alias}`)}\n`);
    return;
  }
  await afterClose(c, final, o.out);
}

async function afterClose(c: DaemonClient, r: RfqDto, out?: string): Promise<void> {
  if (r.state === 'closed' && r.result && out) {
    const bytes = await c.bytes(`/api/rfqs/${r.rfqId}/result`);
    await writeFile(resolve(out), bytes);
    console.log(`\n  result saved to ${pc.bold(resolve(out))}`);
  } else if (r.state === 'closed' && r.result) {
    console.log(`\n  download the result with: silicr result ${r.rfqId.slice(0, 12)} -o result.tar.gz`);
  }
  if (r.state !== 'closed') process.exitCode = 1;
}

export async function rfqs(o: { daemon?: string }): Promise<void> {
  const c = buyerClient(o.daemon);
  await ensureBuyer(c);
  const all = await c.get<RfqDto[]>('/api/rfqs');
  if (all.length === 0) {
    console.log('  no RFQs yet');
    return;
  }
  table(
    ['rfq', 'state', 'request', 'bids', 'provider', 'paid', 'reason'],
    all.map((r) => [
      short(r.rfqId, 12),
      r.state,
      `${r.request.count}× ${r.request.gpu}, ${duration(r.request.durationS)}, ≤ ${zec(r.request.maxPricePerHourZats)}/h${r.discloseMax === false ? ' (private)' : ''}`,
      String(r.bids.length),
      r.accepted?.alias ?? '-',
      zec(r.spentZats),
      r.closeReason ?? r.error ?? '',
    ]),
  );
}

export async function bids(id: string, o: { daemon?: string }): Promise<void> {
  const c = buyerClient(o.daemon);
  await ensureBuyer(c);
  const rfqId = await c.resolveRfq(id).catch((e: Error) => fail(e.message));
  const r = await c.get<RfqDto & { rejectedBids?: number }>(`/api/rfqs/${rfqId}`);
  console.log(`\n  RFQ ${pc.bold(short(rfqId, 12))} · ${r.state} · ${r.providersAsked} provider(s) asked · bids until height ${r.expiresHeight}\n`);
  printBids(r.bids);
  if (r.rejectedBids) console.log(`\n  ${pc.dim(`${r.rejectedBids} bid(s) ignored (bad signature, not asked, above ${r.discloseMax === false ? 'your private max' : 'max'} or late)`)}`);
  console.log();
}

export async function accept(id: string, providerArg: string, o: { daemon?: string; follow?: boolean; out?: string; yes?: boolean }): Promise<void> {
  const c = buyerClient(o.daemon);
  const s = await ensureBuyer(c);
  const rfqId = await c.resolveRfq(id).catch((e: Error) => fail(e.message));
  const r = await c.get<RfqDto>(`/api/rfqs/${rfqId}`);
  const p = providerArg.toLowerCase();
  const hits = r.bids.filter((b) => b.alias === p || b.providerId.startsWith(p));
  const ids = [...new Set(hits.map((b) => b.providerId))];
  if (ids.length !== 1) fail(ids.length ? `"${providerArg}" matches ${ids.length} bidders` : `no bid from "${providerArg}" on this RFQ`);
  // Mainnet: the ACCEPT pays interval 0 at once; say what the whole deal could cost first.
  const bid = hits.find((b) => b.providerId === ids[0])!;
  const intervals = Math.max(1, Math.ceil(r.request.durationS / bid.intervalS));
  await confirmMainnet(
    s,
    `This pays ${bid.alias} ${zec(bid.pricePerIntervalZats)} now (interval 0) and commits up to ${zec(BigInt(bid.pricePerIntervalZats) * BigInt(intervals))} of real funds in all (${intervals} × ${bid.intervalS} s intervals) plus fees`,
    o.yes,
  );
  let acc: RfqDto;
  try {
    acc = await c.post<RfqDto>(`/api/rfqs/${rfqId}/accept`, { providerId: ids[0] });
  } catch (e) {
    fail((e as Error).message);
  }
  console.log(`\n  accepted ${pc.bold(acc.accepted?.alias ?? providerArg)}; interval #0 paid by the ACCEPT transaction\n`);
  if (o.follow === false) return;
  const final = await follow({ buyer: c, rfqId });
  await afterClose(c, final, o.out);
}

export async function stop(id: string, o: { daemon?: string }): Promise<void> {
  const c = buyerClient(o.daemon);
  await ensureBuyer(c);
  const rfqId = await c.resolveRfq(id).catch((e: Error) => fail(e.message));
  try {
    const r = await c.post<RfqDto>(`/api/rfqs/${rfqId}/stop`);
    console.log(`  ${short(rfqId, 12)} → ${r.state}${r.closeReason ? ` (${r.closeReason})` : ''}; no further payments`);
  } catch (e) {
    fail((e as Error).message);
  }
}

/**
 * `silicr migrate <rfqId> [--providers ids] [--yes]`: a NEW RFQ for the same job, resumed from the
 * latest checkpoint the buyer holds; the old one gets CLOSE(buyer_stop) if it is still open.
 */
export async function migrate(id: string, o: { daemon?: string; providers?: string; follow?: boolean; out?: string; yes?: boolean; waitBlocks?: string }): Promise<void> {
  const c = buyerClient(o.daemon);
  const s = await ensureBuyer(c);
  const rfqId = await c.resolveRfq(id).catch((e: Error) => fail(e.message));
  const old = await c.get<RfqDto>(`/api/rfqs/${rfqId}`);
  if (!old.checkpoint) fail(`${short(rfqId, 12)} has no checkpoint yet: the provider uploads one at the end of every served interval, so there is nothing to resume from`);
  if (old.migratedTo) fail(`${short(rfqId, 12)} was already migrated to ${short(old.migratedTo, 12)}`);
  const req: MigrateRequest = {};
  if (o.providers) req.providerIds = o.providers.split(',').map((x) => x.trim()).filter(Boolean);
  if (o.waitBlocks !== undefined) req.autoAccept = { rule: 'cheapest', waitBlocks: Number(o.waitBlocks) };
  const max = BigInt(old.request.maxPricePerHourZats);
  const worst = (max * BigInt(old.request.durationS) + 3599n) / 3600n;
  await confirmMainnet(s, `This opens a new request that commits up to ${zec(worst)} of real funds (${zec(max)}/h for ${duration(old.request.durationS)}) plus fees, and stops the old one`, o.yes);
  let r: RfqDto;
  try {
    r = await c.post<RfqDto>(`/api/rfqs/${rfqId}/migrate`, req);
  } catch (e) {
    fail(e instanceof ApiError ? `${e.message}${e.code === 'spend_cap' ? '\n  Raise the caps (silicr init --cap-per-request / --cap-total) if you mean it.' : ''}` : (e as Error).message);
  }
  console.log(
    `\n  migrating ${pc.bold(short(rfqId, 12))} → new RFQ ${pc.bold(short(r.rfqId, 12))}: resumes from the checkpoint of interval ${old.checkpoint.seq} (${old.checkpoint.sizeBytes} bytes), cheapest signed bid auto-accepted\n`,
  );
  if (o.follow === false) {
    console.log(`  Follow it with: silicr bids ${short(r.rfqId, 12)}`);
    return;
  }
  const final = await follow({ buyer: c, rfqId: r.rfqId });
  await afterClose(c, final, o.out);
}

export async function result(id: string, o: { daemon?: string; out?: string }): Promise<void> {
  const c = buyerClient(o.daemon);
  await ensureBuyer(c);
  const rfqId = await c.resolveRfq(id).catch((e: Error) => fail(e.message));
  const out = resolve(o.out ?? `silicr-result-${rfqId.slice(0, 8)}.tar.gz`);
  try {
    const bytes = await c.bytes(`/api/rfqs/${rfqId}/result`);
    await writeFile(out, bytes);
    kv([
      ['saved', out],
      ['size', `${bytes.length} bytes`],
    ]);
  } catch (e) {
    fail((e as Error).message);
  }
}

/** Demo fault injection: `silicr fault <rfqId> stop-paying|resume-paying` (buyer) or `stop-heartbeats|resume-heartbeats` (provider). */
export async function fault(id: string, kind: string, o: { daemon?: string; provider?: string }): Promise<void> {
  const k = kind.replace(/-/g, '_');
  if (k === 'stop_paying' || k === 'resume_paying') {
    const c = buyerClient(o.daemon);
    await ensureBuyer(c);
    const rfqId = await c.resolveRfq(id).catch((e: Error) => fail(e.message));
    await c.post(`/api/rfqs/${rfqId}/fault`, { fault: k }).catch((e: Error) => fail(e.message));
    console.log(`  ${short(rfqId, 12)}: buyer ${k === 'stop_paying' ? pc.red('stopped paying') : pc.green('pays again')}${k === 'stop_paying' ? ' (no CLOSE sent: the provider pauses at the next boundary, then stops after its grace period)' : ''}`);
    return;
  }
  if (k === 'stop_heartbeats' || k === 'resume_heartbeats') {
    const c = new DaemonClient(o.provider ?? process.env.SILICR_PROVIDER_URL ?? DEFAULT_URLS.provider);
    const rfqId = /^[0-9a-f]{32}$/.test(id) ? id : await buyerClient(o.daemon).resolveRfq(id).catch((e: Error) => fail(e.message));
    await c.post(`/api/jobs/${rfqId}/fault`, { fault: k }).catch((e: Error) => fail(e.message));
    console.log(`  ${short(rfqId, 12)}: provider ${k === 'stop_heartbeats' ? pc.red('stopped heartbeating') : pc.green('heartbeats again')}${k === 'stop_heartbeats' ? ' (the buyer stops paying and closes with no_heartbeat)' : ''}`);
    return;
  }
  fail('fault must be one of: stop-paying, resume-paying, stop-heartbeats, resume-heartbeats');
}
