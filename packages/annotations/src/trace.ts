/**
 * Trace-over (F4). While the caret sits on an open word-choice suggestion (or at
 * an insertion point), the writer can retype the ghost text. This plugin:
 *
 * - tracks the active suggestion's region as the writer types, absorbing typing
 *   at its edges the way the fold does once a trace hint is present;
 * - reports activation changes, so the controller calls
 *   `editor.setTraceSuggestion(id | null)` and typed runs carry the hint;
 * - draws ghost text as widget decorations (never document text), and while
 *   tracing draws the characters that match the ghost in the writer's colour,
 *   with the rest of the ghost still waiting in the AI colour after the caret.
 *
 * The outcome (adopted, adapted, stale) is never decided here: it comes from the
 * fold, through `ProjectState`.
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { createGhostElement, ghostDescriptionId } from './ghost';

/** An open suggestion the writer can trace over, in local document positions. */
export interface TraceCandidate {
  id: string;
  kind: 'word-choice' | 'insertion';
  from: number;
  to: number;
  /** The anchored text (word choice) or '' (insertion). */
  original: string;
  /** Alternatives (word choice) or the one sentence (insertion). */
  ghosts: readonly string[];
  /** Which ghost to show before typing starts. */
  preferred: number;
}

/** The region being traced. */
export interface TraceRegion {
  id: string;
  from: number;
  to: number;
}

/** Plugin state. */
export interface TraceState {
  candidates: readonly TraceCandidate[];
  active: TraceRegion | null;
  /** Word-choice suggestions whose ghost shows inline even without the caret on them. */
  shown: ReadonlySet<string>;
}

/** How far a trace has got. */
export interface TraceProgress {
  id: string;
  /** Text the writer has typed in the region (leading space trimmed for insertions). */
  typed: string;
  /** The ghost being traced. */
  ghost: string;
  /** Characters of `typed` that match the ghost from its start. */
  matched: number;
  /** True once the typing left the ghost. */
  diverged: boolean;
  /** True while the region still holds the original text. */
  untouched: boolean;
}

interface TraceMeta {
  candidates?: readonly TraceCandidate[];
  shown?: ReadonlySet<string>;
}

/** The plugin key. */
export const traceKey = new PluginKey<TraceState>('longhand-annotations-trace');

const EMPTY: TraceState = { candidates: [], active: null, shown: new Set() };

function contains(c: TraceCandidate, state: EditorState): boolean {
  const sel = state.selection;
  if (c.kind === 'insertion') return sel.empty && sel.head === c.from;
  if (c.to <= c.from) return false;
  if (sel.empty) return sel.head > c.from && sel.head < c.to;
  return sel.from >= c.from && sel.to <= c.to;
}

function within(r: TraceRegion, state: EditorState): boolean {
  const sel = state.selection;
  return sel.from >= r.from && sel.to <= r.to;
}

function apply(tr: Transaction, prev: TraceState, next: EditorState): TraceState {
  const meta = tr.getMeta(traceKey) as TraceMeta | undefined;
  let candidates = prev.candidates;
  let active = prev.active;
  const shown = meta?.shown ?? prev.shown;
  if (tr.docChanged) {
    if (!meta?.candidates) {
      candidates = candidates.map((c) => {
        if (c.kind === 'insertion') {
          const p = tr.mapping.map(c.from, -1);
          return { ...c, from: p, to: p };
        }
        const from = tr.mapping.map(c.from, 1);
        return { ...c, from, to: Math.max(from, tr.mapping.map(c.to, -1)) };
      });
    }
    if (active) {
      const from = tr.mapping.map(active.from, -1);
      active = { ...active, from, to: Math.max(from, tr.mapping.map(active.to, 1)) };
    }
  }
  if (meta?.candidates) candidates = meta.candidates;
  if (active && !candidates.some((c) => c.id === active!.id)) active = null;
  if (active && !within(active, next)) {
    // Leaving the region: the candidate continues from what the writer typed.
    const a = active;
    candidates = candidates.map((c) => (c.id === a.id ? { ...c, from: a.from, to: a.to } : c));
    active = null;
  }
  if (!active) {
    const hit = candidates.find((c) => contains(c, next));
    if (hit) active = { id: hit.id, from: hit.from, to: hit.to };
  }
  if (candidates === prev.candidates && active === prev.active && shown === prev.shown) return prev;
  return { candidates, active, shown };
}

function regionText(state: EditorState, from: number, to: number): string {
  const size = state.doc.content.size;
  const f = Math.max(0, Math.min(from, size));
  const t = Math.max(f, Math.min(to, size));
  return state.doc.textBetween(f, t, '\n', '￼');
}

function lcp(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i]!.toLowerCase() === b[i]!.toLowerCase()) i++;
  return i;
}

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/** Computes the trace progress of the active region, or null. */
export function traceProgress(state: EditorState): TraceProgress | null {
  const ts = traceKey.getState(state);
  const a = ts?.active;
  if (!ts || !a) return null;
  const c = ts.candidates.find((x) => x.id === a.id);
  if (!c) return null;
  const region = regionText(state, a.from, a.to);
  const untouched = c.kind === 'word-choice' ? region === c.original : region === '';
  const lead = c.kind === 'insertion' ? region.length - region.trimStart().length : 0;
  const typed = region.slice(lead);
  let best = c.ghosts[c.preferred] ?? c.ghosts[0] ?? '';
  let matched = untouched ? 0 : lcp(typed, best);
  if (!untouched) {
    for (const g of c.ghosts) {
      const m = lcp(typed, g);
      if (m > matched) {
        matched = m;
        best = g;
      }
    }
  }
  return {
    id: c.id,
    typed: untouched ? '' : typed,
    ghost: best,
    matched,
    diverged: !untouched && matched < typed.length,
    untouched,
  };
}

function ghostWidget(
  pos: number,
  text: string,
  id: string,
  className: string,
  keySuffix: string,
): Decoration {
  return Decoration.widget(
    pos,
    (view) => createGhostElement(view.dom.ownerDocument, text, { className, annotationId: id }),
    {
      side: 1,
      key: `ghost:${id}:${keySuffix}:${className}:${text}`,
      ignoreSelection: true,
      marks: [],
      stopEvent: () => true,
    },
  );
}

/** Spacing for a ghost sentence at a point: a space on any side that touches a non-space. */
function spaced(state: EditorState, pos: number, sentence: string): string {
  const doc = state.doc;
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const before = $p.parent.isTextblock
    ? $p.parent.textBetween(0, $p.parentOffset, undefined, '￼')
    : '';
  const after = $p.parent.isTextblock
    ? $p.parent.textBetween($p.parentOffset, $p.parent.content.size, undefined, '￼')
    : '';
  const lead = before.length > 0 && !isSpace(before[before.length - 1]) ? ' ' : '';
  const trail = after.length > 0 && !isSpace(after[0]) ? ' ' : '';
  return `${lead}${sentence}${trail}`;
}

function decorations(state: EditorState): DecorationSet {
  const ts = traceKey.getState(state);
  if (!ts || ts.candidates.length === 0) return DecorationSet.empty;
  const out: Decoration[] = [];
  const size = state.doc.content.size;
  const progress = traceProgress(state);
  for (const c of ts.candidates) {
    const isActive = ts.active?.id === c.id;
    const ghost = c.ghosts[c.preferred] ?? c.ghosts[0] ?? '';
    if (!isActive) {
      if (c.from < 0 || c.to > size) continue;
      if (c.kind === 'insertion')
        out.push(
          ghostWidget(c.from, spaced(state, c.from, ghost), c.id, 'lh-ghost-insertion', 'i'),
        );
      else if (ts.shown.has(c.id)) out.push(ghostWidget(c.to, ghost, c.id, 'lh-ghost-alt', 'a'));
      continue;
    }
    const a = ts.active!;
    if (!progress || progress.untouched) {
      if (c.kind === 'insertion')
        out.push(
          ghostWidget(
            a.from,
            spaced(state, a.from, ghost),
            c.id,
            'lh-ghost-insertion lh-ghost-active',
            'i',
          ),
        );
      else out.push(ghostWidget(a.to, ghost, c.id, 'lh-ghost-alt lh-ghost-active', 'a'));
      continue;
    }
    const region = regionText(state, a.from, a.to);
    const lead = c.kind === 'insertion' ? region.length - region.trimStart().length : 0;
    const start = a.from + lead;
    const typedEnd = Math.min(a.to, start + progress.typed.length);
    if (a.to > a.from)
      out.push(
        Decoration.inline(a.from, a.to, { class: 'lh-trace-region', 'data-trace-id': c.id }),
      );
    if (progress.matched > 0)
      out.push(
        Decoration.inline(start, start + progress.matched, {
          class: 'lh-trace-typed',
          'data-trace-id': c.id,
        }),
      );
    if (progress.diverged)
      out.push(
        Decoration.inline(start + progress.matched, typedEnd, {
          class: 'lh-trace-diverged',
          'data-trace-id': c.id,
        }),
      );
    else if (progress.matched < progress.ghost.length) {
      let rest = progress.ghost.slice(progress.matched);
      if (c.kind === 'insertion') {
        const after = spaced(state, a.to, 'x');
        if (after.endsWith(' ')) rest += ' ';
      }
      out.push(ghostWidget(a.to, rest, c.id, 'lh-ghost-trace', 't'));
    }
  }
  return DecorationSet.create(state.doc, out);
}

/** Options for {@link createTracePlugin}. */
export interface TracePluginOptions {
  /** Called whenever the active suggestion changes (null when the caret leaves it). */
  onActiveChange?: (id: string | null) => void;
  /** Called after every view update while a trace is active (progress changed). */
  onProgress?: (progress: TraceProgress | null) => void;
}

/** The trace-over plugin with helpers to feed it. */
export interface TracePlugin {
  readonly plugin: Plugin<TraceState>;
  /** Replaces the candidates (positions in the view's current document). */
  setCandidates(view: EditorView, candidates: readonly TraceCandidate[]): void;
  /** Word-choice ids whose ghost shows inline without the caret on them. */
  setShown(view: EditorView, ids: ReadonlySet<string>): void;
  get(state: EditorState): TraceState;
}

/** Creates the trace-over plugin. */
export function createTracePlugin(opts: TracePluginOptions = {}): TracePlugin {
  const plugin = new Plugin<TraceState>({
    key: traceKey,
    state: {
      init: () => EMPTY,
      apply: (tr, prev, _old, next) => apply(tr, prev, next),
    },
    props: {
      decorations,
      attributes: (state): Record<string, string> => {
        const a = traceKey.getState(state)?.active;
        return a ? { 'data-tracing': a.id, 'aria-describedby': ghostDescriptionId(a.id) } : {};
      },
    },
    view(view) {
      let last: string | null = traceKey.getState(view.state)?.active?.id ?? null;
      if (last) opts.onActiveChange?.(last);
      let lastProgress: TraceProgress | null = null;
      return {
        update(v) {
          const id = traceKey.getState(v.state)?.active?.id ?? null;
          if (id !== last) {
            last = id;
            opts.onActiveChange?.(id);
          }
          if (opts.onProgress) {
            const p = id ? traceProgress(v.state) : null;
            if (
              p?.id !== lastProgress?.id ||
              p?.typed !== lastProgress?.typed ||
              p?.ghost !== lastProgress?.ghost
            ) {
              lastProgress = p;
              opts.onProgress(p);
            }
          }
        },
        destroy() {
          if (last) opts.onActiveChange?.(null);
          last = null;
        },
      };
    },
  });
  return {
    plugin,
    setCandidates(view, candidates) {
      view.dispatch(view.state.tr.setMeta(traceKey, { candidates } satisfies TraceMeta));
    },
    setShown(view, ids) {
      view.dispatch(view.state.tr.setMeta(traceKey, { shown: ids } satisfies TraceMeta));
    },
    get: (state) => traceKey.getState(state) ?? EMPTY,
  };
}
