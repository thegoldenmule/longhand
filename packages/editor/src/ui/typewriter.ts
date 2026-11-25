/**
 * Typewriter scrolling: the caret line stays at a fixed height of the viewport
 * (50% by default, 33–60%) and the page scrolls instead.
 *
 * - While "locked" (the writer is typing), every change re-centers instantly, so
 *   the caret holds across soft wraps, Enter, Backspace across lines, IME
 *   composition, paste and remote updates.
 * - A pointer selection, wheel, touch or any scroll the editor did not cause
 *   unlocks: the view never jumps on a click or while the writer scrolls away.
 * - The next keystroke (text input or keyboard caret movement) re-centers with a
 *   ~120 ms ease, or instantly under `prefers-reduced-motion`, and locks again.
 *
 * ProseMirror's own scroll-into-view is suppressed while typewriter mode is on.
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { isRemoteTransaction } from '../input/guard';

/** Typewriter settings. */
export interface TypewriterSettings {
  enabled: boolean;
  /** Caret height as a fraction of the viewport, clamped to 0.33–0.6. */
  caretRatio: number;
}

/** Clamps a caret ratio to the allowed 33–60% range. */
export function clampCaretRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(0.6, Math.max(0.33, r));
}

type Reason = 'input' | 'pointer' | 'remote' | 'settings' | 'none';

interface TypewriterState {
  settings: TypewriterSettings;
  reason: Reason;
  seq: number;
}

/** Plugin key; dispatch `tr.setMeta(typewriterKey, settings)` to change settings. */
export const typewriterKey = new PluginKey<TypewriterState>('longhand-typewriter');

export interface TypewriterOptions {
  settings: TypewriterSettings;
  /** The element that scrolls (default: the window). */
  scrollContainer?: () => HTMLElement | Window | null;
  /** Re-center duration (ms). Default 120. */
  durationMs?: number;
}

function reasonOf(tr: Transaction): Reason {
  if (tr.getMeta(typewriterKey)) return 'settings';
  if (tr.getMeta('pointer')) return 'pointer';
  if (isRemoteTransaction(tr)) return 'remote';
  if (tr.docChanged || tr.scrolledIntoView) return 'input';
  return 'none';
}

function isWindow(x: HTMLElement | Window): x is Window {
  return (x as Window).window === x;
}

/** Controls scrolling for one view. Exposed for tests via {@link typewriterControllerOf}. */
export class TypewriterController {
  locked = true;
  private ignoreUntil = 0;
  private anim: number | null = null;
  private unsubs: Array<() => void> = [];

  constructor(
    private view: EditorView,
    private opts: TypewriterOptions,
  ) {
    const target = this.container();
    const win = view.dom.ownerDocument.defaultView;
    const onScroll = (): void => {
      if (performance.now() > this.ignoreUntil && this.anim === null) this.locked = false;
    };
    const onWheel = (): void => this.unlock();
    target.addEventListener('scroll', onScroll, { passive: true });
    target.addEventListener('wheel', onWheel, { passive: true });
    target.addEventListener('touchmove', onWheel, { passive: true });
    const onResize = (): void => {
      if (this.locked) this.center(false);
    };
    win?.addEventListener('resize', onResize);
    this.unsubs.push(() => {
      target.removeEventListener('scroll', onScroll);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('touchmove', onWheel);
      win?.removeEventListener('resize', onResize);
    });
  }

  private settings(): TypewriterSettings {
    return typewriterKey.getState(this.view.state)?.settings ?? this.opts.settings;
  }

  container(): HTMLElement | Window {
    return this.opts.scrollContainer?.() ?? this.view.dom.ownerDocument.defaultView ?? window;
  }

  unlock(): void {
    this.locked = false;
    this.cancel();
  }

  private cancel(): void {
    if (this.anim !== null) {
      cancelAnimationFrame(this.anim);
      this.anim = null;
    }
  }

  /** The caret's vertical center in viewport coordinates, or null. */
  caretY(): number | null {
    const { head } = this.view.state.selection;
    try {
      const r = this.view.coordsAtPos(head);
      return (r.top + r.bottom) / 2;
    } catch {
      return null;
    }
  }

  /** The target line in viewport coordinates. */
  targetY(): number {
    const c = this.container();
    const ratio = clampCaretRatio(this.settings().caretRatio);
    if (isWindow(c)) {
      const h = c.visualViewport?.height ?? c.innerHeight;
      return h * ratio;
    }
    const rect = c.getBoundingClientRect();
    return rect.top + c.clientTop + c.clientHeight * ratio;
  }

  private scrollTop(): number {
    const c = this.container();
    return isWindow(c) ? c.scrollY : c.scrollTop;
  }

  private setScrollTop(y: number): void {
    const c = this.container();
    this.ignoreUntil = performance.now() + 100;
    if (isWindow(c)) c.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior });
    else c.scrollTop = y;
  }

  /** Re-centers the caret line (animated or instantly). */
  center(animate: boolean): void {
    if (!this.settings().enabled) return;
    const y = this.caretY();
    if (y === null) return;
    const delta = y - this.targetY();
    if (Math.abs(delta) < 0.5) return;
    this.cancel();
    const from = this.scrollTop();
    const to = from + delta;
    const reduced = this.view.dom.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const duration = this.opts.durationMs ?? 120;
    if (!animate || reduced || duration <= 0) {
      this.setScrollTop(to);
      return;
    }
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      this.setScrollTop(from + (to - from) * eased);
      if (t < 1) this.anim = requestAnimationFrame(step);
      else {
        this.anim = null;
        // Content may have moved during the animation; settle exactly.
        const y2 = this.caretY();
        if (y2 !== null && Math.abs(y2 - this.targetY()) >= 0.5) this.setScrollTop(this.scrollTop() + y2 - this.targetY());
      }
    };
    this.anim = requestAnimationFrame(step);
  }

  update(state: EditorState, prev: EditorState): void {
    const cur = typewriterKey.getState(state);
    const old = typewriterKey.getState(prev);
    if (!cur || cur === old || cur.seq === old?.seq) return;
    if (!cur.settings.enabled) return;
    switch (cur.reason) {
      case 'pointer':
        this.unlock();
        break;
      case 'input':
        this.center(!this.locked);
        this.locked = true;
        break;
      case 'remote':
      case 'settings':
        if (this.locked) this.center(false);
        break;
      case 'none':
        break;
    }
  }

  destroy(): void {
    this.cancel();
    for (const u of this.unsubs) u();
  }
}

const controllers = new WeakMap<EditorView, TypewriterController>();

/** The controller attached to a view (for tests and the React wrapper). */
export function typewriterControllerOf(view: EditorView): TypewriterController | undefined {
  return controllers.get(view);
}

/** Creates the typewriter scrolling plugin. */
export function typewriterPlugin(opts: TypewriterOptions): Plugin<TypewriterState> {
  return new Plugin<TypewriterState>({
    key: typewriterKey,
    state: {
      init: () => ({ settings: { ...opts.settings }, reason: 'none', seq: 0 }),
      apply(tr, value) {
        const meta = tr.getMeta(typewriterKey) as Partial<TypewriterSettings> | undefined;
        const settings = meta ? { ...value.settings, ...meta } : value.settings;
        const reason = reasonOf(tr);
        if (reason === 'none' && !meta) return value;
        return { settings, reason, seq: value.seq + 1 };
      },
    },
    props: {
      handleScrollToSelection(view) {
        return typewriterKey.getState(view.state)?.settings.enabled ?? false;
      },
    },
    view(view) {
      const c = new TypewriterController(view, opts);
      controllers.set(view, c);
      return {
        update: (v, prev) => c.update(v.state, prev),
        destroy: () => {
          c.destroy();
          controllers.delete(view);
        },
      };
    },
  });
}
