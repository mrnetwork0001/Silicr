/**
 * Log plumbing: split stdout/stderr into lines, pull out SILICR_PROGRESS lines,
 * and keep the rest in a bounded buffer that any number of readers can replay
 * from the start.
 */
import { StringDecoder } from 'node:string_decoder';

export const PROGRESS_RE = /^SILICR_PROGRESS\s+step=(\d{1,15})(?:\s.*)?$/;

/** Returns the step if the line is a progress report, else null. */
export function parseProgress(line: string): number | null {
  const m = PROGRESS_RE.exec(line.trim());
  return m ? Number(m[1]) : null;
}

export class LineSplitter {
  private readonly onLine: (line: string) => void;
  private readonly maxLine: number;
  private readonly decoder = new StringDecoder('utf8');
  private buf = '';

  constructor(onLine: (line: string) => void, maxLine = 64 * 1024) {
    this.onLine = onLine;
    this.maxLine = maxLine;
  }

  write(chunk: Buffer): void {
    this.buf += this.decoder.write(chunk);
    let start = 0;
    for (let nl = this.buf.indexOf('\n', start); nl >= 0; nl = this.buf.indexOf('\n', start)) {
      this.emit(this.buf.slice(start, nl));
      start = nl + 1;
    }
    this.buf = this.buf.slice(start);
    while (this.buf.length > this.maxLine) {
      this.emit(this.buf.slice(0, this.maxLine));
      this.buf = this.buf.slice(this.maxLine);
    }
  }

  end(): void {
    this.buf += this.decoder.end();
    if (this.buf.length > 0) this.emit(this.buf);
    this.buf = '';
  }

  private emit(raw: string): void {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // Carriage-return progress bars: keep what a terminal would show.
    const cr = line.lastIndexOf('\r');
    if (cr >= 0) line = line.slice(cr + 1);
    this.onLine(line);
  }
}

export class LogBuffer {
  private readonly maxLines: number;
  private readonly maxChars: number;
  private lines: string[] = [];
  /** Absolute index of lines[0]; grows when old lines are dropped. */
  private base = 0;
  private chars = 0;
  private closed = false;
  private wakers: (() => void)[] = [];

  constructor(maxLines = 50_000, maxChars = 16 * 1024 * 1024) {
    this.maxLines = maxLines;
    this.maxChars = maxChars;
  }

  push(line: string): void {
    if (this.closed) return;
    this.lines.push(line);
    this.chars += line.length;
    let drop = 0;
    while (this.lines.length - drop > this.maxLines || (this.chars > this.maxChars && this.lines.length - drop > 1)) {
      this.chars -= this.lines[drop]!.length;
      drop++;
    }
    if (drop > 0) {
      this.lines = this.lines.slice(drop);
      this.base += drop;
    }
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  /** The most recent n lines. */
  tail(n: number): string[] {
    return this.lines.slice(Math.max(0, this.lines.length - n));
  }

  /** A fresh reader from the oldest retained line; ends after close(). */
  async *read(): AsyncGenerator<string> {
    let i = this.base;
    for (;;) {
      if (i < this.base) i = this.base;
      while (i < this.base + this.lines.length) {
        const line = this.lines[i - this.base]!;
        i++;
        yield line;
        if (i < this.base) i = this.base;
      }
      if (this.closed) return;
      await new Promise<void>((r) => this.wakers.push(r));
    }
  }

  private wake(): void {
    const w = this.wakers;
    this.wakers = [];
    for (const f of w) f();
  }
}
