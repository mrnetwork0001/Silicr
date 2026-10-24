// Block-time profiles after NU7: testnet runs 25 s blocks, mainnet switches at its NU7 height.
import { describe, expect, it } from 'vitest';
import { MAINNET_NU7_HEIGHT, MAINNET_PROFILE, MEMORY_PROFILE, TESTNET_PROFILE, profileAtHeight } from '../src/profile.ts';

const secs = (blocks: number, blockTimeS: number) => blocks * blockTimeS;

describe('NU7 timing', () => {
  it('testnet: 25 s blocks, same wall-clock windows as the 75 s profile (5 min bid, 25 min accept)', () => {
    expect(TESTNET_PROFILE.blockTimeS).toBe(25);
    expect(secs(TESTNET_PROFILE.bidWindowBlocks, 25)).toBe(secs(4, 75));
    expect(secs(TESTNET_PROFILE.acceptWindowBlocks, 25)).toBe(secs(20, 75));
    expect(profileAtHeight(TESTNET_PROFILE, 10_000_000)).toBe(TESTNET_PROFILE);
  });

  it('mainnet: 75 s blocks before height 3,543,405, 25 s from it on, windows unchanged in wall-clock time', () => {
    expect(MAINNET_NU7_HEIGHT).toBe(3_543_405);
    const before = profileAtHeight(MAINNET_PROFILE, MAINNET_NU7_HEIGHT - 1);
    const after = profileAtHeight(MAINNET_PROFILE, MAINNET_NU7_HEIGHT);
    expect(before).toBe(MAINNET_PROFILE);
    expect(before.blockTimeS).toBe(75);
    expect(after.blockTimeS).toBe(25);
    expect(secs(after.bidWindowBlocks, after.blockTimeS)).toBe(secs(before.bidWindowBlocks, before.blockTimeS));
    expect(secs(after.acceptWindowBlocks, after.blockTimeS)).toBe(secs(before.acceptWindowBlocks, before.blockTimeS));
    // Seconds-based settlement values do not change.
    expect(after.intervalS).toBe(before.intervalS);
    expect(after.graceS).toBe(before.graceS);
  });

  it('profiles without an upgrade are returned as they are', () => {
    expect(profileAtHeight(MEMORY_PROFILE, 5_000_000)).toBe(MEMORY_PROFILE);
  });
});
