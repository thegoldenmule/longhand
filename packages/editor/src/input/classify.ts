/**
 * Pure input-method classification: given what a transaction does and what real
 * input events the tracker has seen, decide the transaction's `InputMethod` and
 * keystroke kind, or refuse it.
 *
 * Rules (first match wins):
 * 0. A declared input ({@link EDITOR_INPUT_META}, e.g. Cite or Place clipping from
 *    the research lane) → its `citation`/`clipping` run, if a user gesture is
 *    recent and the steps insert only what that method may insert.
 * 1. Undo/redo (prosemirror-history meta) → `history`, needs recent user input.
 * 2. `uiEvent: paste` → needs a trusted paste event. `pasted-internal` if the
 *    clipboard marker names this project and its text hash matches the inserted
 *    text, else `pasted-external`.
 * 3. `uiEvent: drop` → needs a trusted drop event. `drop-internal` if the drag began
 *    in this editor, else `pasted-external` (via drop).
 * 4. `uiEvent: cut` → needs a trusted cut; `typed`, kind `cut`.
 * 5. Composition (meta or tracker state) → `ime`; inserted units ≤ composition length
 *    plus typed budget.
 * 6. Otherwise `typed` (or `autocorrect` after `insertReplacementText`): needs a
 *    trusted input event inside the editor, and inserted units ≤ typed budget (or
 *    a grant from Longhand's own commands and input rules).
 * 7. A change that inserts and deletes nothing (marks, block types) may also come
 *    from a trusted click or key anywhere in the page (a toolbar button).
 *
 * Anything else is a violation. Under policy `flag`, a violating *insertion* is let
 * through as `pasted-external` (never overclaim); deletions and format changes
 * without input are always refused.
 */
import {
  countWords,
  sha256Hex,
  type EventPayloads,
  type InputMethod,
  type InputRun,
  type Keystroke,
  type KeystrokeKind,
} from '@longhand/schema';
import type { TrackerState } from './tracker';

/** Clipboard/drop details recorded in the companion `PasteOccurred`. */
export interface PasteInfo {
  pasteId: string;
  origin: 'external' | 'internal';
  via: 'clipboard' | 'drop';
  copyId: string | null;
  mimeTypes: string[];
  characters: number;
  words: number;
  textHash: string;
}

/** The input method and timeline kind of a doc-changing transaction. */
export interface InputTag {
  method: InputMethod;
  kind: KeystrokeKind;
  pasteId?: string;
  citationId?: string;
  clippingId?: string;
  traceSuggestionId?: string;
  /** Companion `PasteOccurred` data for `pasted-*` methods. */
  paste?: PasteInfo;
  /** Set when policy `flag` let an unverifiable insertion through as `pasted-external`. */
  flagged?: boolean;
  /** Companion events to commit before the `TextEdited` carrying these steps. */
  companions?: DeclaredInput['companions'];
  /** Keystroke-timeline `len` override (declared inputs). */
  timelineLen?: number;
}

/**
 * Transaction meta key any package may use to declare the input method of a
 * command it dispatches on a user gesture: `tr.setMeta(EDITOR_INPUT_META, input)`.
 * Only methods the fold verifies against an earlier event are accepted
 * (`citation`, `clipping`); everything else is classified from real input events.
 */
export const EDITOR_INPUT_META = 'longhand/editor-input';

/** Alias read for the research lane's commands (`RESEARCH_INPUT_META` in `@longhand/research`). */
export const RESEARCH_INPUT_META_ALIAS = 'longhand/research-input';

/** A declared input (the value of {@link EDITOR_INPUT_META}). */
export interface DeclaredInput {
  /** The run covering every step of the transaction (`run.steps === tr.steps.length`). */
  run: InputRun;
  /** Companion events committed before the `TextEdited` (only `CitationInserted`). */
  companions: Array<{ type: 'CitationInserted'; payload: EventPayloads['CitationInserted'] }>;
  /** Inline characters inserted (informational; the batcher counts from the steps). */
  characters: number;
  /** Keystroke-timeline entry for the action. */
  keystroke: Pick<Keystroke, 'kind' | 'len'>;
}

/** A privileged grant from Longhand's own commands and input rules. */
export interface InputGrant {
  /** Units the command may insert beyond the typed budget (`all` for any). */
  units: number | 'all';
  kind?: KeystrokeKind;
  /** Command was triggered by user activation outside the editor (toolbar). */
  activation?: boolean;
}

/** What a transaction does, extracted by the guard. */
export interface TransactionFacts {
  docChanged: boolean;
  uiEvent?: string | undefined;
  history?: { redo: boolean } | undefined;
  composition: boolean;
  insertedUnits: number;
  insertedChars: number;
  deletedChars: number;
  split: boolean;
  structural: boolean;
  /** Timeline kind hinted by the dispatcher (cannot change the method). */
  hintKind?: KeystrokeKind | undefined;
  grant?: InputGrant | undefined;
  /** A declared input from {@link EDITOR_INPUT_META} (or its research alias). */
  declared?: DeclaredInput | undefined;
  /** Number of steps. */
  steps: number;
  /** Type names of every node the steps insert. */
  insertedNodeNames: ReadonlySet<string>;
  /** Inline text inserted by the transaction (`inlineTextBetween(…, '\n')`). Lazy. */
  insertedText: () => string;
}

/** Context the classifier needs besides tracker state. */
export interface ClassifyContext {
  projectId: string;
  policy: 'refuse' | 'flag';
  newId: () => string;
  traceSuggestionId?: string | null;
}

/** What to consume from the tracker after an accepted classification. */
export interface Consumption {
  text?: number;
  paste?: boolean;
  drop?: boolean;
  autocorrect?: boolean;
}

/** Classification result. */
export type Classification =
  | { ok: true; tag: InputTag | null; consume: Consumption }
  | { ok: false; reason: string };

function fresh(at: number, s: TrackerState): boolean {
  return s.now - at <= s.windowMs;
}

function pasteInfo(
  facts: TransactionFacts,
  ctx: ClassifyContext,
  base: { origin: 'external' | 'internal'; via: 'clipboard' | 'drop'; copyId: string | null; mimeTypes: string[] },
): PasteInfo {
  const text = facts.insertedText();
  return {
    pasteId: ctx.newId(),
    ...base,
    characters: text.length,
    words: countWords(text),
    textHash: sha256Hex(text),
  };
}

function typedKind(facts: TransactionFacts): KeystrokeKind {
  if (facts.hintKind) return facts.hintKind;
  if (facts.insertedChars > 0) return 'insert';
  if (facts.deletedChars > 0) return 'delete';
  if (facts.split) return 'break';
  if (facts.insertedUnits > 0) return 'insert';
  return 'format';
}

function withTrace(tag: InputTag, ctx: ClassifyContext): InputTag {
  if (ctx.traceSuggestionId && (tag.method === 'typed' || tag.method === 'ime' || tag.method === 'autocorrect'))
    return { ...tag, traceSuggestionId: ctx.traceSuggestionId };
  return tag;
}

/** Classifies one transaction. Pure apart from `ctx.newId` and `facts.insertedText`. */
export function classifyTransaction(
  facts: TransactionFacts,
  s: TrackerState,
  ctx: ClassifyContext,
): Classification {
  if (!facts.docChanged) return { ok: true, tag: null, consume: {} };
  const editorInput = fresh(s.editorInputAt, s);
  const activation = editorInput || fresh(s.activationAt, s);
  const grant = facts.grant;

  const violation = (reason: string): Classification => {
    if (ctx.policy === 'flag' && facts.insertedUnits > 0) {
      const paste = pasteInfo(facts, ctx, { origin: 'external', via: 'clipboard', copyId: null, mimeTypes: [] });
      return {
        ok: true,
        tag: { method: 'pasted-external', kind: 'paste', pasteId: paste.pasteId, paste, flagged: true },
        consume: {},
      };
    }
    return { ok: false, reason };
  };

  if (facts.declared) {
    const d = facts.declared;
    const refuse = (reason: string): Classification => ({ ok: false, reason: `declared input: ${reason}` });
    if (!activation) return refuse('no recent user gesture');
    const { run } = d;
    if (run.steps !== facts.steps) return refuse(`run covers ${run.steps} steps, transaction has ${facts.steps}`);
    if (facts.deletedChars > 0) return refuse('it deletes text');
    const names = facts.insertedNodeNames;
    if (run.method === 'citation') {
      if (!run.citationId) return refuse('citation run without citationId');
      if (facts.insertedChars > 0 || [...names].some((n) => n !== 'citation'))
        return refuse('a citation run may insert only citation nodes');
      if (d.companions.some((c) => c.type !== 'CitationInserted' || c.payload.citationId !== run.citationId))
        return refuse('companion does not match the citation');
    } else if (run.method === 'clipping') {
      if (!run.clippingId) return refuse('clipping run without clippingId');
      const allowed = new Set(['quote_block', 'paragraph', 'text', 'hard_break']);
      if (!names.has('quote_block') || [...names].some((n) => !allowed.has(n)))
        return refuse('a clipping run may insert only one quote block');
      if (d.companions.length > 0) return refuse('clipping runs have no companions');
    } else {
      return refuse(`method ${run.method} cannot be declared`);
    }
    const tag: InputTag = {
      method: run.method,
      kind: d.keystroke.kind,
      companions: d.companions,
      timelineLen: d.keystroke.len,
    };
    if (run.citationId) tag.citationId = run.citationId;
    if (run.clippingId) tag.clippingId = run.clippingId;
    return { ok: true, tag, consume: {} };
  }

  if (facts.history) {
    if (!activation) return violation('undo/redo without user input');
    return { ok: true, tag: { method: 'history', kind: facts.history.redo ? 'redo' : 'undo' }, consume: {} };
  }

  if (facts.uiEvent === 'paste') {
    const p = s.paste;
    if (!p || !fresh(p.at, s)) return violation('paste transaction without a trusted paste event');
    let origin: 'internal' | 'external' = 'external';
    let copyId: string | null = null;
    if (p.marker && p.marker.projectId === ctx.projectId) {
      const text = facts.insertedText();
      if (sha256Hex(text) === p.marker.textHash) {
        origin = 'internal';
        copyId = p.marker.copyId;
      }
    }
    const paste = pasteInfo(facts, ctx, { origin, via: 'clipboard', copyId, mimeTypes: p.mimeTypes });
    return {
      ok: true,
      tag: {
        method: origin === 'internal' ? 'pasted-internal' : 'pasted-external',
        kind: 'paste',
        pasteId: paste.pasteId,
        paste,
      },
      consume: { paste: true },
    };
  }

  if (facts.uiEvent === 'drop') {
    const d = s.drop;
    if (!d || !fresh(d.at, s)) return violation('drop transaction without a trusted drop event');
    if (d.internal) return { ok: true, tag: { method: 'drop-internal', kind: 'drop' }, consume: { drop: true } };
    const paste = pasteInfo(facts, ctx, { origin: 'external', via: 'drop', copyId: null, mimeTypes: d.mimeTypes });
    return {
      ok: true,
      tag: { method: 'pasted-external', kind: 'drop', pasteId: paste.pasteId, paste },
      consume: { drop: true },
    };
  }

  if (facts.uiEvent === 'cut') {
    if (!fresh(s.cutAt, s)) return violation('cut transaction without a trusted cut event');
    if (facts.insertedUnits > 0) return violation('cut inserted content');
    return { ok: true, tag: { method: 'typed', kind: 'cut' }, consume: {} };
  }

  const granted = grant ? (grant.units === 'all' ? Infinity : grant.units) : 0;

  if (facts.composition || s.composing || fresh(s.compositionEndedAt, s)) {
    if (!editorInput) return violation('composition change without input events');
    const allowed = s.compositionLength + s.textBudget + granted;
    if (facts.insertedUnits > allowed)
      return violation(`IME inserted ${facts.insertedUnits} units, input allowed ${allowed}`);
    return {
      ok: true,
      tag: withTrace({ method: 'ime', kind: facts.insertedChars > 0 ? 'compose' : typedKind(facts) }, ctx),
      consume: { text: Math.min(s.textBudget, facts.insertedUnits) },
    };
  }

  if (facts.insertedUnits === 0 && facts.deletedChars === 0) {
    if (!activation) return violation('format change without user input');
    return { ok: true, tag: withTrace({ method: 'typed', kind: typedKind(facts) }, ctx), consume: {} };
  }

  if (!editorInput && !(grant?.activation && activation)) return violation('edit without user input');

  const budget = s.textBudget + granted;
  if (facts.insertedUnits > budget)
    return violation(`inserted ${facts.insertedUnits} units but the writer typed ${s.textBudget}`);

  const consume: Consumption = { text: Math.min(s.textBudget, facts.insertedUnits) };
  if (fresh(s.autocorrectAt, s) && facts.insertedChars > 0) {
    consume.autocorrect = true;
    return { ok: true, tag: withTrace({ method: 'autocorrect', kind: 'autocorrect' }, ctx), consume };
  }
  return { ok: true, tag: withTrace({ method: 'typed', kind: typedKind(facts) }, ctx), consume };
}

/** Methods whose runs require `pasteId`. */
export function needsPasteId(method: InputMethod): boolean {
  return method === 'pasted-external' || method === 'pasted-internal';
}
