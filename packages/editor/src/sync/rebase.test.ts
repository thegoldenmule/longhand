import { schema } from '@longhand/schema';
import { EditorState } from 'prosemirror-state';
import { Transform, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { docOf } from '../test/helpers';
import { rebaseOnDoc, rebaseStepsHeadless } from './rebase';

const text = (s: EditorState): string => s.doc.textBetween(0, s.doc.content.size, '|');

describe('rebase', () => {
  // Confirmed doc: "Hello world". Local: insert " brave" after "Hello" and "!" at the end.
  // Remote (applied first by the ledger): insert "Oh, " at the start.
  const base = docOf('Hello world');
  const localTr = new Transform(base).insert(6, schema.text(' brave')).insert(18, schema.text('!'));
  const remoteTr = new Transform(base).insert(1, schema.text('Oh, '));

  it('rebases local steps on the document (collab algorithm)', () => {
    const state = EditorState.create({ doc: localTr.doc, schema });
    const local = localTr.steps.map((step, i) => ({ step, inverted: step.invert(localTr.docs[i]!) }));
    const r = rebaseOnDoc(state.tr, local, remoteTr.steps);
    const next = state.apply(r.transform);
    expect(text(next)).toBe('Oh, Hello brave world!');
    expect(r.steps.every(Boolean)).toBe(true);
    // The rebased steps applied to the new confirmed doc give the same result.
    let doc = remoteTr.doc;
    for (const s of r.steps) doc = (s as Step).apply(doc).doc!;
    expect(doc.eq(next.doc)).toBe(true);
    // mapAfter: a position after the first local step ("Hello brave|") maps past the remote insert.
    expect(r.mapAfter(1, 12)).toBe(16);
    expect(r.survivorsBefore(1)).toBe(1);
  });

  it('gives the same steps headlessly (maps only)', () => {
    const r = rebaseStepsHeadless(localTr.steps, remoteTr.steps);
    let doc = remoteTr.doc;
    for (const s of r.steps) doc = (s as Step).apply(doc).doc!;
    expect(doc.textContent).toBe('Oh, Hello brave world!');
  });

  it('drops local steps whose target the remote deleted', () => {
    const doc = docOf('one two three');
    const local = new Transform(doc).addMark(5, 8, schema.marks.em!.create());
    const remote = new Transform(doc).delete(5, 9);
    const state = EditorState.create({ doc: local.doc, schema });
    const r = rebaseOnDoc(
      state.tr,
      local.steps.map((step, i) => ({ step, inverted: step.invert(local.docs[i]!) })),
      remote.steps,
    );
    expect(text(state.apply(r.transform))).toBe('one three');
    expect(r.steps[0]).toBeNull();
  });
});
