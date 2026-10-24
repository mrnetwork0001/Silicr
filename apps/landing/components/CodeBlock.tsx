import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton';

export interface CommandLine {
  cmd: string;
  /** Shown above the command as a shell comment; never copied. */
  note?: string;
}

/**
 * A terminal snippet with a copy button. Only the commands are copied: no
 * prompts and no comments (zsh doesn't treat # as a comment interactively).
 * Long commands wrap with a hanging indent instead of scrolling out of view.
 */
export function CodeBlock({ title, lines, footer }: { title: string; lines: CommandLine[]; footer?: ReactNode }) {
  const text = lines.map((l) => l.cmd).join('\n');
  return (
    <figure className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[var(--shadow-pop)]">
      <figcaption className="flex items-center justify-between gap-3 border-b border-line bg-black/40 py-2 pl-4 pr-2">
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex shrink-0 gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-accent/80 shadow-[0_0_8px_var(--accent)]" />
          </span>
          <span className="truncate font-mono text-[12px] font-medium text-muted">{title}</span>
        </span>
        <CopyButton text={text} label={`Copy commands: ${title}`} />
      </figcaption>
      <pre className="px-4 py-4 text-[13px] leading-6 text-fg">
        <code className="block space-y-3">
          {lines.map((l, i) => (
            <span key={i} className="block">
              {l.note && <span className="block whitespace-pre-wrap text-muted [overflow-wrap:anywhere]"># {l.note}</span>}
              <span className="flex gap-2">
                <span className="shrink-0 select-none text-accent" aria-hidden>
                  $
                </span>
                <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{l.cmd}</span>
              </span>
            </span>
          ))}
        </code>
      </pre>
      {footer && <div className="mt-auto border-t border-line px-4 py-3 text-[13.5px] leading-relaxed text-muted">{footer}</div>}
    </figure>
  );
}
