'use client';

import { EyeOff, ScanEye } from '@/components/icons';
import { useMemo } from 'react';
import { formatDuration, gpuLabel, zecString } from '@/lib/format';
import type { CostEstimate } from '@/lib/market';

/** Decorative ciphertext: deterministic hex from the form's inputs, so it changes as you type. Not the real memo. */
function fakeHex(seed: string, chars: number): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let x = h >>> 0 || 1;
  let out = '';
  while (out.length < chars) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += ((x >>> 0) & 0xffff).toString(16).padStart(4, '0');
  }
  return out.slice(0, chars);
}

/** Live "sealed memo" preview: what the chain sees vs what the chosen providers decrypt. */
export function SealedPreview({
  est,
  gpu,
  count,
  durationS,
  maxPerHour,
  discloseMax,
  recipients,
  seed,
}: {
  est: CostEstimate | null;
  gpu: string;
  count: number | null;
  durationS: number | null;
  maxPerHour: bigint | null;
  discloseMax: boolean;
  recipients: number;
  seed: string;
}) {
  const hex = useMemo(() => fakeHex(seed, 96), [seed]);
  const outputs = est?.paddedOutputs ?? 4;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="die-tile min-w-0 rounded-lg p-2.5">
        <div className="flex items-center gap-1.5 text-2xs font-semibold text-muted">
          <EyeOff className="size-3.5" aria-hidden /> What the chain sees
        </div>
        <ul className="mt-1.5 space-y-0.5 text-2xs text-secondary">
          <li>1 shielded transaction</li>
          <li>
            <span className="tabular-nums text-fg">{outputs}</span> padded outputs
          </li>
          <li>
            fee <span className="tabular-nums text-fg">{est ? zecString(est.rfqFee) : '—'}</span> ZEC
          </li>
        </ul>
        <p className="hex-shimmer mt-1.5 break-all font-mono text-[10px] leading-[13px]" aria-label="Encrypted memo (illustration)">
          {hex}
        </p>
      </div>
      <div className="die-tile min-w-0 rounded-lg p-2.5">
        <div className="flex items-center gap-1.5 text-2xs font-semibold text-muted">
          <ScanEye className="size-3.5" aria-hidden /> What the providers see
        </div>
        <ul className="mt-1.5 space-y-0.5 text-2xs text-secondary">
          <li className="text-fg">
            {count ?? '?'}× {gpuLabel(gpu)} · {durationS !== null ? formatDuration(durationS) : '?'}
          </li>
          <li>
            budget{' '}
            {discloseMax ? (
              <span className="text-zec tabular-nums">{maxPerHour !== null ? `${zecString(maxPerHour)} ZEC/h` : '?'}</span>
            ) : (
              <span className="rounded bg-white/[0.05] px-1 italic text-muted">undisclosed</span>
            )}
          </li>
          <li>
            only the <span className="tabular-nums text-fg">{recipients || 'selected'}</span> you picked can decrypt
          </li>
          <li className="text-faint">job bundle: only the winning provider gets it</li>
        </ul>
      </div>
    </div>
  );
}
