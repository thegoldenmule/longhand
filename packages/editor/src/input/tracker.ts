/**
 * Tracks real (trusted) user input events so the input guard can decide whether a
 * transaction came from the writer, and how.
 *
 * Listeners are attached in the capture phase on the editor DOM (so they run before
 * ProseMirror's own handlers and also see events from nested footnote editors) and
 * on the owning document (for user activation such as toolbar clicks).
 *
 * Only `event.isTrusted` events count. Unit tests running in jsdom, where every event
 * is synthetic, pass `trustSyntheticEvents: true`.
 */
import { readMarkerFromTransfer, type SliceMarker } from './clipboard';

/** A paste the browser delivered, waiting for ProseMirror's paste transaction. */
export interface PendingPaste {
  at: number;
  mimeTypes: string[];
  marker: SliceMarker | null;
}

/** A drop the browser delivered, waiting for ProseMirror's drop transaction. */
export interface PendingDrop {
  at: number;
  /** The drag started inside this editor (`view.dragging` was set). */
  internal: boolean;
  mimeTypes: string[];
}

export interface InputTrackerOptions {
  /** How long an input event authorizes a following transaction (ms). Default 500. */
  windowMs?: number;
  /** Treat synthetic events as trusted. For jsdom unit tests only. */
  trustSyntheticEvents?: boolean;
  /** Clock (epoch ms). Default `Date.now`. */
  now?: () => number;
  /** Returns true while ProseMirror is dragging a slice from this editor. */
  isDraggingInternally?: () => boolean;
}

/** Snapshot of tracker state, for the classifier. */
export interface TrackerState {
  now: number;
  windowMs: number;
  /** Last trusted keyboard/beforeinput/composition/clipboard/drop event inside the editor. */
  editorInputAt: number;
  /** Last trusted pointer or key event anywhere in the document. */
  activationAt: number;
  /** Text units the writer has typed and no transaction has consumed yet. */
  textBudget: number;
  textBudgetAt: number;
  composing: boolean;
  compositionEndedAt: number;
  /** Length of the latest composition string. */
  compositionLength: number;
  autocorrectAt: number;
  autocorrectLength: number;
  historyAt: number;
  cutAt: number;
  paste: PendingPaste | null;
  drop: PendingDrop | null;
}

const NEVER = -Infinity;

/** Collects trusted input events. One tracker per editor view. */
export class InputTracker {
  readonly windowMs: number;
  private readonly trustSynthetic: boolean;
  private readonly clock: () => number;
  private readonly isDraggingInternally: () => boolean;
  private s: Omit<TrackerState, 'now' | 'windowMs'> = {
    editorInputAt: NEVER,
    activationAt: NEVER,
    textBudget: 0,
    textBudgetAt: NEVER,
    composing: false,
    compositionEndedAt: NEVER,
    compositionLength: 0,
    autocorrectAt: NEVER,
    autocorrectLength: 0,
    historyAt: NEVER,
    cutAt: NEVER,
    paste: null,
    drop: null,
  };

  constructor(opts: InputTrackerOptions = {}) {
    this.windowMs = opts.windowMs ?? 500;
    this.trustSynthetic = opts.trustSyntheticEvents ?? false;
    this.clock = opts.now ?? (() => Date.now());
    this.isDraggingInternally = opts.isDraggingInternally ?? (() => false);
  }

  now(): number {
    return this.clock();
  }

  /** True if the event came from the user agent (or synthetic events are trusted). */
  trusted(e: Event): boolean {
    return e.isTrusted || this.trustSynthetic;
  }

  /** Current state (a copy). */
  state(): TrackerState {
    return { ...this.s, now: this.clock(), windowMs: this.windowMs };
  }

  /** True if a trusted editor input event happened within the window. */
  recentEditorInput(): boolean {
    return this.clock() - this.s.editorInputAt <= this.windowMs;
  }

  /** True if any trusted user activation (editor input, pointer or key anywhere) is recent. */
  recentActivation(): boolean {
    const now = this.clock();
    return (
      now - this.s.editorInputAt <= this.windowMs || now - this.s.activationAt <= this.windowMs
    );
  }

  /** Spends text budget. */
  consumeText(units: number): void {
    this.s.textBudget = Math.max(0, this.s.textBudget - units);
  }

  /** Clears a pending paste (it was used). */
  consumePaste(): void {
    this.s.paste = null;
  }

  /** Clears a pending drop (it was used). */
  consumeDrop(): void {
    this.s.drop = null;
  }

  consumeAutocorrect(): void {
    this.s.autocorrectAt = NEVER;
  }

  /** Records a trusted cut handled by the clipboard code. */
  noteCut(): void {
    const now = this.clock();
    this.s.cutAt = now;
    this.s.editorInputAt = now;
  }

  // ---- event intake (public so tests can feed events directly) -------------

  /** Feeds one DOM event from the editor. */
  handleEditorEvent(e: Event): void {
    if (!this.trusted(e)) return;
    const now = this.clock();
    switch (e.type) {
      case 'keydown': {
        this.s.editorInputAt = now;
        this.s.activationAt = now;
        const k = e as KeyboardEvent;
        if ((k.metaKey || k.ctrlKey) && (k.key === 'z' || k.key === 'Z' || k.key === 'y'))
          this.s.historyAt = now;
        break;
      }
      case 'beforeinput': {
        this.s.editorInputAt = now;
        const ie = e as InputEvent;
        const data = ie.data ?? ie.dataTransfer?.getData('text/plain') ?? '';
        switch (ie.inputType) {
          case 'insertText':
          case 'insertCompositionText':
          case 'insertFromComposition':
          case 'insertTranspose':
          case 'insertFromDictation':
            this.addBudget(data.length, now);
            if (ie.inputType !== 'insertText')
              this.s.compositionLength = Math.max(this.s.compositionLength, data.length);
            break;
          case 'insertReplacementText':
            this.s.autocorrectAt = now;
            this.s.autocorrectLength = data.length;
            this.addBudget(data.length, now);
            break;
          case 'historyUndo':
          case 'historyRedo':
            this.s.historyAt = now;
            break;
          default:
            break;
        }
        break;
      }
      case 'compositionstart':
        this.s.editorInputAt = now;
        this.s.composing = true;
        this.s.compositionLength = 0;
        break;
      case 'compositionupdate':
      case 'compositionend': {
        this.s.editorInputAt = now;
        const data = (e as CompositionEvent).data ?? '';
        this.s.compositionLength = Math.max(this.s.compositionLength, data.length);
        if (e.type === 'compositionend') {
          this.s.composing = false;
          this.s.compositionEndedAt = now;
        }
        break;
      }
      case 'paste': {
        this.s.editorInputAt = now;
        const ce = e as ClipboardEvent;
        const dt = ce.clipboardData;
        this.s.paste = {
          at: now,
          mimeTypes: dt
            ? Array.from(dt.types)
                .slice(0, 20)
                .map((t) => t.slice(0, 100))
            : [],
          marker: dt ? readMarkerFromTransfer(dt) : null,
        };
        break;
      }
      case 'drop': {
        this.s.editorInputAt = now;
        const de = e as DragEvent;
        const dt = de.dataTransfer;
        this.s.drop = {
          at: now,
          internal: this.isDraggingInternally(),
          mimeTypes: dt
            ? Array.from(dt.types)
                .slice(0, 20)
                .map((t) => t.slice(0, 100))
            : [],
        };
        break;
      }
      case 'cut':
      case 'copy':
        this.s.editorInputAt = now;
        break;
      default:
        break;
    }
  }

  /** Feeds one DOM event from the owning document (user activation only). */
  handleDocumentEvent(e: Event): void {
    if (!this.trusted(e)) return;
    this.s.activationAt = this.clock();
  }

  private addBudget(n: number, now: number): void {
    if (now - this.s.textBudgetAt > this.windowMs * 4) this.s.textBudget = 0;
    this.s.textBudget += n;
    this.s.textBudgetAt = now;
  }

  /** Attaches listeners to the editor DOM and its document. Returns a detach function. */
  attach(dom: HTMLElement): () => void {
    const editorEvents = [
      'keydown',
      'beforeinput',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'paste',
      'drop',
      'cut',
      'copy',
    ];
    const onEditor = (e: Event): void => this.handleEditorEvent(e);
    const onDoc = (e: Event): void => this.handleDocumentEvent(e);
    for (const t of editorEvents) dom.addEventListener(t, onEditor, true);
    const doc = dom.ownerDocument;
    const docEvents = ['pointerdown', 'mousedown', 'keydown', 'click', 'touchstart'];
    for (const t of docEvents) doc.addEventListener(t, onDoc, true);
    return () => {
      for (const t of editorEvents) dom.removeEventListener(t, onEditor, true);
      for (const t of docEvents) doc.removeEventListener(t, onDoc, true);
    };
  }
}
