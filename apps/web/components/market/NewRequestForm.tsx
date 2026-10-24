'use client';

import clsx from 'clsx';
import { Coins, Lock, Send } from '@/components/icons';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { NetworkName, ProviderDto } from '@silicr/api';
import { formatDuration, gpuLabel, zecString } from '@/lib/format';
import { estimateCost, type SpendCapCheck } from '@/lib/market';
import { Button, ErrorNote, Field, Input, Panel, Select, Switch, Zec } from '../ui';
import { SealedPreview } from './SealedPreview';

export interface RequestFormState {
  gpu: string;
  count: string;
  duration: string;
  unit: 'min' | 'h';
  maxZec: string;
  path: string;
  command: string;
  image: string;
  env: string;
  autoAccept: boolean;
  /** Put the max price in the RFQ memo. Off by default: providers bid their own price and the daemon filters locally. */
  discloseMax: boolean;
  waitBlocks: string;
  minBond: string;
}

export interface RequestFormDerived {
  count: number | null;
  durationS: number | null;
  maxPerHour: bigint | null;
  minBond: bigint | null;
  waitBlocks: number | null;
  argv: string[];
  env: Record<string, string> | null;
  errors: Partial<Record<keyof RequestFormState | 'recipients' | 'cap', string>>;
}

/** How long a first click on mainnet stays armed before the button falls back to its normal label. */
const ARM_MS = 6000;

export function NewRequestForm({
  form,
  set,
  derived,
  gpuChoices,
  recipients,
  submitting,
  submitError,
  disabledReason,
  onSubmit,
  network = null,
  capCheck = null,
}: {
  form: RequestFormState;
  set: <K extends keyof RequestFormState>(key: K, value: RequestFormState[K]) => void;
  derived: RequestFormDerived;
  gpuChoices: { value: string; label: string }[];
  recipients: ProviderDto[];
  submitting: boolean;
  submitError: string | null;
  disabledReason: string | null;
  onSubmit: () => void;
  /** The buyer daemon's network: on mainnet the estimate is real ZEC and sending takes a second click. */
  network?: NetworkName | null;
  /** The daemon's spend cap applied to this request, when it reports one. */
  capCheck?: SpendCapCheck | null;
}) {
  const { errors } = derived;
  const n = recipients.length;
  const est = derived.maxPerHour !== null && derived.durationS !== null ? estimateCost(derived.maxPerHour, derived.durationS, n) : null;
  const worstCase = est ? est.maxCost + est.rfqFee + est.paymentFees : null;
  const realChain = network === 'main';
  const canSubmit = !disabledReason && !submitting && Object.keys(errors).length === 0;

  // Mainnet: the first click only arms the button, with the amount and the cap on screen; the second sends.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  const handle = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (realChain && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    onSubmit();
  };

  const stepOk = {
    compute: !errors.count && !!form.gpu,
    budget: !errors.duration && !errors.maxZec,
    job: !errors.path && !errors.command && !errors.env,
    recipients: !errors.recipients && !errors.waitBlocks && !errors.minBond,
  };

  return (
    <Panel title="Seal a request" subtitle="A sealed RFQ, sent as one shielded transaction" className="lg:sticky lg:top-[calc(var(--chrome-h,48px)+20px)]">
      <form onSubmit={handle} className="step-rail space-y-5 p-4" noValidate>
        <Step n={1} title="Compute" done={stepOk.compute}>
          <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
            <Field label="GPU model" htmlFor="rq-gpu">
              <Select id="rq-gpu" value={form.gpu} onChange={(e) => set('gpu', e.target.value)}>
                {gpuChoices.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Count" htmlFor="rq-count" error={errors.count}>
              <Input id="rq-count" inputMode="numeric" value={form.count} invalid={!!errors.count} onChange={(e) => set('count', e.target.value.replace(/[^\d]/g, ''))} className="tabular-nums" />
            </Field>
          </div>
        </Step>

        <Step n={2} title="Time & budget" done={stepOk.budget}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration" htmlFor="rq-dur" error={errors.duration}>
              <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-1.5">
                <Input id="rq-dur" inputMode="decimal" value={form.duration} invalid={!!errors.duration} onChange={(e) => set('duration', e.target.value)} className="tabular-nums" />
                <Select aria-label="Duration unit" value={form.unit} onChange={(e) => set('unit', e.target.value as 'min' | 'h')}>
                  <option value="min">min</option>
                  <option value="h">h</option>
                </Select>
              </div>
            </Field>
            <Field label="Max price" htmlFor="rq-max" error={errors.maxZec}>
              <Input id="rq-max" inputMode="decimal" value={form.maxZec} invalid={!!errors.maxZec} onChange={(e) => set('maxZec', e.target.value)} suffix="ZEC/h" className="tabular-nums" />
            </Field>
          </div>
          <label className="mt-3 flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="block text-xs font-medium text-fg">Disclose my max price to providers</span>
              <span className="block text-2xs text-faint">Off: the RFQ memo says “undisclosed”, providers bid their own price and bids above your max are dropped here. On: every provider asked sees your budget.</span>
            </span>
            <Switch checked={form.discloseMax} onChange={(v) => set('discloseMax', v)} label="Disclose my max price to providers" />
          </label>
        </Step>

        <Step n={3} title="Job" done={stepOk.job}>
          <div className="space-y-3">
            <Field label="Job folder" htmlFor="rq-path" hint="On this machine. The daemon packs, encrypts and uploads it." error={errors.path}>
              <Input id="rq-path" value={form.path} invalid={!!errors.path} onChange={(e) => set('path', e.target.value)} className="font-mono text-xs" spellCheck={false} />
            </Field>
            <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3">
              <Field label="Command" htmlFor="rq-cmd" error={errors.command}>
                <Input id="rq-cmd" value={form.command} invalid={!!errors.command} onChange={(e) => set('command', e.target.value)} className="font-mono text-xs" spellCheck={false} />
              </Field>
              <Field label="Image" htmlFor="rq-img">
                <Input id="rq-img" value={form.image} placeholder="python:3.12-slim" onChange={(e) => set('image', e.target.value)} className="font-mono text-xs" spellCheck={false} />
              </Field>
            </div>
            <Field label="Environment" htmlFor="rq-env" hint="Optional KEY=VALUE pairs. The daemon drops reserved SILICR_* names." error={errors.env}>
              <Input
                id="rq-env"
                value={form.env}
                placeholder="SILICR_STEPS=200 SILICR_STEP_DELAY_MS=100"
                invalid={!!errors.env}
                onChange={(e) => set('env', e.target.value)}
                className="font-mono text-xs"
                spellCheck={false}
              />
            </Field>
          </div>
        </Step>

        <Step n={4} title="Recipients" done={stepOk.recipients}>
          <div className="rounded-md border border-line bg-sunken/60 p-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-muted">Recipients</span>
              <span className={clsx('tabular-nums', n ? 'text-fg' : 'text-bad')}>
                {n} provider{n === 1 ? '' : 's'}
              </span>
            </div>
            {n > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {recipients.map((p) => (
                  <span key={p.providerId} className="rounded border border-accent-line bg-accent-soft px-1.5 py-0.5 font-mono text-2xs text-fg">
                    {p.alias}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-2xs text-bad">{errors.recipients ?? 'Select at least one provider in the directory.'}</p>
            )}
            <p className="mt-2 text-2xs text-faint">Choose recipients in the directory. Only they can decrypt the request.</p>
          </div>
          <label className="mt-3 flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="block text-xs font-medium text-fg">Auto-accept the cheapest bid</span>
              <span className="block text-2xs text-faint">Matching runs here, on your machine. No server picks for you.</span>
            </span>
            <Switch checked={form.autoAccept} onChange={(v) => set('autoAccept', v)} label="Auto-accept the cheapest bid" />
          </label>
          {form.autoAccept && (
            <div className="mt-3 grid grid-cols-2 gap-3 animate-in">
              <Field label="Wait for bids" htmlFor="rq-wait" error={errors.waitBlocks}>
                <Input id="rq-wait" inputMode="numeric" value={form.waitBlocks} onChange={(e) => set('waitBlocks', e.target.value.replace(/[^\d]/g, ''))} suffix="blocks" className="tabular-nums" />
              </Field>
              <Field label="Min bond" htmlFor="rq-bond" error={errors.minBond}>
                <Input id="rq-bond" inputMode="decimal" value={form.minBond} placeholder="0" onChange={(e) => set('minBond', e.target.value)} suffix="ZEC" className="tabular-nums" />
              </Field>
            </div>
          )}
        </Step>

        <Step n={5} title="Seal & send" done={canSubmit}>
          <div className="space-y-3.5">
            <SealedPreview
              est={est}
              gpu={form.gpu}
              count={derived.count}
              durationS={derived.durationS}
              maxPerHour={derived.maxPerHour}
              discloseMax={form.discloseMax}
              recipients={n}
              seed={`${form.gpu}|${form.count}|${form.duration}${form.unit}|${form.maxZec}|${form.discloseMax}|${form.path}|${form.command}|${form.image}|${form.env}|${n}`}
            />
            <dl className="space-y-1.5 border-t border-line pt-3.5 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted">Max cost</dt>
                <dd className="text-right">
                  {est ? <Zec zats={est.maxCost} className="text-sm font-semibold" /> : <span className="text-faint">—</span>}
                  {est && derived.durationS !== null && (
                    <div className="text-2xs text-faint">
                      {formatDuration(derived.durationS)} × {zecString(derived.maxPerHour)} ZEC/h
                    </div>
                  )}
                  {realChain && <div className="text-2xs font-semibold text-real">real ZEC on Zcash mainnet</div>}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="whitespace-nowrap text-muted">Network fees (est.)</dt>
                <dd className="text-right tabular-nums">
                  {est ? (
                    <>
                      <span className="text-fg">≈ {zecString(est.rfqFee + est.paymentFees, { maxDecimals: 5 })} ZEC</span>
                      <div className="text-2xs text-faint">
                        RFQ {zecString(est.rfqFee)} + {est.intervals} payments × {zecString(est.paymentFees / BigInt(est.intervals))} (10-min intervals)
                      </div>
                    </>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="whitespace-nowrap text-muted">Exposure</dt>
                <dd className="text-right tabular-nums">
                  {est ? (
                    <>
                      <span className="text-fg">≈ {zecString(est.perIntervalAtMax, { maxDecimals: 4 })} ZEC</span>
                      <div className="text-2xs text-faint">one prepaid interval (10 min) at your max price</div>
                    </>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </dd>
              </div>
              {capCheck && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="whitespace-nowrap text-muted">Spend cap</dt>
                  <dd className={clsx('text-right tabular-nums', errors.cap ? 'text-bad' : 'text-fg')}>
                    spent {zecString(capCheck.spent)} of {zecString(capCheck.total)} ZEC
                    <div className={clsx('text-2xs', errors.cap ? 'text-bad' : 'text-faint')}>
                      per request ≤ {zecString(capCheck.perRfq)} ZEC · {zecString(capCheck.remaining)} ZEC left
                    </div>
                  </dd>
                </div>
              )}
            </dl>

            {errors.cap && <ErrorNote title="Over the spend cap">{errors.cap}</ErrorNote>}

            {realChain && (
              <div className="flex gap-2.5 rounded-md border border-real/40 bg-real-soft p-3 text-xs leading-relaxed text-fg">
                <Coins className="mt-0.5 size-3.5 shrink-0 text-real" aria-hidden />
                <p>
                  <strong className="font-semibold text-real">Real funds.</strong> This request spends real ZEC on Zcash mainnet: up to{' '}
                  <strong className="font-semibold">{worstCase !== null ? zecString(worstCase, { maxDecimals: 5 }) : '—'} ZEC</strong> at your max price,
                  fees included.{' '}
                  {capCheck ? `Your daemon's cap: spent ${zecString(capCheck.spent)} of ${zecString(capCheck.total)} ZEC, per request ≤ ${zecString(capCheck.perRfq)} ZEC.` : 'Your daemon reports no spend cap.'}
                  {' '}Sending takes two clicks.
                </p>
              </div>
            )}

            <div className="flex gap-2.5 rounded-md border border-accent-line bg-accent-soft p-3 text-xs leading-relaxed text-fg">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
              <p>
                Goes <strong className="font-semibold">only</strong> to the {n || 'selected'} selected provider{n === 1 ? '' : 's'}, inside{' '}
                <strong className="font-semibold">one shielded transaction</strong> padded to {est?.paddedOutputs ?? 4} outputs. The chain sees{' '}
                {est?.paddedOutputs ?? 4} shielded (Ironwood) actions and a fee: not who, what or how much. Bids return to a one-time address made for this
                request.
              </p>
            </div>

            {submitError && <ErrorNote title="Request not sent">{submitError}</ErrorNote>}
            {disabledReason && <p className="text-xs text-warn">{disabledReason}</p>}

            <Button
              type="submit"
              variant="primary"
              size="md"
              className={clsx('btn-sheen w-full', armed && 'ring-2 ring-real ring-offset-2 ring-offset-panel')}
              disabled={!canSubmit}
              loading={submitting}
              icon={armed ? <Coins className="size-3.5" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
            >
              {submitting
                ? 'Building shielded transaction…'
                : armed
                  ? `Confirm: send and spend up to ${worstCase !== null ? zecString(worstCase, { maxDecimals: 5 }) : '?'} ZEC`
                  : realChain
                    ? `Send sealed request${n ? ` to ${n}` : ''} · real ZEC`
                    : `Send sealed request${n ? ` to ${n}` : ''}`}
            </Button>
            <p className="text-center text-2xs text-faint">
              {form.count || '?'}× {gpuLabel(form.gpu)} · {form.duration || '?'} {form.unit} · max {form.maxZec || '?'} ZEC/h
            </p>
          </div>
        </Step>
      </form>
    </Panel>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <section className="relative pl-9" aria-label={`Step ${n}: ${title}`}>
      <span className="step-pad absolute left-0 top-0" data-done={done} aria-hidden>
        {n}
      </span>
      <h3 className="section-label mb-2.5 flex h-[23px] items-center text-[10px] text-secondary">{title}</h3>
      {children}
    </section>
  );
}
