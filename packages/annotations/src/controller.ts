/**
 * `AnnotationsController`: one object that wires the annotation layer to an
 * editor handle and a stream of folded `ProjectState`s.
 *
 * - Builds cards from the state and keeps a snapshot for React
 *   (`subscribe` / `getSnapshot`, used by `useSyncExternalStore`).
 * - Draws the layer's decorations with `editor.setDecorations(layer, …, version)`
 *   and feeds the trace-over plugin, retrying when the editor has not caught up
 *   with the state's version yet.
 * - Calls `editor.setTraceSuggestion` while the caret is on a suggestion.
 * - Turns writer actions into events through `editor.submitEvent` (dismiss,
 *   reject, discuss, feedback requests) and `editor.acceptProposal`.
 * - Keeps ghost text off the clipboard.
 *
 * It never changes the manuscript itself.
 */
import { createDecorationLayer, type DecorationLayer, type EditorHandle } from '@longhand/editor';
import type { DismissReason, ProjectState, SurfacedCandidate } from '@longhand/schema';
import type { Plugin } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import type { Mapping } from 'prosemirror-transform';
import { annotationDecorations } from './decorations';
import {
  discussRequested,
  feedbackRequested,
  newId as defaultNewId,
  proposalRejected,
  retryRequest,
  suggestionDismissed,
  type AnnotationEvent,
  type FeedbackRequestInput,
} from './drafts';
import { installGhostClipboardGuard } from './ghost';
import {
  cardsFromState,
  documentNodeOf,
  reviewsFromState,
  type Card,
  type ReviewView,
} from './model';
import { reduceProgress, type ReviewProgressEvent, type SessionProgress } from './progress';
import {
  createTracePlugin,
  type TraceCandidate,
  type TracePlugin,
  type TraceProgress,
} from './trace';

/** The writer clicked "Cite" on a citation-needed flag or a source suggestion. */
export interface CiteRequest {
  /** The card the request came from. */
  cardId: string;
  kind: 'citation-flag' | 'source-suggestion';
  documentId: string;
  /** The library source the AI suggested (source suggestions), or null. */
  sourceId: string | null;
  /** The claim the flag restates, or the suggestion's rationale. */
  claim: string;
  /** Where the claim is, in the editor's local document (null if unknown). */
  range: { from: number; to: number } | null;
}

/** The writer wants to check and add an AI-surfaced candidate to the library. */
export interface AddSourceRequest {
  surfacedId: string;
  candidateIndex: number;
  candidate: SurfacedCandidate;
}

/** A human event the controller submitted (for observers and tests). */
export type SubmittedEvent =
  | AnnotationEvent
  | { type: 'ProposalAccepted'; payload: { proposalId: string; documentId: string } };

/** The current selection, as a feedback scope can use it. */
export interface SelectionScope {
  documentId: string;
  from: number;
  to: number;
  /** The editor's local version (the version the positions are in). */
  version: number;
}

/** Options for {@link AnnotationsController}. */
export interface AnnotationsControllerOptions {
  /** The document the editor shows. */
  documentId: string;
  editor?: EditorHandle | null;
  state?: ProjectState | null;
  /** Opens the host's citation picker. */
  onCite?: (request: CiteRequest) => void;
  /** Lets the writer check an AI-surfaced candidate and add it (`SourceAdded`). */
  onAddSource?: (request: AddSourceRequest) => void;
  /** Called after every event the controller submits. */
  onSubmit?: (event: SubmittedEvent) => void;
  /** Called when the editor refuses an action (no editor attached, wrong document…). */
  onError?: (error: Error) => void;
  /** Id generator for request and thread ids. */
  newId?: () => string;
  /**
   * When word-choice ghost text shows inline: only for the suggestion the caret,
   * pointer or a click is on (`'focus'`, default) or always (`'always'`). Insertion
   * ghosts always show at their point; every ghost also shows on its card.
   */
  inlineGhosts?: 'focus' | 'always';
  /** Install the document-level clipboard guard (default true). */
  clipboardGuard?: boolean;
}

/** What the components render. Immutable; a new object on every change. */
export interface AnnotationsSnapshot {
  readonly state: ProjectState | null;
  readonly documentId: string;
  /** Every card for this document plus unanchored ones, in document order. */
  readonly cards: readonly Card[];
  /** Cards drawn in the margin: open and stale anchored cards, plus ones resolved while open here. */
  readonly marginCards: readonly Card[];
  readonly reviews: readonly ReviewView[];
  readonly progress: Readonly<Record<string, SessionProgress>>;
  readonly activeId: string | null;
  readonly hoverId: string | null;
  /** The suggestion the caret is tracing over. */
  readonly tracingId: string | null;
  readonly trace: TraceProgress | null;
  /** Alternative index the writer picked per word-choice suggestion. */
  readonly preferred: Readonly<Record<string, number>>;
  /** The editor's current non-empty selection, or null. */
  readonly selection: SelectionScope | null;
  /** Bumped whenever the editor's layout may have changed (margin re-measures). */
  readonly layoutTick: number;
  readonly editorAttached: boolean;
}

type Listener = () => void;

/** Wires the annotation layer to an editor and a `ProjectState` stream. */
export class AnnotationsController {
  /** Add these to the editor (`extraPlugins`). Stable for the controller's life. */
  readonly plugins: readonly Plugin[];
  readonly layer: DecorationLayer;
  private readonly trace: TracePlugin;
  private opts: AnnotationsControllerOptions;
  private editor: EditorHandle | null = null;
  private editorUnsubs: Array<() => void> = [];
  private listeners = new Set<Listener>();
  private snap: AnnotationsSnapshot;
  private state: ProjectState | null = null;
  private cards: Card[] = [];
  private everOpen = new Set<string>();
  private recent = new Set<string>();
  private progress: Record<string, SessionProgress> = {};
  private activeId: string | null = null;
  private hoverId: string | null = null;
  private tracingId: string | null = null;
  private traceProgress: TraceProgress | null = null;
  private preferred: Record<string, number> = {};
  private selection: SelectionScope | null = null;
  private layoutTick = 0;
  private pending = false;
  private candidatesKey = '';
  private scheduled = false;
  private uninstallGuard: (() => void) | null = null;
  private connected = 0;

  constructor(opts: AnnotationsControllerOptions) {
    this.opts = opts;
    this.layer = createDecorationLayer('annotations');
    this.trace = createTracePlugin({
      onActiveChange: (id) => {
        this.tracingId = id;
        try {
          this.editor?.setTraceSuggestion(id);
        } catch (err) {
          this.fail(err);
        }
        this.scheduleEmit();
      },
      onProgress: (p) => {
        this.traceProgress = p;
        this.scheduleEmit();
      },
    });
    this.plugins = Object.freeze([this.layer.plugin, this.trace.plugin]);
    this.snap = this.build();
    if (opts.state) this.setState(opts.state);
    if (opts.editor) this.attach(opts.editor);
  }

  // ---------------------------------------------------------------------------
  // Store
  // ---------------------------------------------------------------------------

  /** Subscribes to snapshot changes. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The current snapshot. */
  getSnapshot = (): AnnotationsSnapshot => this.snap;

  private emit(): void {
    this.snap = this.build();
    for (const l of [...this.listeners]) l();
  }

  private emitPending = false;
  private scheduleEmit(): void {
    if (this.emitPending) return;
    this.emitPending = true;
    queueMicrotask(() => {
      this.emitPending = false;
      this.emit();
    });
  }

  private build(): AnnotationsSnapshot {
    const documentId = this.opts.documentId;
    const marginCards = this.cards.filter(
      (c) =>
        c.documentId === documentId &&
        c.anchorPos !== null &&
        (c.phase !== 'resolved' || this.recent.has(c.id)),
    );
    return Object.freeze({
      state: this.state,
      documentId,
      cards: this.cards,
      marginCards,
      reviews: reviewsFromState(this.state),
      progress: this.progress,
      activeId: this.activeId,
      hoverId: this.hoverId,
      tracingId: this.tracingId,
      trace: this.traceProgress,
      preferred: this.preferred,
      selection: this.selection,
      layoutTick: this.layoutTick,
      editorAttached: this.editor !== null,
    });
  }

  // ---------------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------------

  /** Updates callbacks and settings (the document id too). */
  setOptions(opts: Partial<AnnotationsControllerOptions>): void {
    const docChanged = opts.documentId !== undefined && opts.documentId !== this.opts.documentId;
    this.opts = { ...this.opts, ...opts };
    if (docChanged) {
      this.activeId = null;
      this.hoverId = null;
      this.recent.clear();
      this.cards = cardsFromState(this.state, { documentId: this.opts.documentId });
      this.candidatesKey = '';
      this.apply();
      this.emit();
    }
  }

  /**
   * Installs the clipboard guard. `useAnnotations` calls it on mount; without
   * React, call it once after creating the controller. Paired with {@link disconnect}.
   */
  connect(): void {
    this.connected += 1;
    if (this.uninstallGuard || this.opts.clipboardGuard === false) return;
    if (typeof document !== 'undefined') this.uninstallGuard = installGhostClipboardGuard(document);
  }

  /** Undoes one {@link connect}; the last one removes the guard and detaches the editor. */
  disconnect(): void {
    this.connected = Math.max(0, this.connected - 1);
    if (this.connected > 0) return;
    this.uninstallGuard?.();
    this.uninstallGuard = null;
    this.attach(null);
  }

  /** Attaches an editor handle (or detaches with null). */
  attach(editor: EditorHandle | null): void {
    if (editor === this.editor) return;
    for (const u of this.editorUnsubs) u();
    this.editorUnsubs = [];
    if (this.editor && this.tracingId) {
      try {
        this.editor.setTraceSuggestion(null);
      } catch {
        // The old editor may be destroyed already.
      }
    }
    this.editor = editor;
    this.tracingId = null;
    this.traceProgress = null;
    this.candidatesKey = '';
    if (editor) {
      if (editor.documentId !== this.opts.documentId)
        this.opts = { ...this.opts, documentId: editor.documentId };
      this.cards = cardsFromState(this.state, { documentId: this.opts.documentId });
      this.editorUnsubs.push(
        editor.on('update', ({ state, prevState }) => {
          if (state.doc !== prevState.doc || !state.selection.eq(prevState.selection)) {
            this.layoutTick += 1;
            this.trackSelection();
            this.scheduleEmit();
          }
        }),
        editor.on('version', () => {
          if (this.pending) this.scheduleApply();
        }),
      );
      this.trackSelection();
      this.apply();
    }
    this.emit();
  }

  /** The attached editor. */
  editorHandle(): EditorHandle | null {
    return this.editor;
  }

  /** Feeds a new folded state. */
  setState(state: ProjectState | null): void {
    if (state === this.state) return;
    this.state = state;
    const cards = cardsFromState(state, { documentId: this.opts.documentId });
    for (const c of cards) {
      if (c.phase === 'open') this.everOpen.add(c.id);
      else if (c.phase === 'resolved' && this.everOpen.has(c.id)) this.recent.add(c.id);
    }
    this.cards = cards;
    if (this.activeId && !cards.some((c) => c.id === this.activeId)) this.activeId = null;
    // A session's live progress gives way to the ledger once the state has it.
    this.apply();
    this.emit();
  }

  /**
   * Feeds one live progress event (`SessionProgressEvent` from the agent runner,
   * relayed by the server). Agent events name their session; `feedbackSessionId`
   * is only a fallback for events that do not.
   */
  pushProgress(event: ReviewProgressEvent, feedbackSessionId?: string): void {
    const next = reduceProgress(this.progress, event, feedbackSessionId ?? null);
    if (next === this.progress) return;
    this.progress = next;
    this.emit();
  }

  private trackSelection(): void {
    const ed = this.editor;
    if (!ed) {
      this.selection = null;
      return;
    }
    const sel = ed.getState().selection;
    const prev = this.selection;
    if (sel.empty) {
      if (prev) this.selection = null;
      return;
    }
    const version = ed.version().local;
    if (prev && prev.from === sel.from && prev.to === sel.to && prev.version === version) return;
    this.selection = { documentId: ed.documentId, from: sel.from, to: sel.to, version };
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  private scheduleApply(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.apply();
      this.emit();
    });
  }

  private docVersion(): number | null {
    return this.state?.documents[this.opts.documentId]?.version ?? null;
  }

  /** Mapping from the state's document version to the editor's local document. */
  private mapping(): Mapping | null {
    const v = this.docVersion();
    if (v === null || !this.editor) return null;
    try {
      return this.editor.mappingFrom(v);
    } catch {
      return null;
    }
  }

  private apply(): void {
    const ed = this.editor;
    if (!ed) return;
    const documentId = this.opts.documentId;
    const version = this.docVersion();
    const docCards = this.cards.filter((c) => c.documentId === documentId);
    try {
      if (!this.state || version === null) {
        this.layer.clear(ed.view);
        this.setCandidates([], '');
        this.pending = false;
        return;
      }
      const decos = annotationDecorations(
        docCards,
        { activeId: this.activeId, hoverId: this.hoverId },
        documentNodeOf(this.state, documentId),
      );
      const ok = ed.setDecorations(this.layer, decos, version);
      const mapping = this.mapping();
      this.pending = !ok || !mapping;
      if (mapping) this.applyCandidates(docCards, mapping, version);
      this.applyShown(docCards);
      this.layoutTick += 1;
    } catch (err) {
      this.fail(err);
    }
  }

  private applyCandidates(cards: readonly Card[], mapping: Mapping, version: number): void {
    const size = this.editor!.getState().doc.content.size;
    const candidates: TraceCandidate[] = [];
    for (const c of cards) {
      if (c.kind !== 'suggestion' || c.phase !== 'open' || !c.range) continue;
      const s = c.data;
      if (s.kind === 'rephrase') continue;
      const from = mapping.map(c.range.from, s.kind === 'insertion' ? -1 : 1);
      const to = s.kind === 'insertion' ? from : Math.max(from, mapping.map(c.range.to, -1));
      if (from < 0 || to > size) continue;
      candidates.push({
        id: c.id,
        kind: s.kind,
        from,
        to,
        original: s.kind === 'word-choice' ? s.anchor.quote : '',
        ghosts: s.kind === 'word-choice' ? s.alternatives : [s.sentence],
        preferred: this.preferred[c.id] ?? 0,
      });
    }
    const key = `${version}|${this.editor!.version().local}|${candidates
      .map((c) => `${c.id}:${c.from}:${c.to}:${c.preferred}`)
      .join(',')}`;
    this.setCandidates(candidates, key);
  }

  private setCandidates(candidates: readonly TraceCandidate[], key: string): void {
    if (!this.editor || key === this.candidatesKey) return;
    this.candidatesKey = key;
    this.trace.setCandidates(this.editor.view, candidates);
  }

  private applyShown(cards: readonly Card[]): void {
    if (!this.editor) return;
    const always = this.opts.inlineGhosts === 'always';
    const ids = new Set<string>();
    for (const c of cards) {
      if (c.kind !== 'suggestion' || c.data.kind !== 'word-choice' || c.phase !== 'open') continue;
      if (always || c.id === this.activeId || c.id === this.hoverId) ids.add(c.id);
    }
    const cur = this.trace.get(this.editor.getState()).shown;
    if (cur.size === ids.size && [...ids].every((i) => cur.has(i))) return;
    this.trace.setShown(this.editor.view, ids);
  }

  /** Local document position of a card's anchor, or null. */
  anchorPosition(cardId: string): number | null {
    const card = this.cards.find((c) => c.id === cardId);
    if (!card || card.anchorPos === null || !this.editor) return null;
    const traced = this.trace.get(this.editor.getState()).active;
    if (traced && traced.id === cardId) return traced.from;
    const mapping = this.mapping();
    const pos = mapping ? mapping.map(card.anchorPos, 1) : card.anchorPos;
    const size = this.editor.getState().doc.content.size;
    return Math.max(0, Math.min(pos, size));
  }

  /** Local document range of a card's text, or null. */
  localRange(cardId: string): { from: number; to: number } | null {
    const card = this.cards.find((c) => c.id === cardId);
    if (!card?.range || !this.editor) return null;
    const traced = this.trace.get(this.editor.getState()).active;
    if (traced && traced.id === cardId) return { from: traced.from, to: traced.to };
    const mapping = this.mapping();
    const size = this.editor.getState().doc.content.size;
    const clamp = (p: number): number => Math.max(0, Math.min(p, size));
    if (!mapping) return { from: clamp(card.range.from), to: clamp(card.range.to) };
    const from = clamp(mapping.map(card.range.from, 1));
    return { from, to: Math.max(from, clamp(mapping.map(card.range.to, -1))) };
  }

  /**
   * Vertical offset of a card's anchor relative to `container`'s top edge, in CSS
   * pixels, or null if it cannot be measured (no editor, no layout).
   */
  anchorTop(cardId: string, container: Element): number | null {
    const pos = this.anchorPosition(cardId);
    if (pos === null || !this.editor) return null;
    try {
      const r = this.editor.view.coordsAtPos(pos, 1);
      const box = container.getBoundingClientRect();
      if (!Number.isFinite(r.top)) return null;
      return r.top - box.top;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------

  /** Highlights a card's span and scrolls it into view (null clears). */
  focus(cardId: string | null, opts: { scroll?: boolean } = {}): void {
    this.activeId = cardId;
    this.apply();
    this.emit();
    if (!cardId || opts.scroll === false || !this.editor) return;
    const pos = this.anchorPosition(cardId);
    if (pos === null) return;
    try {
      const view = this.editor.view;
      const at = view.domAtPos(pos);
      const node = at.node.nodeType === 3 ? at.node.parentElement : (at.node as Element);
      const el =
        (node?.nodeType === 1 ? (node as Element) : null)?.closest('[data-ann-id]') ?? node;
      const reduce =
        typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      (el as Element | null)?.scrollIntoView?.({
        block: 'center',
        behavior: reduce ? 'auto' : 'smooth',
      });
    } catch {
      // No layout (tests) or position gone.
    }
  }

  /** Marks the card under the pointer (proposal previews, inline ghosts). */
  hover(cardId: string | null): void {
    if (cardId === this.hoverId) return;
    this.hoverId = cardId;
    this.apply();
    this.emit();
  }

  /** Picks which alternative of a word-choice suggestion the ghost shows. */
  chooseAlternative(cardId: string, index: number): void {
    this.preferred = { ...this.preferred, [cardId]: index };
    this.candidatesKey = '';
    this.apply();
    this.emit();
  }

  /**
   * Puts the caret on a suggestion so the writer can trace over it: selects a
   * word-choice span, or places the caret at an insertion point.
   */
  startTrace(cardId: string): boolean {
    const card = this.cards.find((c) => c.id === cardId);
    if (!card || card.kind !== 'suggestion' || card.phase !== 'open' || !this.editor) return false;
    const r = this.localRange(cardId);
    if (!r) return false;
    const view = this.editor.view;
    try {
      const sel =
        card.data.kind === 'insertion'
          ? TextSelection.create(view.state.doc, r.from)
          : TextSelection.create(view.state.doc, r.from, r.to);
      view.dispatch(view.state.tr.setSelection(sel));
      view.focus();
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Actions (human events)
  // ---------------------------------------------------------------------------

  private fail(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    if (this.opts.onError) this.opts.onError(e);
    else console.error('[longhand/annotations]', e);
  }

  private submit(event: AnnotationEvent): boolean {
    const ed = this.editor;
    if (!ed) {
      this.fail(new Error(`no editor attached: cannot submit ${event.type}`));
      return false;
    }
    try {
      // Each branch keeps the type and payload paired for submitEvent's generic.
      switch (event.type) {
        case 'FeedbackRequested':
          ed.submitEvent('FeedbackRequested', event.payload);
          break;
        case 'SuggestionDismissed':
          ed.submitEvent('SuggestionDismissed', event.payload);
          break;
        case 'ProposalRejected':
          ed.submitEvent('ProposalRejected', event.payload);
          break;
        case 'DiscussRequested':
          ed.submitEvent('DiscussRequested', event.payload);
          break;
      }
    } catch (err) {
      this.fail(err);
      return false;
    }
    this.opts.onSubmit?.(event);
    return true;
  }

  private newId(): string {
    return (this.opts.newId ?? defaultNewId)();
  }

  /** Asks for feedback (`FeedbackRequested`). Returns the request id, or null. */
  requestFeedback(input: FeedbackRequestInput): string | null {
    let event;
    try {
      event = feedbackRequested(input, () => this.newId());
    } catch (err) {
      this.fail(err);
      return null;
    }
    return this.submit(event) ? event.payload.requestId : null;
  }

  /** Retries a failed review with the same request. Returns the new request id. */
  retryReview(requestId: string): string | null {
    if (!this.state) return null;
    const event = retryRequest(this.state, requestId, () => this.newId());
    if (!event) return null;
    return this.submit(event) ? event.payload.requestId : null;
  }

  /** Dismisses a card (any kind but proposals) with an optional reason and note. */
  dismiss(
    cardId: string,
    reason: DismissReason | null = null,
    note: string | null = null,
  ): boolean {
    const card = this.cards.find((c) => c.id === cardId);
    if (card?.kind === 'proposal') return this.reject(cardId, reason);
    return this.submit(suggestionDismissed(cardId, reason, note));
  }

  /** Rejects a proposal (`ProposalRejected`). */
  reject(proposalId: string, reason: DismissReason | null = null): boolean {
    return this.submit(proposalRejected(proposalId, reason));
  }

  /** Accepts a proposal in one click (`editor.acceptProposal`). */
  accept(proposalId: string): boolean {
    const ed = this.editor;
    const card = this.cards.find((c) => c.id === proposalId);
    if (!ed || card?.kind !== 'proposal' || card.phase !== 'open') {
      this.fail(new Error(`cannot accept ${proposalId}`));
      return false;
    }
    if (card.data.documentId !== ed.documentId) {
      this.fail(new Error(`proposal ${proposalId} is for another document`));
      return false;
    }
    try {
      ed.acceptProposal(proposalId);
    } catch (err) {
      this.fail(err);
      return false;
    }
    if (this.activeId === proposalId) this.activeId = null;
    this.opts.onSubmit?.({
      type: 'ProposalAccepted',
      payload: { proposalId, documentId: ed.documentId },
    });
    this.apply();
    this.emit();
    return true;
  }

  /** Asks the editor a follow-up about a card (`DiscussRequested`). Returns the thread id. */
  discuss(targetId: string, message: string): string | null {
    let event;
    try {
      event = discussRequested(this.state, targetId, message, () => this.newId());
    } catch (err) {
      this.fail(err);
      return null;
    }
    return this.submit(event) ? event.payload.threadId : null;
  }

  /** Opens the host's citation picker for a flag or a source suggestion. */
  cite(cardId: string): boolean {
    const card = this.cards.find((c) => c.id === cardId);
    if (!card || (card.kind !== 'citation-flag' && card.kind !== 'source-suggestion')) return false;
    if (!this.opts.onCite) return false;
    this.opts.onCite({
      cardId,
      kind: card.kind,
      documentId: card.documentId ?? this.opts.documentId,
      sourceId: card.kind === 'source-suggestion' ? card.data.sourceId : null,
      claim: card.kind === 'citation-flag' ? card.data.claim : card.data.rationale,
      range: this.localRange(cardId),
    });
    return true;
  }

  /** Hands an AI-surfaced candidate to the host so the writer can check and add it. */
  addSource(surfacedId: string, candidateIndex: number): boolean {
    const s = this.state?.annotations.surfacedSources[surfacedId];
    const candidate = s?.candidates[candidateIndex];
    if (!candidate || !this.opts.onAddSource) return false;
    this.opts.onAddSource({ surfacedId, candidateIndex, candidate });
    return true;
  }

  /** True when the host handles Cite / Add source. */
  can(action: 'cite' | 'add-source'): boolean {
    return action === 'cite' ? !!this.opts.onCite : !!this.opts.onAddSource;
  }

  /** Detaches the editor and removes listeners and the clipboard guard. */
  destroy(): void {
    this.connected = 1;
    this.disconnect();
    this.listeners.clear();
  }
}
