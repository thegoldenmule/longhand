import { CommitDraftSchema, type CommitDraft } from '@longhand/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, settle, type Harness } from '../test-support/fixtures';
import type { SubmittedEvent } from './controller';
import { traceKey } from './trace';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.destroy();
  document.body.innerHTML = '';
});

function make(...args: Parameters<typeof harness>): Harness {
  const h = harness(...args);
  open.push(h);
  return h;
}

const typed = (dom: Element): string =>
  [...dom.querySelectorAll('.lh-trace-typed')].map((e) => e.textContent).join('');

const ofType = (drafts: CommitDraft[], type: string) => drafts.filter((d) => d.type === type);

describe('controller: drawing', () => {
  it('underlines suggestion spans and draws insertion ghosts as aria-hidden widgets', async () => {
    const h = make('suggestions');
    await settle();
    const dom = h.handle.view.dom;
    const marks = [...dom.querySelectorAll('.lh-ann-suggestion')].map((e) => e.textContent);
    expect(marks).toEqual(
      expect.arrayContaining(['old', 'roof', 'waited', 'moved', 'the hedges were black']),
    );
    const ghost = dom.querySelector('.lh-ghost-insertion') as HTMLElement;
    expect(ghost.textContent).toBe(' Her tea had gone cold.');
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.hasAttribute('data-lh-ghost')).toBe(true);
    expect(ghost.getAttribute('contenteditable')).toBe('false');
    expect(ghost.style.userSelect).toBe('none');
    // Ghost text is decoration: the manuscript does not contain it.
    expect(h.text()).not.toContain('Her tea');
    // Word-choice ghosts show inline only on focus.
    expect(dom.querySelector('.lh-ghost-alt')).toBeNull();
    h.controller.focus('sug-adopt');
    expect(dom.querySelector('.lh-ghost-alt')?.textContent).toBe('weathered');
    expect(dom.querySelector('.lh-ann-active')?.textContent).toBe('old');
  });

  it('maps decorations through local edits the ledger has not seen', async () => {
    const h = make('suggestions');
    await settle();
    h.select(1);
    h.typeText('Oh. ');
    const mark = [...h.handle.view.dom.querySelectorAll('.lh-ann-suggestion')].find(
      (e) => e.textContent === 'old',
    );
    expect(mark).toBeTruthy();
    expect(h.controller.localRange('sug-adopt')).toEqual({ from: 26, to: 29 });
    expect(h.handle.getState().doc.textBetween(26, 29)).toBe('old');
  });

  it('draws nothing before a review was requested', async () => {
    const h = make('suggestions');
    const first = h.transport.projectState();
    void first;
    h.controller.setState(null);
    await settle();
    expect(h.handle.view.dom.querySelector('.lh-ann-mark, .lh-ghost')).toBeNull();
    expect(h.controller.getSnapshot().cards).toEqual([]);
  });

  it('previews proposals on hover: outline, drop marker, strike-through, split and join', async () => {
    const h = make('proposals');
    await settle();
    const dom = h.handle.view.dom;
    expect(dom.querySelector('.lh-prop-source')).toBeNull();
    h.controller.hover('mv-sentence');
    expect(dom.querySelector('.lh-prop-source')?.textContent).toBe('The town was built anyway.');
    expect(dom.querySelector('.lh-prop-drop')?.textContent).toBe('move here');
    h.controller.hover('cut-anchor');
    expect(dom.querySelector('.lh-prop-cut-text')?.textContent).toBe(' here');
    h.controller.hover('split-1');
    expect(dom.querySelector('.lh-prop-split-mark.lh-prop-preview')).not.toBeNull();
    h.controller.hover('merge-rejected');
    expect(dom.querySelectorAll('.lh-prop-merge-block')).toHaveLength(2);
    expect(dom.querySelector('.lh-prop-join-mark.lh-prop-preview')).not.toBeNull();
    h.controller.hover('mv-paragraph');
    expect(dom.querySelector('.lh-prop-source-block')?.textContent).toBe(
      'The church still stands. Its bell rings for every flood.',
    );
    expect(dom.querySelector('.lh-prop-drop-block')).not.toBeNull();
  });
});

describe('controller: events', () => {
  it('dismisses with a reason through editor.submitEvent', async () => {
    const submitted: SubmittedEvent[] = [];
    const h = make('suggestions', { controller: { onSubmit: (e) => submitted.push(e) } });
    await settle();
    expect(h.controller.dismiss('sug-dismiss', 'not-my-voice')).toBe(true);
    const d = ofType(h.drafts, 'SuggestionDismissed');
    expect(d).toHaveLength(1);
    expect(CommitDraftSchema.safeParse(d[0]).success).toBe(true);
    expect(d[0]!.payload).toEqual({ targetId: 'sug-dismiss', reason: 'not-my-voice', note: null });
    expect(submitted[0]!.type).toBe('SuggestionDismissed');
    await h.commit();
    expect(h.transport.rejected).toEqual([]);
    expect(h.controller.getSnapshot().cards.find((c) => c.id === 'sug-dismiss')).toMatchObject({
      status: 'dismissed',
      outcome: 'Dismissed · not my voice',
    });
  });

  it('dismisses comments, questions and research cards', async () => {
    const h = make('feedback-session');
    await settle();
    h.controller.dismiss('q-2', null);
    h.controller.dismiss('com-2', 'later', 'after chapter two');
    await h.commit();
    expect(ofType(h.drafts, 'SuggestionDismissed').map((d) => d.payload)).toEqual([
      { targetId: 'q-2', reason: null, note: null },
      { targetId: 'com-2', reason: 'later', note: 'after chapter two' },
    ]);
    expect(h.transport.rejected).toEqual([]);
    const r = make('research');
    await settle();
    r.controller.dismiss('surf-1', 'wrong');
    await r.commit();
    expect(r.transport.projectState().annotations.surfacedSources['surf-1']!.status).toBe(
      'dismissed',
    );
  });

  it('rejects proposals with ProposalRejected', async () => {
    const h = make('proposals');
    await settle();
    h.controller.reject('cut-rejected', 'not-my-voice');
    h.controller.dismiss('merge-rejected', 'wrong'); // proposals are rejected, never dismissed
    await h.commit();
    expect(ofType(h.drafts, 'SuggestionDismissed')).toEqual([]);
    expect(ofType(h.drafts, 'ProposalRejected').map((d) => d.payload)).toEqual([
      { proposalId: 'cut-rejected', reason: 'not-my-voice' },
      { proposalId: 'merge-rejected', reason: 'wrong' },
    ]);
    const p = h.transport.projectState().annotations.proposals;
    expect(p['cut-rejected']!.status).toBe('rejected');
    expect(p['merge-rejected']!.rejectReason).toBe('wrong');
  });

  it('accepts a move in one click: the fold moves the words and keeps their provenance', async () => {
    const h = make('proposals');
    await settle();
    const before = h.transport.projectState().documents['doc-p']!;
    const sentence = 'The town was built anyway.';
    const runAt = (doc: typeof before, text: string) => {
      const json = JSON.stringify(doc.content);
      void json;
      const node = h.handle.getState().doc;
      let pos = -1;
      node.descendants((n, p) => {
        if (pos < 0 && n.isText && n.text!.includes(text)) pos = p + n.text!.indexOf(text);
      });
      return doc.provenance.find((r) => r.from <= pos && r.to > pos);
    };
    const origin = runAt(before, sentence)!;
    expect(origin.class).toBe('typed');
    expect(h.controller.accept('mv-sentence')).toBe(true);
    expect(ofType(h.drafts, 'ProposalAccepted').map((d) => d.payload)).toEqual([
      { proposalId: 'mv-sentence', documentId: 'doc-p', baseVersion: before.version },
    ]);
    await h.commit();
    await settle(10);
    expect(h.transport.rejected).toEqual([]);
    expect(h.text().split('\n')[0]).toBe(
      'The town was built anyway. The river floods every spring. Nobody here remembers a dry year.',
    );
    const after = h.transport.projectState().documents['doc-p']!;
    expect(after.version).toBeGreaterThan(before.version);
    const moved = runAt(after, sentence)!;
    expect(moved.class).toBe('typed');
    expect(moved.originSeq).toBe(origin.originSeq);
    expect(h.controller.getSnapshot().cards.find((c) => c.id === 'mv-sentence')?.outcome).toBe(
      'Accepted',
    );
  });

  it('discusses a card and shows the answer from the annotation layer', async () => {
    const h = make('discuss');
    await settle();
    const thread = h.controller.discuss('sug-d', 'Why not keep ruined?');
    expect(thread).toBeTruthy();
    const d = ofType(h.drafts, 'DiscussRequested');
    expect(d[0]!.payload).toEqual({
      threadId: thread,
      targetId: 'sug-d',
      message: 'Why not keep ruined?',
    });
    await h.commit();
    // A follow-up reuses the thread.
    h.controller.discuss('sug-d', 'And gone to seed?');
    expect(ofType(h.drafts, 'DiscussRequested')[1]!.payload.threadId).toBe(thread);
    await h.commit();
    const t = h.transport.projectState().annotations.discussions[thread!]!;
    expect(t.messages.map((m) => m.body)).toEqual(['Why not keep ruined?', 'And gone to seed?']);
    expect(t.status).toBe('awaiting-editor');
  });

  it('asks for feedback and retries a failed review', async () => {
    let n = 0;
    const h = make('feedback-session', { prefix: 'all', controller: { newId: () => `id-${++n}` } });
    await settle();
    const id = h.controller.retryReview('req-2');
    expect(id).toBe('id-1');
    const d = ofType(h.drafts, 'FeedbackRequested')[0]!;
    expect(d.payload).toMatchObject({
      requestId: 'id-1',
      lenses: ['word-choice'],
      intensity: 'light',
      ask: null,
    });
    expect((d.payload as { scope: { kind: string } }).scope.kind).toBe('selection');
    h.controller.requestFeedback({
      scope: { kind: 'project' },
      lenses: ['pacing'],
      intensity: 'thorough',
      ask: '  Too slow? ',
    });
    await h.commit();
    expect(h.transport.rejected).toEqual([]);
    const reqs = h.transport.projectState().annotations.feedbackRequests;
    expect(reqs['id-1']!.status).toBe('pending');
    expect(reqs['id-2']).toMatchObject({ ask: 'Too slow?', intensity: 'thorough' });
  });

  it('hands Cite to the host', async () => {
    const cites: unknown[] = [];
    const h = make('research', { controller: { onCite: (r) => cites.push(r) } });
    await settle();
    expect(h.controller.cite('flag-2')).toBe(true);
    expect(cites[0]).toMatchObject({
      cardId: 'flag-2',
      kind: 'citation-flag',
      documentId: 'doc-r',
      sourceId: null,
      claim: 'Some farmers never adapted.',
    });
    h.controller.cite('ss-1');
    expect(cites[1]).toMatchObject({ kind: 'source-suggestion', sourceId: 'src-okafor' });
  });
});

describe('controller: trace-over', () => {
  it('sets the trace hint while the caret is on a suggestion and resolves adopted (retyped)', async () => {
    const h = make('suggestions');
    await settle();
    expect(h.controller.startTrace('sug-adopt')).toBe(true);
    await settle();
    expect(h.controller.getSnapshot().tracingId).toBe('sug-adopt');
    const dom = h.handle.view.dom;
    expect(dom.querySelector('.lh-ghost-alt.lh-ghost-active')?.textContent).toBe('weathered');
    h.typeText('weat');
    expect(typed(dom)).toBe('weat');
    expect(dom.querySelector('.lh-ghost-trace')?.textContent).toBe('hered');
    const progress = traceKey.getState(h.handle.getState());
    expect(progress?.active?.id).toBe('sug-adopt');
    h.typeText('hered');
    expect(dom.querySelector('.lh-ghost-trace')).toBeNull();
    await h.commit();
    await settle(10);
    const runs = ofType(h.drafts, 'TextEdited').flatMap(
      (d) => (d.payload as { runs: Array<{ traceSuggestionId?: string }> }).runs,
    );
    expect(runs.some((r) => r.traceSuggestionId === 'sug-adopt')).toBe(true);
    const s = h.transport.projectState().annotations.suggestions['sug-adopt']!;
    expect(s.status).toBe('adopted');
    expect(h.transport.ofType('SuggestionResolved').map((c) => c.payload)).toContainEqual(
      expect.objectContaining({ targetId: 'sug-adopt', outcome: 'adopted' }),
    );
    const card = h.controller.getSnapshot().marginCards.find((c) => c.id === 'sug-adopt');
    expect(card?.outcome).toBe('Adopted · retyped');
    expect(h.controller.getSnapshot().tracingId).toBeNull();
    // The retyped words are attributed to the suggestion by the fold.
    const doc = h.transport.projectState().documents['doc-s']!;
    expect(
      doc.provenance.some(
        (r) => r.class === 'typed-from-suggestion' && r.suggestionId === 'sug-adopt',
      ),
    ).toBe(true);
  });

  it('resolves divergent typing as adapted', async () => {
    const h = make('suggestions');
    await settle();
    h.controller.startTrace('sug-adapt');
    await settle();
    h.typeText('lingerd');
    const dom = h.handle.view.dom;
    expect(typed(dom)).toBe('linger');
    expect(dom.querySelector('.lh-trace-diverged')?.textContent).toBe('d');
    await h.commit();
    await settle(10);
    expect(h.transport.projectState().annotations.suggestions['sug-adapt']!.status).toBe('adapted');
  });

  it('traces an insertion at its point', async () => {
    const h = make('suggestions');
    await settle();
    h.controller.startTrace('sug-insert');
    await settle();
    expect(h.controller.getSnapshot().tracingId).toBe('sug-insert');
    h.typeText(' Her tea');
    const dom = h.handle.view.dom;
    expect(typed(dom)).toBe('Her tea');
    expect(dom.querySelector('.lh-ghost-trace')?.textContent).toBe(' had gone cold.');
    h.typeText(' had gone cold.');
    await h.commit();
    await settle(10);
    expect(h.transport.projectState().annotations.suggestions['sug-insert']!.status).toBe(
      'adopted',
    );
  });

  it('clears the hint when the caret leaves', async () => {
    const h = make('suggestions');
    await settle();
    h.controller.startTrace('sug-adopt');
    await settle();
    expect(h.controller.getSnapshot().tracingId).toBe('sug-adopt');
    h.select(1);
    await settle();
    expect(h.controller.getSnapshot().tracingId).toBeNull();
    h.typeText('A');
    await h.commit();
    const runs = ofType(h.drafts, 'TextEdited').flatMap(
      (d) => (d.payload as { runs: Array<{ traceSuggestionId?: string }> }).runs,
    );
    expect(runs.every((r) => r.traceSuggestionId === undefined)).toBe(true);
  });
});
