// The mainnet go-ahead: say what a command is about to commit and the cap, then ask (or need --yes).
import { createInterface } from 'node:readline/promises';
import type { StatusDto } from '@silicr/api';
import { fail, pc, zec } from './format.ts';

export const MAINNET_TAG = 'Zcash mainnet · REAL ZEC';

/** "cap: spent X of Y ZEC (per request ≤ Z ZEC)" from StatusDto.spendCap. */
export function capLine(cap: StatusDto['spendCap']): string {
  if (!cap) return 'cap: NONE';
  return `cap: spent ${zec(cap.spentZats)} of ${zec(cap.totalZats)} (per request ≤ ${zec(cap.perRfqZats)})`;
}

/** The network as `silicr status` shows it. */
export function networkLabel(network: string): string {
  if (network === 'main') return pc.red(MAINNET_TAG);
  if (network === 'test') return 'Zcash testnet';
  if (network === 'memory') return pc.yellow('memory: SIMULATED chain');
  return network;
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * On mainnet: print "This commits up to X ZEC of real funds (cap: …)", then ask "Continue? [y/N]" on a
 * terminal, or require --yes when there is none. Anything but a yes sends nothing. A no-op elsewhere.
 */
export async function confirmMainnet(s: StatusDto, commits: string, yes: boolean | undefined): Promise<void> {
  if (s.network !== 'main') return;
  console.log(`\n  ${pc.red(MAINNET_TAG)}  ${commits} (${capLine(s.spendCap)}).`);
  if (yes) {
    console.log(`  ${pc.dim('--yes given: continuing')}`);
    return;
  }
  if (!isInteractive()) fail('real funds need an explicit go-ahead: re-run with --yes to confirm this amount (no terminal to ask on)');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (await rl.question('  Continue? [y/N] ')).trim().toLowerCase();
  } finally {
    rl.close();
  }
  if (answer !== 'y' && answer !== 'yes') fail('cancelled: nothing was sent');
}
