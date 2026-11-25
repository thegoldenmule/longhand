import { describe, expect, it } from 'vitest';
import { CAPS, capsFor } from './bounds';
import { EVENTS } from './events';
import {
  EMPTY_SESSION_COUNTS,
  SuggestInsertionInput,
  SuggestWordChoiceInput,
  TOOLS,
  TOOL_JSON_SCHEMAS,
  TOOL_NAMES,
  capViolation,
  countCall,
  rephraseGuidanceViolation,
  toolsForSession,
  type SessionCounts,
  type ToolName,
} from './tools';

const anchor = { documentId: 'd1', sentenceId: 'p1.s1', quote: 'rain' };

describe('catalog', () => {
  it('has exactly the spec tools plus answer_discussion', () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
        'read_document',
        'read_notes',
        'get_outline',
        'comment',
        'ask_question',
        'suggest_word_choice',
        'suggest_insertion',
        'suggest_rephrase',
        'propose_move',
        'propose_cut',
        'propose_split',
        'propose_merge',
        'flag_citation_needed',
        'search_sources',
        'suggest_source',
        'finish_review',
        'answer_discussion',
      ].sort(),
    );
  });

  it('has no tool that could write manuscript text', () => {
    for (const name of TOOL_NAMES) {
      expect(name).not.toMatch(/rewrite|replace|write|insert_text|edit/);
      const emits = TOOLS[name].emits;
      if (emits) expect(EVENTS[emits].actor, name).toBe('agent');
      if (emits) expect(EVENTS[emits].manuscript, name).toBe(false);
    }
  });

  it('exports an object JSON Schema for every tool, with no $schema key', () => {
    for (const name of TOOL_NAMES) {
      const js = TOOL_JSON_SCHEMAS[name];
      expect(js.type).toBe('object');
      expect(js).not.toHaveProperty('$schema');
      expect(JSON.parse(JSON.stringify(js))).toEqual(js);
    }
    const wc = TOOL_JSON_SCHEMAS.suggest_word_choice as unknown as {
      properties: { alternatives: { maxItems: number; minItems: number } };
      required: string[];
    };
    expect(wc.properties.alternatives).toMatchObject({ minItems: 1, maxItems: 3 });
    expect(wc.required).toEqual(expect.arrayContaining(['anchor', 'alternatives', 'rationale']));
    const comment = TOOL_JSON_SCHEMAS.comment as unknown as {
      properties: { body: { maxLength: number } };
    };
    expect(comment.properties.body.maxLength).toBe(600);
  });

  it('splits tools by session kind', () => {
    expect(toolsForSession('discuss').sort()).toEqual(
      ['answer_discussion', 'get_outline', 'read_document', 'read_notes'].sort(),
    );
    expect(toolsForSession('review')).toContain('finish_review');
    expect(toolsForSession('review')).not.toContain('answer_discussion');
  });
});

describe('argument bounds', () => {
  const ok = (name: ToolName, input: unknown) => TOOLS[name].input.safeParse(input).success;

  it('comment: body ≤ 600 and exactly one target', () => {
    const base = { category: 'pacing', severity: 'minor', body: 'Slow.' };
    expect(ok('comment', { ...base, anchor })).toBe(true);
    expect(
      ok('comment', { ...base, span: { documentId: 'd1', unit: 'paragraph', ids: ['p1'] } }),
    ).toBe(true);
    expect(ok('comment', base)).toBe(false);
    expect(
      ok('comment', {
        ...base,
        anchor,
        span: { documentId: 'd1', unit: 'paragraph', ids: ['p1'] },
      }),
    ).toBe(false);
    expect(ok('comment', { ...base, anchor, body: 'x'.repeat(601) })).toBe(false);
    expect(ok('comment', { ...base, anchor, body: '   ' })).toBe(false);
    expect(ok('comment', { ...base, anchor, category: 'vibes' })).toBe(false);
  });

  it('ask_question: ≤ 300 chars, optional anchor', () => {
    expect(ok('ask_question', { question: 'Who narrates?' })).toBe(true);
    expect(ok('ask_question', { question: 'x'.repeat(301) })).toBe(false);
  });

  it('suggest_word_choice: anchor ≤ 4 words, 1-3 alternatives ≤ 4 words, distinct', () => {
    const base = { anchor, alternatives: ['drizzle'], rationale: 'Specific.' };
    expect(SuggestWordChoiceInput.safeParse(base).success).toBe(true);
    expect(
      ok('suggest_word_choice', {
        ...base,
        anchor: { ...anchor, quote: 'one two three four five' },
      }),
    ).toBe(false);
    expect(
      ok('suggest_word_choice', { ...base, anchor: { ...anchor, quote: 'one two three four' } }),
    ).toBe(true);
    expect(ok('suggest_word_choice', { ...base, alternatives: [] })).toBe(false);
    expect(ok('suggest_word_choice', { ...base, alternatives: ['a', 'b', 'c', 'd'] })).toBe(false);
    expect(ok('suggest_word_choice', { ...base, alternatives: ['one two three four five'] })).toBe(
      false,
    );
    expect(ok('suggest_word_choice', { ...base, alternatives: ['Rain'] })).toBe(false);
    expect(ok('suggest_word_choice', { ...base, alternatives: ['mist', 'Mist'] })).toBe(false);
    expect(ok('suggest_word_choice', { ...base, alternatives: ['—'] })).toBe(false);
    expect(ok('suggest_word_choice', { ...base, rationale: 'x'.repeat(201) })).toBe(false);
  });

  it('suggest_insertion: exactly one sentence of ≤ 40 words', () => {
    const base = { documentId: 'd1', position: 'after', sentenceId: 'p1.s1', purpose: 'Bridge.' };
    expect(
      SuggestInsertionInput.safeParse({ ...base, sentence: 'She waited by the door.' }).success,
    ).toBe(true);
    expect(ok('suggest_insertion', { ...base, sentence: 'She waited. Then she left.' })).toBe(
      false,
    );
    expect(ok('suggest_insertion', { ...base, sentence: `${'word '.repeat(41).trim()}.` })).toBe(
      false,
    );
    expect(ok('suggest_insertion', { ...base, sentence: `${'word '.repeat(40).trim()}.` })).toBe(
      true,
    );
    expect(
      ok('suggest_insertion', { ...base, sentence: 'Mr. Smith waited, e.g. at the door.' }),
    ).toBe(true);
    expect(ok('suggest_insertion', { ...base, position: 'inside', sentence: 'Hi.' })).toBe(false);
  });

  it('suggest_rephrase: guidance ≤ 200 chars', () => {
    expect(ok('suggest_rephrase', { anchor, guidance: 'Too passive; name who acts.' })).toBe(true);
    expect(ok('suggest_rephrase', { anchor, guidance: 'x'.repeat(201) })).toBe(false);
  });

  it('rephraseGuidanceViolation rejects quoted new wording but allows quoting the writer', () => {
    const sentence = 'The decision was made by the committee after a long delay.';
    expect(rephraseGuidanceViolation('Passive voice; say who decided.', sentence)).toBeNull();
    expect(
      rephraseGuidanceViolation('"was made by the committee" hides the actor.', sentence),
    ).toBeNull();
    expect(
      rephraseGuidanceViolation('Try “The committee finally decided” instead.', sentence),
    ).not.toBeNull();
    expect(rephraseGuidanceViolation('Maybe "decided" alone?', sentence)).toBeNull(); // under 3 words
  });

  it('propose_move / cut / split / merge shapes', () => {
    expect(
      ok('propose_move', {
        documentId: 'd1',
        unit: 'paragraph',
        ids: ['p2', 'p3'],
        destination: { position: 'before', id: 'p1' },
        rationale: 'Open with action.',
      }),
    ).toBe(true);
    expect(
      ok('propose_move', {
        documentId: 'd1',
        unit: 'chapter',
        ids: ['p2'],
        destination: { position: 'before', id: 'p1' },
        rationale: 'x',
      }),
    ).toBe(false);
    expect(
      ok('propose_move', {
        documentId: 'd1',
        unit: 'paragraph',
        ids: [],
        destination: { position: 'before', id: 'p1' },
        rationale: 'x',
      }),
    ).toBe(false);
    expect(ok('propose_cut', { anchor, rationale: 'Redundant.' })).toBe(true);
    expect(ok('propose_cut', { rationale: 'Redundant.' })).toBe(false);
    expect(
      ok('propose_split', {
        documentId: 'd1',
        paragraphId: 'p2',
        sentenceId: 'p2.s3',
        rationale: 'Two ideas.',
      }),
    ).toBe(true);
    expect(
      ok('propose_split', {
        documentId: 'd1',
        paragraphId: 'p2.s1',
        sentenceId: 'p2.s3',
        rationale: 'x',
      }),
    ).toBe(false);
    expect(
      ok('propose_merge', {
        documentId: 'd1',
        firstParagraphId: 'p2',
        secondParagraphId: 'p3',
        rationale: 'One idea.',
      }),
    ).toBe(true);
  });

  it('flag_citation_needed: claim ≤ 150; search/suggest source; finish_review ≤ 5 priorities', () => {
    expect(ok('flag_citation_needed', { anchor, claim: 'x'.repeat(150) })).toBe(true);
    expect(ok('flag_citation_needed', { anchor, claim: 'x'.repeat(151) })).toBe(false);
    expect(ok('search_sources', { query: 'rainfall records 1900' })).toBe(true);
    expect(ok('suggest_source', { anchor, sourceId: 'src1', rationale: 'Covers it.' })).toBe(true);
    const fr = { summary: 'Good.', strengths: ['Voice'], topPriorities: ['a', 'b', 'c', 'd', 'e'] };
    expect(ok('finish_review', fr)).toBe(true);
    expect(ok('finish_review', { ...fr, topPriorities: [...fr.topPriorities, 'f'] })).toBe(false);
  });

  it('anchors must use real sentence ids and non-blank quotes', () => {
    expect(ok('ask_question', { question: 'Q?', anchor: { ...anchor, sentenceId: 'p3' } })).toBe(
      false,
    );
    expect(ok('ask_question', { question: 'Q?', anchor: { ...anchor, quote: ' ' } })).toBe(false);
    expect(ok('ask_question', { question: 'Q?', anchor: { ...anchor, occurrence: -1 } })).toBe(
      false,
    );
  });
});

describe('caps', () => {
  const run = (calls: ToolName[], intensity: 'light' | 'standard' | 'thorough') => {
    let counts: SessionCounts = { ...EMPTY_SESSION_COUNTS };
    const rejected: number[] = [];
    calls.forEach((c, i) => {
      if (capViolation(c, counts, intensity)) rejected.push(i);
      else counts = countCall(c, counts);
    });
    return { counts, rejected };
  };

  it('light touch allows at most 5 items in total', () => {
    const { counts, rejected } = run(
      [
        'comment',
        'ask_question',
        'comment',
        'propose_cut',
        'flag_citation_needed',
        'comment',
        'comment',
      ],
      'light',
    );
    expect(counts.items).toBe(5);
    expect(rejected).toEqual([5, 6]);
  });

  it('never more than 15 suggestions or 3 insertions', () => {
    const many = Array<ToolName>(30).fill('suggest_word_choice');
    expect(run(many, 'thorough').counts.suggestions).toBe(CAPS.maxSuggestionsPerSession);
    const ins = Array<ToolName>(10).fill('suggest_insertion');
    expect(run(ins, 'thorough').counts.insertions).toBe(CAPS.maxInsertionsPerSession);
    for (const i of ['light', 'standard', 'thorough'] as const) {
      expect(capsFor(i).maxSuggestions).toBeLessThanOrEqual(15);
      expect(capsFor(i).maxInsertions).toBeLessThanOrEqual(3);
    }
  });

  it('read and control tools are never capped', () => {
    const calls = Array<ToolName>(100).fill('read_document');
    expect(run([...calls, 'finish_review'], 'light').rejected).toEqual([]);
  });
});
