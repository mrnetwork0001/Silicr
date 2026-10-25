// `silicr status`: what the local daemons report.
import type { ProviderJobDto, RfqDto, StatusDto } from '@silicr/api';
import { DaemonClient, DEFAULT_URLS } from '../client.ts';
import { capLine, networkLabel } from '../confirm.ts';
import { kv, pc, short, zec } from '../format.ts';

export async function status(o: { buyer?: string; provider?: string }): Promise<void> {
  const targets = [
    new DaemonClient(o.buyer ?? process.env.SILICR_BUYER_URL ?? DEFAULT_URLS.buyer),
    new DaemonClient(o.provider ?? process.env.SILICR_PROVIDER_URL ?? DEFAULT_URLS.provider),
  ];
  let any = false;
  for (const c of targets) {
    let s: StatusDto & { runner?: { sandboxed: boolean; warning?: string } };
    try {
      s = await c.get(`/api/status`);
    } catch {
      console.log(`\n  ${pc.dim(`${c.base}: no daemon`)}`);
      continue;
    }
    any = true;
    console.log(`\n  ${pc.bold(s.role)} ${pc.dim(c.base)}${s.demoMode ? pc.dim('  (demo mode)') : ''}`);
    const rows: [string, string][] = [
      ['network', networkLabel(s.network)],
      ['height', `${s.height} ${pc.dim(`(~${s.blockTimeS} s blocks)`)}`],
      ['address', s.address],
      ['balance', `${zec(s.balance.spendable)} spendable · ${zec(s.balance.pending)} pending`],
      ['relay', s.relayUrl],
      ['proxy', s.proxy ? pc.green(`${s.proxy.url} (SOCKS5: IP hidden from the relay and light-wallet server)`) : pc.yellow('none: direct connections, IP visible to the relay and light-wallet server')],
    ];
    if (s.spendCap) rows.push(['spend cap', capLine(s.spendCap).replace(/^cap: /, '')]);
    else if (s.network === 'main') rows.push(['spend cap', pc.red('NONE (a mainnet daemon must not run without one)')]);
    if (s.role === 'provider') {
      rows.push(['provider', `${pc.bold(s.alias ?? '?')} ${pc.dim(short(s.providerId, 16))}`]);
      if (s.runner) rows.push(['runner', s.runner.sandboxed ? pc.green('docker sandbox') : pc.red(s.runner.warning ?? 'NOT a sandbox')]);
      const jobs = await c.get<ProviderJobDto[]>('/api/jobs').catch(() => []);
      const live = jobs.filter((j) => ['won', 'running', 'paused'].includes(j.state));
      rows.push(['jobs', `${jobs.length} total, ${live.length} running`]);
    } else {
      const rfqs = await c.get<RfqDto[]>('/api/rfqs').catch(() => []);
      const live = rfqs.filter((r) => ['broadcasting', 'collecting', 'accepted', 'running', 'closing'].includes(r.state));
      rows.push(['rfqs', `${rfqs.length} total, ${live.length} active${live[0] ? ` (latest ${short(live[0].rfqId, 12)}: ${live[0].state})` : ''}`]);
    }
    rows.push(['version', s.version]);
    kv(rows);
  }
  console.log();
  if (!any) {
    console.log(`  Start the testnet demo with ${pc.bold('pnpm silicr demo')}, or a daemon with ${pc.bold('silicr daemon --data <dir>')}.\n`);
    process.exitCode = 1;
  }
}
