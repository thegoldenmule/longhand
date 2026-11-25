import { describe, expect, it } from 'vitest';
import { docFromJSON } from './document';
import {
  PROVENANCE_CLASSES,
  ProvenanceRunSchema,
  checkProvenanceRuns,
  provenanceUnits,
  runAt,
  type ProvenanceRun,
} from './provenance';

// doc: <p>ab<citation/>c</p><hr/><p>d<footnote>ef</footnote></p>
const doc = docFromJSON({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'ab' },
        { type: 'citation', attrs: { sourceId: 's1' } },
        { type: 'text', text: 'c' },
      ],
    },
    { type: 'scene_break' },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'd' },
        { type: 'footnote', content: [{ type: 'text', text: 'ef' }] },
      ],
    },
  ],
});
// Positions: p opens at 0; a=1 b=2 cite=3 c=4; p closes 5→6; hr 6; p opens 7; d=8; footnote 9 (open), e=10 f=11, close 12.

const run = (
  from: number,
  to: number,
  cls: ProvenanceRun['class'] = 'typed',
  originSeq = 2,
  extra: Partial<ProvenanceRun> = {},
) => ({ from, to, class: cls, originSeq, ...extra }) as ProvenanceRun;

describe('provenance units', () => {
  it('are text characters and inline leaves only', () => {
    expect(provenanceUnits(doc)).toEqual([1, 2, 3, 4, 8, 10, 11]);
  });
});

describe('checkProvenanceRuns', () => {
  it('accepts the canonical form', () => {
    const runs = [
      run(1, 3),
      run(3, 4, 'quoted'),
      run(4, 5),
      run(8, 9),
      run(10, 12, 'pasted-external', 5),
    ];
    expect(checkProvenanceRuns(doc, runs)).toBeNull();
    for (const r of runs) expect(ProvenanceRunSchema.safeParse(r).success).toBe(true);
  });

  it('runs never span block boundaries or footnote tokens', () => {
    expect(
      checkProvenanceRuns(doc, [run(1, 3), run(3, 4, 'quoted'), run(4, 9), run(10, 12)]),
    ).toMatch(/not a text unit/);
    expect(
      checkProvenanceRuns(doc, [run(1, 3), run(3, 4, 'quoted'), run(4, 5), run(8, 12)]),
    ).toMatch(/not a text unit/);
  });

  it('requires merging identical adjacent runs and full coverage', () => {
    expect(
      checkProvenanceRuns(doc, [
        run(1, 2),
        run(2, 3),
        run(3, 4, 'quoted'),
        run(4, 5),
        run(8, 9),
        run(10, 12),
      ]),
    ).toMatch(/merged/);
    expect(
      checkProvenanceRuns(doc, [run(1, 3), run(3, 4, 'quoted'), run(4, 5), run(8, 9)]),
    ).toMatch(/not covered/);
    expect(checkProvenanceRuns(doc, [run(2, 3)])).toMatch(/expected the next unit/);
  });

  it('enforces suggestionId, matchedKind and pasted-internal rules', () => {
    const base = [run(3, 4, 'quoted'), run(4, 5), run(8, 9), run(10, 12)];
    expect(checkProvenanceRuns(doc, [run(1, 3, 'typed-from-suggestion'), ...base])).toMatch(
      /suggestionId/,
    );
    expect(
      checkProvenanceRuns(doc, [
        run(1, 3, 'typed-from-suggestion', 2, { suggestionId: 's1', matchedKind: 'comment' }),
        ...base,
      ]),
    ).toBeNull();
    expect(
      checkProvenanceRuns(doc, [
        run(1, 3, 'typed-from-suggestion', 2, { suggestionId: 's1' }),
        ...base,
      ]),
    ).toMatch(/matchedKind/);
    expect(
      checkProvenanceRuns(doc, [
        run(1, 2, 'typed-from-suggestion', 2, { suggestionId: 's1', matchedKind: 'comment' }),
        run(2, 3, 'typed-from-suggestion', 2, { suggestionId: 's1', matchedKind: 'discuss' }),
        ...base,
      ]),
    ).toBeNull();
    expect(
      checkProvenanceRuns(doc, [
        run(1, 3, 'typed', 2, { suggestionId: 's1', matchedKind: 'suggestion' }),
        ...base,
      ]),
    ).toMatch(/suggestionId/);
    expect(checkProvenanceRuns(doc, [run(1, 3, 'pasted-internal'), ...base])).toMatch(
      /never a run class/,
    );
    expect(checkProvenanceRuns(doc, [run(1, 3, 'typed', 2, { moves: [9, 7] }), ...base])).toMatch(
      /ascending/,
    );
  });

  it('runAt finds the covering run', () => {
    const runs = [
      run(1, 3),
      run(3, 4, 'quoted'),
      run(4, 5),
      run(8, 9),
      run(10, 12, 'pasted-external', 5),
    ];
    expect(runAt(runs, 3)?.class).toBe('quoted');
    expect(runAt(runs, 11)?.originSeq).toBe(5);
    expect(runAt(runs, 6)).toBeUndefined();
  });

  it('lists the six spec classes', () => {
    expect(PROVENANCE_CLASSES).toEqual([
      'typed',
      'typed-from-suggestion',
      'pasted-external',
      'pasted-internal',
      'imported',
      'quoted',
    ]);
  });
});
