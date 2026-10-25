'use client';

import clsx from 'clsx';
import { ArrowUpRight, CircleAlert, Coins, Inbox, Lock, QrCode, Send, ShieldCheck, Wallet } from '@/components/icons';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { WalletDto, WithdrawConfirmDto, WithdrawResultDto } from '@silicr/api';
import { errorMessage } from '@/lib/client';
import { explorerTxLink } from '@/lib/config';
import { getDriver } from '@/lib/driver';
import { formatHeight, networkLabel, parseZec, toZats, zecString } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { isPublicDemo, useSilicr } from '@/lib/store';
import { RealZecChip } from '../shell/ConnectionStatus';
import { Badge, Button, CopyButton, ErrorNote, Field, Input, Mono, Panel, Skeleton, Switch, Zec } from '../ui';
import { Qr } from './Qr';
import { UA_PREFIX, destinationError, zip321With } from '@/lib/wallet';

type Role = 'buyer' | 'provider';

const POLL_MS = 5000;

function useRoles(): Role[] {
  const conn = useSilicr((s) => s.conn);
  return useMemo(() => (['buyer', 'provider'] as const).filter((r) => conn[r].status === 'online'), [conn]);
}

function useWallet(role: Role | null): { wallet: WalletDto | null; error: string | null; refresh: () => void } {
  const mode = useSilicr((s) => s.mode);
  const [wallet, setWallet] = useState<WalletDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setWallet(null);
    setError(null);
  }, [role, mode]);
  useEffect(() => {
    if (!role) return;
    let live = true;
    const load = async () => {
      const d = getDriver();
      if (!d) return;
      try {
        const w = await d.getWallet(role);
        if (live) {
          setWallet(w);
          setError(null);
        }
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [role, mode, tick]);
  return { wallet, error, refresh: useCallback(() => setTick((n) => n + 1), []) };
}

/** The wallet connection: fund the local wallet from your own Zcash wallet, and withdraw back to it. */
export function WalletPanel({ compact }: { compact?: boolean }) {
  const roles = useRoles();
  const mode = useSilicr((s) => s.mode);
  const [picked, setPicked] = useState<Role | null>(null);
  const role = picked && roles.includes(picked) ? picked : (roles[0] ?? null);
  const { wallet, error, refresh } = useWallet(role);
  const publicDemo = useSilicr(isPublicDemo);
  const blockTimeS = useSilicr((s) => (role === 'provider' ? s.providerStatus : s.buyerStatus)?.blockTimeS ?? null);
  // Whether this is a public demo (withdraw off) is only known once the daemon's status is in.
  const statusLoaded = useSilicr((s) => !!(role === 'provider' ? s.providerStatus : s.buyerStatus));

  if (mode === 'probing' || (role && !statusLoaded)) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }
  if (!role) {
    return (
      <ErrorNote title="No daemon connected">
        Start one with <code className="font-mono">pnpm silicr daemon --network test --role buyer</code> (buyer on 7701, provider on 7702), or a whole
        testnet stack with <code className="font-mono">pnpm silicr demo</code>.
      </ErrorNote>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Wallet className="size-5 text-accent" aria-hidden />
        <h1 className="text-base font-[650] tracking-[-0.01em] text-fg">Wallet</h1>
        {wallet?.network === 'main' && <RealZecChip />}
        {wallet && wallet.network !== 'main' && <Badge tone="neutral">{networkLabel(wallet.network)}</Badge>}
        {publicDemo && <Badge tone="accent">public demo · shared wallet</Badge>}
        {roles.length > 1 && (
          <div className="ml-auto flex gap-0.5" role="tablist" aria-label="Which wallet">
            {roles.map((r) => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={r === role}
                onClick={() => setPicked(r)}
                className={clsx('rounded-full px-3 py-1 text-xs font-semibold transition-colors', r === role ? 'glass-pill text-white' : 'text-secondary hover:text-white')}
              >
                {r === 'buyer' ? 'Buyer' : 'Provider'}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="max-w-2xl text-xs leading-relaxed text-muted">
        Keys never leave this machine: the {role} daemon holds the wallet, and this page only sees addresses, amounts and txids. Everything stays
        shielded: deposits and withdrawals go to Orchard receivers only.
      </p>

      {error && !wallet && <ErrorNote title="Wallet unavailable">{error}</ErrorNote>}
      {!wallet && !error && <Skeleton className="h-64 w-full rounded-xl" />}
      {wallet && (
        <div className={clsx('grid min-w-0 gap-4', !compact && 'lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]')}>
          <DepositCard wallet={wallet} blockTimeS={blockTimeS} />
          <div className="flex min-w-0 flex-col gap-4">
            <BalanceCard wallet={wallet} />
            {publicDemo ? (
              <Panel title="Withdraw" subtitle="Off in the public demo" actions={<Lock className="size-4 text-faint" aria-hidden />} bodyClassName="p-4">
                <p className="text-xs leading-relaxed text-muted" id="withdraw-disabled">
                  Public testnet demo: this is a shared wallet holding testnet coins only, so withdrawals are disabled. Run your own daemon (
                  <code className="font-mono">pnpm silicr demo</code>) to try withdrawing.
                </p>
              </Panel>
            ) : (
              <WithdrawCard key={`${role}-${wallet.network}`} wallet={wallet} role={role} onSent={refresh} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DepositCard({ wallet, blockTimeS }: { wallet: WalletDto; blockTimeS: number | null }) {
  const [amount, setAmount] = useState('');
  const amountZats = amount.trim() ? parseZec(amount) : null;
  const amountBad = amount.trim() !== '' && (amountZats === null || amountZats <= 0n);
  const uri = zip321With(wallet.zip321Uri, amountBad ? null : amountZats);
  const n = wallet.confirmationsRequired.received;
  return (
    <Panel
      title="Deposit"
      subtitle="Fund this wallet from your own Zcash wallet"
      actions={<QrCode className="size-4 text-faint" aria-hidden />}
      bodyClassName="flex flex-col gap-4 p-4"
    >
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start max-[900px]:flex-col! max-[900px]:items-center!">
        <div className="shrink-0 rounded-xl border border-line-strong bg-white p-1.5 shadow-[0_0_28px_rgba(238,127,32,0.18)]">
          <Qr text={uri} className="size-48 sm:size-52 max-[900px]:size-[240px]!" label={`ZIP 321 payment request: ${uri}`} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 max-[900px]:w-full">
          <p className="text-sm leading-relaxed text-body">
            Scan with your Zcash wallet (Zashi, Ywallet, any shielded wallet). Funds are spendable after{' '}
            <strong className="font-semibold text-fg">
              {n} confirmation{n === 1 ? '' : 's'}
            </strong>
            {(wallet.network === 'main' || wallet.network === 'test') && blockTimeS ? ` (about ${Math.max(1, Math.round((n * blockTimeS) / 60))} min)` : ''}.
          </p>
          {wallet.network === 'main' && (
            <p className="flex gap-1.5 text-xs text-bad">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Real ZEC on Zcash mainnet. Keep the balance small: a demo costs under 0.002 ZEC in fees.
            </p>
          )}
          <Field label="Amount (optional)" htmlFor="deposit-amount" error={amountBad ? 'A ZEC amount with at most 8 decimals' : undefined} hint="Puts the amount in the QR so your wallet fills it in.">
            <Input id="deposit-amount" inputMode="decimal" placeholder="0.05" value={amount} onChange={(e) => setAmount(e.target.value)} invalid={amountBad} suffix="ZEC" />
          </Field>
        </div>
      </div>
      <div className="rounded-lg border border-line bg-sunken p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="section-label text-[10px] text-muted">Orchard-only unified address</span>
          <CopyButton text={wallet.address} label="Copy address" className="max-[900px]:size-11 max-[900px]:rounded-full max-[900px]:border max-[900px]:border-line" />
        </div>
        <p className="break-all font-mono text-xs leading-relaxed text-secondary">{wallet.address}</p>
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2">
          <span className="min-w-0 truncate font-mono text-2xs text-faint" title={uri}>
            {uri.length > 48 ? `${uri.slice(0, 26)}…${uri.slice(-18)}` : uri}
          </span>
          <CopyButton text={uri} label="Copy ZIP 321 URI" className="max-[900px]:size-11 max-[900px]:rounded-full max-[900px]:border max-[900px]:border-line" />
        </div>
      </div>
      <p className="flex gap-1.5 text-2xs leading-relaxed text-faint">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        Send from a shielded balance. A deposit from a transparent address publishes its amount on the way in; Silicr only ever pays out to Orchard
        receivers.
      </p>
    </Panel>
  );
}

function BalanceCard({ wallet }: { wallet: WalletDto }) {
  const li = wallet.lastIncoming;
  const need = wallet.confirmationsRequired.received;
  const pct = li ? Math.min(100, Math.round((li.confirmations / Math.max(1, need)) * 100)) : 0;
  const done = li ? li.confirmations >= need : false;
  return (
    <Panel title="Balance" subtitle={`Height ${formatHeight(wallet.height)}`} actions={<Coins className="size-4 text-faint" aria-hidden />} bodyClassName="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="section-label text-[10px] text-muted">Spendable</div>
          <div className="mt-0.5 text-xl font-semibold">
            <Zec zats={wallet.balance.spendable} proportional />
          </div>
        </div>
        <div>
          <div className="section-label text-[10px] text-muted">Pending</div>
          <div className="mt-0.5 text-xl font-semibold">
            <Zec zats={wallet.balance.pending} proportional muted={toZats(wallet.balance.pending) === 0n} />
          </div>
        </div>
      </div>
      {li ? (
        <div className="rounded-lg border border-line bg-sunken p-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 text-secondary">
              <Inbox className="size-3.5" aria-hidden />
              Last deposit <Zec zats={li.zats} />
            </span>
            <span className={clsx('tabular-nums', done ? 'text-ok' : 'text-warn')}>
              {done ? 'spendable' : `${li.confirmations}/${need} confirmations`}
            </span>
          </div>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={need}
            aria-valuenow={Math.min(li.confirmations, need)}
            aria-label="Deposit confirmations"
          >
            <div className={clsx('h-full rounded-full transition-[width] duration-500', done ? 'bg-ok' : 'bg-accent')} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1.5 text-2xs text-faint">
            <Mono value={li.txid} head={10} tail={6} href={explorerTxLink(li.txid, wallet.network)} />
          </div>
        </div>
      ) : (
        <p className="text-xs text-faint">No deposit seen since the daemon started. New payments show up here while they confirm.</p>
      )}
    </Panel>
  );
}

function WithdrawCard({ wallet, role, onSent }: { wallet: WalletDto; role: Role; onSent: () => void }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [all, setAll] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<WithdrawConfirmDto | null>(null);
  const [result, setResult] = useState<WithdrawResultDto | null>(null);
  const now = useNow(1000, pending !== null);
  const realChain = wallet.network === 'main';

  useEffect(() => {
    if (pending && now > pending.expiresAt) setPending(null);
  }, [pending, now]);

  const fee = toZats(wallet.feeEstimateZats);
  const spendable = toZats(wallet.balance.spendable);
  const amountZats = all ? (spendable > fee ? spendable - fee : 0n) : amount.trim() ? parseZec(amount) : null;
  const toErr = destinationError(to, wallet.network);
  const amountErr = all
    ? amountZats === 0n
      ? 'Nothing spendable after the fee'
      : null
    : amount.trim() === ''
      ? null
      : amountZats === null || amountZats <= 0n
        ? 'A ZEC amount with at most 8 decimals'
        : amountZats + fee > spendable
          ? `More than the ${zecString(spendable)} ZEC spendable (with the fee)`
          : null;
  const ready = to.trim() !== '' && !toErr && amountZats !== null && amountZats > 0n && !amountErr && (!wallet.busy || force);

  const reset = () => setPending(null);

  const send = async (confirm?: string) => {
    const d = getDriver();
    if (!d || amountZats === null) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await d.withdraw(role, {
        to: to.trim(),
        amountZats: all ? 'all' : amountZats.toString(),
        ...(confirm ? { confirm } : {}),
        ...(force ? { force: true } : {}),
      });
      if ('confirm' in r) {
        setPending(r);
      } else {
        setResult(r);
        setPending(null);
        setAmount('');
        setAll(false);
        onSent();
      }
    } catch (e) {
      setErr(errorMessage(e));
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    // Mainnet, like the request form: the first click only asks the daemon for its summary and a
    // confirm token (nothing is sent); the second click, within 60 s, echoes the token and sends.
    void send(pending?.confirm);
  };

  const secondsLeft = pending ? Math.max(0, Math.ceil((pending.expiresAt - now) / 1000)) : 0;

  return (
    <Panel title="Withdraw" subtitle="Back to your own shielded wallet" actions={<Send className="size-4 text-faint" aria-hidden />} bodyClassName="p-4">
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <Field label="Destination" htmlFor="withdraw-to" error={toErr ?? undefined} hint={`A unified address with an Orchard receiver (${UA_PREFIX[wallet.network]}…). The daemon checks it again.`}>
          <Input
            id="withdraw-to"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              reset();
            }}
            placeholder={`${UA_PREFIX[wallet.network]}…`}
            autoComplete="off"
            spellCheck={false}
            invalid={!!toErr}
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label="Amount"
          htmlFor="withdraw-amount"
          error={amountErr ?? undefined}
          trailing={
            <label className="flex items-center gap-1.5 text-2xs text-muted">
              All
              <Switch
                checked={all}
                onChange={(v) => {
                  setAll(v);
                  reset();
                }}
                label="Withdraw everything spendable"
              />
            </label>
          }
          hint={
            <>
              Fee about {zecString(fee)} ZEC (ZIP 317, more if many notes are spent). {all ? 'Sweeps the spendable balance minus the fee.' : ''}
            </>
          }
        >
          <Input
            id="withdraw-amount"
            inputMode="decimal"
            placeholder="0.01"
            value={all ? zecString(amountZats ?? 0n, { group: false }) : amount}
            onChange={(e) => {
              setAmount(e.target.value);
              reset();
            }}
            disabled={all}
            invalid={!!amountErr}
            suffix="ZEC"
          />
        </Field>

        {wallet.busy && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
            <span>A {role === 'buyer' ? 'request' : 'job'} is live: withdrawing now could leave it without funds.</span>
            <label className="flex shrink-0 items-center gap-1.5">
              Anyway
              <Switch checked={force} onChange={setForce} label="Withdraw while busy" />
            </label>
          </div>
        )}

        <div className="flex gap-2 rounded-md border border-accent-line bg-accent-soft p-3 text-xs leading-relaxed text-fg">
          <Lock className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
          <p>
            One shielded transaction to an Orchard receiver: the chain sees shielded actions and a fee, not the amount or the destination.
            {realChain && ' Not counted against the spend cap: this is your own money leaving Silicr.'}
          </p>
        </div>

        {pending && (
          <div className="rounded-md border border-real/60 bg-real-soft p-3 text-xs text-fg" role="alert">
            <div className="mb-1 flex items-center gap-2">
              <RealZecChip />
              <span className="font-semibold">Confirm this withdraw</span>
              <span className="ml-auto tabular-nums text-muted">{secondsLeft} s</span>
            </div>
            <p>
              Send <Zec zats={pending.summary.zats} /> (fee about <Zec zats={pending.summary.feeZats} />) to{' '}
              <Mono value={pending.summary.to} head={12} tail={8} copy={false} /> on {networkLabel(pending.summary.network)}.
            </p>
          </div>
        )}

        {err && <ErrorNote title="Withdraw not sent">{err}</ErrorNote>}

        <Button
          type="submit"
          variant={pending ? 'danger' : 'primary'}
          size="md"
          className={clsx('btn-sheen w-full', pending && 'ring-2 ring-real ring-offset-2 ring-offset-panel')}
          disabled={!ready}
          loading={busy}
          icon={pending ? <Coins className="size-3.5" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
        >
          {busy
            ? 'Building shielded transaction…'
            : pending
              ? `Confirm: send ${zecString(pending.summary.zats)} ZEC of real ZEC`
              : realChain
                ? 'Withdraw · real ZEC'
                : 'Withdraw'}
        </Button>
        {pending && (
          <button type="button" className="text-center text-2xs text-muted hover:text-fg" onClick={reset}>
            Cancel
          </button>
        )}

        {result && (
          <div className="rounded-md border border-ok/30 bg-ok-soft p-3 text-xs text-ok" role="status">
            <div className="flex items-center gap-1.5 font-semibold">
              <ArrowUpRight className="size-3.5" aria-hidden />
              Sent <Zec zats={result.zats} /> <span className="font-normal text-muted">(fee {zecString(result.feeZats)} ZEC)</span>
            </div>
            <div className="mt-1 text-secondary">
              <Mono value={result.txid} head={12} tail={8} href={explorerTxLink(result.txid, result.network)} />
            </div>
          </div>
        )}
      </form>
    </Panel>
  );
}
