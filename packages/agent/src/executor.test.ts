import { describe, expect, it } from 'vitest';
import {
  CommitDraftSchema,
  docFromJSON,
  segmentDoc,
  toolsForSession,
  type Intensity,
  type SurfacedCandidate,
} from '@longhand/schema';
import {
  InMemoryAnnotationSink,
  StaticSourceSearch,
  ToolExecutor,
  buildDiscussContext,
  buildReviewContext,
  idTokens,
  writerFacingIdViolation,
  type FeedbackRequest,
  type ToolCallOutcome,
} from './index';
import { deterministic, docRequest, makeState } from './fixtures.test-helpers';

const state = makeState();
const seg = segmentDoc(docFromJSON(state.documents.ch1!.content));
const A = (sentenceId: string, quote: string, occurrence?: number) => ({
  documentId: 'ch1',
  sentenceId,
  quote,
  ...(occurrence === undefined ? {} : { occurrence }),
});

function setup(
  opts: {
    intensity?: Intensity;
    request?: Partial<FeedbackRequest>;
    search?: StaticSourceSearch;
  } = {},
) {
  const ctx = buildReviewContext({
    state,
    request: docRequest({ intensity: opts.intensity ?? 'thorough', ...opts.request }),
    feedbackSessionId: 'fs1',
  });
  const sink = new InMemoryAnnotationSink();
  const ex = new ToolExecutor({
    snapshot: ctx.snapshot,
    sink,
    search: opts.search ?? null,
    ...deterministic(),
  });
  return { ex, sink, ctx };
}

function expectError(o: ToolCallOutcome, code: string, message?: RegExp) {
  expect(o.result.ok).toBe(false);
  if (o.result.ok) return;
  expect(o.result.error.code).toBe(code);
  if (message) expect(o.result.error.message).toMatch(message);
  expect(o.draft).toBeUndefined();
}

const comment = (anchor: unknown) => ({
  anchor,
  category: 'clarity',
  severity: 'minor',
  body: 'This could be clearer.',
});

describe('ToolExecutor: session and tool checks', () => {
  it('offers exactly the review tools and rejects others', async () => {
    const { ex } = setup();
    expect(ex.tools).toEqual(toolsForSession('review'));
    expectError(await ex.call('rewrite_paragraph', {}), 'unknown-tool');
    expectError(
      await ex.call('answer_discussion', { threadId: 't', body: 'x' }),
      'tool-not-allowed',
    );
  });

  it('rejects calls after finish_review', async () => {
    const { ex, sink } = setup();
    const fin = await ex.call('finish_review', {
      summary: 'Good.',
      strengths: [],
      topPriorities: [],
    });
    expect(fin.result.ok).toBe(true);
    expect(fin.finished).toBe(true);
    expect(ex.finished).toBe(true);
    expectError(await ex.call('comment', comment(A('p2.s1', 'rain'))), 'session-finished');
    expectError(
      await ex.call('finish_review', { summary: 'Again.', strengths: [], topPriorities: [] }),
      'session-finished',
    );
    expect(sink.drafts.map((d) => d.draft.type)).toEqual(['ReviewFinished']);
  });

  it('reports zod errors with paths', async () => {
    const { ex } = setup();
    const o = await ex.call('comment', {
      anchor: A('p2.s1', 'rain'),
      category: 'vibes',
      severity: 'minor',
      body: 'x',
    });
    expectError(o, 'invalid-arguments', /category/);
    expectError(
      await ex.call('comment', { category: 'clarity', severity: 'minor', body: 'x' }),
      'invalid-arguments',
      /exactly one of anchor or span/,
    );
  });
});

describe('ToolExecutor: anchors', () => {
  it('accepts a valid anchored comment and resolves positions at the read version', async () => {
    const { ex, sink } = setup();
    const o = await ex.call('comment', comment(A('p2.s1', 'sideways')));
    expect(o.result.ok).toBe(true);
    expect(o.seq).toBe(1);
    const d = sink.drafts[0]!.draft;
    expect(CommitDraftSchema.safeParse(d).success).toBe(true);
    expect(d.actor).toEqual({ kind: 'agent', id: 'opus' });
    expect(d.sessionId).toBe('fs1');
    expect(d.type).toBe('CommentAdded');
    if (d.type !== 'CommentAdded') return;
    const s = seg.sentenceById.get('p2.s1')!;
    const start = s.from + s.text.indexOf('sideways');
    expect(d.payload.target).toEqual({
      kind: 'anchor',
      anchor: { documentId: 'ch1', sentenceId: 'p2.s1', quote: 'sideways', occurrence: 0 },
      from: start,
      to: start + 'sideways'.length,
      readVersion: 7,
      version: 7,
    });
  });

  it('rejects nonexistent sentences, quotes not in the sentence, and unknown documents', async () => {
    const { ex, sink } = setup();
    expectError(await ex.call('comment', comment(A('p9.s1', 'rain'))), 'unknown-sentence');
    expectError(
      await ex.call('comment', comment(A('p2.s2', 'sideways'))),
      'quote-not-found',
      /Copy it exactly/,
    );
    expectError(
      await ex.call('comment', comment({ ...A('p2.s1', 'rain'), documentId: 'nope' })),
      'unknown-document',
      /ch1 \(Chapter 1\)/,
    );
    expectError(
      await ex.call('comment', comment(A('p2', 'rain'))),
      'invalid-arguments',
      /sentence id/,
    );
    expect(sink.drafts).toHaveLength(0);
  });

  it('requires occurrence for repeated quotes and checks its range', async () => {
    const { ex } = setup();
    expectError(
      await ex.call('comment', comment(A('p2.s3', 'rain'))),
      'ambiguous-quote',
      /3 times/,
    );
    expectError(
      await ex.call('comment', comment(A('p2.s3', 'rain', 5))),
      'occurrence-out-of-range',
    );
    const ok = await ex.call('comment', comment(A('p2.s3', 'rain', 2)));
    expect(ok.result.ok).toBe(true);
  });

  it('rejects anchors outside the document under review and on notes', async () => {
    const { ex } = setup();
    expectError(
      await ex.call(
        'comment',
        comment({ documentId: 'ch2', sentenceId: 'p1.s1', quote: 'letter' }),
      ),
      'out-of-scope',
      /covers only document ch1/,
    );
    expectError(
      await ex.call(
        'comment',
        comment({ documentId: 'style', sentenceId: 'p1.s1', quote: 'Short' }),
      ),
      'out-of-scope',
      /note/,
    );
  });

  it('project scope allows any manuscript document', async () => {
    const { ex } = setup({ request: { scope: { kind: 'project' } } });
    const o = await ex.call(
      'comment',
      comment({ documentId: 'ch2', sentenceId: 'p1.s1', quote: 'letter' }),
    );
    expect(o.result.ok).toBe(true);
  });

  it('selection scope rejects targets outside the selection', async () => {
    const p3 = seg.blockById.get('p3')!;
    const { ex } = setup({
      request: {
        scope: {
          kind: 'selection',
          documentId: 'ch1',
          from: p3.contentFrom,
          to: p3.contentTo,
          version: 7,
        },
      },
    });
    expectError(
      await ex.call('comment', comment(A('p2.s1', 'sideways'))),
      'out-of-scope',
      /p3\.s1–p3\.s3/,
    );
    expect((await ex.call('comment', comment(A('p3.s2', 'letter')))).result.ok).toBe(true);
    expectError(
      await ex.call('suggest_insertion', {
        documentId: 'ch1',
        position: 'after',
        sentenceId: 'p5.s2',
        sentence: 'It rained.',
        purpose: 'x',
      }),
      'out-of-scope',
    );
  });

  it('comments can target spans; spans must be contiguous', async () => {
    const { ex } = setup();
    const ok = await ex.call('comment', {
      span: { documentId: 'ch1', unit: 'paragraph', ids: ['p2', 'p3'] },
      category: 'structure',
      severity: 'major',
      body: 'These two paragraphs repeat each other.',
    });
    expect(ok.result.ok).toBe(true);
    expect(ok.draft?.type === 'CommentAdded' && ok.draft.payload.target.kind).toBe('span');
    expectError(
      await ex.call('comment', {
        span: { documentId: 'ch1', unit: 'sentence', ids: ['p2.s1', 'p2.s3'] },
        category: 'structure',
        severity: 'major',
        body: 'x',
      }),
      'not-contiguous',
    );
  });

  it('rejects over-long comment bodies and questions', async () => {
    const { ex } = setup();
    expectError(
      await ex.call('comment', { ...comment(A('p2.s1', 'rain')), body: 'x'.repeat(601) }),
      'invalid-arguments',
      /body/,
    );
    expectError(
      await ex.call('ask_question', { question: 'q'.repeat(301) }),
      'invalid-arguments',
      /question/,
    );
    const q = await ex.call('ask_question', { question: 'What is in the letter?' });
    expect(q.result.ok).toBe(true);
    expect(q.draft?.type === 'QuestionAsked' && q.draft.payload.target).toBeNull();
  });
});

describe('ToolExecutor: suggestions', () => {
  it('word choice: anchor ≤ 4 words, 1–3 alternatives ≤ 4 words each', async () => {
    const { ex } = setup();
    const base = {
      anchor: A('p2.s1', 'sideways'),
      alternatives: ['aslant'],
      rationale: 'Sharper.',
    };
    const ok = await ex.call('suggest_word_choice', base);
    expect(ok.result.ok).toBe(true);
    expect(ok.draft?.type === 'SuggestionProposed' && ok.draft.payload.suggestion.kind).toBe(
      'word-choice',
    );
    expectError(
      await ex.call('suggest_word_choice', {
        ...base,
        anchor: A('p3.s1', 'Mara waited by the window'),
      }),
      'invalid-arguments',
      /at most 4 words/,
    );
    expectError(
      await ex.call('suggest_word_choice', { ...base, alternatives: ['a', 'b', 'c', 'd'] }),
      'invalid-arguments',
    );
    expectError(
      await ex.call('suggest_word_choice', { ...base, alternatives: ['one two three four five'] }),
      'invalid-arguments',
      /1-4 words/,
    );
    expectError(
      await ex.call('suggest_word_choice', { ...base, alternatives: [] }),
      'invalid-arguments',
    );
    expectError(
      await ex.call('suggest_word_choice', { ...base, rationale: 'r'.repeat(201) }),
      'invalid-arguments',
      /rationale/,
    );
  });

  it('insertion: exactly one sentence of ≤ 40 words at a real sentence', async () => {
    const { ex, sink } = setup();
    const base = {
      documentId: 'ch1',
      position: 'after',
      sentenceId: 'p3.s2',
      sentence: 'It had no return address.',
      purpose: 'Raise the stakes.',
    };
    const ok = await ex.call('suggest_insertion', base);
    expect(ok.result.ok).toBe(true);
    const d = sink.drafts[0]!.draft;
    expect(
      d.type === 'SuggestionProposed' &&
        d.payload.suggestion.kind === 'insertion' &&
        d.payload.suggestion.target.pos,
    ).toBe(seg.sentenceById.get('p3.s2')!.to);
    expectError(
      await ex.call('suggest_insertion', { ...base, sentence: 'It had no address. It was blank.' }),
      'invalid-arguments',
      /exactly one sentence/,
    );
    expectError(
      await ex.call('suggest_insertion', { ...base, sentence: `${'word '.repeat(41).trim()}.` }),
      'invalid-arguments',
      /40 words/,
    );
    expectError(
      await ex.call('suggest_insertion', { ...base, sentenceId: 'p3.s9' }),
      'unknown-sentence',
    );
    expectError(
      await ex.call('suggest_insertion', { ...base, documentId: 'zzz' }),
      'unknown-document',
    );
  });

  it('rephrase: guidance must not supply replacement text', async () => {
    const { ex } = setup();
    const ok = await ex.call('suggest_rephrase', {
      anchor: A('p3.s3', 'It said very little'),
      guidance: 'Say what "said very little" means here; be concrete.',
    });
    expect(ok.result.ok).toBe(true);
    expectError(
      await ex.call('suggest_rephrase', {
        anchor: A('p3.s3', 'It said very little'),
        guidance: 'Try "The letter was nearly empty" instead.',
      }),
      'replacement-text',
    );
    expectError(
      await ex.call('suggest_rephrase', {
        anchor: A('p3.s3', 'little. Dawn'),
        guidance: 'Tighten.',
      }),
      'quote-not-found',
    );
  });
});

describe('ToolExecutor: proposals', () => {
  it('move: contiguous run, destination of the same kind outside the span', async () => {
    const { ex, sink } = setup();
    const ok = await ex.call('propose_move', {
      documentId: 'ch1',
      unit: 'paragraph',
      ids: ['p3'],
      destination: { position: 'before', id: 'p2' },
      rationale: 'Open on Mara.',
    });
    expect(ok.result.ok).toBe(true);
    const d = sink.drafts[0]!.draft;
    expect(d.type).toBe('MoveProposed');
    if (d.type === 'MoveProposed') {
      const p2 = seg.blockById.get('p2')!;
      const p3 = seg.blockById.get('p3')!;
      expect(d.payload.source).toMatchObject({
        from: p3.pos,
        to: p3.end,
        readVersion: 7,
        version: 7,
      });
      expect(d.payload.destination).toEqual({ position: 'before', id: 'p2', pos: p2.pos });
    }
    const move = (ids: string[], dest: string, unit = 'paragraph') => ({
      documentId: 'ch1',
      unit,
      ids,
      destination: { position: 'after', id: dest },
      rationale: 'x',
    });
    expectError(await ex.call('propose_move', move(['p2', 'p5'], 'p1')), 'not-contiguous');
    expectError(
      await ex.call('propose_move', move(['p2.s1', 'p2.s3'], 'p3.s1', 'sentence')),
      'not-contiguous',
    );
    expectError(await ex.call('propose_move', move(['p2'], 'p2')), 'invalid-destination');
    expectError(await ex.call('propose_move', move(['p2'], 'p3.s1')), 'invalid-destination');
    expectError(await ex.call('propose_move', move(['p6'], 'p2')), 'not-top-level');
    expectError(await ex.call('propose_move', move(['p2'], 'p99')), 'invalid-destination');
    const section = await ex.call('propose_move', move(['p4'], 'p1', 'section'));
    expect(section.result.ok).toBe(false); // after p1's section is the end of p1..p3 — p4 follows it already
  });

  it('section moves resolve whole sections', async () => {
    const { ex } = setup();
    const o = await ex.call('propose_move', {
      documentId: 'ch1',
      unit: 'section',
      ids: ['p4'],
      destination: { position: 'before', id: 'p1' },
      rationale: 'Start in the morning.',
    });
    expect(o.result.ok).toBe(true);
  });

  it('cut: anchor or span', async () => {
    const { ex } = setup();
    expect(
      (
        await ex.call('propose_cut', {
          anchor: A('p2.s2', 'Nobody came to the door.'),
          rationale: 'Redundant.',
        })
      ).result.ok,
    ).toBe(true);
    expect(
      (
        await ex.call('propose_cut', {
          span: { documentId: 'ch1', unit: 'sentence', ids: ['p2.s2', 'p2.s3'] },
          rationale: 'Slow.',
        })
      ).result.ok,
    ).toBe(true);
    expectError(
      await ex.call('propose_cut', {
        anchor: A('p2.s2', 'x'),
        span: { documentId: 'ch1', unit: 'paragraph', ids: ['p2'] },
        rationale: 'x',
      }),
      'invalid-arguments',
    );
    expectError(
      await ex.call('propose_cut', { anchor: A('p2.s2', 'Nobody'), rationale: 'r'.repeat(301) }),
      'invalid-arguments',
    );
  });

  it('split: a paragraph before a non-first sentence', async () => {
    const { ex } = setup();
    const ok = await ex.call('propose_split', {
      documentId: 'ch1',
      paragraphId: 'p3',
      sentenceId: 'p3.s2',
      rationale: 'Two beats.',
    });
    expect(ok.result.ok).toBe(true);
    expect(ok.draft?.type === 'SplitProposed' && ok.draft.payload.pos).toBe(
      seg.sentenceById.get('p3.s2')!.from,
    );
    expectError(
      await ex.call('propose_split', {
        documentId: 'ch1',
        paragraphId: 'p3',
        sentenceId: 'p3.s1',
        rationale: 'x',
      }),
      'invalid-split',
    );
    expectError(
      await ex.call('propose_split', {
        documentId: 'ch1',
        paragraphId: 'p3',
        sentenceId: 'p2.s2',
        rationale: 'x',
      }),
      'invalid-split',
    );
    expectError(
      await ex.call('propose_split', {
        documentId: 'ch1',
        paragraphId: 'p1',
        sentenceId: 'p1.s1',
        rationale: 'x',
      }),
      'invalid-split',
    );
  });

  it('merge: two directly adjacent paragraphs', async () => {
    const { ex } = setup();
    const ok = await ex.call('propose_merge', {
      documentId: 'ch1',
      firstParagraphId: 'p2',
      secondParagraphId: 'p3',
      rationale: 'One thought.',
    });
    expect(ok.result.ok).toBe(true);
    if (ok.draft?.type === 'MergeProposed') {
      const p2 = seg.blockById.get('p2')!;
      const p3 = seg.blockById.get('p3')!;
      expect(ok.draft.payload).toMatchObject({ joinPos: p2.end, from: p2.pos, to: p3.end });
    }
    expectError(
      await ex.call('propose_merge', {
        documentId: 'ch1',
        firstParagraphId: 'p2',
        secondParagraphId: 'p5',
        rationale: 'x',
      }),
      'invalid-merge',
    );
    expectError(
      await ex.call('propose_merge', {
        documentId: 'ch1',
        firstParagraphId: 'p3',
        secondParagraphId: 'p4',
        rationale: 'x',
      }),
      'invalid-merge',
    );
  });
});

describe('ToolExecutor: research tools', () => {
  const items: SurfacedCandidate[] = [
    {
      csl: { id: 'c1', type: 'article-journal', title: 'Rain and memory', DOI: '10.1/rain' },
      provider: 'crossref',
      url: 'https://doi.org/10.1/rain',
    },
    // The provider comes from the search, not from the item's identifiers.
    {
      csl: { id: 'c2', type: 'book', title: 'Storms', ISBN: '9780000000000' },
      provider: 'web',
      url: null,
    },
    // Invalid CSL, dropped.
    { csl: { id: '', type: 'book' }, provider: 'openlibrary', url: null },
  ];

  it('flag_citation_needed: anchor + claim ≤ 150 chars', async () => {
    const { ex } = setup();
    expect(
      (
        await ex.call('flag_citation_needed', {
          anchor: A('p3.s1', 'an hour'),
          claim: 'She waited an hour.',
        })
      ).result.ok,
    ).toBe(true);
    expectError(
      await ex.call('flag_citation_needed', {
        anchor: A('p3.s1', 'an hour'),
        claim: 'c'.repeat(151),
      }),
      'invalid-arguments',
    );
  });

  it('search_sources: calls SourceSearch and labels candidates', async () => {
    const search = new StaticSourceSearch(items);
    const { ex, sink } = setup({ search });
    const o = await ex.call('search_sources', { query: 'rain memory', anchor: A('p2.s1', 'rain') });
    expect(o.result.ok).toBe(true);
    expect(search.queries).toEqual(['rain memory']);
    const d = sink.drafts[0]!.draft;
    expect(d.type).toBe('SourceSurfaced');
    if (d.type === 'SourceSurfaced') {
      expect(d.payload.candidates.map((c) => [c.provider, c.url])).toEqual([
        ['crossref', 'https://doi.org/10.1/rain'],
        ['web', null],
      ]);
      expect(d.payload.target?.anchor.quote).toBe('rain');
    }
  });

  it('search_sources: empty results produce no event; no search configured is an error', async () => {
    const { ex, sink } = setup({ search: new StaticSourceSearch([]) });
    const o = await ex.call('search_sources', { query: 'nothing' });
    expect(o.result.ok).toBe(true);
    expect(sink.drafts).toHaveLength(0);
    expect(ex.counts.searches).toBe(1);
    const { ex: ex2 } = setup();
    expectError(await ex2.call('search_sources', { query: 'x' }), 'search-unavailable');
  });

  it('suggest_source: the source must be in the library', async () => {
    const { ex } = setup();
    expect(
      (
        await ex.call('suggest_source', {
          anchor: A('p2.s1', 'rain'),
          sourceId: 'src1',
          rationale: 'Covers weather.',
        })
      ).result.ok,
    ).toBe(true);
    expectError(
      await ex.call('suggest_source', {
        anchor: A('p2.s1', 'rain'),
        sourceId: 'src9',
        rationale: 'x',
      }),
      'unknown-source',
      /src1 \(Weather and Mood\)/,
    );
  });
});

describe('ToolExecutor: caps', () => {
  it('light touch: at most 5 items in total', async () => {
    const { ex, sink } = setup({ intensity: 'light' });
    for (let i = 0; i < 5; i++) {
      const o = await ex.call('comment', comment(A('p2.s1', 'rain')));
      expect(o.result.ok).toBe(true);
    }
    expectError(
      await ex.call('comment', comment(A('p2.s1', 'rain'))),
      'cap-reached',
      /at most 5 items/,
    );
    expect(sink.drafts).toHaveLength(5);
    // finish_review never counts against caps.
    expect(
      (await ex.call('finish_review', { summary: 'Done.', strengths: [], topPriorities: [] }))
        .result.ok,
    ).toBe(true);
  });

  it('insertions and questions have their own caps', async () => {
    const { ex } = setup({ intensity: 'light' });
    const ins = {
      documentId: 'ch1',
      position: 'after',
      sentenceId: 'p3.s2',
      sentence: 'It was short.',
      purpose: 'x',
    };
    expect((await ex.call('suggest_insertion', ins)).result.ok).toBe(true);
    expectError(await ex.call('suggest_insertion', ins), 'cap-reached', /insertions/);
    expect((await ex.call('ask_question', { question: 'One?' })).result.ok).toBe(true);
    expect((await ex.call('ask_question', { question: 'Two?' })).result.ok).toBe(true);
    expectError(await ex.call('ask_question', { question: 'Three?' }), 'cap-reached', /questions/);
  });

  it('thorough: at most 15 suggestions (the hard limit)', async () => {
    const { ex } = setup({ intensity: 'thorough' });
    for (let i = 0; i < 15; i++) {
      const o = await ex.call('suggest_word_choice', {
        anchor: A('p2.s1', 'sideways'),
        alternatives: ['aslant'],
        rationale: 'r',
      });
      expect(o.result.ok).toBe(true);
    }
    expectError(
      await ex.call('suggest_word_choice', {
        anchor: A('p2.s1', 'sideways'),
        alternatives: ['aslant'],
        rationale: 'r',
      }),
      'cap-reached',
      /15 suggestions/,
    );
  });

  it('rejected calls do not count', async () => {
    const { ex } = setup({ intensity: 'light' });
    for (let i = 0; i < 10; i++) await ex.call('comment', comment(A('p9.s1', 'nope')));
    expect(ex.counts.items).toBe(0);
  });

  it('parallel calls are serialized so caps hold', async () => {
    const { ex, sink } = setup({ intensity: 'light' });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ex.call('comment', comment(A('p2.s1', 'rain')))),
    );
    expect(results.filter((r) => r.result.ok)).toHaveLength(5);
    expect(sink.drafts).toHaveLength(5);
  });
});

describe('ToolExecutor: sink failures and read tools', () => {
  it('a sink rejection is returned to the model and not counted', async () => {
    const ctx = buildReviewContext({ state, request: docRequest(), feedbackSessionId: 'fs1' });
    const sink = new InMemoryAnnotationSink({
      reject: () => ({ code: 'quote-not-found', message: 'The text changed.', retryable: false }),
    });
    const ex = new ToolExecutor({ snapshot: ctx.snapshot, sink });
    const o = await ex.call('comment', comment(A('p2.s1', 'rain')));
    expectError(o, 'sink-rejected', /The text changed/);
    expect(ex.counts.items).toBe(0);
  });

  it('read tools serve from the snapshot', async () => {
    const { ex, sink } = setup();
    const doc = await ex.call('read_document', { documentId: 'ch2' });
    expect(doc.result.ok && doc.result.content).toContain('[p1.s1] The letter arrived on Tuesday.');
    const notes = await ex.call('read_notes', {});
    expect(notes.result.ok && notes.result.content).toContain(
      'Short sentences. Keep adverbs rare.',
    );
    expectError(await ex.call('read_notes', { noteIds: ['ch1'] }), 'unknown-document');
    const outline = await ex.call('get_outline', {});
    expect(outline.result.ok && outline.result.content).toContain('Chapter 2 (id ch2');
    expectError(await ex.call('read_document', { documentId: 'old' }), 'unknown-document');
    expect(sink.drafts).toHaveLength(0);
    expect(ex.counts.items).toBe(0);
  });
});

describe('ToolExecutor: discuss sessions', () => {
  const ctx = buildDiscussContext({
    state,
    request: { threadId: 'th1', targetId: 'sg0', message: 'Why slantwise?' },
    feedbackSessionId: 'fs2',
  });

  it('offers only read tools and answer_discussion', async () => {
    const ex = new ToolExecutor({ snapshot: ctx.snapshot, sink: new InMemoryAnnotationSink() });
    expect([...ex.tools].sort()).toEqual([
      'answer_discussion',
      'get_outline',
      'read_document',
      'read_notes',
    ]);
    expectError(await ex.call('comment', comment(A('p2.s1', 'rain'))), 'tool-not-allowed');
  });

  it('answers the session thread only, then finishes', async () => {
    const sink = new InMemoryAnnotationSink();
    const ex = new ToolExecutor({ snapshot: ctx.snapshot, sink, ...deterministic() });
    expectError(
      await ex.call('answer_discussion', { threadId: 'other', body: 'Hi.' }),
      'unknown-thread',
    );
    expectError(
      await ex.call('answer_discussion', { threadId: 'th1', body: 'b'.repeat(1201) }),
      'invalid-arguments',
    );
    const o = await ex.call('answer_discussion', {
      threadId: 'th1',
      body: 'Because the rain is at an angle.',
    });
    expect(o.result.ok).toBe(true);
    expect(o.finished).toBe(true);
    expect(sink.drafts[0]!.draft).toMatchObject({
      type: 'DiscussAnswered',
      sessionId: 'fs2',
      actor: { kind: 'agent', id: 'sonnet' },
      payload: { feedbackSessionId: 'fs2', threadId: 'th1', targetId: 'sg0' },
    });
  });
});

describe('ToolExecutor: ids never reach the writer', () => {
  const leaks = [
    'My only word-choice notes are small: "do it" in p1.s2.',
    'The ritual in s2 and the wrong wind in s3–s4 pull against each other.',
    'See s3-4.',
    'The footnote (fn1.s1) repeats the point.',
    'Paragraph p3 runs long.',
    'Compare [p2.s1] with the ending.',
  ];

  it.each(leaks)('rejects a comment body that mentions an id: %s', async (body) => {
    const { ex, sink } = setup();
    const o = await ex.call('comment', { ...comment(A('p2.s1', 'rain')), body });
    expectError(o, 'invalid-arguments', /body mentions .*never sees sentence or paragraph ids/);
    expect(sink.drafts).toHaveLength(0);
  });

  it('checks every writer-facing field, names the field, and lets the corrected call through', async () => {
    const { ex, sink } = setup();
    expectError(
      await ex.call('ask_question', { anchor: A('p2.s1', 'rain'), question: 'Is s1 literal?' }),
      'invalid-arguments',
      /^question mentions "s1"/,
    );
    expectError(
      await ex.call('suggest_rephrase', {
        anchor: A('p2.s3', 'the endless rain'),
        guidance: 'Echoes p2.s1 too closely.',
      }),
      'invalid-arguments',
      /^guidance/,
    );
    expectError(
      await ex.call('propose_cut', { anchor: A('p2.s2', 'Nobody'), rationale: 'Repeats p3.' }),
      'invalid-arguments',
      /^rationale/,
    );
    expectError(
      await ex.call('suggest_word_choice', {
        anchor: A('p2.s1', 'sideways'),
        alternatives: ['slantwise'],
        rationale: 'Sharper next to s2.',
      }),
      'invalid-arguments',
      /^rationale/,
    );
    expectError(
      await ex.call('flag_citation_needed', {
        anchor: A('p2.s2', 'Nobody came'),
        claim: 'The claim in p2.s2.',
      }),
      'invalid-arguments',
      /^claim/,
    );
    expectError(
      await ex.call('finish_review', {
        summary: 'Clear and calm.',
        strengths: ['Good rhythm.', 'The ending of p5 lands.'],
        topPriorities: [],
      }),
      'invalid-arguments',
      /^strengths\.1 mentions "p5"/,
    );
    expectError(
      await ex.call('finish_review', {
        summary: 'Clear and calm.',
        strengths: [],
        topPriorities: ['Tighten s2–s3.'],
      }),
      'invalid-arguments',
      /^topPriorities\.0/,
    );
    expect(sink.drafts).toHaveLength(0);

    const fixed = await ex.call('finish_review', {
      summary: 'My only word-choice note is small: "sideways" in the first sentence.',
      strengths: ['The start of paragraph 2 sets the mood.'],
      topPriorities: [],
    });
    expect(fixed.result.ok).toBe(true);
  });

  it('does not reject ordinary prose that only looks a little like an id', async () => {
    const { ex, sink } = setup();
    const fine = [
      'Add an s to the verb, since the subject is plural.',
      'It reads like the 1990s, and the 80s before that.',
      'The mp3 player and the S3 bucket are anachronisms; so is the P1 grade.',
      'See p. 12 of the style guide, and the s-curve of the plot.',
      'The second sentence of the paragraph is the strongest; its pace is right.',
      "The rain's rhythm works. The fn key and the ps at the end are fine.",
    ];
    for (const body of fine) {
      const o = await ex.call('comment', { ...comment(A('p2.s1', 'rain')), body });
      expect(o.result.ok, body).toBe(true);
    }
    expect(sink.drafts).toHaveLength(fine.length);
  });

  it('allows an id-like word the writer wrote themselves', async () => {
    const s = makeState({ ch1: ['The p53 gene guards the genome. It fails in s1 cells.'] });
    const ctx = buildReviewContext({ state: s, request: docRequest(), feedbackSessionId: 'fs1' });
    const ex = new ToolExecutor({
      snapshot: ctx.snapshot,
      sink: new InMemoryAnnotationSink(),
      ...deterministic(),
    });
    const ok = await ex.call('comment', {
      ...comment(A('p1.s1', 'p53 gene')),
      body: 'Say what p53 does before naming s1 cells.',
    });
    expect(ok.result.ok).toBe(true);
    expectError(
      await ex.call('comment', { ...comment(A('p1.s1', 'p53 gene')), body: 'Merge p1.s2 here.' }),
      'invalid-arguments',
      /"p1\.s2"/,
    );
  });

  it('rejects an id in a discuss answer', async () => {
    const ctx = buildDiscussContext({
      state,
      request: { threadId: 'th1', targetId: 'sg0', message: 'Why slantwise?' },
      feedbackSessionId: 'fs2',
    });
    const ex = new ToolExecutor({
      snapshot: ctx.snapshot,
      sink: new InMemoryAnnotationSink(),
      ...deterministic(),
    });
    expectError(
      await ex.call('answer_discussion', { threadId: 'th1', body: 'Because p2.s1 is about wind.' }),
      'invalid-arguments',
      /^body mentions "p2\.s1"/,
    );
  });
});

describe('writerFacingIdViolation', () => {
  it('finds the id patterns and nothing else', () => {
    expect(idTokens('p1.s2, p3, fn1, fn1.s1, s3–s4, s3-4, s12')).toEqual([
      'p1.s2',
      'p3',
      'fn1',
      'fn1.s1',
      's3–s4',
      's3-4',
      's12',
    ]);
    expect(idTokens('s, its, 1990s, mp3, S3, P1, p., s-curve, ps, fn, sp1x, p1x')).toEqual([]);
    expect(writerFacingIdViolation([{ field: 'body', text: 'All good.' }])).toBeNull();
    expect(
      writerFacingIdViolation([{ field: 'body', text: 'The p53 gene.' }], new Set(['p53'])),
    ).toBeNull();
  });
});
