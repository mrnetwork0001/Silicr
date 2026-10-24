// `silicr wallet` (deposit address, ZIP 321 QR, balance) and `silicr withdraw` (back to your own wallet).
// Keys never leave the daemon: this only ever sees addresses, amounts and txids.
import QRCode from 'qrcode';
import type { WalletDto, WithdrawConfirmDto, WithdrawRequest, WithdrawResultDto } from '@silicr/api';
import { formatZec, parseZec } from '@silicr/engine';
import { ApiError, DaemonClient, DEFAULT_URLS } from '../client.ts';
import { readConfig } from '../config.ts';
import { MAINNET_TAG, isInteractive, networkLabel } from '../confirm.ts';
import { createInterface } from 'node:readline/promises';
import { fail, kv, pc, zec } from '../format.ts';

interface Target {
  data?: string;
  daemon?: string;
}

/** --daemon wins; else --data's config.json port; else the buyer daemon. */
export async function walletClient(o: Target): Promise<DaemonClient> {
  if (o.daemon) return new DaemonClient(o.daemon);
  if (o.data) {
    const cfg = await readConfig(o.data);
    if (!cfg) fail(`no config.json in ${o.data} (run silicr init first)`);
    return new DaemonClient(`http://127.0.0.1:${cfg!.port}`);
  }
  return new DaemonClient(process.env.SILICR_BUYER_URL ?? DEFAULT_URLS.buyer);
}

/** A terminal QR of the text, two modules per character row. */
export async function terminalQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'utf8', errorCorrectionLevel: 'M', margin: 2 });
}

export async function wallet(o: Target & { amount?: string; qr?: boolean }): Promise<void> {
  const c = await walletClient(o);
  let q = '';
  if (o.amount) {
    let z: bigint;
    try {
      z = parseZec(o.amount);
    } catch (e) {
      fail(String((e as Error).message));
    }
    q = `?amount=${encodeURIComponent(formatZec(z!))}`;
  }
  const w = await c.get<WalletDto>(`/api/wallet${q}`);
  console.log(`\n  ${pc.bold(`${w.role} wallet`)} ${pc.dim(c.base)}`);
  const rows: [string, string][] = [
    ['network', networkLabel(w.network)],
    ['address', w.address],
    ['balance', `${pc.bold(zec(w.balance.spendable))} spendable · ${zec(w.balance.pending)} pending`],
    ['confirmations', `${w.confirmationsRequired.received} for deposits, ${w.confirmationsRequired.change} for change`],
  ];
  if (w.lastIncoming) {
    const li = w.lastIncoming;
    const need = w.confirmationsRequired.received;
    const conf = li.confirmations >= need ? pc.green(`${li.confirmations} confirmations: spendable`) : pc.yellow(`${li.confirmations}/${need} confirmations`);
    rows.push(['last deposit', `${zec(li.zats)} · ${conf}`]);
  }
  if (w.busy) rows.push(['busy', pc.yellow('a request or job is live: withdraws need --force')]);
  kv(rows);
  if (o.qr !== false) {
    console.log(`\n  ${pc.dim('ZIP 321:')} ${w.zip321Uri}\n`);
    const qr = await terminalQr(w.zip321Uri);
    for (const line of qr.split('\n')) if (line !== '') console.log(`  ${line}`);
  }
  console.log(`\n  Scan with your Zcash wallet (Zashi, Ywallet, any shielded wallet). Funds are spendable after ${w.confirmationsRequired.received} confirmation${w.confirmationsRequired.received === 1 ? '' : 's'}.`);
  if (w.network === 'main') console.log(`  ${pc.red(MAINNET_TAG)}: send only small amounts.`);
  console.log();
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(question)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

export async function withdraw(to: string, amount: string, o: Target & { yes?: boolean; force?: boolean }): Promise<void> {
  const c = await walletClient(o);
  let amountZats: WithdrawRequest['amountZats'];
  if (amount.toLowerCase() === 'all') amountZats = 'all';
  else {
    try {
      amountZats = parseZec(amount).toString();
    } catch (e) {
      fail(String((e as Error).message));
    }
  }
  const body: WithdrawRequest = { to, amountZats: amountZats!, ...(o.force ? { force: true } : {}) };
  let r = await postWithdraw(c, body);
  if ('confirm' in r) {
    // Mainnet: the daemon sent nothing and wants its token back within 60 s.
    const cf = r;
    console.log(`\n  ${pc.red(MAINNET_TAG)}`);
    kv([
      ['withdraw', pc.bold(zec(cf.summary.zats)) + (cf.summary.all ? pc.dim(' (everything spendable, minus the fee)') : '')],
      ['fee', `about ${zec(cf.summary.feeZats)}`],
      ['to', cf.summary.to],
      ['network', networkLabel(cf.summary.network)],
      ['spend cap', pc.dim('not counted: this is your own money leaving Silicr')],
    ]);
    if (!o.yes) {
      if (!isInteractive()) fail('real funds need an explicit go-ahead: re-run with --yes (no terminal to ask on); nothing was sent');
      if (!(await ask('  Send this withdraw? [y/N] '))) fail('cancelled: nothing was sent');
    } else console.log(`  ${pc.dim('--yes given: continuing')}`);
    r = await postWithdraw(c, { ...body, confirm: cf.confirm });
    if ('confirm' in r) fail('the confirmation expired (60 s): run the withdraw again; nothing was sent');
  }
  const done = r as WithdrawResultDto;
  console.log();
  kv([
    ['sent', pc.bold(zec(done.zats))],
    ['fee', zec(done.feeZats)],
    ['network', networkLabel(done.network)],
    ['txid', done.txid],
  ]);
  console.log();
}

/** POST /api/wallet/withdraw: the result, or the mainnet confirm request (409 confirm_required). */
async function postWithdraw(c: DaemonClient, body: WithdrawRequest): Promise<WithdrawResultDto | WithdrawConfirmDto> {
  let res: Response;
  try {
    res = await fetch(`${c.base}/api/wallet/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'unreachable', `no daemon is answering at ${c.base}`);
  }
  const json = (await res.json().catch(() => ({ error: `HTTP ${res.status}`, code: 'http_error' }))) as WithdrawResultDto | WithdrawConfirmDto;
  if (res.ok) return json;
  const err = json as WithdrawConfirmDto;
  if (res.status === 409 && err.code === 'confirm_required' && typeof err.confirm === 'string') return err;
  throw new ApiError(res.status, err.code, err.error);
}
