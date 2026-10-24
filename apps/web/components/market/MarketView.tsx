'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NewRfqRequest, PresetRfqRequest, ProviderDto } from '@silicr/api';
import { errorMessage } from '@/lib/client';
import { hostOf } from '@/lib/config';
import { getDriver } from '@/lib/driver';
import { normalizeGpu, toZats, zecString } from '@/lib/format';
import { derive, publicDemoForm, publicDemoRules } from '@/lib/request-form';
import { checkSpendCap, estimateCost, gpuOptions, providerMatches, sortedRfqs } from '@/lib/market';
import { isPublicDemo, useSilicr } from '@/lib/store';
import { Zec } from '../ui';
import { MarketHeader } from './MarketHeader';
import { NewRequestForm, type RequestFormState } from './NewRequestForm';
import { ProviderTable, type ProviderRow } from './ProviderTable';
import { RequestList } from './RequestList';

const DEFAULT_FORM: RequestFormState = {
  gpu: 'a100',
  count: '4',
  duration: '1',
  unit: 'h',
  maxZec: '0.8',
  path: './examples/tiny-train',
  command: 'python3 train.py',
  image: '',
  env: '',
  autoAccept: false,
  discloseMax: false,
  waitBlocks: '2',
  minBond: '',
  preset: '',
};

export function MarketView() {
  const router = useRouter();
  const mode = useSilicr((s) => s.mode);
  const providers = useSilicr((s) => s.providers);
  const providersError = useSilicr((s) => s.providersError);
  const rfqMap = useSilicr((s) => s.rfqs);
  const rfqsLoaded = useSilicr((s) => s.rfqsLoaded);
  const buyerConn = useSilicr((s) => s.conn.buyer);
  const buyerStatus = useSilicr((s) => s.buyerStatus);
  const publicDemo = useSilicr(isPublicDemo);
  const presetsKey = JSON.stringify(buyerStatus?.presets ?? null) + JSON.stringify(buyerStatus?.publicDemoLimits ?? null);
  // presetsKey stands in for the status fields the rules are made of.
  const demoRules = useMemo(() => (publicDemo ? publicDemoRules(buyerStatus) : null), [publicDemo, presetsKey]);

  const [form, setForm] = useState<RequestFormState>(DEFAULT_FORM);
  // Entering a public demo: adopt its first preset and limits once.
  const demoApplied = useRef(false);
  useEffect(() => {
    if (!demoRules || demoApplied.current || !demoRules.presets.length) return;
    demoApplied.current = true;
    setForm((f) => publicDemoForm(f, demoRules));
  }, [demoRules]);
  const [gpuTouched, setGpuTouched] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const derived = useMemo(() => derive(form, demoRules), [form, demoRules]);
  const count = derived.count ?? 1;

  const rows: ProviderRow[] = useMemo(() => {
    const list = (providers ?? []).map((p) => ({
      p,
      matches: providerMatches(p, form.gpu, count),
      aboveMax: derived.maxPerHour !== null && toZats(p.minPricePerHourZats) > derived.maxPerHour,
    }));
    return list.sort((a, b) => {
      if (a.matches !== b.matches) return a.matches ? -1 : 1;
      if (a.p.verified !== b.p.verified) return a.p.verified ? -1 : 1;
      const pa = toZats(a.p.minPricePerHourZats);
      const pb = toZats(b.p.minPricePerHourZats);
      return pa < pb ? -1 : pa > pb ? 1 : a.p.alias.localeCompare(b.p.alias);
    });
  }, [providers, form.gpu, count, derived.maxPerHour]);

  // Default selection: every verified provider that matches and can bid under the max price.
  const autoSelection = useMemo(() => rows.filter((r) => r.matches && r.p.verified && !r.aboveMax).map((r) => r.p.providerId), [rows]);
  const autoKey = autoSelection.join(',');
  const baseKey = `${form.gpu}|${count}`;
  const lastBase = useRef(baseKey);
  useEffect(() => {
    const baseChanged = lastBase.current !== baseKey;
    lastBase.current = baseKey;
    if (baseChanged || !touched) {
      setSelected(new Set(autoSelection));
      if (baseChanged) setTouched(false);
    }
    // autoKey stands in for autoSelection's contents.
  }, [autoKey, baseKey]);

  // An untouched form adopts what the directory actually offers if the default matches nobody.
  useEffect(() => {
    if (gpuTouched || demoRules || !providers?.length) return;
    if (providers.some((p) => p.verified && providerMatches(p, form.gpu, count))) return;
    const first = providers.find((p) => p.verified && p.gpus.length);
    const g = first?.gpus.find((x) => normalizeGpu(x.model) !== 'cpu') ?? first?.gpus[0];
    if (g) setForm((f) => ({ ...f, gpu: normalizeGpu(g.model), count: String(Math.max(1, Math.min(g.count, 4))) }));
  }, [providers, gpuTouched, demoRules, form.gpu, count]);

  const recipients: ProviderDto[] = useMemo(
    () => rows.filter((r) => r.matches && r.p.verified && selected.has(r.p.providerId)).map((r) => r.p),
    [rows, selected],
  );

  // The daemon's spend cap, applied to this request's worst case (the daemon enforces it again).
  const spendCap = buyerStatus?.spendCap;
  const capCheck = useMemo(() => {
    if (!spendCap || derived.maxPerHour === null || derived.durationS === null) return null;
    return checkSpendCap(estimateCost(derived.maxPerHour, derived.durationS, recipients.length), spendCap);
  }, [spendCap, derived.maxPerHour, derived.durationS, recipients.length]);

  const errors = { ...derived.errors };
  if (!recipients.length) errors.recipients = rows.some((r) => r.matches) ? 'Select at least one provider in the directory.' : 'No directory provider offers this GPU and count.';
  if (capCheck?.exceeds === 'per_rfq') {
    errors.cap = `Up to ${zecString(capCheck.needed, { maxDecimals: 5 })} ZEC at your max price, fees included, but the per-request cap is ${zecString(capCheck.perRfq)} ZEC. Lower the max price or the duration.`;
  } else if (capCheck?.exceeds === 'total') {
    errors.cap = `Up to ${zecString(capCheck.needed, { maxDecimals: 5 })} ZEC at your max price, fees included, but only ${zecString(capCheck.remaining)} of the ${zecString(capCheck.total)} ZEC total cap is left.`;
  }
  const derivedWithRecipients = { ...derived, errors };

  const disabledReason =
    mode === 'probing'
      ? 'Connecting to your daemons…'
      : mode === 'real' && buyerConn.status !== 'online'
        ? `Buyer daemon not connected (${hostOf(buyerConn.url)}). Requests are built, signed and paid by your buyer daemon.`
        : null;

  const rfqs = useMemo(() => sortedRfqs(rfqMap), [rfqMap]);
  const verifiedCount = (providers ?? []).filter((p) => p.verified).length;

  const submit = async () => {
    const d = getDriver();
    if (!d || derived.count === null || derived.durationS === null || derived.maxPerHour === null) return;
    const base = {
      gpu: form.gpu,
      count: derived.count,
      durationS: derived.durationS,
      maxPricePerHourZats: derived.maxPerHour.toString(),
      discloseMax: form.discloseMax,
      providerIds: recipients.map((p) => p.providerId),
      autoAccept: form.autoAccept
        ? { rule: 'cheapest' as const, waitBlocks: derived.waitBlocks ?? 2, ...(derived.minBond && derived.minBond > 0n ? { minBondZats: derived.minBond.toString() } : {}) }
        : null,
    };
    const req: NewRfqRequest | PresetRfqRequest = demoRules
      ? { ...base, job: { preset: form.preset } }
      : {
          ...base,
          job: {
            path: form.path.trim(),
            command: derived.argv,
            ...(form.image.trim() ? { image: form.image.trim() } : {}),
            ...(derived.env && Object.keys(derived.env).length ? { env: derived.env } : {}),
          },
        };
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { rfqId } = await d.createRfq(req);
      router.push(`/rfq/${rfqId}`);
    } catch (e) {
      setSubmitError(errorMessage(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <MarketHeader
        stats={[
          {
            label: 'Providers',
            value: providers ? <>{verifiedCount} <span className="text-sm font-medium text-muted">verified</span></> : '—',
            sub: providers ? `${providers.length} in directory` : undefined,
          },
          {
            label: 'Shielded balance',
            value: buyerStatus ? <Zec zats={buyerStatus.balance.spendable} maxDecimals={4} /> : '—',
            sub: 'shielded, spendable',
          },
          {
            label: 'Requests',
            value: <>{rfqs.filter((r) => r.state === 'running').length} <span className="text-sm font-medium text-muted">running</span></>,
            sub: `${rfqs.length} total`,
          },
        ]}
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-5">
          <ProviderTable
            rows={rows}
            loading={providers === null && !providersError}
            error={providersError}
            gpu={form.gpu}
            count={count}
            selected={selected}
            onToggle={(id) => {
              setTouched(true);
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onSelectMatching={() => {
              setTouched(true);
              setSelected(new Set(rows.filter((r) => r.matches && r.p.verified).map((r) => r.p.providerId)));
            }}
            onClear={() => {
              setTouched(true);
              setSelected(new Set());
            }}
          />
          <RequestList rfqs={rfqs} loading={!rfqsLoaded} offline={mode === 'real' && buyerConn.status !== 'online'} />
        </div>
        <NewRequestForm
          form={form}
          set={(key, value) => {
            setSubmitError(null);
            if (key === 'gpu' || key === 'count') setGpuTouched(true);
            setForm((f) => {
              const next = { ...f, [key]: value };
              // Picking another preset adopts its GPU and duration (within the demo's limits).
              return key === 'preset' && demoRules ? publicDemoForm(next, demoRules) : next;
            });
          }}
          derived={derivedWithRecipients}
          gpuChoices={gpuOptions(providers)}
          recipients={recipients}
          submitting={submitting}
          submitError={submitError}
          disabledReason={disabledReason}
          onSubmit={submit}
          network={mode === 'probing' ? null : (buyerStatus?.network ?? null)}
          capCheck={capCheck}
          publicDemo={demoRules}
        />
      </div>
    </div>
  );
}
