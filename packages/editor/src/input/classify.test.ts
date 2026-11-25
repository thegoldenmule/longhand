import { sha256Hex, type DeclaredInput } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { classifyTransaction, type ClassifyContext, type TransactionFacts } from './classify';
import type { TrackerState } from './tracker';

const NOW = 10_000;

function tracker(over: Partial<TrackerState> = {}): TrackerState {
  return {
    now: NOW,
    windowMs: 500,
    editorInputAt: -Infinity,
    activationAt: -Infinity,
    textBudget: 0,
    textBudgetAt: -Infinity,
    composing: false,
    compositionEndedAt: -Infinity,
    compositionLength: 0,
    autocorrectAt: -Infinity,
    autocorrectLength: 0,
    historyAt: -Infinity,
    cutAt: -Infinity,
    paste: null,
    drop: null,
    ...over,
  };
}

function facts(over: Partial<TransactionFacts> = {}, text = 'a'): TransactionFacts {
  return {
    docChanged: true,
    composition: false,
    insertedUnits: text.length,
    insertedChars: text.length,
    deletedChars: 0,
    split: false,
    structural: false,
    steps: 1,
    insertedNodeNames: new Set(['text']),
    insertedText: () => text,
    ...over,
  };
}

let ids = 0;
const ctx: ClassifyContext = { projectId: 'proj', policy: 'refuse', newId: () => `id${++ids}` };

describe('classifyTransaction', () => {
  it('passes selection-only transactions untagged', () => {
    expect(classifyTransaction(facts({ docChanged: false }), tracker(), ctx)).toEqual({
      ok: true,
      tag: null,
      consume: {},
    });
  });

  it('classifies typing backed by a beforeinput budget as typed', () => {
    const r = classifyTransaction(facts(), tracker({ editorInputAt: NOW - 5, textBudget: 1 }), ctx);
    expect(r).toMatchObject({
      ok: true,
      tag: { method: 'typed', kind: 'insert' },
      consume: { text: 1 },
    });
  });

  it('refuses insertions without input events', () => {
    const r = classifyTransaction(facts(), tracker(), ctx);
    expect(r.ok).toBe(false);
  });

  it('refuses insertions beyond the typed budget (a plugin adding text on a keystroke)', () => {
    const r = classifyTransaction(
      facts({}, 'hello world'),
      tracker({ editorInputAt: NOW - 5, textBudget: 1 }),
      ctx,
    );
    expect(r).toMatchObject({ ok: false });
  });

  it('flags over-budget insertions as pasted-external under policy flag', () => {
    const r = classifyTransaction(
      facts({}, 'hello world'),
      tracker({ editorInputAt: NOW - 5, textBudget: 1 }),
      { ...ctx, policy: 'flag' },
    );
    expect(r).toMatchObject({
      ok: true,
      tag: {
        method: 'pasted-external',
        flagged: true,
        paste: { origin: 'external', characters: 11 },
      },
    });
  });

  it('never flags a deletion without input: it is refused under both policies', () => {
    const del = facts({ insertedUnits: 0, insertedChars: 0, deletedChars: 20 }, '');
    expect(classifyTransaction(del, tracker(), ctx).ok).toBe(false);
    expect(classifyTransaction(del, tracker(), { ...ctx, policy: 'flag' }).ok).toBe(false);
  });

  it('accepts deletions and breaks after a key event', () => {
    const del = facts({ insertedUnits: 0, insertedChars: 0, deletedChars: 1 }, '');
    expect(classifyTransaction(del, tracker({ editorInputAt: NOW - 1 }), ctx)).toMatchObject({
      ok: true,
      tag: { method: 'typed', kind: 'delete' },
    });
    const brk = facts({ insertedUnits: 0, insertedChars: 0, split: true }, '');
    expect(classifyTransaction(brk, tracker({ editorInputAt: NOW - 1 }), ctx)).toMatchObject({
      ok: true,
      tag: { kind: 'break' },
    });
  });

  it('expires input after the window', () => {
    const r = classifyTransaction(
      facts(),
      tracker({ editorInputAt: NOW - 600, textBudget: 1 }),
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it('allows format-only changes from a toolbar click (activation outside the editor)', () => {
    const fmt = facts({ insertedUnits: 0, insertedChars: 0, structural: true }, '');
    expect(classifyTransaction(fmt, tracker({ activationAt: NOW - 10 }), ctx)).toMatchObject({
      ok: true,
      tag: { kind: 'format' },
    });
    // …but not text insertions.
    expect(
      classifyTransaction(facts(), tracker({ activationAt: NOW - 10, textBudget: 5 }), ctx).ok,
    ).toBe(false);
  });

  it('honours grants from Longhand commands', () => {
    const hardBreak = facts(
      { insertedUnits: 1, insertedChars: 1, grant: { units: 1, kind: 'break' }, hintKind: 'break' },
      '\n',
    );
    expect(classifyTransaction(hardBreak, tracker({ editorInputAt: NOW - 1 }), ctx)).toMatchObject({
      ok: true,
      tag: { method: 'typed', kind: 'break' },
    });
  });

  it('classifies composition changes as ime within the composition length', () => {
    const r = classifyTransaction(
      facts({ composition: true }, '日本'),
      tracker({ editorInputAt: NOW - 1, composing: true, compositionLength: 2 }),
      ctx,
    );
    expect(r).toMatchObject({ ok: true, tag: { method: 'ime', kind: 'compose' } });
    const tooMuch = classifyTransaction(
      facts({ composition: true }, '日本語の文章'),
      tracker({ editorInputAt: NOW - 1, composing: true, compositionLength: 2 }),
      ctx,
    );
    expect(tooMuch.ok).toBe(false);
  });

  it('classifies insertReplacementText as autocorrect', () => {
    const r = classifyTransaction(
      facts({}, 'their'),
      tracker({ editorInputAt: NOW - 1, autocorrectAt: NOW - 1, textBudget: 5 }),
      ctx,
    );
    expect(r).toMatchObject({
      ok: true,
      tag: { method: 'autocorrect', kind: 'autocorrect' },
      consume: { autocorrect: true },
    });
  });

  it('classifies undo/redo as history', () => {
    const r = classifyTransaction(
      facts({ history: { redo: false } }, 'lots of text'),
      tracker({ editorInputAt: NOW - 1 }),
      ctx,
    );
    expect(r).toMatchObject({ ok: true, tag: { method: 'history', kind: 'undo' } });
    expect(classifyTransaction(facts({ history: { redo: true } }), tracker(), ctx).ok).toBe(false);
  });

  it('classifies a paste without a marker as pasted-external with PasteOccurred data', () => {
    const r = classifyTransaction(
      facts({ uiEvent: 'paste' }, 'Two words'),
      tracker({
        editorInputAt: NOW - 1,
        paste: { at: NOW - 1, mimeTypes: ['text/plain'], marker: null },
      }),
      ctx,
    );
    expect(r).toMatchObject({
      ok: true,
      tag: {
        method: 'pasted-external',
        kind: 'paste',
        paste: {
          origin: 'external',
          via: 'clipboard',
          copyId: null,
          characters: 9,
          words: 2,
          textHash: sha256Hex('Two words'),
          mimeTypes: ['text/plain'],
        },
      },
      consume: { paste: true },
    });
    if (r.ok) expect(r.tag?.pasteId).toBe(r.tag?.paste?.pasteId);
  });

  it('classifies a paste with a matching marker as pasted-internal', () => {
    const marker = {
      v: 1 as const,
      copyId: 'copy1',
      projectId: 'proj',
      documentId: 'doc',
      textHash: sha256Hex('copied'),
    };
    const r = classifyTransaction(
      facts({ uiEvent: 'paste' }, 'copied'),
      tracker({ editorInputAt: NOW - 1, paste: { at: NOW - 1, mimeTypes: [], marker } }),
      ctx,
    );
    expect(r).toMatchObject({
      ok: true,
      tag: { method: 'pasted-internal', paste: { origin: 'internal', copyId: 'copy1' } },
    });
  });

  it('downgrades internal pastes whose text or project does not match', () => {
    const marker = {
      v: 1 as const,
      copyId: 'copy1',
      projectId: 'proj',
      documentId: 'doc',
      textHash: sha256Hex('copied'),
    };
    const edited = classifyTransaction(
      facts({ uiEvent: 'paste' }, 'copied, then edited'),
      tracker({ paste: { at: NOW - 1, mimeTypes: [], marker } }),
      ctx,
    );
    expect(edited).toMatchObject({
      ok: true,
      tag: { method: 'pasted-external', paste: { copyId: null } },
    });
    const otherProject = classifyTransaction(
      facts({ uiEvent: 'paste' }, 'copied'),
      tracker({ paste: { at: NOW - 1, mimeTypes: [], marker: { ...marker, projectId: 'other' } } }),
      ctx,
    );
    expect(otherProject).toMatchObject({ ok: true, tag: { method: 'pasted-external' } });
  });

  it('refuses programmatic pastes (no trusted paste event)', () => {
    expect(
      classifyTransaction(facts({ uiEvent: 'paste' }), tracker({ editorInputAt: NOW - 1 }), ctx).ok,
    ).toBe(false);
  });

  it('classifies drops', () => {
    const internal = classifyTransaction(
      facts({ uiEvent: 'drop' }),
      tracker({ drop: { at: NOW - 1, internal: true, mimeTypes: [] } }),
      ctx,
    );
    expect(internal).toMatchObject({ ok: true, tag: { method: 'drop-internal', kind: 'drop' } });
    const external = classifyTransaction(
      facts({ uiEvent: 'drop' }),
      tracker({ drop: { at: NOW - 1, internal: false, mimeTypes: ['text/plain'] } }),
      ctx,
    );
    expect(external).toMatchObject({
      ok: true,
      tag: { method: 'pasted-external', kind: 'drop', paste: { via: 'drop' } },
    });
  });

  it('classifies a cut as a typed deletion', () => {
    const r = classifyTransaction(
      facts({ uiEvent: 'cut', insertedUnits: 0, insertedChars: 0, deletedChars: 4 }, ''),
      tracker({ cutAt: NOW - 1 }),
      ctx,
    );
    expect(r).toMatchObject({ ok: true, tag: { method: 'typed', kind: 'cut' } });
  });

  it('adds traceSuggestionId to typed runs only', () => {
    const c = { ...ctx, traceSuggestionId: 'sug1' };
    expect(
      classifyTransaction(facts(), tracker({ editorInputAt: NOW - 1, textBudget: 1 }), c),
    ).toMatchObject({ tag: { traceSuggestionId: 'sug1' } });
    const paste = classifyTransaction(
      facts({ uiEvent: 'paste' }),
      tracker({ paste: { at: NOW - 1, mimeTypes: [], marker: null } }),
      c,
    );
    expect(paste.ok && paste.tag?.traceSuggestionId).toBeFalsy();
  });

  describe('declared input (INPUT_METHOD_META)', () => {
    const citation = {
      run: { steps: 1, method: 'citation' as const, citationId: 'cit1' },
      companions: [
        {
          type: 'CitationInserted' as const,
          payload: { citationId: 'cit1', documentId: 'doc', sourceId: 'src', locator: null },
        },
      ],
      characters: 0,
      keystroke: { kind: 'cite' as const, len: 0 },
    };
    const citeFacts = facts(
      {
        declared: citation,
        insertedUnits: 1,
        insertedChars: 0,
        insertedNodeNames: new Set(['citation']),
      },
      '',
    );

    it('accepts a citation after a user gesture, carrying its companion', () => {
      const r = classifyTransaction(citeFacts, tracker({ activationAt: NOW - 20 }), ctx);
      expect(r).toMatchObject({
        ok: true,
        tag: {
          method: 'citation',
          citationId: 'cit1',
          kind: 'cite',
          companions: citation.companions,
        },
      });
    });

    it('refuses without a gesture, or when the steps insert text', () => {
      expect(classifyTransaction(citeFacts, tracker(), ctx).ok).toBe(false);
      const sneaky = facts(
        { declared: citation, insertedNodeNames: new Set(['citation', 'text']) },
        'AI words',
      );
      expect(classifyTransaction(sneaky, tracker({ activationAt: NOW - 1 }), ctx).ok).toBe(false);
    });

    it('refuses declared methods the fold cannot verify', () => {
      // The meta is untyped at runtime: a forged method is refused.
      const typed = {
        ...citation,
        run: { steps: 1, method: 'typed' },
      } as unknown as DeclaredInput;
      expect(
        classifyTransaction(facts({ declared: typed }), tracker({ activationAt: NOW - 1 }), ctx).ok,
      ).toBe(false);
    });

    it('accepts a clipping that inserts one quote block', () => {
      const clip = {
        run: { steps: 1, method: 'clipping' as const, clippingId: 'clip1' },
        companions: [],
        characters: 5,
        keystroke: { kind: 'clip' as const, len: 5 },
      };
      const ok = facts(
        { declared: clip, insertedNodeNames: new Set(['quote_block', 'paragraph', 'text']) },
        'quote',
      );
      expect(classifyTransaction(ok, tracker({ activationAt: NOW - 1 }), ctx)).toMatchObject({
        ok: true,
        tag: { method: 'clipping', clippingId: 'clip1', kind: 'clip', timelineLen: 5 },
      });
      const bad = facts(
        { declared: clip, insertedNodeNames: new Set(['heading', 'text']) },
        'quote',
      );
      expect(classifyTransaction(bad, tracker({ activationAt: NOW - 1 }), ctx).ok).toBe(false);
    });
  });
});
