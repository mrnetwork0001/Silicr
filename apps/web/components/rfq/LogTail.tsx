'use client';

import clsx from 'clsx';
import { ArrowDown, Lock, SquareTerminal } from '@/components/icons';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Empty, Panel } from '../ui';

function lineTone(line: string): string {
  if (/\[watchdog\]|stopp|missing|error|fail/i.test(line)) return 'text-warn';
  if (/checkpoint|writing|done in|resum/i.test(line)) return 'text-accent';
  if (/^\[\d\d:\d\d:\d\d\] silicr-runner|^\[runner\]/.test(line)) return 'text-muted';
  return 'text-fg';
}

export function LogTail({ lines, live, subtitle }: { lines: string[]; live: boolean; subtitle?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Job log <span className="font-normal tabular-nums text-muted">{lines.length} lines</span>
        </span>
      }
      subtitle={subtitle ?? 'Sealed by the provider, decrypted here. The relay only ever stores ciphertext.'}
      actions={
        <span className="flex items-center gap-1 text-2xs text-faint">
          <Lock className="size-3" aria-hidden /> end-to-end encrypted
        </span>
      }
    >
      {!lines.length ? (
        <Empty icon={<SquareTerminal className="size-6" />} title={live ? 'Waiting for the first log lines…' : 'No log output'}>
          Lines appear here as the provider streams them.
        </Empty>
      ) : (
        <div className="relative">
          <div
            ref={box}
            className="thin-scroll h-[300px] overflow-auto bg-sunken px-4 py-3 font-mono text-[12px] leading-[1.55]"
            role="log"
            aria-live="off"
            aria-label="Job log"
            tabIndex={0}
          >
            {lines.map((l, i) => (
              <div key={i} className={clsx('whitespace-pre-wrap break-all', lineTone(l))}>
                {l}
              </div>
            ))}
            {live && <span className="inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-accent" aria-hidden />}
          </div>
          {!follow && (
            <button
              type="button"
              onClick={() => setFollow(true)}
              className="absolute bottom-3 right-4 inline-flex items-center gap-1 rounded-md border border-line-strong bg-raised px-2 py-1 text-2xs text-fg shadow-[var(--shadow-pop)] hover:bg-hover"
            >
              <ArrowDown className="size-3" aria-hidden /> Follow
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}
