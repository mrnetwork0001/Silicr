'use client';

import { useEffect, useRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';

/**
 * A section that reveals itself once, when it scrolls into view.
 *
 * Server-rendered content is fully visible. Only after hydration, and only when the visitor has not asked for
 * reduced motion, does this add `rv` to the root, which hides the parts still waiting to be revealed:
 *   - `[data-rv-head]`: its direct children rise and unblur in order (eyebrow, heading, lead).
 *   - `[data-rv-body]`: each direct child is a group, observed on its own. Inside a group, list entries
 *     (rows, steps, cards, code blocks) are staggered 75 ms apart; a group with none fades in as a whole.
 * Numbers in `[data-count]` count up as they appear. Bordered panels get a cursor spotlight (`--mx/--my`),
 * and small ones lift on hover.
 */

const ITEM_SELECTOR = [
  'ol > li',
  'ul > li',
  'tbody > tr',
  'dl > div',
  'pre',
  'figure',
  '.faq > details',
  '.grid > *',
  '[data-rv-item]',
].join(',');

const STEP = 0.075;
const MAX_STEPS = 9;
const MAX_DEPTH = 3;

function tagItems(group: HTMLElement): void {
  const seen = new Map<Element, number>(); // per-parent index
  let any = false;
  for (const el of group.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) {
    if (el.closest('svg') || el.classList.contains('sr-only')) continue;
    const parentItem = el.parentElement?.closest<HTMLElement>('.rv-item');
    const inGroup = parentItem && group.contains(parentItem) ? parentItem : null;
    const depth = inGroup ? Number(inGroup.dataset.rvDepth ?? '1') + 1 : 1;
    if (depth > MAX_DEPTH) continue;
    // A grid cell whose parent grid is itself an item (a row laid out as a grid) is not staggered again.
    if (el.parentElement?.classList.contains('grid') && el.parentElement.classList.contains('rv-item')) continue;
    const parent = el.parentElement!;
    const i = seen.get(parent) ?? 0;
    seen.set(parent, i + 1);
    const base = inGroup ? Number(inGroup.style.getPropertyValue('--rv-d').replace('s', '')) + 0.12 : 0.05;
    el.classList.add('rv-item');
    el.dataset.rvDepth = String(depth);
    el.style.setProperty('--rv-d', `${(base + Math.min(i, MAX_STEPS) * STEP).toFixed(3)}s`);
    any = true;
  }
  if (!any) {
    group.classList.add('rv-item');
    group.style.setProperty('--rv-d', '0.05s');
  }
}

function tagPanels(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('.rounded-xl.border, .rounded-2xl.border, .rounded-3xl.border')) {
    if (el.closest('svg') || el.classList.contains('hatch')) continue;
    el.classList.add('spot');
    if (el.offsetWidth > 0 && el.offsetWidth < 760 && el.offsetHeight < 520) el.classList.add('lift');
  }
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

function countUp(el: HTMLElement, delayMs: number): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; text: string }[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (NUMBER.test(t.data)) nodes.push({ node: t, text: t.data });
    NUMBER.lastIndex = 0;
  }
  if (!nodes.length) return;
  const render = (k: number) => {
    for (const { node, text } of nodes) {
      node.data = text.replace(NUMBER, (m) => {
        const commas = m.includes(',');
        const decimals = m.includes('.') ? m.split('.')[1]!.length : 0;
        const v = Number(m.replace(/,/g, '')) * k;
        const s = v.toFixed(decimals);
        if (!commas) return s;
        const [int, frac] = s.split('.');
        return int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
      });
    }
  };
  const restore = () => {
    for (const { node, text } of nodes) node.data = text;
  };
  render(0);
  const dur = 1100;
  window.setTimeout(() => {
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      if (p >= 1) return restore();
      render(1 - (1 - p) ** 3);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, delayMs);
}

export function Reveal({ children, className = '', ...rest }: { children: ReactNode; className?: string } & ComponentPropsWithoutRef<'section'>) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const groups: HTMLElement[] = [];
    const head = root.querySelector<HTMLElement>('[data-rv-head]');
    if (head) {
      let i = 0;
      for (const child of head.children) {
        if (!(child instanceof HTMLElement) || child.classList.contains('corona')) continue;
        child.classList.add('rv-item', 'rv-head-item');
        child.style.setProperty('--rv-d', `${(i++ * 0.09).toFixed(2)}s`);
      }
      groups.push(head);
    }
    const body = root.querySelector<HTMLElement>('[data-rv-body]');
    if (body) {
      for (const child of body.children) {
        if (!(child instanceof HTMLElement)) continue;
        tagItems(child);
        groups.push(child);
      }
    }
    for (const g of groups) g.classList.add('rv-group');
    tagPanels(root);
    root.classList.add('rv');

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const g = e.target as HTMLElement;
          g.classList.add('rv-in');
          root.classList.add('rv-on');
          io.unobserve(g);
          for (const c of g.querySelectorAll<HTMLElement>('[data-count]')) {
            if (c.offsetParent === null) continue;
            const holder = c.closest<HTMLElement>('.rv-item');
            const d = Number((holder?.style.getPropertyValue('--rv-d') ?? '0').replace('s', '')) || 0;
            countUp(c, d * 1000 + 150);
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    );
    for (const g of groups) io.observe(g);

    // Cursor spotlight on panels: one passive listener per section, written once per frame.
    let frame = 0;
    let last: { el: HTMLElement; x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>('.spot');
      if (!el) return;
      const r = el.getBoundingClientRect();
      last = { el, x: e.clientX - r.left, y: e.clientY - r.top };
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!last) return;
          last.el.style.setProperty('--mx', `${last.x}px`);
          last.el.style.setProperty('--my', `${last.y}px`);
        });
    };
    root.addEventListener('pointermove', onMove, { passive: true });

    return () => {
      io.disconnect();
      root.removeEventListener('pointermove', onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section ref={ref} className={className} {...rest}>
      {children}
    </section>
  );
}
