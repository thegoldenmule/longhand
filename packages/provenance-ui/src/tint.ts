/**
 * The provenance tint: a decoration layer (the editor's `createDecorationLayer`)
 * that tints text by provenance class, plus a small plugin that switches the tint
 * on and off, highlights one class, and turns clicks and a key into inspection
 * requests for the span inspector.
 *
 * Positions come from `ProvenanceRun`s at a ledger document version. The tint hands
 * that version to `handle.setDecorations`, so the editor maps the runs onto the
 * local document, which may hold unacknowledged steps. Text typed locally since
 * then has no run yet and stays untinted until fresh runs arrive.
 */
import {
  createDecorationLayer,
  type DecorationLayer,
  type LayerDecoration,
} from '@longhand/editor';
import type { ProvenanceRun } from '@longhand/schema';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import type { Mapping } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import { CLASS_META, MATCHED_KIND_LABEL, tintClassName, type TintClass } from './classes';

/**
 * What the tint needs from an editor. `EditorHandle` from `@longhand/editor`
 * satisfies it; a read-only view can supply its own (see `staticTintHost`).
 */
export interface TintHost {
  readonly view: EditorView;
  setDecorations(
    layer: DecorationLayer,
    decorations: readonly LayerDecoration[],
    version?: number,
  ): boolean;
  /** Mapping from a ledger version to the local document, or null when too old. */
  mappingFrom?(version: number): Mapping | null;
}

/** A host for a view whose document *is* the ledger version (no local edits). */
export function staticTintHost(view: EditorView): TintHost {
  return {
    view,
    setDecorations(layer, decorations) {
      layer.set(view, decorations);
      return true;
    },
  };
}

/** Viewport rectangle of the inspected character. */
export interface InspectRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A request to inspect the character at a position. */
export interface InspectRequest {
  /** Position of the character in the editor's local document. */
  localPos: number;
  /**
   * Position of that character in the ledger version the runs were set at, or null
   * when the character is not in that version (typed locally, not yet synced) or
   * the version is too old to map.
   */
  ledgerPos: number | null;
  /** Ledger version the runs were set at (null when set without one). */
  version: number | null;
  via: 'pointer' | 'keyboard';
  rect: InspectRect | null;
}

/** The tint's observable state. */
export interface TintSnapshot {
  enabled: boolean;
  /** Class whose spans are highlighted (others fade), or null. */
  highlight: TintClass | null;
  runs: readonly ProvenanceRun[];
  version: number | null;
  /** True when the editor could not map `version` onto its document (fetch fresh runs). */
  stale: boolean;
}

export interface ProvenanceTintOptions {
  /** Decoration layer name (default `provenance`). */
  name?: string;
  /** Start enabled (default false). */
  enabled?: boolean;
  /**
   * Opens the inspector on the character after the caret. Default `Alt-Enter`.
   * A predicate receives the keydown event.
   */
  inspectKey?: (event: KeyboardEvent) => boolean;
  /** Pointer clicks open the inspector while the tint is on (default true). */
  inspectOnClick?: boolean;
}

/** The tint controller. Add `plugins` to the editor, then `attach` its handle. */
export interface ProvenanceTint {
  readonly layer: DecorationLayer;
  /** The layer plugin and the tint plugin; pass both in `extraPlugins`. */
  readonly plugins: readonly Plugin[];
  /** Binds an editor (or read-only view). Returns a detach function. */
  attach(host: TintHost): () => void;
  /** The attached host, if any. */
  host(): TintHost | null;
  /**
   * Sets the runs, computed at ledger document `version` (omit for a view whose
   * document is the runs' version). Returns false when the editor cannot map that
   * version; the snapshot is then `stale` and the host should fetch fresh runs.
   */
  setRuns(runs: readonly ProvenanceRun[], version?: number | null): boolean;
  setEnabled(enabled: boolean): void;
  toggle(): void;
  setHighlight(cls: TintClass | null): void;
  getSnapshot(): TintSnapshot;
  /** Listens for snapshot changes (React: `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void;
  /** Listens for inspection requests (click or key while enabled). */
  onInspect(listener: (req: InspectRequest) => void): () => void;
  /** Listens for Escape in the editor (closes the inspector). */
  onDismiss(listener: () => void): () => void;
  /** Requests inspection of the character at a local position (as the key does). */
  inspectAt(localPos: number, via?: InspectRequest['via']): InspectRequest | null;
  /** The ledger position of a local character, or null (see `InspectRequest.ledgerPos`). */
  toLedgerPos(localPos: number): number | null;
  /**
   * Outlines the inspected span (`from`/`to` in the runs' ledger version), or clears
   * the outline with null.
   */
  markSpan(range: { from: number; to: number } | null): void;
}

/** Decoration attributes for one run. */
export function runAttrs(run: ProvenanceRun): Record<string, string> {
  const cls = (run.class === 'pasted-internal' ? 'pasted-external' : run.class) as TintClass;
  const attrs: Record<string, string> = {
    class: tintClassName(cls),
    'data-prov': cls,
    'data-prov-seq': String(run.originSeq),
  };
  if (run.matchedKind) {
    attrs['data-prov-matched'] = run.matchedKind;
    attrs.title = `${CLASS_META[cls].label}: matched ${MATCHED_KIND_LABEL[run.matchedKind]}`;
  }
  if (run.moves) attrs['data-prov-moved'] = String(run.moves.length);
  return attrs;
}

/** Attributes that decide how a run looks; runs that agree on them draw as one span. */
function lookKey(attrs: Record<string, string>): string {
  return [
    attrs['data-prov'],
    attrs['data-prov-matched'] ?? '',
    attrs['data-prov-moved'] ?? '',
  ].join('|');
}

/**
 * Inline decorations for the runs. Adjacent runs that look the same (same class,
 * matched kind and moved state) are merged into one decoration, so run
 * boundaries (a batch ending mid-word, two pastes side by side) never show as a
 * seam in the wash or a restart in the underline. A merged decoration's
 * `data-prov-seq` lists every origin seq it covers, space-separated, and its
 * `spec.runs` holds the runs (`spec.provenance` is the first).
 */
export function provenanceDecorations(runs: readonly ProvenanceRun[]): LayerDecoration[] {
  const sorted = [...runs].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: LayerDecoration[] = [];
  let group: {
    from: number;
    to: number;
    attrs: Record<string, string>;
    runs: ProvenanceRun[];
  } | null = null;
  const flush = () => {
    if (!group) return;
    const seqs = [...new Set(group.runs.map((r) => String(r.originSeq)))];
    out.push({
      kind: 'inline',
      from: group.from,
      to: group.to,
      attrs: { ...group.attrs, 'data-prov-seq': seqs.join(' ') },
      spec: { provenance: group.runs[0], runs: group.runs },
    });
  };
  for (const run of sorted) {
    const attrs = runAttrs(run);
    if (group && group.to === run.from && lookKey(group.attrs) === lookKey(attrs)) {
      group.to = run.to;
      group.runs.push(run);
      continue;
    }
    flush();
    group = { from: run.from, to: run.to, attrs, runs: [run] };
  }
  flush();
  return out;
}

/** Default inspector key: Alt-Enter (Option-Return), no other modifiers. */
export function defaultInspectKey(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

interface PluginValue {
  enabled: boolean;
  highlight: TintClass | null;
}

/** True when `pos` is a provenance unit (a text character or an inline leaf). */
function isUnit(state: EditorState, pos: number): boolean {
  if (pos < 0 || pos >= state.doc.content.size) return false;
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.inlineContent) return false;
  const node = $pos.parent.childAfter($pos.parentOffset).node;
  return !!node && (node.isText || (node.isInline && node.isLeaf));
}

function rectOf(view: EditorView, pos: number): InspectRect | null {
  try {
    const a = view.coordsAtPos(pos, 1);
    const b = view.coordsAtPos(Math.min(pos + 1, view.state.doc.content.size), -1);
    return {
      left: a.left,
      right: b.top === a.top ? Math.max(a.left, b.right) : a.right,
      top: a.top,
      bottom: a.bottom,
    };
  } catch {
    return null;
  }
}

/** Creates a tint controller. */
export function createProvenanceTint(opts: ProvenanceTintOptions = {}): ProvenanceTint {
  const layer = createDecorationLayer(opts.name ?? 'provenance');
  const markLayer = createDecorationLayer(`${opts.name ?? 'provenance'}-inspected`);
  const key = new PluginKey<PluginValue>(`longhand-provenance-tint-${opts.name ?? 'provenance'}`);
  const inspectKey = opts.inspectKey ?? defaultInspectKey;
  const inspectOnClick = opts.inspectOnClick ?? true;

  let snap: TintSnapshot = {
    enabled: opts.enabled ?? false,
    highlight: null,
    runs: [],
    version: null,
    stale: false,
  };
  let current: TintHost | null = null;
  const listeners = new Set<() => void>();
  const inspectListeners = new Set<(r: InspectRequest) => void>();
  const dismissListeners = new Set<() => void>();

  const update = (patch: Partial<TintSnapshot>): void => {
    snap = { ...snap, ...patch };
    for (const l of [...listeners]) l();
  };

  const pushPluginState = (): void => {
    const view = current?.view;
    if (!view || view.isDestroyed) return;
    view.dispatch(view.state.tr.setMeta(key, { enabled: snap.enabled, highlight: snap.highlight }));
  };

  /** Draws (or clears) the decorations for the current snapshot. */
  const draw = (): boolean => {
    const host = current;
    if (!host || host.view.isDestroyed) return true;
    if (!snap.enabled) {
      layer.clear(host.view);
      markLayer.clear(host.view);
      return true;
    }
    const decos = provenanceDecorations(snap.runs);
    return snap.version === null
      ? host.setDecorations(layer, decos)
      : host.setDecorations(layer, decos, snap.version);
  };

  const toLedgerPos = (localPos: number): number | null => {
    if (snap.version === null || !current?.mappingFrom) return localPos;
    const mapping = current.mappingFrom(snap.version);
    if (!mapping) return null;
    const inv = mapping.invert();
    const a = inv.mapResult(localPos, 1);
    const b = inv.mapResult(localPos + 1, -1);
    if (a.deleted || b.deleted || b.pos - a.pos !== 1) return null;
    return a.pos;
  };

  const emitInspect = (view: EditorView, localPos: number, via: InspectRequest['via']) => {
    const req: InspectRequest = {
      localPos,
      ledgerPos: toLedgerPos(localPos),
      version: snap.version,
      via,
      rect: rectOf(view, localPos),
    };
    for (const l of [...inspectListeners]) l(req);
    return req;
  };

  /** The unit at or around a caret position: the character after it, else the one before. */
  const unitNear = (state: EditorState, pos: number): number | null => {
    if (isUnit(state, pos)) return pos;
    if (isUnit(state, pos - 1)) return pos - 1;
    return null;
  };

  const plugin = new Plugin<PluginValue>({
    key,
    state: {
      init: () => ({ enabled: snap.enabled, highlight: snap.highlight }),
      apply: (tr, value) => (tr.getMeta(key) as PluginValue | undefined) ?? value,
    },
    props: {
      attributes(state): Record<string, string> {
        const v = key.getState(state);
        if (!v?.enabled) return {};
        const attrs: Record<string, string> = { class: 'lh-prov-on' };
        if (v.highlight) attrs['data-prov-highlight'] = v.highlight;
        return attrs;
      },
      handleClick(view, pos, event) {
        if (!inspectOnClick || !key.getState(view.state)?.enabled) return false;
        if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey) return false;
        let unit = pos;
        try {
          const c = view.coordsAtPos(pos, 1);
          if (event.clientX < c.left && pos > 0) unit = pos - 1;
        } catch {
          // jsdom and detached views have no layout; keep `pos`.
        }
        const u = isUnit(view.state, unit) ? unit : unitNear(view.state, pos);
        if (u === null) return false;
        emitInspect(view, u, 'pointer');
        return false;
      },
      handleKeyDown(view, event) {
        if (!key.getState(view.state)?.enabled) return false;
        if (event.key === 'Escape') {
          if (dismissListeners.size === 0) return false;
          for (const l of [...dismissListeners]) l();
          return false;
        }
        if (!inspectKey(event)) return false;
        const u = unitNear(view.state, view.state.selection.head);
        if (u === null) return false;
        emitInspect(view, u, 'keyboard');
        return true;
      },
    },
  });

  const tint: ProvenanceTint = {
    layer,
    plugins: [layer.plugin, markLayer.plugin, plugin],
    attach(host) {
      current = host;
      pushPluginState();
      update({ stale: !draw() });
      return () => {
        if (current === host) current = null;
      };
    },
    host: () => current,
    setRuns(runs, version = null) {
      update({ runs, version });
      const ok = draw();
      if (snap.stale === ok) update({ stale: !ok });
      return ok;
    },
    setEnabled(enabled) {
      if (enabled === snap.enabled) return;
      update({ enabled, highlight: enabled ? snap.highlight : null });
      pushPluginState();
      const ok = draw();
      if (snap.stale === ok) update({ stale: !ok });
    },
    toggle() {
      tint.setEnabled(!snap.enabled);
    },
    setHighlight(cls) {
      if (cls === snap.highlight) return;
      update({ highlight: cls });
      pushPluginState();
    },
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onInspect(listener) {
      inspectListeners.add(listener);
      return () => inspectListeners.delete(listener);
    },
    onDismiss(listener) {
      dismissListeners.add(listener);
      return () => dismissListeners.delete(listener);
    },
    inspectAt(localPos, via = 'keyboard') {
      const view = current?.view;
      if (!view) return null;
      const u = unitNear(view.state, localPos);
      return u === null ? null : emitInspect(view, u, via);
    },
    toLedgerPos,
    markSpan(range) {
      const host = current;
      if (!host || host.view.isDestroyed) return;
      if (!range) {
        markLayer.clear(host.view);
        return;
      }
      const decos: LayerDecoration[] = [
        { kind: 'inline', from: range.from, to: range.to, attrs: { class: 'lh-prov-inspected' } },
      ];
      if (snap.version === null) host.setDecorations(markLayer, decos);
      else host.setDecorations(markLayer, decos, snap.version);
    },
  };
  return tint;
}
