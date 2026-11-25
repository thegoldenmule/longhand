/**
 * ProseMirror commands that put research material into the manuscript: Cite
 * (a `citation` atom) and Place clipping (a `quote_block`).
 *
 * Neither command types text. Each produces exactly one `ReplaceStep` and tags its
 * transaction with {@link RESEARCH_INPUT_META}, which tells the editor's batcher:
 *
 * - the input-method run for these steps (`citation` + `citationId`, or
 *   `clipping` + `clippingId`), exactly as `InputRun` in `@longhand/schema`;
 * - the companion event that must be committed *before* the `TextEdited` carrying
 *   the steps (`CitationInserted` for a citation; a clipping's `ClippingSaved` was
 *   committed when it was saved, so it has none);
 * - the `characters` the steps insert and a suggested keystroke-timeline entry.
 *
 * See the package README ("Editor integration") for the full contract.
 */
import {
  LocatorSchema,
  schema as longhandSchema,
  type ClippingState,
  type EventPayload,
  type InputRun,
  type Keystroke,
} from '@longhand/schema';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import {
  NodeSelection,
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import { newId } from './drafts';

/** Transaction meta key carrying {@link ResearchInput}. */
export const RESEARCH_INPUT_META = 'longhand/research-input';

/** What a research command's transaction tells the editor's batcher. */
export interface ResearchInput {
  /** The input-method run for every step of this transaction (`run.steps === tr.steps.length`). */
  run: InputRun & { method: 'citation' | 'clipping' };
  /**
   * Companion events to commit before the `TextEdited` that carries these steps
   * (lower seq). Wrap each with `makeDraft` / `citationInsertedDraft`.
   */
  companions: Array<{ type: 'CitationInserted'; payload: EventPayload<'CitationInserted'> }>;
  /** Inline text characters inserted (0 for a citation; the clipping text without `\n` separators). */
  characters: number;
  /**
   * Suggested keystroke-timeline entry for the action. The schema has no
   * dedicated kind for Cite / Place clipping, so these are recorded as `paste`
   * (not typing), with `len` = `characters`.
   */
  keystroke: Pick<Keystroke, 'kind' | 'len'>;
}

/** Reads the research tag from a transaction, if it has one. */
export function getResearchInput(tr: Transaction): ResearchInput | null {
  return (tr.getMeta(RESEARCH_INPUT_META) as ResearchInput | undefined) ?? null;
}

/** Options for {@link insertCitation}. */
export interface InsertCitationOptions {
  /** The document being edited (goes into `CitationInserted.documentId`). */
  documentId: string;
  /** Defaults to a new id. */
  citationId?: string;
  /** Id generator (defaults to `crypto.randomUUID()`). */
  newId?: () => string;
}

function cleanLocator(locator: string | null | undefined): string | null {
  const l = (locator ?? '').trim();
  if (l === '') return null;
  return LocatorSchema.parse(l);
}

/**
 * Builds the Cite transaction without dispatching it: a `citation` node inserted at
 * the end of the selection (selected text is kept; the citation follows it), with
 * the cursor after it. Returns `null` if a citation cannot go there.
 */
export function citationTransaction(
  state: EditorState,
  sourceId: string,
  locator: string | null | undefined,
  opts: InsertCitationOptions,
): { tr: Transaction; input: ResearchInput } | null {
  const type = state.schema.nodes.citation;
  if (!type) return null;
  if (state.selection instanceof NodeSelection && !state.selection.node.isInline) return null;
  const $pos = state.selection.$to;
  if (!$pos.parent.inlineContent) return null;
  if (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), type)) return null;

  const loc = cleanLocator(locator);
  const node = type.create({ sourceId, locator: loc });
  const tr = state.tr.insert($pos.pos, node);
  tr.setSelection(TextSelection.create(tr.doc, $pos.pos + node.nodeSize));
  const citationId = opts.citationId ?? newId(opts);
  const input: ResearchInput = {
    run: { steps: tr.steps.length, method: 'citation', citationId },
    companions: [
      {
        type: 'CitationInserted',
        payload: { citationId, documentId: opts.documentId, sourceId, locator: loc },
      },
    ],
    characters: 0,
    keystroke: { kind: 'paste', len: 0 },
  };
  tr.setMeta(RESEARCH_INPUT_META, input);
  tr.scrollIntoView();
  return { tr, input };
}

/**
 * Cite: inserts a structured `citation` node (not text) tied to `sourceId` and an
 * optional locator such as `p. 12`. The transaction is tagged with
 * {@link RESEARCH_INPUT_META}.
 */
export function insertCitation(
  sourceId: string,
  locator: string | null | undefined,
  opts: InsertCitationOptions,
): Command {
  return (state, dispatch) => {
    if (!dispatch)
      return (
        citationTransaction(state, sourceId, locator, { ...opts, citationId: 'probe' }) !== null
      );
    const built = citationTransaction(state, sourceId, locator, opts);
    if (!built) return false;
    dispatch(built.tr);
    return true;
  };
}

/** The clipping fields {@link placeClipping} needs (a `ClippingState` fits). */
export type PlaceableClipping = Pick<ClippingState, 'id' | 'sourceId' | 'text' | 'locator'>;

/**
 * Builds the `quote_block` for a clipping: one paragraph per `\n`-separated line,
 * so its inline text (`"\n"` between paragraphs) equals the clipping text exactly,
 * which is what the fold checks before classing it `quoted`.
 */
export function clippingNode(clipping: PlaceableClipping, schema: Schema = longhandSchema): PMNode {
  const quote = schema.nodes.quote_block;
  const para = schema.nodes.paragraph;
  if (!quote || !para) throw new Error('schema has no quote_block / paragraph');
  const paragraphs = clipping.text
    .split('\n')
    .map((line) => para.create(null, line === '' ? null : schema.text(line)));
  return quote.create(
    { sourceId: clipping.sourceId, clippingId: clipping.id, locator: clipping.locator ?? null },
    paragraphs,
  );
}

/** Options for {@link placeClipping}. */
export interface PlaceClippingOptions {
  /**
   * Where to insert, as a position between top-level blocks. Defaults to after the
   * top-level block that holds the selection.
   */
  pos?: number;
}

/** The position after the top-level block holding the selection, if a quote block fits there. */
function blockInsertPos(state: EditorState, node: PMNode, pos?: number): number | null {
  const doc = state.doc;
  let at: number;
  if (pos !== undefined) {
    at = pos;
  } else {
    const $from = state.selection.$from;
    at = $from.depth === 0 ? $from.pos : $from.after(1);
  }
  if (at < 0 || at > doc.content.size) return null;
  const $at = doc.resolve(at);
  if ($at.depth !== 0) return null;
  const index = $at.index(0);
  return doc.canReplaceWith(index, index, node.type) ? at : null;
}

/**
 * Builds the Place clipping transaction without dispatching it. Returns `null` if
 * the quote block cannot go there.
 */
export function clippingTransaction(
  state: EditorState,
  clipping: PlaceableClipping,
  opts: PlaceClippingOptions = {},
): { tr: Transaction; input: ResearchInput } | null {
  if (!state.schema.nodes.quote_block) return null;
  const node = clippingNode(clipping, state.schema);
  const at = blockInsertPos(state, node, opts.pos);
  if (at === null) return null;
  const tr = state.tr.insert(at, node);
  const after = tr.doc.resolve(at + node.nodeSize);
  tr.setSelection(Selection.near(after, 1));
  const characters = clipping.text.replace(/\n/g, '').length;
  const input: ResearchInput = {
    run: { steps: tr.steps.length, method: 'clipping', clippingId: clipping.id },
    companions: [],
    characters,
    keystroke: { kind: 'paste', len: characters },
  };
  tr.setMeta(RESEARCH_INPUT_META, input);
  tr.scrollIntoView();
  return { tr, input };
}

/**
 * Place clipping: inserts the clipping as a `quote_block` after the current
 * top-level block. Its text is quoted, never typed. The transaction is tagged with
 * {@link RESEARCH_INPUT_META}.
 */
export function placeClipping(
  clipping: PlaceableClipping,
  opts: PlaceClippingOptions = {},
): Command {
  return (state, dispatch) => {
    const built = clippingTransaction(state, clipping, opts);
    if (!built) return false;
    dispatch?.(built.tr);
    return true;
  };
}
