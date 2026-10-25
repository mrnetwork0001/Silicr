import { describe, expect, it } from 'vitest';
import type { StatusDto } from '@silicr/api';
import type { RequestFormState } from '../components/market/NewRequestForm';
import { derive, publicDemoForm, publicDemoRules } from '../lib/request-form';
import { readDeal } from './fixtures/load';

const FORM: RequestFormState = {
  gpu: 'a100',
  count: '4',
  duration: '1',
  unit: 'h',
  maxZec: '0.8',
  path: './examples/tiny-train',
  command: 'python3 train.py',
  image: '',
  env: 'SILICR_STEPS=200',
  autoAccept: false,
  discloseMax: false,
  waitBlocks: '2',
  minBond: '',
  preset: '',
};

const demoStatus: StatusDto = {
  ...readDeal().buyerStatus,
  publicDemo: true,
  presets: [
    { id: 'tiny-train', title: 'Tiny training run', description: 'A character-level model, ~2 min', command: ['python3', 'train.py'], gpu: 'a100', durationS: 600 },
    { id: 'tiny-train-short', title: 'Short run', description: '60 steps', command: ['python3', 'train.py'], gpu: 'cpu', durationS: 300 },
  ],
  publicDemoLimits: { maxDurationS: 900, maxCount: 1, maxActive: 1, perIpPerHour: 3, maxPricePerHourZats: '50000000' },
};

describe('the request form on your own daemon', () => {
  it('needs a folder and a command, and parses env', () => {
    const d = derive(FORM);
    expect(d.errors).toEqual({});
    expect(d.argv).toEqual(['python3', 'train.py']);
    expect(d.env).toEqual({ SILICR_STEPS: '200' });
    expect(derive({ ...FORM, path: ' ', command: '' }).errors).toMatchObject({ path: 'Required', command: 'Required' });
    expect(publicDemoRules(readDeal().buyerStatus)).toBeNull();
  });
});

describe('the request form on a public demo daemon', () => {
  const rules = publicDemoRules(demoStatus)!;

  it('reads the presets and limits from /api/status', () => {
    expect(rules.presets.map((p) => p.id)).toEqual(['tiny-train', 'tiny-train-short']);
    expect(rules.limits?.maxDurationS).toBe(900);
  });

  it('opens on the first preset, clamped to the limits, auto-accepting after one block', () => {
    const f = publicDemoForm(FORM, rules);
    expect(f.preset).toBe('tiny-train');
    expect(f.gpu).toBe('a100');
    expect(f.count).toBe('1');
    expect([f.duration, f.unit]).toEqual(['10', 'min']);
    // An abandoned manual request would hold the demo's single slot: auto-accept is on by default.
    expect([f.autoAccept, f.waitBlocks]).toEqual([true, '1']);
    expect(derive(f, rules).waitBlocks).toBe(1);
    expect(derive(f, rules).errors).toEqual({});
    // Another preset adopts its GPU and duration, and leaves the visitor's auto-accept choice alone.
    const g = publicDemoForm({ ...f, preset: 'tiny-train-short', autoAccept: false }, rules, { keepAutoAccept: true });
    expect([g.gpu, g.duration, g.autoAccept]).toEqual(['cpu', '5', false]);
    expect(publicDemoForm({ ...f, autoAccept: false }, rules).autoAccept).toBe(true);
  });

  it('ignores folder, command and env, and refuses anything over the limits', () => {
    const f = publicDemoForm(FORM, rules);
    const d = derive({ ...f, path: '', command: '', env: 'not a pair' }, rules);
    expect(d.errors).toEqual({});
    expect(d.argv).toEqual([]);
    expect(d.env).toBeNull();
    expect(derive({ ...f, duration: '16' }, rules).errors.duration).toBe('At most 15 min in the public demo');
    expect(derive({ ...f, count: '2' }, rules).errors.count).toBe('At most 1 in the public demo');
    expect(derive({ ...f, preset: 'rm-rf' }, rules).errors.preset).toBe('Pick an example job');
  });
});

describe('the public demo price ceiling', () => {
  const rules = publicDemoRules(demoStatus)!;
  it('clamps the max price to the demo ceiling and refuses more', () => {
    const f = publicDemoForm({ ...FORM, maxZec: '0.8' }, rules);
    expect(f.maxZec).toBe('0.5');
    expect(derive(f, rules).errors.maxZec).toBeUndefined();
    expect(derive({ ...f, maxZec: '0.6' }, rules).errors.maxZec).toBe('At most 0.5 ZEC/h in the public demo');
    expect(publicDemoForm({ ...FORM, maxZec: '0.1' }, rules).maxZec).toBe('0.1');
  });
});
