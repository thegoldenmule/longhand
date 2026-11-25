/**
 * `<AnnotationMargin>`: margin cards anchored beside their text. Each card's top
 * follows its anchor in the editor (mapped through every local edit), and cards
 * are stacked so they never overlap. The active card sits exactly at its anchor;
 * its neighbours make room above and below.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AnnotationsController } from '../controller';
import type { Card } from '../model';
import { AnnotationCard, GhostDescriptions } from './cards';
import { useAnnotationsSnapshot } from './hooks';

/** Props of {@link AnnotationMargin}. */
export interface AnnotationMarginProps {
  controller: AnnotationsController;
  /** Space between stacked cards, px. Default 10. */
  gap?: number;
  className?: string;
}

interface Placed {
  top: number;
  anchor: number | null;
}

/** Stacks cards: anchors in order, no overlaps, the active card pinned to its anchor. */
export function layoutCards(
  items: ReadonlyArray<{ id: string; anchor: number | null; height: number }>,
  gap: number,
  activeId: string | null,
): Record<string, number> {
  const sorted = [...items].sort(
    (a, b) => (a.anchor ?? Number.MAX_SAFE_INTEGER) - (b.anchor ?? Number.MAX_SAFE_INTEGER),
  );
  const out: Record<string, number> = {};
  const pin = sorted.findIndex((i) => i.id === activeId && i.anchor !== null);
  const start = pin >= 0 ? pin : 0;
  // Downward from the pinned card (or the first).
  let y = -Infinity;
  for (let i = start; i < sorted.length; i++) {
    const it = sorted[i]!;
    const want = it.anchor ?? (Number.isFinite(y) ? y : 0);
    const top = i === pin ? want : Math.max(want, Number.isFinite(y) ? y : -Infinity);
    out[it.id] = top;
    y = top + it.height + gap;
  }
  // Upward from the pinned card.
  if (pin > 0) {
    let limit = out[sorted[pin]!.id]! - gap;
    for (let i = pin - 1; i >= 0; i--) {
      const it = sorted[i]!;
      const want = it.anchor ?? 0;
      const top = Math.min(want, limit - it.height);
      out[it.id] = top;
      limit = top - gap;
    }
  }
  return out;
}

/** The margin. Place it beside the editor, in the same scrolling container. */
export function AnnotationMargin(props: AnnotationMarginProps): React.JSX.Element | null {
  const { controller, gap = 10 } = props;
  const snap = useAnnotationsSnapshot(controller);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cardEls = useRef(new Map<string, HTMLElement>());
  const [placed, setPlaced] = useState<Record<string, Placed>>({});
  const [tick, setTick] = useState(0);
  // Cards already shown at a position glide when they move; new ones appear in place.
  const shown = useRef(new Set<string>());
  const cards = snap.marginCards;

  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const items = cards.map((c: Card) => ({
      id: c.id,
      anchor: controller.anchorTop(c.id, box),
      height: cardEls.current.get(c.id)?.offsetHeight ?? 0,
    }));
    const tops = layoutCards(items, gap, snap.activeId);
    const next: Record<string, Placed> = {};
    for (const it of items) next[it.id] = { top: tops[it.id] ?? 0, anchor: it.anchor };
    setPlaced((prev) => {
      const same =
        Object.keys(prev).length === Object.keys(next).length &&
        Object.entries(next).every(
          ([k, v]) =>
            prev[k] && Math.abs(prev[k]!.top - v.top) < 0.5 && prev[k]!.anchor === v.anchor,
        );
      return same ? prev : next;
    });
  }, [cards, controller, gap, snap.activeId]);

  useLayoutEffect(measure, [measure, snap.layoutTick, tick]);
  useEffect(() => {
    shown.current = new Set(Object.keys(placed));
  }, [placed]);

  useEffect(() => {
    const onResize = (): void => setTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      for (const el of cardEls.current.values()) ro.observe(el);
      const editorDom = controller.editorHandle()?.view.dom;
      if (editorDom) ro.observe(editorDom);
    }
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, [cards, controller, snap.editorAttached]);

  if (!snap.state)
    return <div ref={boxRef} className={`lh-ann lh-margin ${props.className ?? ''}`} />;

  return (
    <div
      ref={boxRef}
      className={`lh-ann lh-margin${props.className ? ` ${props.className}` : ''}`}
      aria-label="Margin notes"
      role="complementary"
      data-testid="annotation-margin"
    >
      <GhostDescriptions snapshot={snap} />
      {cards.map((card) => {
        const p = placed[card.id];
        return (
          <AnnotationCard
            key={card.id}
            ref={(el: HTMLElement | null) => {
              if (el) cardEls.current.set(card.id, el);
              else cardEls.current.delete(card.id);
            }}
            controller={controller}
            card={card}
            snapshot={snap}
            variant="margin"
            style={{
              position: 'absolute',
              top: p ? `${p.top}px` : '0px',
              visibility: p ? 'visible' : 'hidden',
              ...(shown.current.has(card.id) ? {} : { transition: 'none' }),
            }}
          />
        );
      })}
    </div>
  );
}
