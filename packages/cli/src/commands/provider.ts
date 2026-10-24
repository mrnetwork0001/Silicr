// Provider commands; they talk to the local provider daemon.
import type { ProviderJobDto, ProviderPolicyDto, StatusDto } from '@silicr/api';
import { parseZec } from '@silicr/engine';
import { ApiError, DaemonClient, DEFAULT_URLS } from '../client.ts';
import { capLine, MAINNET_TAG } from '../confirm.ts';
import { duration, event, fail, kv, pc, short, table, zec } from '../format.ts';

export function providerClient(url?: string): DaemonClient {
  return new DaemonClient(url ?? process.env.SILICR_PROVIDER_URL ?? DEFAULT_URLS.provider);
}

async function ensureProvider(c: DaemonClient): Promise<StatusDto> {
  let s: StatusDto;
  try {
    s = await c.get<StatusDto>('/api/status');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unreachable') {
      fail(`no provider daemon at ${c.base}. Start one with \`silicr daemon --role provider --data <dir>\`, or run \`silicr demo\`.`);
    }
    throw e;
  }
  if (s.role !== 'provider') fail(`${c.base} is a ${s.role} daemon, not a provider`);
  return s;
}

export interface ProvideOptions {
  gpu: string;
  count: string;
  min: string;
  vram?: string;
  interval?: string;
  grace?: string;
  autoBid?: boolean;
  daemon?: string;
  follow?: boolean;
}

/** `silicr provide --gpu a100 --count 4 --min 0.6`: set the policy and (re)publish the directory entry. */
export async function provide(o: ProvideOptions): Promise<void> {
  const c = providerClient(o.daemon);
  const s0 = await ensureProvider(c);
  if (s0.network === 'main') {
    console.log(`\n  ${pc.red(MAINNET_TAG)}  each BID and CLOSE costs this wallet ~0.0001 ZEC in fees; earnings arrive shielded (${capLine(s0.spendCap)})`);
  }
  let min: bigint;
  try {
    min = parseZec(o.min);
  } catch (e) {
    fail(`--min: ${(e as Error).message}`);
  }
  const patch: Partial<ProviderPolicyDto> = {
    gpus: [{ model: o.gpu.toLowerCase(), count: Number(o.count), vramGb: Number(o.vram ?? 0) }],
    minPricePerHourZats: min.toString(),
    autoBid: o.autoBid !== false,
  };
  if (o.interval) patch.intervalS = Number(o.interval);
  if (o.grace) patch.graceS = Number(o.grace);
  let pol: ProviderPolicyDto;
  try {
    pol = await c.put<ProviderPolicyDto>('/api/policy', patch);
  } catch (e) {
    fail((e as Error).message);
  }
  const s = (await c.get<StatusDto & { runner?: { sandboxed: boolean; warning?: string } }>('/api/status'));
  console.log(`\n  ${pc.green('directory entry published')} (signed, pseudonymous; nothing about buyers in it)\n`);
  kv([
    ['provider', `${pc.bold(s.alias ?? '?')} ${pc.dim(s.providerId ?? '')}`],
    ['GPUs', pol.gpus.map((g) => `${g.count}× ${g.model}${g.vramGb ? ` (${g.vramGb} GB)` : ''}`).join(', ')],
    ['min price', `${zec(pol.minPricePerHourZats)}/h, billed per ${duration(pol.intervalS)} interval`],
    ['grace', `${pol.graceS} s for a late payment, then the job stops`],
    ['auto-bid', pol.autoBid ? 'on' : 'off'],
    ['RFQ address', s.address],
    ['runner', s.runner?.sandboxed ? pc.green('docker sandbox') : pc.red(s.runner?.warning ?? 'process mode: NOT a sandbox')],
  ]);
  console.log();
  if (o.follow) await watchJobs(c);
}

async function watchJobs(c: DaemonClient): Promise<void> {
  console.log(pc.dim('  watching for RFQs and jobs (Ctrl-C to stop)…\n'));
  const last = new Map<string, string>();
  const ctl = new AbortController();
  process.on('SIGINT', () => {
    ctl.abort();
    process.exit(0);
  });
  await c.events((e) => {
    if (e.type !== 'job.updated') return;
    const j = e.job;
    if (last.get(j.rfqId) === j.state) return;
    last.set(j.rfqId, j.state);
    const tag = j.state === 'paused' ? 'watchdog' : 'provider';
    event(tag, `${short(j.rfqId, 12)} ${pc.bold(j.state)} · ${j.request.count}× ${j.request.gpu} · bid ${zec(j.bid.pricePerIntervalZats)}/${j.bid.intervalS} s · earned ${zec(j.earnedZats)}${j.stopReason ? ` · ${j.stopReason}` : ''}`);
  }, ctl.signal);
}

export async function jobs(o: { daemon?: string; follow?: boolean }): Promise<void> {
  const c = providerClient(o.daemon);
  await ensureProvider(c);
  const all = await c.get<ProviderJobDto[]>('/api/jobs');
  if (all.length === 0) console.log('  no jobs yet');
  else
    table(
      ['rfq', 'state', 'request', 'bid', 'served', 'earned', 'reason'],
      all.map((j) => [
        short(j.rfqId, 12),
        j.state,
        `${j.request.count}× ${j.request.gpu}, ${duration(j.request.durationS)}`,
        `${zec(j.bid.pricePerIntervalZats)}/${j.bid.intervalS} s`,
        `#${j.servingSeq}`,
        zec(j.earnedZats),
        j.stopReason ?? '',
      ]),
    );
  if (o.follow) await watchJobs(c);
}
