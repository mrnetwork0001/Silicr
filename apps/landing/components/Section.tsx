import type { ReactNode } from 'react';
import { Reveal } from './motion/Reveal';

/** A long-form section with an anchor, an eyebrow, a heading and a lead paragraph. */
export function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  tone = 'bg',
  split = false,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
  tone?: 'bg' | 'panel';
  /** Heading in a narrow left column, content on the right (wide screens only). */
  split?: boolean;
}) {
  const header = (
    <div data-rv-head className={`relative ${split ? 'lg:sticky lg:top-24' : 'max-w-3xl'}`}>
      <div className="corona" aria-hidden />
      <p className="eyebrow relative">{eyebrow}</p>
      <h2
        id={`${id}-title`}
        className="relative mt-4 text-balance text-[2.25rem] font-[720] leading-[1.06] tracking-[-0.03em] text-white sm:text-[3.4rem]"
      >
        {title}
      </h2>
      {lead && <div className="prose-body relative mt-6 text-pretty text-[17px] leading-relaxed text-body sm:text-[19px]">{lead}</div>}
    </div>
  );
  return (
    <Reveal
      id={id}
      aria-labelledby={`${id}-title`}
      className={`relative isolate overflow-x-clip py-24 sm:py-32 ${tone === 'panel' ? 'section-alt' : ''}`}
    >
      <span className="sec-line" aria-hidden />
      <div className="mx-auto max-w-[1410px] px-4">
        {split ? (
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)] lg:gap-14">
            <div>{header}</div>
            <div data-rv-body className="min-w-0">{children}</div>
          </div>
        ) : (
          <>
            {header}
            <div data-rv-body className="mt-12">{children}</div>
          </>
        )}
      </div>
    </Reveal>
  );
}
