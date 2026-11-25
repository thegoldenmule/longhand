import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { BinderArea } from '@longhand/schema';

/** Joins class names, skipping falsy ones. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/** The drag-and-drop MIME type binder components put on the data transfer. */
export const BINDER_DRAG_MIME = 'application/x-longhand-binder';

/** Human labels for the two binder areas. */
export const AREA_LABELS: Readonly<Record<BinderArea, string>> = {
  manuscript: 'Manuscript',
  notes: 'Notes',
};

/** `‘title’` with typographic quotes, for messages and labels. */
export function quoted(title: string): string {
  return `‘${title}’`;
}

/** Formats a word count for display. */
export function formatCount(n: number): string {
  const s = String(n);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A polite live region. `announce` replaces the message; repeated identical messages
 * are re-announced by toggling a trailing no-break space.
 */
export function useAnnouncer(): [string, (message: string) => void] {
  const [message, setMessage] = useState('');
  const announce = useCallback((next: string) => {
    setMessage((prev) => (prev === next ? `${next}\u00a0` : next));
  }, []);
  return [message, announce];
}

/** Renders the live region for {@link useAnnouncer}. */
export function LiveRegion({ message }: { message: string }) {
  return (
    <div className="lh-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

/**
 * Focuses an element after the next render that contains it. Elements register via
 * the returned `register(key)` ref callback; `focusSoon(key)` requests focus.
 */
export function useDeferredFocus() {
  const elements = useRef(new Map<string, HTMLElement>());
  const pending = useRef<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const key = pending.current;
    if (key === null) return;
    const el = elements.current.get(key);
    if (el?.isConnected) {
      pending.current = null;
      if (document.activeElement !== el) el.focus();
    }
  });

  const register = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) elements.current.set(key, el);
    },
    [],
  );

  const focusSoon = useCallback((key: string) => {
    pending.current = key;
    setTick((t) => t + 1);
  }, []);

  return { register, focusSoon, tick };
}

/** Starts a drag carrying a binder key. jsdom and old browsers may lack `dataTransfer`. */
export function startDrag(e: DragEvent, key: string) {
  const dt = e.dataTransfer as DataTransfer | null | undefined;
  if (!dt) return;
  try {
    dt.setData(BINDER_DRAG_MIME, key);
    dt.setData('text/plain', '');
    dt.effectAllowed = 'move';
  } catch {
    // Some environments refuse setData outside a trusted drag; the components track the drag themselves.
  }
}

/** Marks a dragover as an allowed move. */
export function allowDrop(e: DragEvent) {
  e.preventDefault();
  const dt = e.dataTransfer as DataTransfer | null | undefined;
  if (dt) {
    try {
      dt.dropEffect = 'move';
    } catch {
      // ignore
    }
  }
}

/** Where along an axis the pointer sits within the event's current target (0..1). */
export function pointerFraction(e: DragEvent, axis: 'x' | 'y'): number {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const size = axis === 'y' ? rect.height : rect.width;
  if (!size) return 0.5;
  const offset = axis === 'y' ? e.clientY - rect.top : e.clientX - rect.left;
  return Math.min(Math.max(offset / size, 0), 1);
}
