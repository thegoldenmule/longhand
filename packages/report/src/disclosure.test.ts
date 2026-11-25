import { loadFixture } from '@longhand/ledger/fixtures';
import type { ProvenanceClass } from '@longhand/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeReport } from './compute';
import { disclosureStatement, type DisclosureInput } from './disclosure';
import { allocateTenths, count, formatDuration, formatInt, joinList, percentLabel } from './format';

const base: DisclosureInput = (() => {
  const f = loadFixture('plain-typing');
  const { disclosure: _, ...rest } = computeReport(f.commits, { scope: 'project' });
  return rest;
})();

/** A report with every count at zero, then `edit` applied. */
function variant(edit: (r: DisclosureInput) => void): DisclosureInput {
  const r = structuredClone(base);
  r.sessions = { count: 0, days: 0, firstAt: null, lastAt: null, list: [] };
  for (const c of Object.keys(r.words.byClass) as ProvenanceClass[]) r.words.byClass[c] = 0;
  r.words.total = 0;
  edit(r);
  return r;
}

function words(r: DisclosureInput, counts: Partial<Record<ProvenanceClass, number>>): void {
  for (const [c, n] of Object.entries(counts)) r.words.byClass[c as ProvenanceClass] = n;
  r.words.total = Object.values(r.words.byClass).reduce((a, b) => a + b, 0);
}

const say = (edit: (r: DisclosureInput) => void) => disclosureStatement(variant(edit));

describe('disclosure template', () => {
  it('handles an empty record', () => {
    expect(say(() => {})).toBe(
      'No writing sessions were recorded in Longhand. The manuscript has no words yet. No AI feedback was requested in Longhand.',
    );
    expect(say((r) => (r.scope = { kind: 'document', documentId: 'd' }))).toContain(
      'The document has no words yet.',
    );
  });

  it('pluralizes sessions and days', () => {
    expect(say((r) => (r.sessions.count = 1))).toMatch(/^Written in 1 session\. /);
    expect(say((r) => Object.assign(r.sessions, { count: 3, days: 1 }))).toMatch(
      /^Written in 3 sessions on 1 day\. /,
    );
    expect(say((r) => Object.assign(r.sessions, { count: 14, days: 9 }))).toMatch(
      /^Written in 14 sessions over 9 days\. /,
    );
  });

  it('says 100% only when it is all of it', () => {
    expect(say((r) => words(r, { typed: 1 }))).toContain('1 word: 100% typed directly.');
    expect(say((r) => words(r, { typed: 1234 }))).toContain('1,234 words: 100% typed directly.');
    // 99.95% typed rounds down, never up to 100%.
    expect(say((r) => words(r, { typed: 9995, 'pasted-external': 5 }))).toContain(
      '10,000 words: 99.9% typed directly; 0.1% pasted or unverified.',
    );
  });

  it('rounds shares so they sum to 100%', () => {
    expect(
      say((r) => words(r, { typed: 1, 'typed-from-suggestion': 1, 'pasted-external': 1 })),
    ).toContain('3 words: 33.3% typed directly; 33.3% retyped from AI suggestions; 33.4% pasted');
    expect(say((r) => words(r, { typed: 2, quoted: 1 }))).toContain(
      '3 words: 66.6% typed directly; 33.4% quoted.',
    );
  });

  it('never prints a non-zero share as 0% or a partial share as 100%', () => {
    expect(say((r) => words(r, { typed: 99998, quoted: 1, 'pasted-external': 1 }))).toContain(
      '100,000 words: 99.9% typed directly; under 0.1% quoted; 0.1% pasted or unverified.',
    );
    expect(say((r) => words(r, { typed: 1, 'pasted-external': 99999 }))).toContain(
      'under 0.1% typed directly; over 99.9% pasted',
    );
  });

  it('names the AI texts behind retyped words', () => {
    const one = say((r) => {
      words(r, { typed: 978, 'typed-from-suggestion': 16, 'pasted-external': 6 });
      r.extensions.assisted = {
        annotations: 11,
        byKind: { ...r.extensions.assisted.byKind, 'word-choice': 11 },
      };
      r.pastes.external.count = 2;
    });
    expect(one).toContain(
      '1,000 words: 97.8% typed directly; 1.6% retyped from 11 AI word-choice suggestions; 0.6% pasted (2 external pastes).',
    );
    const many = say((r) => {
      words(r, { typed: 9, 'typed-from-suggestion': 1 });
      r.extensions.assisted = {
        annotations: 4,
        byKind: { ...r.extensions.assisted.byKind, 'word-choice': 1, insertion: 1, comment: 2 },
      };
    });
    expect(many).toContain(
      '10.0% retyped from AI text (1 word-choice suggestion, 1 suggested sentence and 2 comments)',
    );
  });

  it('describes AI activity, including zero accepted', () => {
    const s = say((r) => {
      r.ai.feedbackRequests = 3;
      r.ai.comments = 1;
      r.proposals.total = 5;
      r.proposals.byKind.move.proposed = 3;
      r.proposals.byKind.cut.proposed = 2;
      r.extensions.proposals.moves.paragraph.proposed = 3;
    });
    expect(s).toContain('AI feedback was requested 3 times; the editor left 1 comment.');
    expect(s).toContain('AI proposed 3 paragraph moves and 2 cuts; none accepted.');
    const t = say((r) => {
      r.ai.feedbackRequests = 1;
      r.proposals.total = 3;
      r.proposals.byKind.move = { proposed: 3, accepted: 2, rejected: 1, stale: 0, open: 0 };
      r.extensions.proposals.moves.paragraph = { proposed: 3, accepted: 2 };
      r.suggestions.total = 4;
      r.suggestions.byOutcome = { open: 1, adopted: 2, adapted: 0, stale: 0, dismissed: 1 };
    });
    expect(t).toContain(
      'AI feedback was requested once. AI made 4 wording suggestions: 2 adopted, 1 dismissed and 1 still open. AI proposed 3 paragraph moves; 2 accepted.',
    );
  });

  it('mentions imports and unwitnessed intervals', () => {
    const s = say((r) => {
      words(r, { typed: 1, imported: 3 });
      r.imports = { documents: 1, words: 1 };
    });
    expect(s).toContain('75.0% imported (unverified)');
    expect(s).toContain('1 document was imported from an existing draft (1 word at import)');
    const two = say((r) => (r.imports = { documents: 2, words: 2400 }));
    expect(two).toContain('2 documents were imported from existing drafts (2,400 words at import)');
    const one = say((r) => {
      r.unwitnessed = [
        {
          fromSeq: 4,
          toSeq: 4,
          firstClientTime: '2026-11-02T09:00:00.000Z',
          lastClientTime: '2026-11-02T09:00:00.000Z',
          serverTime: '2026-11-02T09:10:00.000Z',
          reason: 'queued-offline',
          commits: 1,
          maxLagMs: 600_000,
        },
      ];
    });
    expect(one).toContain(
      "1 interval of writing (1 commit) reached the server late after being queued offline, so its timing rests on the device's clock.",
    );
  });
});

describe('number formatting', () => {
  it('formats integers, counts, lists and durations without Intl', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatInt(999)).toBe('999');
    expect(formatInt(1000)).toBe('1,000');
    expect(formatInt(1234567)).toBe('1,234,567');
    expect(count(1, 'day')).toBe('1 day');
    expect(count(2, 'day')).toBe('2 days');
    expect(count(2, 'summary', 'summaries')).toBe('2 summaries');
    expect(joinList([])).toBe('');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(30_000)).toBe('under 1 min');
    expect(formatDuration(5_400_000)).toBe('1 h 30 min');
    expect(formatDuration(7_200_000)).toBe('2 h');
  });

  it('allocates tenths that sum to 100%, never rounding the typed share up', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 100_000 }), { minLength: 1, maxLength: 6 }),
        fc.nat({ max: 5 }),
        (counts, k) => {
          const floorIndex = k % counts.length;
          const total = counts.reduce((a, b) => a + b, 0);
          const tenths = allocateTenths(counts, floorIndex);
          if (total === 0) return tenths.every((t) => t === 0);
          if (tenths.reduce((a, b) => a + b, 0) !== 1000) return false;
          // The floored entry never exceeds its exact share.
          if ((tenths[floorIndex] as number) * total > (counts[floorIndex] as number) * 1000)
            return false;
          // Every entry is within one tenth of its exact share.
          return counts.every((c, i) => Math.abs((tenths[i] as number) * total - c * 1000) < total);
        },
      ),
    );
  });

  it('labels shares honestly', () => {
    expect(percentLabel(0, 1, 10_000)).toBe('under 0.1%');
    expect(percentLabel(1000, 9_999, 10_000)).toBe('over 99.9%');
    expect(percentLabel(1000, 5, 5)).toBe('100%');
    expect(percentLabel(978, 978, 1000)).toBe('97.8%');
    expect(percentLabel(0, 0, 0)).toBe('0%');
  });
});
