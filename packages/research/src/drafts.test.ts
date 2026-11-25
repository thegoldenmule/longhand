import { CommitDraftSchema, SCHEMA_VERSION } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import {
  citationInsertedDraft,
  clippingRemovedDraft,
  clippingSavedDraft,
  normalizeClippingText,
  researchCardDismissedDraft,
  sourceAddedDraft,
  sourceUpdatedDraft,
  surfacedSourceAddedDraft,
  type DraftContext,
} from './drafts';

function ctx(): DraftContext {
  let n = 0;
  return {
    projectId: 'proj1',
    actor: { kind: 'human', id: 'user1' },
    deviceId: 'dev1',
    sessionId: 'sess1',
    now: () => new Date('2026-11-24T12:00:00.000Z'),
    newId: () => `id${++n}`,
  };
}

const csl = { id: 'doi:10.1038/nature14539', type: 'article-journal', title: 'Deep learning' };

describe('draft builders', () => {
  it('SourceAdded: envelope, new ids, CSL id = source id', () => {
    const d = sourceAddedDraft(ctx(), {
      csl,
      origin: { kind: 'doi', value: '10.1038/nature14539' },
    });
    expect(d).toEqual({
      commitId: 'id2',
      projectId: 'proj1',
      clientTime: '2026-11-24T12:00:00.000Z',
      actor: { kind: 'human', id: 'user1' },
      deviceId: 'dev1',
      sessionId: 'sess1',
      type: 'SourceAdded',
      schemaVersion: SCHEMA_VERSION,
      payload: {
        sourceId: 'id1',
        csl: { ...csl, id: 'id1' },
        origin: { kind: 'doi', value: '10.1038/nature14539' },
        fromSurfacedId: null,
        candidateIndex: null,
      },
    });
    expect(CommitDraftSchema.safeParse(d).success).toBe(true);
  });

  it('SourceAdded from an AI-surfaced candidate', () => {
    const d = surfacedSourceAddedDraft(ctx(), 'surf1', 2, {
      csl,
      provider: 'crossref',
      url: 'https://doi.org/10.1038/nature14539',
    });
    expect(d.payload).toMatchObject({
      origin: { kind: 'surfaced', value: 'https://doi.org/10.1038/nature14539' },
      fromSurfacedId: 'surf1',
      candidateIndex: 2,
    });
    expect(CommitDraftSchema.safeParse(d).success).toBe(true);
  });

  it('SourceUpdated: only the given fields; rejects an empty update', () => {
    const d = sourceUpdatedDraft(ctx(), 'src1', { note: 'useful for ch. 2', csl });
    expect(d.payload).toEqual({
      sourceId: 'src1',
      note: 'useful for ch. 2',
      csl: { ...csl, id: 'src1' },
    });
    expect(sourceUpdatedDraft(ctx(), 'src1', { archived: true }).payload).toEqual({
      sourceId: 'src1',
      archived: true,
    });
    expect(() => sourceUpdatedDraft(ctx(), 'src1', {})).toThrow();
  });

  it('ClippingSaved: trims locator, nulls empty note, normalizes text', () => {
    const d = clippingSavedDraft(ctx(), {
      sourceId: 'src1',
      text: 'First line\r\n\r\nSecond line\n',
      locator: ' p. 4 ',
      note: '',
    });
    expect(d.payload).toEqual({
      clippingId: 'id1',
      sourceId: 'src1',
      text: 'First line\nSecond line',
      locator: 'p. 4',
      note: null,
    });
    expect(() => clippingSavedDraft(ctx(), { sourceId: 'src1', text: '  \n ' })).toThrow();
  });

  it('ClippingRemoved and CitationInserted', () => {
    expect(clippingRemovedDraft(ctx(), 'clip1').payload).toEqual({ clippingId: 'clip1' });
    const c = citationInsertedDraft(ctx(), {
      citationId: 'cite1',
      documentId: 'doc1',
      sourceId: 'src1',
      locator: 'p. 9',
    });
    expect(c.type).toBe('CitationInserted');
    expect(CommitDraftSchema.safeParse(c).success).toBe(true);
  });

  it('SuggestionDismissed for a research card', () => {
    const d = researchCardDismissedDraft(ctx(), 'surf1', 'wrong');
    expect(d.payload).toEqual({ targetId: 'surf1', reason: 'wrong', note: null });
    expect(CommitDraftSchema.safeParse(d).success).toBe(true);
  });

  it('refuses non-human actors', () => {
    expect(() =>
      clippingRemovedDraft({ ...ctx(), actor: { kind: 'agent', id: 'opus' } }, 'clip1'),
    ).toThrow(/human/);
  });

  it('normalizeClippingText collapses blank lines', () => {
    expect(normalizeClippingText('\n\na\n\n\nb\n')).toBe('a\nb');
  });
});
