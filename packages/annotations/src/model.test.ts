import { foldCommits, projectState } from '@longhand/ledger';
import { describe, expect, it } from 'vitest';
import { ANNOTATION_FIXTURES, fixtureCommits, fixtureState } from '../test-support/fixtures';
import { untilFirstReview } from '../test-support/foldingTransport';
import {
  cardsFromState,
  filterCards,
  groupCards,
  hasAnyAnnotations,
  reviewsFromState,
  threadFailure,
  threadFor,
  type Card,
} from './model';

function annotationIds(state: ReturnType<typeof fixtureState>): string[] {
  const a = state.annotations;
  return [
    ...Object.keys(a.comments),
    ...Object.keys(a.questions),
    ...Object.keys(a.suggestions),
    ...Object.keys(a.proposals),
    ...Object.keys(a.citationFlags),
    ...Object.keys(a.surfacedSources),
    ...Object.keys(a.sourceSuggestions),
  ].sort();
}

const byId = (cards: Card[]): Map<string, Card> => new Map(cards.map((c) => [c.id, c]));

describe('cardsFromState', () => {
  it.each(ANNOTATION_FIXTURES)('makes one card per annotation in %s', (name) => {
    const state = fixtureState(name);
    const cards = cardsFromState(state);
    expect(cards.map((c) => c.id).sort()).toEqual(annotationIds(state));
    for (const c of cards) {
      expect(c.documentId === null || state.documents[c.documentId]).toBeTruthy();
      expect(['open', 'stale', 'resolved']).toContain(c.phase);
    }
  });

  it('labels suggestion outcomes from the fold', () => {
    const cards = byId(cardsFromState(fixtureState('suggestions')));
    expect(cards.get('sug-adopt')).toMatchObject({
      phase: 'resolved',
      outcome: 'Adopted · retyped',
    });
    expect(cards.get('sug-adapt')).toMatchObject({ phase: 'resolved', outcome: 'Adapted' });
    expect(cards.get('sug-stale')).toMatchObject({ phase: 'stale' });
    expect(cards.get('sug-arrival')).toMatchObject({ phase: 'stale' });
    expect(cards.get('sug-dismiss')).toMatchObject({
      phase: 'resolved',
      outcome: 'Dismissed · not my voice',
    });
    expect(cards.get('sug-insert')).toMatchObject({ kind: 'suggestion', phase: 'resolved' });
    expect(cards.get('sug-rephrase')).toMatchObject({ phase: 'resolved', outcome: 'Adapted' });
    expect(cards.get('com-s')).toMatchObject({
      kind: 'comment',
      phase: 'open',
      quote: 'The lane was empty',
    });
  });

  it('labels proposal outcomes and keeps open previews positioned', () => {
    const final = byId(cardsFromState(fixtureState('proposals')));
    expect(final.get('mv-sentence')).toMatchObject({
      phase: 'resolved',
      outcome: 'Accepted',
      range: null,
    });
    expect(final.get('merge-rejected')).toMatchObject({ outcome: 'Rejected · wrong' });
    expect(final.get('cut-rejected')).toMatchObject({ outcome: 'Rejected · not my voice' });
    expect(final.get('merge-stale')).toMatchObject({ phase: 'stale' });

    const open = byId(
      cardsFromState(projectState(foldCommits(untilFirstReview(fixtureCommits('proposals'))))),
    );
    for (const id of [
      'mv-sentence',
      'cut-anchor',
      'split-1',
      'merge-rejected',
      'mv-paragraph',
      'cut-rejected',
      'merge-stale',
    ]) {
      const c = open.get(id)!;
      expect(c.phase).toBe('open');
      expect(c.anchorPos).not.toBeNull();
    }
    expect(open.get('cut-anchor')!.quote).toBe(' here');
    expect(open.get('mv-sentence')!.quote).toBe('The town was built anyway.');
  });

  it('marks research cards AI-surfaced and cited flags resolved', () => {
    const cards = byId(cardsFromState(fixtureState('research')));
    expect(cards.get('flag-1')).toMatchObject({
      kind: 'citation-flag',
      phase: 'resolved',
      outcome: 'Cited',
      aiSurfaced: true,
    });
    expect(cards.get('flag-2')).toMatchObject({ phase: 'open', aiSurfaced: true });
    expect(cards.get('surf-1')).toMatchObject({ kind: 'surfaced-source', aiSurfaced: true });
    expect(cards.get('ss-1')).toMatchObject({
      kind: 'source-suggestion',
      phase: 'resolved',
      outcome: 'Dismissed · later',
    });
  });

  it('keeps unanchored questions when filtering by document', () => {
    const state = fixtureState('feedback-session');
    const cards = cardsFromState(state, { documentId: 'doc-ch1' });
    expect(cards.find((c) => c.id === 'q-2')).toMatchObject({ documentId: null, anchorPos: null });
    expect(cards.at(-1)!.id).toBe('q-2');
    expect(cardsFromState(state, { documentId: 'elsewhere' }).map((c) => c.id)).toEqual(['q-2']);
  });

  it('orders cards by position', () => {
    const cards = cardsFromState(
      projectState(foldCommits(untilFirstReview(fixtureCommits('suggestions')))),
    );
    const anchored = cards.filter((c) => c.anchorPos !== null).map((c) => c.anchorPos!);
    expect(anchored).toEqual([...anchored].sort((a, b) => a - b));
  });
});

describe('filters and groups', () => {
  it('filters by phase and group', () => {
    const cards = cardsFromState(fixtureState('suggestions'));
    expect(filterCards(cards).every((c) => c.phase !== 'resolved')).toBe(true);
    expect(filterCards(cards, { phase: 'resolved' }).every((c) => c.phase === 'resolved')).toBe(
      true,
    );
    expect(filterCards(cards, { phase: 'all' })).toHaveLength(cards.length);
    expect(filterCards(cards, { phase: 'all', groups: ['comments'] }).map((c) => c.id)).toEqual([
      'com-s',
    ]);
    expect(groupCards(cards).map((g) => g.group)).toEqual(['suggestions', 'comments']);
  });
});

describe('reviewsFromState', () => {
  it('shows finished and failed reviews, newest first', () => {
    const reviews = reviewsFromState(fixtureState('feedback-session'));
    expect(reviews.map((r) => [r.requestId, r.phase])).toEqual([
      ['req-2', 'failed'],
      ['req-1', 'finished'],
    ]);
    expect(reviews[0]!.failureReason).toBe('model timeout');
    expect(reviews[1]!.session?.review?.topPriorities).toHaveLength(2);
    expect(reviews[1]!.annotationIds).toEqual(['com-1', 'com-2', 'q-1', 'q-2']);
  });

  it('shows a running review', () => {
    const commits = fixtureCommits('feedback-session');
    const idx = commits.findIndex((c) => c.type === 'QuestionAsked');
    const reviews = reviewsFromState(projectState(foldCommits(commits.slice(0, idx))));
    expect(reviews[0]).toMatchObject({ phase: 'reviewing', annotationIds: ['com-1', 'com-2'] });
    const waiting = reviewsFromState(
      projectState(
        foldCommits(
          commits.slice(
            0,
            commits.findIndex((c) => c.type === 'FeedbackSessionStarted'),
          ),
        ),
      ),
    );
    expect(waiting[0]!.phase).toBe('waiting');
  });

  it('is empty when nothing was requested', () => {
    const commits = fixtureCommits('feedback-session');
    const before = projectState(
      foldCommits(
        commits.slice(
          0,
          commits.findIndex((c) => c.type === 'FeedbackRequested'),
        ),
      ),
    );
    expect(reviewsFromState(before)).toEqual([]);
    expect(hasAnyAnnotations(before)).toBe(false);
    expect(cardsFromState(before)).toEqual([]);
  });
});

describe('discuss threads', () => {
  it('finds the thread and its last failure', () => {
    const state = fixtureState('discuss');
    const t = threadFor(state, 'sug-d')!;
    expect(t.id).toBe('thr-1');
    expect(t.messages.map((m) => m.role)).toEqual(['writer', 'editor', 'writer']);
    expect(threadFailure(state, 'thr-1')).toBe('model unavailable');
    expect(threadFor(state, 'nothing')).toBeNull();
  });
});
