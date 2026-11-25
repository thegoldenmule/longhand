import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  inlineTextBetween,
  parseSentenceId,
  resolveAnchor,
  resolveInsertionPoint,
  resolveMerge,
  resolveMove,
  resolveSpan,
  resolveSplit,
  segment,
  segmentDoc,
  sentenceId,
} from './anchors';
import { docFromJSON, type PMNodeJSON } from './document';

const t = (text: string, marks?: string[]): PMNodeJSON =>
  marks ? { type: 'text', text, marks: marks.map((m) => ({ type: m })) } : { type: 'text', text };
const p = (...content: PMNodeJSON[]): PMNodeJSON => ({ type: 'paragraph', content });
const h = (level: number, text: string): PMNodeJSON => ({
  type: 'heading',
  attrs: { level },
  content: [t(text)],
});
const doc = (...content: PMNodeJSON[]) => docFromJSON({ type: 'doc', content });

const sample = doc(
  h(1, 'Chapter One'),
  p(t('The rain fell sideways. It was cold. The rain stopped.')),
  p(t('Mr. Smith arrived. '), t('He was ', ['em']), t('late.')),
  { type: 'scene_break' },
  p(t('A short one.')),
  {
    type: 'blockquote',
    content: [p(t('Quoted text. Second.'))],
  },
  {
    type: 'bullet_list',
    content: [{ type: 'list_item', content: [p(t('Item one.'))] }],
  },
  h(2, 'Part B'),
  p(
    t('Claim here'),
    { type: 'citation', attrs: { sourceId: 'src1', locator: 'p. 4' } },
    t(', and'),
    { type: 'hard_break' },
    t('more'),
    { type: 'footnote', content: [t('Note one. Note two.')] },
    t(' text.'),
  ),
);

describe('segmentDoc', () => {
  const s = segmentDoc(sample);

  it('numbers textblocks in document order at any depth', () => {
    expect(s.blocks.map((b) => [b.id, b.nodeType, b.depth, b.parentType])).toEqual([
      ['p1', 'heading', 0, 'doc'],
      ['p2', 'paragraph', 0, 'doc'],
      ['p3', 'paragraph', 0, 'doc'],
      ['p4', 'paragraph', 0, 'doc'],
      ['p5', 'paragraph', 1, 'blockquote'],
      ['p6', 'paragraph', 2, 'list_item'],
      ['p7', 'heading', 0, 'doc'],
      ['p8', 'paragraph', 0, 'doc'],
    ]);
    expect(s.footnotes.map((f) => f.id)).toEqual(['fn1']);
  });

  it('assigns sentence ids and exact positions', () => {
    const sents = segment(s);
    expect(sents.map((x) => `${x.id}: ${x.text}`)).toEqual([
      'p1.s1: Chapter One',
      'p2.s1: The rain fell sideways.',
      'p2.s2: It was cold.',
      'p2.s3: The rain stopped.',
      'p3.s1: Mr. Smith arrived.',
      'p3.s2: He was late.',
      'p4.s1: A short one.',
      'p5.s1: Quoted text.',
      'p5.s2: Second.',
      'p6.s1: Item one.',
      'p7.s1: Part B',
      'p8.s1: Claim here, and\nmore text.',
      'fn1.s1: Note one.',
      'fn1.s2: Note two.',
    ]);
    for (const x of sents) {
      // Positions slice back to the same text (marks and hard breaks included).
      expect(inlineTextBetween(sample, x.from, x.to)).toBe(x.text);
    }
  });

  it('excludes footnote text from the host sentence but includes the node in its range', () => {
    const host = s.sentenceById.get('p8.s1');
    const fn = s.footnotes[0];
    expect(host && fn).toBeTruthy();
    expect(fn!.pos).toBeGreaterThan(host!.from);
    expect(fn!.end).toBeLessThan(host!.to);
    expect(sample.textBetween(fn!.contentFrom, fn!.contentTo)).toBe('Note one. Note two.');
  });

  it('numbers empty paragraphs but gives them no sentences', () => {
    const d = doc(p(), p(t('Hi.')));
    const sg = segmentDoc(d);
    expect(sg.blocks.map((b) => b.id)).toEqual(['p1', 'p2']);
    expect(sg.sentences.map((x) => x.id)).toEqual(['p2.s1']);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(segment(sample))).toBe(
      JSON.stringify(segment(docFromJSON(sample.toJSON()))),
    );
  });
});

describe('sentence id helpers', () => {
  it('round-trips', () => {
    expect(sentenceId('p', 2, 1)).toBe('p3.s2');
    expect(parseSentenceId('p3.s2')).toEqual({
      prefix: 'p',
      blockId: 'p3',
      blockIndex: 2,
      sentenceIndex: 1,
    });
    expect(parseSentenceId('fn1.s1')?.blockId).toBe('fn1');
    expect(parseSentenceId('p0.s1')).toBeNull();
    expect(parseSentenceId('p3')).toBeNull();
  });
});

describe('resolveAnchor', () => {
  const s = segmentDoc(sample);
  const a = (sentenceId: string, quote: string, occurrence?: number) => ({
    documentId: 'd1',
    sentenceId,
    quote,
    ...(occurrence === undefined ? {} : { occurrence }),
  });

  it('maps a quote to positions', () => {
    const r = resolveAnchor(s, a('p2.s1', 'fell sideways'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sample.textBetween(r.from, r.to)).toBe('fell sideways');
    expect(r.anchor.occurrence).toBe(0);
  });

  it('works across mark boundaries', () => {
    const r = resolveAnchor(s, a('p3.s2', 'was late'));
    expect(r.ok && sample.textBetween(r.from, r.to)).toBe('was late');
  });

  it('spans citations and hard breaks', () => {
    const r = resolveAnchor(s, a('p8.s1', 'here, and\nmore'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(inlineTextBetween(sample, r.from, r.to)).toBe('here, and\nmore');
    const r2 = resolveAnchor(s, a('p8.s1', 'more text.'));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    // The footnote node sits inside this range.
    expect(r2.to - r2.from).toBeGreaterThan('more text.'.length);
    expect(inlineTextBetween(sample, r2.from, r2.to)).toBe('more text.');
  });

  it('resolves inside footnotes', () => {
    const r = resolveAnchor(s, a('fn1.s2', 'two'));
    expect(r.ok && inlineTextBetween(sample, r.from, r.to)).toBe('two');
  });

  it('disambiguates repeated quotes', () => {
    const d = doc(p(t('The cat saw the cat.')));
    expect(resolveAnchor(d, a('p1.s1', 'cat'))).toMatchObject({
      ok: false,
      error: { code: 'ambiguous-quote' },
    });
    const r0 = resolveAnchor(d, a('p1.s1', 'cat', 0));
    const r1 = resolveAnchor(d, a('p1.s1', 'cat', 1));
    expect(r0.ok && r1.ok).toBe(true);
    if (!r0.ok || !r1.ok) return;
    expect(r1.from).toBeGreaterThan(r0.from);
    expect(d.textBetween(r1.from, r1.to)).toBe('cat');
    expect(resolveAnchor(d, a('p1.s1', 'cat', 2))).toMatchObject({
      ok: false,
      error: { code: 'occurrence-out-of-range' },
    });
  });

  it('counts overlapping occurrences', () => {
    const d = doc(p(t('aaa')));
    const r = resolveAnchor(d, a('p1.s1', 'aa', 1));
    expect(r.ok && [r.from, r.to]).toEqual([2, 4]);
  });

  it('rejects unknown sentences and missing quotes with a helpful message', () => {
    expect(resolveAnchor(s, a('p9.s1', 'x'))).toMatchObject({
      ok: false,
      error: { code: 'unknown-sentence' },
    });
    const r = resolveAnchor(s, a('p2.s1', 'fell down'));
    expect(r).toMatchObject({ ok: false, error: { code: 'quote-not-found' } });
    if (!r.ok) expect(r.error.message).toContain('The rain fell sideways.');
    // Quotes must stay within the named sentence.
    expect(resolveAnchor(s, a('p2.s1', 'sideways. It was'))).toMatchObject({ ok: false });
    expect(resolveAnchor(s, a('p2.s1', '   '))).toMatchObject({
      ok: false,
      error: { code: 'empty' },
    });
  });

  it('accepts a Node or a Segmentation', () => {
    expect(resolveAnchor(sample, a('p2.s2', 'cold'))).toEqual(resolveAnchor(s, a('p2.s2', 'cold')));
  });

  it('property: every substring of every sentence resolves back to itself', () => {
    const sents = segment(s);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: sents.length - 1 }), fc.nat(), fc.nat(), (si, x, y) => {
        const sent = sents[si]!;
        const i = x % sent.text.length;
        const j = i + 1 + (y % (sent.text.length - i));
        const quote = sent.text.slice(i, j);
        if (quote.trim() === '') return;
        const occ = (() => {
          let n = 0;
          for (
            let k = sent.text.indexOf(quote);
            k !== -1 && k < i;
            k = sent.text.indexOf(quote, k + 1)
          )
            n++;
          return n;
        })();
        const r = resolveAnchor(s, a(sent.id, quote, occ));
        expect(r.ok).toBe(true);
        if (r.ok) expect(inlineTextBetween(sample, r.from, r.to)).toBe(quote);
      }),
    );
  });
});

describe('resolveSpan', () => {
  const s = segmentDoc(sample);

  it('sentence runs', () => {
    const r = resolveSpan(s, { unit: 'sentence', ids: ['p2.s2', 'p2.s3'] });
    expect(r.ok && sample.textBetween(r.from, r.to)).toBe('It was cold. The rain stopped.');
    expect(resolveSpan(s, { unit: 'sentence', ids: ['p2.s1', 'p2.s3'] })).toMatchObject({
      ok: false,
      error: { code: 'not-contiguous' },
    });
    expect(resolveSpan(s, { unit: 'sentence', ids: ['p2.s3', 'p3.s1'] })).toMatchObject({
      ok: false,
      error: { code: 'not-contiguous' },
    });
    expect(resolveSpan(s, { unit: 'sentence', ids: ['p2'] })).toMatchObject({
      ok: false,
      error: { code: 'wrong-unit' },
    });
  });

  it('paragraph runs cover whole nodes and must be adjacent top-level blocks', () => {
    const r = resolveSpan(s, { unit: 'paragraph', ids: ['p2', 'p3'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b2 = s.blockById.get('p2')!;
    const b3 = s.blockById.get('p3')!;
    expect([r.from, r.to]).toEqual([b2.pos, b3.end]);
    expect(sample.slice(r.from, r.to).content.childCount).toBe(2);
    // p3 and p4 are separated by a scene break.
    expect(resolveSpan(s, { unit: 'paragraph', ids: ['p3', 'p4'] })).toMatchObject({
      ok: false,
      error: { code: 'not-contiguous' },
    });
    expect(resolveSpan(s, { unit: 'paragraph', ids: ['p5'] })).toMatchObject({
      ok: false,
      error: { code: 'not-top-level' },
    });
    expect(resolveSpan(s, { unit: 'paragraph', ids: ['fn1'] })).toMatchObject({
      ok: false,
      error: { code: 'not-top-level' },
    });
    expect(resolveSpan(s, { unit: 'paragraph', ids: [] })).toMatchObject({
      ok: false,
      error: { code: 'empty' },
    });
  });

  it('sections run to the next heading of the same or higher level', () => {
    const r1 = resolveSpan(s, { unit: 'section', ids: ['p1'] });
    expect(r1.ok && [r1.from, r1.to]).toEqual([0, sample.content.size]); // h2 does not end an h1 section
    const r7 = resolveSpan(s, { unit: 'section', ids: ['p7'] });
    expect(r7.ok && [r7.from, r7.to]).toEqual([s.blockById.get('p7')!.pos, sample.content.size]);
    expect(resolveSpan(s, { unit: 'section', ids: ['p2'] })).toMatchObject({
      ok: false,
      error: { code: 'wrong-unit' },
    });
    const d = doc(h(2, 'A'), p(t('a.')), h(2, 'B'), p(t('b.')), h(2, 'C'));
    const ab = resolveSpan(d, { unit: 'section', ids: ['p1', 'p3'] });
    expect(ab.ok && [ab.from, ab.to]).toEqual([0, segmentDoc(d).blockById.get('p5')!.pos]);
    expect(resolveSpan(d, { unit: 'section', ids: ['p1', 'p5'] })).toMatchObject({
      ok: false,
      error: { code: 'not-contiguous' },
    });
  });
});

describe('resolveMove / resolveInsertionPoint / resolveSplit / resolveMerge', () => {
  const s = segmentDoc(sample);

  it('moves', () => {
    const r = resolveMove(
      s,
      { unit: 'sentence', ids: ['p2.s3'] },
      { position: 'before', id: 'p2.s1' },
    );
    expect(r.ok && r.insertAt).toBe(s.sentenceById.get('p2.s1')!.from);
    expect(
      resolveMove(s, { unit: 'paragraph', ids: ['p2'] }, { position: 'after', id: 'p4' }),
    ).toMatchObject({
      ok: true,
      insertAt: s.blockById.get('p4')!.end,
    });
    // No-op and self-overlapping destinations.
    expect(
      resolveMove(s, { unit: 'paragraph', ids: ['p2'] }, { position: 'before', id: 'p3' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-destination' },
    });
    expect(
      resolveMove(
        s,
        { unit: 'sentence', ids: ['p2.s1', 'p2.s2'] },
        { position: 'after', id: 'p2.s1' },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-destination' },
    });
    expect(
      resolveMove(s, { unit: 'paragraph', ids: ['p2'] }, { position: 'after', id: 'p2.s1' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-destination' },
    });
  });

  it('insertion points', () => {
    expect(resolveInsertionPoint(s, 'after', 'p2.s1')).toMatchObject({
      ok: true,
      pos: s.sentenceById.get('p2.s1')!.to,
    });
    expect(resolveInsertionPoint(s, 'before', 'p2.s1')).toMatchObject({
      ok: true,
      pos: s.sentenceById.get('p2.s1')!.from,
    });
    expect(resolveInsertionPoint(s, 'before', 'p99.s1')).toMatchObject({ ok: false });
  });

  it('splits', () => {
    expect(resolveSplit(s, 'p2', 'p2.s2')).toMatchObject({
      ok: true,
      pos: s.sentenceById.get('p2.s2')!.from,
    });
    expect(resolveSplit(s, 'p2', 'p2.s1')).toMatchObject({
      ok: false,
      error: { code: 'invalid-split' },
    });
    expect(resolveSplit(s, 'p2', 'p3.s2')).toMatchObject({
      ok: false,
      error: { code: 'invalid-split' },
    });
    expect(resolveSplit(s, 'p1', 'p1.s1')).toMatchObject({
      ok: false,
      error: { code: 'invalid-split' },
    });
  });

  it('merges', () => {
    expect(resolveMerge(s, 'p2', 'p3')).toMatchObject({
      ok: true,
      joinPos: s.blockById.get('p2')!.end,
    });
    expect(resolveMerge(s, 'p3', 'p4')).toMatchObject({
      ok: false,
      error: { code: 'invalid-merge' },
    });
    expect(resolveMerge(s, 'p1', 'p2')).toMatchObject({
      ok: false,
      error: { code: 'invalid-merge' },
    });
    expect(resolveMerge(s, 'p4', 'p5')).toMatchObject({
      ok: false,
      error: { code: 'invalid-merge' },
    });
  });
});

describe('inlineTextBetween', () => {
  it('separates blocks and skips footnotes unless the range starts in one', () => {
    const s = segmentDoc(sample);
    const b2 = s.blockById.get('p2')!;
    const b3 = s.blockById.get('p3')!;
    expect(inlineTextBetween(sample, b2.contentFrom, b3.contentTo, ' | ')).toBe(
      'The rain fell sideways. It was cold. The rain stopped. | Mr. Smith arrived. He was late.',
    );
    const b8 = s.blockById.get('p8')!;
    expect(inlineTextBetween(sample, b8.contentFrom, b8.contentTo)).toBe(
      'Claim here, and\nmore text.',
    );
  });
});
