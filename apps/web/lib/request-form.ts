/**
 * The New request form's validation, and the public demo's rules for it (presets instead of a
 * folder/command/env, bounded duration and count). Pure: tested in test/request-form.test.ts.
 */
import type { JobPresetDto, StatusDto } from '@silicr/api';
import type { RequestFormDerived, RequestFormState } from '@/components/market/NewRequestForm';
import { parseZec, splitArgv } from './format';

/** What a public-demo buyer daemon allows (StatusDto.publicDemo): server-side presets and request limits. */
export interface PublicDemoRules {
  presets: JobPresetDto[];
  limits: NonNullable<StatusDto['publicDemoLimits']> | null;
}

export function publicDemoRules(status: StatusDto | null): PublicDemoRules | null {
  if (!status?.publicDemo) return null;
  return { presets: Array.isArray(status.presets) ? status.presets : [], limits: status.publicDemoLimits ?? null };
}

/** The form as a public demo opens it: the first preset, at most the demo's limits. */
export function publicDemoForm(f: RequestFormState, rules: PublicDemoRules): RequestFormState {
  const preset = rules.presets.find((p) => p.id === f.preset) ?? rules.presets[0];
  const maxS = rules.limits?.maxDurationS ?? 900;
  const durS = Math.min(preset?.durationS ?? maxS, maxS);
  const maxCount = rules.limits?.maxCount ?? 1;
  return {
    ...f,
    preset: preset?.id ?? '',
    gpu: preset?.gpu ?? f.gpu,
    count: String(Math.min(Math.max(1, Number(f.count) || 1), maxCount)),
    duration: String(Math.max(1, Math.round(durS / 60))),
    unit: 'min',
  };
}

export function derive(f: RequestFormState, demo: PublicDemoRules | null = null): RequestFormDerived {
  const errors: RequestFormDerived['errors'] = {};
  const count = /^\d+$/.test(f.count) ? Number(f.count) : null;
  if (count === null || count < 1 || count > 64) errors.count = '1 to 64';
  const dur = Number(f.duration);
  const durationS = Number.isFinite(dur) && dur > 0 ? Math.round(dur * (f.unit === 'h' ? 3600 : 60)) : null;
  if (durationS === null) errors.duration = 'Enter a duration';
  else if (durationS < 60) errors.duration = 'At least 1 minute';
  else if (durationS > 30 * 86400) errors.duration = 'At most 30 days';
  const maxPerHour = parseZec(f.maxZec);
  if (maxPerHour === null || maxPerHour <= 0n) errors.maxZec = 'A positive amount, ≤ 8 decimals';
  if (demo) {
    // Public demo: the daemon runs one of its own example jobs; folder, command, image and env are not sent.
    if (!demo.presets.some((p) => p.id === f.preset)) errors.preset = 'Pick an example job';
    const maxS = demo.limits?.maxDurationS;
    if (maxS && durationS !== null && durationS > maxS) errors.duration = `At most ${Math.floor(maxS / 60)} min in the public demo`;
    const maxCount = demo.limits?.maxCount;
    if (maxCount && count !== null && count > maxCount) errors.count = `At most ${maxCount} in the public demo`;
  } else if (!f.path.trim()) errors.path = 'Required';
  const argv = demo ? [] : splitArgv(f.command.trim());
  if (!demo && !argv.length) errors.command = 'Required';
  let env: Record<string, string> | null = null;
  if (!demo && f.env.trim()) {
    env = {};
    for (const pair of splitArgv(f.env.replace(/,/g, ' '))) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(pair);
      if (!m) {
        errors.env = `Not KEY=VALUE: ${pair}`;
        break;
      }
      env[m[1]!] = m[2]!;
    }
  }
  let waitBlocks: number | null = null;
  let minBond: bigint | null = null;
  if (f.autoAccept) {
    waitBlocks = /^\d+$/.test(f.waitBlocks) ? Number(f.waitBlocks) : null;
    if (waitBlocks === null || waitBlocks > 100) errors.waitBlocks = '0 to 100';
    if (f.minBond.trim()) {
      minBond = parseZec(f.minBond);
      if (minBond === null) errors.minBond = 'Invalid amount';
    }
  }
  return {
    count,
    durationS: errors.duration ? null : durationS,
    maxPerHour: errors.maxZec ? null : maxPerHour,
    minBond,
    waitBlocks,
    argv,
    env,
    errors,
  };
}
