'use client';

import { Check, RotateCcw, Save } from '@/components/icons';
import { useEffect, useMemo, useState } from 'react';
import type { ProviderPolicyDto } from '@silicr/api';
import { errorMessage } from '@/lib/client';
import { getDriver } from '@/lib/driver';
import { formatDuration, gpuLabel, parseZec, toZats, zecString, zip317Fee } from '@/lib/format';
import { Button, Empty, ErrorNote, Field, Input, Panel, Skeleton, Switch } from '../ui';

interface Draft {
  autoBid: boolean;
  minZec: string;
  intervalS: string;
  graceS: string;
}

const toDraft = (p: ProviderPolicyDto): Draft => ({
  autoBid: p.autoBid,
  minZec: zecString(p.minPricePerHourZats, { group: false }),
  intervalS: String(p.intervalS),
  graceS: String(p.graceS),
});

const PRESETS = [60, 300, 600];

export function PolicyEditor({ policy, disabled }: { policy: ProviderPolicyDto | null; disabled: string | null }) {
  const [draft, setDraft] = useState<Draft | null>(policy ? toDraft(policy) : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const policyKey = policy ? JSON.stringify(policy) : '';

  // Follow the daemon's policy until the user starts editing.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (policy && !dirty) setDraft(toDraft(policy));
    // policyKey stands in for the policy's contents.
  }, [policyKey, dirty]);

  const parsed = useMemo(() => {
    if (!draft) return null;
    const min = parseZec(draft.minZec);
    const interval = /^\d+$/.test(draft.intervalS) ? Number(draft.intervalS) : NaN;
    const grace = /^\d+$/.test(draft.graceS) ? Number(draft.graceS) : NaN;
    const errors: Partial<Record<keyof Draft, string>> = {};
    if (min === null || min <= 0n) errors.minZec = 'A positive amount';
    if (!Number.isInteger(interval) || interval < 1) errors.intervalS = 'Whole seconds ≥ 1';
    if (!Number.isInteger(grace) || grace < 0) errors.graceS = 'Whole seconds ≥ 0';
    return { min, interval, grace, errors };
  }, [draft]);

  if (!policy || !draft || !parsed) {
    return (
      <Panel title="Bidding policy">
        {disabled ? (
          <Empty title="Policy unavailable">{disabled}</Empty>
        ) : (
          <div className="space-y-3 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        )}
      </Panel>
    );
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDirty(true);
    setSaved(false);
    setError(null);
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  };

  const patch: Partial<ProviderPolicyDto> = {};
  if (draft.autoBid !== policy.autoBid) patch.autoBid = draft.autoBid;
  if (parsed.min !== null && parsed.min.toString() !== policy.minPricePerHourZats) patch.minPricePerHourZats = parsed.min.toString();
  if (Number.isInteger(parsed.interval) && parsed.interval !== policy.intervalS) patch.intervalS = parsed.interval;
  if (Number.isInteger(parsed.grace) && parsed.grace !== policy.graceS) patch.graceS = parsed.grace;
  const changed = Object.keys(patch).length > 0;
  const valid = Object.keys(parsed.errors).length === 0;

  const save = async () => {
    const d = getDriver();
    if (!d || !changed || !valid) return;
    setSaving(true);
    setError(null);
    try {
      const next = await d.updatePolicy(patch);
      setDraft(toDraft(next));
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // The trade-off the architecture asks us to print: exposure per interval vs. fees.
  const perHour = parsed.min ?? toZats(policy.minPricePerHourZats);
  const intervalS = Number.isInteger(parsed.interval) && parsed.interval > 0 ? parsed.interval : policy.intervalS;
  const atRisk = (perHour * BigInt(intervalS)) / 3600n;
  const paysPerHour = Math.ceil(3600 / intervalS);
  const feesPerHour = zip317Fee(2) * BigInt(paysPerHour);

  return (
    <Panel title="Bidding policy" subtitle="Applied to every RFQ this daemon decrypts">
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span>
            <span className="block text-xs font-medium text-fg">Auto-bid</span>
            <span className="block text-2xs text-faint">Answer matching RFQs with a signed bid at your floor price</span>
          </span>
          <Switch checked={draft.autoBid} onChange={(v) => set('autoBid', v)} label="Auto-bid" disabled={!!disabled} />
        </label>

        <Field label="Minimum price" htmlFor="pol-min" error={parsed.errors.minZec}>
          <Input id="pol-min" inputMode="decimal" value={draft.minZec} onChange={(e) => set('minZec', e.target.value)} suffix="ZEC/h" disabled={!!disabled} className="tabular-nums" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Interval"
            htmlFor="pol-int"
            error={parsed.errors.intervalS}
            trailing={
              <span className="flex gap-1">
                {PRESETS.map((s) => (
                  <button key={s} type="button" disabled={!!disabled} onClick={() => set('intervalS', String(s))} className="rounded px-1 text-2xs text-accent hover:bg-accent-soft">
                    {s / 60}m
                  </button>
                ))}
              </span>
            }
          >
            <Input id="pol-int" inputMode="numeric" value={draft.intervalS} onChange={(e) => set('intervalS', e.target.value.replace(/[^\d]/g, ''))} suffix="s" disabled={!!disabled} className="tabular-nums" />
          </Field>
          <Field label="Grace" htmlFor="pol-grace" error={parsed.errors.graceS} hint="Late payment → pause, then stop">
            <Input id="pol-grace" inputMode="numeric" value={draft.graceS} onChange={(e) => set('graceS', e.target.value.replace(/[^\d]/g, ''))} suffix="s" disabled={!!disabled} className="tabular-nums" />
          </Field>
        </div>

        <div className="rounded-md border border-line bg-sunken/60 p-3 text-2xs leading-relaxed text-muted">
          At <span className="text-fg">{zecString(perHour)} ZEC/h</span>, buyers prepay at most about one {formatDuration(intervalS)} interval ahead (
          <span className="text-fg">{zecString(atRisk)} ZEC</span>), and pay about{' '}
          <span className="text-fg">{zecString(feesPerHour)} ZEC/h</span> in fees ({paysPerHour} payments an hour). Shorter intervals: less prepaid,
          more fees.
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-muted">GPUs offered</div>
          <div className="flex flex-wrap gap-1">
            {policy.gpus.map((g, i) => (
              <span key={i} className="rounded border border-line-strong bg-raised px-1.5 py-0.5 text-2xs text-fg">
                {g.count}× {gpuLabel(g.model)}
                {g.vramGb ? ` · ${g.vramGb} GB` : ''}
              </span>
            ))}
          </div>
        </div>

        {error && <ErrorNote title="Policy not saved">{error}</ErrorNote>}
        {disabled && <p className="text-2xs text-warn">{disabled}</p>}
        <div className="flex items-center justify-end gap-2">
          {saved && !changed && (
            <span className="mr-auto flex items-center gap-1 text-2xs text-ok">
              <Check className="size-3" aria-hidden /> Saved
            </span>
          )}
          <Button
            icon={<RotateCcw className="size-3" aria-hidden />}
            disabled={!changed || saving}
            onClick={() => {
              setDraft(toDraft(policy));
              setDirty(false);
              setError(null);
            }}
          >
            Reset
          </Button>
          <Button type="submit" variant="primary" icon={<Save className="size-3" aria-hidden />} disabled={!changed || !valid || !!disabled} loading={saving}>
            Save policy
          </Button>
        </div>
      </form>
    </Panel>
  );
}
