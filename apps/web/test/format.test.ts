import { describe, expect, it } from 'vitest';
import {
  compactValue,
  formatCountdown,
  formatDuration,
  formatZec,
  isRealChain,
  looksLikeAddress,
  looksLikeHex,
  networkLabel,
  paddedOutputsFor,
  parseZec,
  perHourZats,
  splitArgv,
  truncateMiddle,
  zecString,
  zip317Fee,
} from '../lib/format';

describe('ZEC formatting', () => {
  it('is compact: trailing zeros trimmed, up to 8 decimals', () => {
    expect(formatZec('1250000')).toBe('0.0125 ZEC');
    expect(zecString('100000000')).toBe('1');
    expect(zecString('1')).toBe('0.00000001');
    expect(zecString('0')).toBe('0');
    expect(zecString(66667n)).toBe('0.00066667');
  });

  it('groups thousands and rounds half up when limiting decimals', () => {
    expect(zecString(123456789012345n)).toBe('1,234,567.89012345');
    expect(zecString('13333333', { maxDecimals: 4 })).toBe('0.1333');
    expect(zecString('13335000', { maxDecimals: 4 })).toBe('0.1334');
    expect(zecString('99999999', { maxDecimals: 2 })).toBe('1');
  });

  it('treats junk as zero instead of throwing', () => {
    expect(zecString('abc')).toBe('0');
    expect(zecString(undefined)).toBe('0');
  });
});

describe('parseZec', () => {
  it('parses user input exactly, without floats', () => {
    expect(parseZec('0.8')).toBe(80_000_000n);
    expect(parseZec('.5')).toBe(50_000_000n);
    expect(parseZec('12')).toBe(1_200_000_000n);
    expect(parseZec('1,000.25')).toBe(100_025_000_000n);
    expect(parseZec('0.00000001')).toBe(1n);
  });

  it('rejects empty, negative, malformed and over-precise input', () => {
    for (const bad of ['', ' ', '-1', '1.2.3', 'abc', '0.000000001', '1e3']) expect(parseZec(bad)).toBeNull();
  });
});

describe('helpers', () => {
  it('normalises per-interval prices to per hour', () => {
    expect(perHourZats('66667', 4)).toBe(60_000_300n);
    expect(perHourZats('350000', 20)).toBe(63_000_000n);
  });

  it('pads RFQ outputs to fixed buckets (recipients + change)', () => {
    expect(paddedOutputsFor(1)).toBe(4);
    expect(paddedOutputsFor(3)).toBe(4);
    expect(paddedOutputsFor(4)).toBe(8);
    expect(paddedOutputsFor(8)).toBe(16);
  });

  it('computes ZIP 317 fees with two grace actions', () => {
    expect(zip317Fee(2)).toBe(10_000n);
    expect(zip317Fee(1)).toBe(10_000n);
    expect(zip317Fee(8)).toBe(40_000n);
  });

  it('splits command lines like a shell', () => {
    expect(splitArgv('python3 train.py')).toEqual(['python3', 'train.py']);
    expect(splitArgv(`python -c "print('hi there')" --x='a b'`)).toEqual(['python', '-c', "print('hi there')", '--x=a b']);
    expect(splitArgv('  a\\ b  ""  ')).toEqual(['a b', '']);
  });

  it('formats durations and countdowns', () => {
    expect(formatDuration(20)).toBe('20 s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(5400)).toBe('1 h 30 min');
    expect(formatCountdown(12_400)).toBe('0:13');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('truncates machine strings in the middle and leaves prose alone', () => {
    const txid = 'b1e7b90c0fa5580ae91fdb2dfcda6f7366dbcd7a83515b0e817b3279df8567a9';
    expect(truncateMiddle(txid, 6, 4)).toBe('b1e7b9…67a9');
    expect(looksLikeHex(txid)).toBe(true);
    expect(looksLikeHex('760c1a0888f7ee3b04a2dd1ed0bdb67d…')).toBe(true);
    expect(compactValue('not present in any message')).toBe('not present in any message');
    expect(looksLikeAddress('uregtest1xzff9cjzpzvmv5tvttflrz8ptwj4qqrle7720kc3nrl67thrnte5zew82echuqhwdju0was455ukew3z')).toBe(true);
    expect(looksLikeAddress('0.8 ZEC/h')).toBe(false);
  });
});

describe('networks', () => {
  it('labels every network the daemon can report', () => {
    expect(networkLabel('main')).toBe('Zcash mainnet');
    expect(networkLabel('test')).toBe('Zcash testnet');
    expect(networkLabel('regtest')).toBe('Zcash regtest');
    expect(networkLabel('memory')).toBe('Simulated chain');
  });

  it('knows which networks spend coins on a public chain', () => {
    expect(isRealChain('main')).toBe(true);
    expect(isRealChain('test')).toBe(true);
    expect(isRealChain('memory')).toBe(false);
    expect(isRealChain(null)).toBe(false);
  });
});
