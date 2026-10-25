// Server-side example jobs for a public demo daemon (`silicr daemon --public-demo`): visitors pick
// one by id; the folder, command and environment never come from the browser.
import { fileURLToPath } from 'node:url';
import type { JobPresetDto } from '@silicr/api';

export interface JobPreset extends JobPresetDto {
  /** Job directory on the daemon's machine. */
  path: string;
  env?: Record<string, string>;
}

/** The repo's examples/ directory (packages/engine/src → ../../../examples). */
export const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples/', import.meta.url));

export const DEFAULT_PRESETS: JobPreset[] = [
  {
    id: 'tiny-train',
    title: 'Tiny training run',
    description: 'examples/tiny-train: a character-level bigram language model, 200 SGD steps (~20 s), with checkpoints; returns model.json, metrics.json and sample.txt.',
    command: ['python3', 'train.py'],
    gpu: 'a100',
    durationS: 600,
    path: `${EXAMPLES_DIR}tiny-train`,
    env: { SILICR_STEPS: '200', SILICR_STEP_DELAY_MS: '100' },
  },
  {
    id: 'tiny-train-quick',
    title: 'Quick training run',
    description: 'examples/tiny-train with 60 steps (~2 s): the shortest end-to-end deal.',
    command: ['python3', 'train.py'],
    gpu: 'a100',
    durationS: 300,
    path: `${EXAMPLES_DIR}tiny-train`,
    env: { SILICR_STEPS: '60', SILICR_STEP_DELAY_MS: '30' },
  },
  {
    id: 'tiny-train-long',
    title: 'Long training run',
    description: 'examples/tiny-train with 2000 steps (~8 min): long enough to watch several interval payments land on chain and to try the "stop paying" fault and the watchdog.',
    command: ['python3', 'train.py'],
    gpu: 'a100',
    durationS: 900,
    path: `${EXAMPLES_DIR}tiny-train`,
    env: { SILICR_STEPS: '2000', SILICR_STEP_DELAY_MS: '250' },
  },
];

/** Provider interval in the public demo: short enough that a ~8 min job shows several PAY transactions (the testnet profile's 300 s would show one). */
export const PUBLIC_DEMO_INTERVAL_S = 60;

/** What a client sees: no paths, no env. */
export function presetDto(p: JobPreset): JobPresetDto {
  return { id: p.id, title: p.title, description: p.description, command: [...p.command], gpu: p.gpu, durationS: p.durationS };
}
