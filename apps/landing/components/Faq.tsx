import { ChevronDown } from '@/components/icons';
import type { ReactNode } from 'react';

/** Native <details> disclosures: keyboard and screen-reader support without JavaScript. */
export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  return (
    <div className="faq divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
      {items.map((it) => (
        <details key={it.q} className="group">
          <summary className="flex cursor-pointer items-center justify-between gap-6 px-5 py-4.5 text-left transition-colors hover:bg-hover sm:px-6">
            <h3 className="text-[16px] font-medium leading-snug sm:text-[17px]">{it.q}</h3>
            <ChevronDown className="faq-chevron size-5 shrink-0 text-muted transition-transform duration-200" aria-hidden />
          </summary>
          <div className="prose-body max-w-3xl px-5 pb-5 text-[15.5px] leading-relaxed text-muted sm:px-6">{it.a}</div>
        </details>
      ))}
    </div>
  );
}
