// Terminal formatting: ZEC as decimals, short ids, timestamps and colored tags.
import pc from 'picocolors';
import { formatZec } from '@silicr/engine';

export { pc };

export function zec(z: bigint | string | number): string {
  return `${formatZec(BigInt(z))} ZEC`;
}

export function short(s: string | undefined, n = 10): string {
  if (!s) return '-';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function clock(at = Date.now()): string {
  return new Date(at).toTimeString().slice(0, 8);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function duration(s: number): string {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${+(s / 60).toFixed(1)} min`;
  return `${+(s / 3600).toFixed(2)} h`;
}

type Paint = (s: string) => string;

const TAGS: Record<string, Paint> = {
  rfq: pc.cyan,
  bid: pc.blue,
  accept: pc.green,
  pay: pc.green,
  hb: pc.dim,
  job: pc.magenta,
  log: pc.dim,
  result: pc.green,
  close: pc.bold,
  chain: pc.yellow,
  provider: pc.magenta,
  watchdog: pc.red,
  fault: pc.red,
  error: pc.red,
  info: pc.dim,
};

/** "12:00:01 PAY      text" */
export function event(tag: string, text: string, at = Date.now()): void {
  const paint = TAGS[tag] ?? ((s: string) => s);
  console.log(`${pc.dim(clock(at))} ${paint(tag.toUpperCase().padEnd(8))} ${text}`);
}

export function kv(rows: [string, string][], indent = 2): void {
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`${' '.repeat(indent)}${pc.dim(k.padEnd(w))}  ${v}`);
}

export function table(head: string[], rows: string[][]): void {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c + ' '.repeat(Math.max(0, widths[i]! - stripAnsi(c).length))).join('  ');
  console.log(`  ${pc.dim(fmt(head))}`);
  for (const r of rows) console.log(`  ${fmt(r)}`);
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function fail(message: string): never {
  console.error(`${pc.red('error')} ${message}`);
  process.exit(1);
}
