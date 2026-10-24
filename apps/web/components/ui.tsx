'use client';

import clsx from 'clsx';
import { Check, Copy, ExternalLink, Loader2 } from '@/components/icons';
import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { compactValue, formatZec, truncateMiddle, zecString, type ZatsLike } from '@/lib/format';

// ---------------------------------------------------------------------------
// Buttons

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-semibold transition-[color,background-color,box-shadow,border-color]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'xs' && 'h-6 px-2 text-2xs',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'btn-primary',
        variant === 'secondary' && 'btn-outline',
        variant === 'ghost' && 'text-secondary hover:bg-hover hover:text-white',
        variant === 'danger' && 'border border-bad/40 bg-bad-soft text-bad hover:border-bad/70',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Badges and dots

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'zec' | 'real';

const toneClass: Record<Tone, string> = {
  neutral: 'border-line-strong bg-white/[0.03] text-secondary',
  accent: 'border-accent-line bg-accent-soft text-accent',
  ok: 'border-ok/30 bg-ok-soft text-ok',
  warn: 'border-warn/30 bg-warn-soft text-warn',
  bad: 'border-bad/30 bg-bad-soft text-bad',
  zec: 'border-zec/30 bg-zec-soft text-zec',
  /** Real mainnet funds: solid red, the loudest chip. */
  real: 'border-real bg-real font-bold text-white shadow-[0_0_14px_rgba(229,72,77,0.55)]',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  title,
  icon,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
  icon?: ReactNode;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-2xs font-medium leading-none',
        toneClass[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

const dotTone: Record<Tone, string> = {
  neutral: 'text-faint',
  accent: 'text-accent',
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  zec: 'text-zec',
  real: 'text-real',
};

export function Dot({ tone = 'neutral', pulse, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx('inline-block size-1.5 shrink-0 rounded-full bg-current', dotTone[tone], pulse && 'live-dot', className)}
    />
  );
}

export function Kbd({ children, className, inverted }: { children: ReactNode; className?: string; inverted?: boolean }) {
  return (
    <kbd
      className={clsx(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md border px-1 font-mono text-[10px] font-medium leading-none',
        inverted ? 'border-current/40 text-current' : 'border-line-strong bg-sunken text-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------------------
// Panels

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={id} className={clsx('glass-panel min-w-0 rounded-xl border border-line', className)}>
      {(title || actions) && (
        <header className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-2">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-[650] tracking-[-0.01em] text-fg">{title}</h2>}
            {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('min-w-0', className)}>
      <div className="section-label text-[10px] text-muted">{label}</div>
      <div className="mt-0.5 truncate text-base font-semibold tabular-nums text-fg">{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// States

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-faint', className)} aria-label="Loading" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={clsx('block animate-pulse rounded bg-hover', className)} />;
}

export function Empty({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon && <div className="text-faint">{icon}</div>}
      <div className="text-sm font-medium text-fg">{title}</div>
      {children && <div className="max-w-md text-xs text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorNote({ title = 'Something went wrong', children, className }: { title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div role="alert" className={clsx('rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad', className)}>
      <div className="font-semibold">{title}</div>
      {children && <div className="mt-0.5 break-words text-bad/90">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Money

/** A shielded ZEC amount: peach, tabular figures. */
export function Zec({
  zats,
  className,
  unit = true,
  maxDecimals,
  suffix,
  muted,
  proportional,
}: {
  zats: ZatsLike;
  className?: string;
  unit?: boolean;
  maxDecimals?: number;
  suffix?: string;
  muted?: boolean;
  /** Proportional figures for big standalone values; tabular (default) for columns. */
  proportional?: boolean;
}) {
  return (
    <span className={clsx('whitespace-nowrap', !proportional && 'tabular-nums', className)} title={formatZec(zats)}>
      <span className={muted ? 'text-muted' : 'text-zec'}>{zecString(zats, { maxDecimals })}</span>
      {unit && <span className="text-faint"> ZEC{suffix ?? ''}</span>}
      {!unit && suffix && <span className="text-faint">{suffix}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Copyable machine strings

export function useCopy(timeoutMs = 1200): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = useCallback(
    (text: string) => {
      const done = () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), timeoutMs);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done, () => undefined);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          done();
        } catch {
          // ignore
        }
        ta.remove();
      }
    },
    [timeoutMs],
  );
  return [copied, copy];
}

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copy(text);
      }}
      className={clsx(
        'inline-flex size-5 shrink-0 items-center justify-center rounded text-faint transition-colors hover:bg-hover hover:text-fg',
        className,
      )}
      aria-label={copied ? 'Copied' : `${label}: ${text}`}
      title={copied ? 'Copied' : label}
    >
      {copied ? <Check className="size-3 text-ok" aria-hidden /> : <Copy className="size-3" aria-hidden />}
    </button>
  );
}

/** Monospace, middle-truncated hash/address with a copy button and optional external link. */
export function Mono({
  value,
  head,
  tail,
  copy = true,
  href,
  className,
  full,
}: {
  value: string;
  head?: number;
  tail?: number;
  copy?: boolean;
  href?: string | null;
  className?: string;
  /** Don't truncate. */
  full?: boolean;
}) {
  const shown = full ? value : head !== undefined || tail !== undefined ? truncateMiddle(value, head ?? 6, tail ?? 4) : compactValue(value);
  return (
    <span className={clsx('inline-flex min-w-0 items-center gap-0.5 align-middle', className)}>
      <span className="truncate font-mono text-[0.92em] tracking-tight" title={value}>
        {shown}
      </span>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-accent"
          aria-label="Open in a third-party block explorer (it will see this txid and your browser's IP)"
          title="Opens a third-party block explorer: it will see this txid and your browser's IP"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
      {copy && <CopyButton text={value} />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Form controls

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
  trailing,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className={clsx('min-w-0', className)}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
          {label}
        </label>
        {trailing}
      </div>
      {children}
      {error ? <p className="mt-1 text-2xs text-bad">{error}</p> : hint ? <p className="mt-1 text-2xs text-faint">{hint}</p> : null}
    </div>
  );
}

const controlClass =
  'h-8 w-full min-w-0 rounded-lg border border-line-strong bg-black px-2.5 text-sm text-fg placeholder:text-faint transition-colors hover:border-faint focus:border-accent focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; suffix?: ReactNode }>(
  function Input({ className, invalid, suffix, ...rest }, ref) {
    if (suffix) {
      return (
        <div className="relative">
          <input ref={ref} className={clsx(controlClass, 'pr-14', invalid && 'border-bad/60', className)} {...rest} />
          <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-faint">{suffix}</span>
        </div>
      );
    }
    return <input ref={ref} className={clsx(controlClass, invalid && 'border-bad/60', className)} {...rest} />;
  },
);

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(controlClass, 'appearance-none bg-[length:10px] bg-[right_0.6rem_center] bg-no-repeat pr-7', className)} style={{ backgroundImage: CHEVRON }} {...rest}>
      {children}
    </select>
  );
}

const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' fill='none' stroke='%238d8d92' stroke-width='1.5'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E\")";

export function Switch({
  checked,
  onChange,
  label,
  id,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50',
        checked ? 'border-accent bg-accent' : 'border-line-strong bg-sunken',
      )}
    >
      <span
        className={clsx(
          'inline-block size-3 rounded-full shadow-sm transition-transform',
          checked ? 'translate-x-[15px] bg-accent-fg' : 'translate-x-[2px] bg-faint',
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tables

export function Th({ children, className, align = 'left' }: { children?: ReactNode; className?: string; align?: 'left' | 'right' | 'center' }) {
  return (
    <th
      scope="col"
      className={clsx(
        'section-label h-8 whitespace-nowrap px-3 text-[10px] text-muted first:pl-4 last:pr-4',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, align = 'left', colSpan }: { children?: ReactNode; className?: string; align?: 'left' | 'right' | 'center'; colSpan?: number }) {
  return (
    <td
      colSpan={colSpan}
      className={clsx(
        'h-10 whitespace-nowrap px-3 align-middle first:pl-4 last:pr-4',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}
