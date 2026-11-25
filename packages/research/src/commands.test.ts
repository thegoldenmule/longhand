import {
  INPUT_METHOD_META,
  InputRunSchema,
  TextEditedSchema,
  docFromJSON,
  inlineTextBetween,
  schema,
  type PMNodeJSON,
} from '@longhand/schema';
import { EditorState, NodeSelection, TextSelection, type Transaction } from 'prosemirror-state';
import { Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { clippingNode, getResearchInput, insertCitation, placeClipping } from './commands';
import { citationInsertedDraft } from './drafts';

const DOC: PMNodeJSON = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The rain fell sideways.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph.' }] },
  ],
};

function stateAt(pos: number, to = pos): EditorState {
  const doc = docFromJSON(DOC);
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos, to) });
}

function run(cmd: ReturnType<typeof insertCitation>, state: EditorState): Transaction | null {
  let tr: Transaction | null = null;
  const ok = cmd(state, (t) => (tr = t));
  return ok ? tr : null;
}

/** What the editor's batcher would commit for this transaction alone. */
function textEditedFor(tr: Transaction) {
  const input = getResearchInput(tr)!;
  return TextEditedSchema.parse({
    documentId: 'doc1',
    baseVersion: 0,
    steps: tr.steps.map((s) => s.toJSON()),
    runs: [input.run],
    timeline: [{ t: 0, kind: input.keystroke.kind, len: input.keystroke.len }],
    characters: input.characters,
    durationMs: 0,
  });
}

/** Nodes inserted by one replace step. */
function insertedNodes(tr: Transaction): string[] {
  const json = tr.steps[0]!.toJSON() as { slice?: { content?: Array<{ type: string }> } };
  return (json.slice?.content ?? []).map((n) => n.type);
}

describe('insertCitation', () => {
  it('inserts one citation atom after the selection, tagged as a citation run', () => {
    const state = stateAt(10, 14); // "fell" selected
    const tr = run(
      insertCitation('src1', ' p. 12 ', { documentId: 'doc1', citationId: 'cite1' }),
      state,
    )!;
    expect(tr).not.toBeNull();
    expect(tr.steps).toHaveLength(1);
    expect(insertedNodes(tr)).toEqual(['citation']);
    const node = tr.doc.nodeAt(14)!;
    expect(node.type.name).toBe('citation');
    expect(node.attrs).toEqual({ sourceId: 'src1', locator: 'p. 12' });
    // Text is untouched; the citation contributes no inline text.
    expect(inlineTextBetween(tr.doc, 0, tr.doc.content.size)).toBe(
      inlineTextBetween(state.doc, 0, state.doc.content.size),
    );
    expect(tr.selection.from).toBe(15);

    const input = tr.getMeta(INPUT_METHOD_META);
    expect(input).toEqual({
      run: { steps: 1, method: 'citation', citationId: 'cite1' },
      companions: [
        {
          type: 'CitationInserted',
          payload: { citationId: 'cite1', documentId: 'doc1', sourceId: 'src1', locator: 'p. 12' },
        },
      ],
      characters: 0,
      keystroke: { kind: 'cite', len: 0 },
    });
    expect(InputRunSchema.safeParse(input.run).success).toBe(true);
    expect(textEditedFor(tr).runs[0]).toEqual(input.run);
  });

  it('produces steps that replay on the base document (as the fold does)', () => {
    const state = stateAt(5);
    const tr = run(insertCitation('src1', null, { documentId: 'doc1', citationId: 'c' }), state)!;
    const payload = textEditedFor(tr);
    let doc = state.doc;
    for (const json of payload.steps) doc = Step.fromJSON(schema, json).apply(doc).doc!;
    expect(doc.eq(tr.doc)).toBe(true);
  });

  it('makes a companion draft the editor can commit first', () => {
    const tr = run(
      insertCitation('src1', '', { documentId: 'doc1', citationId: 'c9' }),
      stateAt(3),
    )!;
    const [companion] = getResearchInput(tr)!.companions;
    const draft = citationInsertedDraft(
      { projectId: 'p', actor: { kind: 'human', id: 'u' }, deviceId: 'd', sessionId: 's' },
      companion!.payload,
    );
    expect(draft.payload).toEqual({
      citationId: 'c9',
      documentId: 'doc1',
      sourceId: 'src1',
      locator: null,
    });
  });

  it('generates a citation id when none is given', () => {
    const tr = run(
      insertCitation('src1', null, { documentId: 'doc1', newId: () => 'gen1' }),
      stateAt(3),
    )!;
    expect(getResearchInput(tr)!.run.citationId).toBe('gen1');
  });

  it('refuses where an inline node cannot go, and rejects over-long locators', () => {
    const doc = docFromJSON({
      type: 'doc',
      content: [{ type: 'scene_break' }, { type: 'paragraph' }],
    });
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 0) });
    expect(insertCitation('src1', null, { documentId: 'doc1' })(state)).toBe(false);
    expect(insertCitation('src1', null, { documentId: 'doc1' })(stateAt(3))).toBe(true);
    expect(() =>
      run(insertCitation('src1', 'x'.repeat(101), { documentId: 'doc1' }), stateAt(3)),
    ).toThrow();
  });
});

describe('placeClipping', () => {
  const clipping = {
    id: 'clip1',
    sourceId: 'src1',
    text: 'It is a truth universally acknowledged,\nthat a single man in possession of a good fortune',
    locator: 'p. 1',
  };

  it('inserts one quote_block after the current block, tagged as a clipping run', () => {
    const state = stateAt(5);
    const tr = run(placeClipping(clipping), state)!;
    expect(tr.steps).toHaveLength(1);
    expect(insertedNodes(tr)).toEqual(['quote_block']);
    const first = state.doc.child(0).nodeSize;
    const quote = tr.doc.nodeAt(first)!;
    expect(quote.type.name).toBe('quote_block');
    expect(quote.attrs).toEqual({ sourceId: 'src1', clippingId: 'clip1', locator: 'p. 1' });
    // The fold's check: the quote block's inline text equals the clipping text.
    expect(inlineTextBetween(tr.doc, first, first + quote.nodeSize)).toBe(clipping.text);
    expect(quote.childCount).toBe(2);

    expect(getResearchInput(tr)).toEqual({
      run: { steps: 1, method: 'clipping', clippingId: 'clip1' },
      companions: [],
      characters: clipping.text.length - 1,
      keystroke: { kind: 'clip', len: clipping.text.length - 1 },
    });
    expect(textEditedFor(tr).characters).toBe(clipping.text.length - 1);
    // The cursor lands after the quote, in the next paragraph.
    expect(tr.selection.$from.parent.textContent).toBe('Second paragraph.');
  });

  it('places at the end of the document and at an explicit position', () => {
    const end = stateAt(30);
    const atEnd = run(placeClipping(clipping), end)!;
    expect(atEnd.doc.lastChild!.type.name).toBe('quote_block');
    const top = run(placeClipping(clipping, { pos: 0 }), end)!;
    expect(top.doc.firstChild!.type.name).toBe('quote_block');
    expect(placeClipping(clipping, { pos: 3 })(end)).toBe(false); // inside a paragraph
  });

  it('places after the enclosing top-level block from inside a list', () => {
    const doc = docFromJSON({
      type: 'doc',
      content: [
        {
          type: 'bullet_list',
          content: [
            {
              type: 'list_item',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
      ],
    });
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 4) });
    const tr = run(placeClipping(clipping), state)!;
    expect(tr.doc.child(1).type.name).toBe('quote_block');
  });

  it('clippingNode makes one paragraph per line', () => {
    const node = clippingNode({ ...clipping, text: 'a\nb\nc', locator: null });
    expect(node.toJSON()).toEqual({
      type: 'quote_block',
      attrs: { sourceId: 'src1', clippingId: 'clip1', locator: null },
      content: ['a', 'b', 'c'].map((t) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: t }],
      })),
    });
  });
});
