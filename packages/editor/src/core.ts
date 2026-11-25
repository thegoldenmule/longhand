/**
 * `createEditorView`: the framework-free editor core. Mounts a ProseMirror view
 * over the Longhand schema, wires the input guard, capture, batching and sync,
 * typewriter scrolling, focus mode and word counts, and returns a handle.
 */
import {
  EMPTY_DOC_JSON,
  docFromJSON,
  inlineTextBetween,
  schema,
  type CommitDraft,
  type CommitDraftOf,
  type EventPayloads,
  type PMNodeJSON,
} from '@longhand/schema';
import { dropCursor } from 'prosemirror-dropcursor';
import { history } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, Selection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { Mapping } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import { editorInputRules, editorKeymaps } from './commands';
import type { DecorationLayer, LayerDecoration } from './decorations';
import { encodeMarker, MARKER_MIME, stampMarker, type SliceMarker } from './input/clipboard';
import type { InputTag } from './input/classify';
import { createInputGuard, inputTagOf, isRemoteTransaction, type GuardViolation, type InputGuard } from './input/guard';
import { DocumentSync, type SubmittableEventType, type SyncError, type SyncStatus, type VersionChange } from './sync/engine';
import { sharedFlusher, type CommitFlusher } from './sync/flusher';
import { createCommitQueue, type CommitQueue } from './sync/queue';
import type { CommitTransport } from './sync/transport';
import { nodes } from './nodes';
import { focusKey, focusPlugin, type FocusMode } from './ui/focus';
import { footnoteNodeView } from './ui/footnote';
import { clampCaretRatio, typewriterKey, typewriterPlugin } from './ui/typewriter';
import { Emitter, newId } from './util';
import { WordCounter, type DailyStorage, type WordCounts } from './wordCount';

/** Writer-facing editor settings. */
export interface EditorSettings {
  /** Typewriter scrolling on/off. Default on. */
  typewriter: boolean;
  /** Caret line height as a fraction of the viewport (0.33–0.6). Default 0.5. */
  caretRatio: number;
  /** Focus mode. Default off. */
  focusMode: FocusMode;
  /** Daily word goal, or null. */
  dailyGoal: number | null;
}

/** Default settings. */
export const DEFAULT_SETTINGS: Readonly<EditorSettings> = Object.freeze({
  typewriter: true,
  caretRatio: 0.5,
  focusMode: 'off',
  dailyGoal: null,
});

/** Options for {@link createEditorView}. */
export interface CreateEditorOptions {
  /** Element the editor mounts into. */
  mount: HTMLElement;
  projectId: string;
  documentId: string;
  /** Human actor id (the signed-in user id). */
  actorId: string;
  /** Device id (random per browser install). Default: persisted in localStorage. */
  deviceId?: string;
  /** Editor session id. Default: random per load. */
  sessionId?: string;
  /** Initial document JSON (default: one empty paragraph) and its ledger version. */
  doc?: PMNodeJSON;
  version?: number;
  transport: CommitTransport;
  /** Outbound queue. Default: one IndexedDB queue per project, shared by editors in this page. */
  queue?: CommitQueue;
  /** Flusher. Default: the shared flusher for queue + transport. */
  flusher?: CommitFlusher;
  settings?: Partial<EditorSettings>;
  /**
   * Extra ProseMirror plugins (decoration layers, annotation UI, provenance tint…).
   * They may add decorations, node views, props and listeners. They cannot change
   * the manuscript: the input guard refuses any doc change no user input explains.
   */
  extraPlugins?: readonly Plugin[];
  /** Element that scrolls for typewriter mode (default: the window). */
  scrollContainer?: () => HTMLElement | Window | null;
  editable?: boolean;
  /** Batching: idle ms (default 2000) and step limit (default 50). */
  batch?: { idleMs?: number; maxSteps?: number };
  /** Input guard policy. Default `refuse` in development, `flag` in production. */
  inputPolicy?: 'refuse' | 'flag';
  /** Treat synthetic DOM events as user input. **Tests only.** */
  trustSyntheticEvents?: boolean;
  /** Words written today before this editor opened (otherwise tracked in localStorage). */
  dailyBaseline?: number;
  dailyStorage?: DailyStorage | null;
  /** Extra attributes for the editable element (e.g. `aria-label`). */
  attributes?: Record<string, string>;
  onWordCount?: (counts: WordCounts) => void;
  onStatus?: (status: SyncStatus) => void;
  onVersion?: (change: VersionChange) => void;
  onError?: (error: SyncError) => void;
  onViolation?: (v: GuardViolation) => void;
  onDraft?: (draft: CommitDraft) => void;
}

/** Arguments of the `update` event. */
export interface EditorUpdate {
  state: EditorState;
  prevState: EditorState;
  transactions: readonly Transaction[];
}

/** Events a handle emits. */
export interface EditorEvents {
  update: EditorUpdate;
  version: VersionChange;
  status: SyncStatus;
  wordCount: WordCounts;
  draft: CommitDraft;
  error: SyncError;
  violation: GuardViolation;
  /** A local, guard-tagged doc change was captured. */
  input: { tr: Transaction; tag: InputTag };
}

/** The editor handle. */
export interface EditorHandle {
  readonly view: EditorView;
  readonly projectId: string;
  readonly documentId: string;
  /** Resolves once queued drafts from an earlier page load were restored. */
  readonly ready: Promise<void>;
  getState(): EditorState;
  /** Ledger-confirmed and local (including unacknowledged steps) versions. */
  version(): { confirmed: number; local: number };
  /** Mapping from a ledger version to the current local document (null if unknown). */
  mappingFrom(version: number): Mapping | null;
  status(): SyncStatus;
  wordCounts(): WordCounts;
  settings(): EditorSettings;
  setSettings(settings: Partial<EditorSettings>): void;
  /** Replaces the extra plugins. */
  setExtraPlugins(plugins: readonly Plugin[]): void;
  /** Sets a decoration layer's decorations, given in positions at ledger `version` (default: current doc). */
  setDecorations(layer: DecorationLayer, decorations: readonly LayerDecoration[], version?: number): boolean;
  /** Marks typed input as tracing over a suggestion (adds `traceSuggestionId` to typed runs). */
  setTraceSuggestion(suggestionId: string | null): void;
  /** Inserts a citation node at the caret (Cite command). Needs a user gesture. Returns the citation id. */
  insertCitation(args: { sourceId: string; locator?: string | null }): string | null;
  /** Places a saved clipping as a quote block after the current block. Needs a user gesture. */
  insertClipping(args: { clippingId: string; sourceId: string; locator?: string | null; text: string }): boolean;
  /** Accepts a proposal (queues `ProposalAccepted` at the local version). */
  acceptProposal(proposalId: string): CommitDraftOf<'ProposalAccepted'>;
  /** Submits another human event through the ordered queue (flushes pending steps first). */
  submitEvent<K extends SubmittableEventType>(type: K, payload: EventPayloads[K]): CommitDraftOf<K>;
  /** Commits the collecting batch now. */
  flush(): void;
  /** Caret rectangle in viewport coordinates. */
  caretRect(): { top: number; bottom: number; left: number; right: number } | null;
  on<E extends keyof EditorEvents>(event: E, listener: (value: EditorEvents[E]) => void): () => void;
  setEditable(editable: boolean): void;
  focus(): void;
  destroy(): void;
}

const queues = new Map<string, CommitQueue>();

/** The default queue for a project (one per page). */
export function defaultQueue(projectId: string): CommitQueue {
  let q = queues.get(projectId);
  if (!q) queues.set(projectId, (q = createCommitQueue(projectId)));
  return q;
}

function defaultDeviceId(): string {
  try {
    const key = 'longhand:deviceId';
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = newId();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return newId();
  }
}

/** Creates an editor. */
export function createEditorView(opts: CreateEditorOptions): EditorHandle {
  let settings: EditorSettings = {
    ...DEFAULT_SETTINGS,
    ...opts.settings,
  };
  settings.caretRatio = clampCaretRatio(settings.caretRatio);
  const projectId = opts.projectId;
  const documentId = opts.documentId;
  const queue = opts.queue ?? defaultQueue(projectId);
  const flusher = opts.flusher ?? sharedFlusher(queue, opts.transport);
  const events = {
    update: new Emitter<EditorUpdate>(),
    version: new Emitter<VersionChange>(),
    status: new Emitter<SyncStatus>(),
    wordCount: new Emitter<WordCounts>(),
    draft: new Emitter<CommitDraft>(),
    error: new Emitter<SyncError>(),
    violation: new Emitter<GuardViolation>(),
    input: new Emitter<{ tr: Transaction; tag: InputTag }>(),
  };

  const guard: InputGuard = createInputGuard({
    projectId,
    ...(opts.inputPolicy ? { policy: opts.inputPolicy } : {}),
    ...(opts.trustSyntheticEvents ? { trustSyntheticEvents: true } : {}),
    onViolation: (v) => events.violation.emit(v),
  });

  const root = document.createElement('div');
  root.className = 'lh-editor';
  root.style.setProperty('--lh-caret-ratio', String(settings.caretRatio));
  opts.mount.appendChild(root);

  // `view` and `sync` are created below; these closures only run after that.
  const handleCopy = (pmView: EditorView, event: ClipboardEvent, cut: boolean, offset = 0): boolean => {
    if (!guard.tracker.trusted(event) || !event.clipboardData) return false;
    const sel = pmView.state.selection;
    if (sel.empty) return false;
    const from = sel.from + offset;
    const to = sel.to + offset;
    const { dom, text } = pmView.serializeForClipboard(sel.content());
    const inline = inlineTextBetween(view.state.doc, from, to, '\n');
    const { copyId, textHash } = sync.sliceCopied(from, to, cut, inline);
    const marker: SliceMarker = { v: 1, copyId, projectId, documentId, textHash };
    stampMarker(dom, marker);
    event.preventDefault();
    const data = event.clipboardData;
    data.clearData();
    data.setData('text/html', dom.innerHTML);
    data.setData('text/plain', text);
    try {
      data.setData(MARKER_MIME, encodeMarker(marker));
    } catch {
      // Some browsers refuse custom types; the HTML attribute still carries the marker.
    }
    if (cut) {
      guard.tracker.noteCut();
      pmView.dispatch(pmView.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
    }
    return true;
  };

  const clipboardPlugin = new Plugin({
    props: {
      handleDOMEvents: {
        copy: (v, e) => handleCopy(v, e as ClipboardEvent, false),
        cut: (v, e) => handleCopy(v, e as ClipboardEvent, true),
      },
    },
  });

  const corePlugins: Plugin[] = [
    guard.plugin,
    editorInputRules(guard),
    ...editorKeymaps(guard),
    history({ newGroupDelay: 800 }),
    dropCursor({ class: 'lh-dropcursor' }),
    clipboardPlugin,
    typewriterPlugin({
      settings: { enabled: settings.typewriter, caretRatio: settings.caretRatio },
      ...(opts.scrollContainer ? { scrollContainer: opts.scrollContainer } : {}),
    }),
    focusPlugin(settings.focusMode),
  ];
  let extraPlugins: readonly Plugin[] = opts.extraPlugins ?? [];

  const initialDoc: PMNode = docFromJSON(opts.doc ?? EMPTY_DOC_JSON);
  const state = guard.createState({ doc: initialDoc, schema, plugins: [...corePlugins, ...extraPlugins] });
  const counter = new WordCounter(initialDoc, {
    documentId,
    dailyGoal: settings.dailyGoal,
    ...(opts.dailyBaseline !== undefined ? { dailyBaseline: opts.dailyBaseline } : {}),
    ...(opts.dailyStorage !== undefined ? { storage: opts.dailyStorage } : {}),
  });

  let countTimer: ReturnType<typeof setTimeout> | null = null;
  const emitCounts = (): void => {
    countTimer = null;
    if (destroyed) return;
    const c = counter.counts(view.state);
    opts.onWordCount?.(c);
    events.wordCount.emit(c);
  };
  const scheduleCounts = (): void => {
    if (countTimer === null) countTimer = setTimeout(emitCounts, 60);
  };

  let destroyed = false;
  const dispatchTransaction = (tr: Transaction): void => {
    if (destroyed) return;
    const prevState = view.state;
    const { state: next, transactions } = prevState.applyTransaction(tr);
    view.updateState(next);
    for (const t of transactions) {
      if (!t.docChanged || isRemoteTransaction(t)) continue;
      const tag = inputTagOf(t);
      if (!tag) continue;
      sync.capture(t, tag);
      events.input.emit({ tr: t, tag });
    }
    if (next !== prevState) {
      if (next.doc !== prevState.doc || !next.selection.eq(prevState.selection)) scheduleCounts();
      events.update.emit({ state: next, prevState, transactions });
    }
  };

  let editable = opts.editable ?? true;
  const view: EditorView = new EditorView(root, {
    state,
    dispatchTransaction,
    editable: () => editable,
    attributes: { class: 'lh-manuscript', spellcheck: 'true', ...(opts.attributes ?? {}) },
    nodeViews: { footnote: footnoteNodeView((v, e, cut, offset) => handleCopy(v, e, cut, offset)) },
  });

  const sync: DocumentSync = new DocumentSync({
    projectId,
    documentId,
    actorId: opts.actorId,
    deviceId: opts.deviceId ?? defaultDeviceId(),
    sessionId: opts.sessionId ?? newId(),
    version: opts.version ?? 0,
    transport: opts.transport,
    queue,
    flusher,
    ...(opts.batch?.idleMs !== undefined ? { idleMs: opts.batch.idleMs } : {}),
    ...(opts.batch?.maxSteps !== undefined ? { maxSteps: opts.batch.maxSteps } : {}),
    host: {
      getState: () => view.state,
      applyRemote: (tr) => dispatchTransaction(guard.markRemote(tr)),
      resetDoc: (doc) => {
        const head = Math.min(view.state.selection.head, doc.content.size);
        const fresh = guard.createState({
          doc,
          schema,
          plugins: view.state.plugins,
          selection: Selection.near(doc.resolve(head)),
        });
        view.updateState(fresh);
        scheduleCounts();
      },
    },
  });

  const unsubs: Array<() => void> = [
    sync.status.on((s) => {
      opts.onStatus?.(s);
      events.status.emit(s);
    }),
    sync.versions.on((v) => {
      opts.onVersion?.(v);
      events.version.emit(v);
    }),
    sync.drafts.on((d) => {
      opts.onDraft?.(d);
      events.draft.emit(d);
    }),
    sync.errors.on((e) => {
      opts.onError?.(e);
      events.error.emit(e);
    }),
    opts.onViolation ? events.violation.on(opts.onViolation) : () => undefined,
  ];

  const onHide = (): void => sync.flush();
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') sync.flush();
  };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVisibility);

  const ready = sync.restore().then(
    () => {
      scheduleCounts();
    },
    (err: unknown) => {
      console.error('[longhand/editor] restoring queued drafts failed', err);
    },
  );
  scheduleCounts();

  const handle: EditorHandle = {
    view,
    projectId,
    documentId,
    ready,
    getState: () => view.state,
    version: () => ({ confirmed: sync.confirmedVersion, local: sync.localVersion }),
    mappingFrom: (version) => sync.mappingFrom(version),
    status: () => sync.current(),
    wordCounts: () => counter.counts(view.state),
    settings: () => ({ ...settings }),
    setSettings(partial) {
      settings = { ...settings, ...partial };
      settings.caretRatio = clampCaretRatio(settings.caretRatio);
      root.style.setProperty('--lh-caret-ratio', String(settings.caretRatio));
      counter.setGoal(settings.dailyGoal);
      view.dispatch(
        view.state.tr
          .setMeta(typewriterKey, { enabled: settings.typewriter, caretRatio: settings.caretRatio })
          .setMeta(focusKey, settings.focusMode),
      );
      scheduleCounts();
    },
    setExtraPlugins(plugins) {
      extraPlugins = plugins;
      view.updateState(view.state.reconfigure({ plugins: [...corePlugins, ...extraPlugins] }));
    },
    setDecorations(layer, decorations, version) {
      let mapping: Mapping | null = null;
      if (version !== undefined) {
        mapping = sync.mappingFrom(version);
        if (!mapping) return false;
      }
      layer.set(view, decorations, mapping);
      return true;
    },
    setTraceSuggestion: (id) => guard.setTraceSuggestion(id),
    insertCitation({ sourceId, locator = null }) {
      if (!guard.tracker.recentActivation()) {
        console.error('[longhand/editor] insertCitation needs a user gesture');
        return null;
      }
      const citationId = newId();
      const node = nodes.citation.create({ sourceId, locator });
      const st = view.state;
      const tr = st.tr;
      if (!st.selection.empty) tr.setSelection(TextSelection.create(st.doc, st.selection.to));
      tr.replaceSelectionWith(node, false);
      sync.citationInserted({ citationId, documentId, sourceId, locator });
      guard.grant(tr, { units: 'all', activation: true, tag: { method: 'citation', citationId, kind: 'insert' } });
      view.dispatch(tr.scrollIntoView());
      return citationId;
    },
    insertClipping({ clippingId, sourceId, locator = null, text }) {
      if (!guard.tracker.recentActivation()) {
        console.error('[longhand/editor] insertClipping needs a user gesture');
        return false;
      }
      const paragraphs = text
        .split('\n')
        .map((line) => nodes.paragraph.create(null, line ? schema.text(line) : null));
      const block = nodes.quote_block.create({ sourceId, clippingId, locator }, paragraphs);
      const st = view.state;
      const { $from } = st.selection;
      const pos = $from.depth >= 1 ? $from.after(1) : st.doc.content.size;
      const tr = st.tr.insert(pos, block);
      guard.grant(tr, { units: 'all', activation: true, tag: { method: 'clipping', clippingId, kind: 'paste' } });
      const before = view.state;
      view.dispatch(tr.scrollIntoView());
      return view.state !== before;
    },
    acceptProposal: (proposalId) => sync.acceptProposal(proposalId),
    submitEvent: (type, payload) => sync.submitEvent(type, payload),
    flush: () => sync.flush(),
    caretRect() {
      try {
        const r = view.coordsAtPos(view.state.selection.head);
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      } catch {
        return null;
      }
    },
    on(event, listener) {
      return (events[event] as unknown as Emitter<EditorEvents[typeof event]>).on(listener);
    },
    setEditable(v) {
      editable = v;
      view.setProps({});
    },
    focus: () => view.focus(),
    destroy() {
      if (destroyed) return;
      sync.destroy();
      destroyed = true;
      if (countTimer) clearTimeout(countTimer);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const u of unsubs) u();
      view.destroy();
      root.remove();
    },
  };
  return handle;
}
