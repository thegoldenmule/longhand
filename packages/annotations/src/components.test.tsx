import { foldCommits, projectState } from '@longhand/ledger';
import {
  FeedbackRequestedSchema,
  STARTER_EDITORS,
  TEXT_LIMITS,
  type EditorProfile,
  type ProjectState,
} from '@longhand/schema';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOTATION_FIXTURES,
  fixtureCommits,
  fixtureState,
  harness,
  settle,
  type Harness,
} from '../test-support/fixtures';
import { untilFirstReview } from '../test-support/foldingTransport';
import { AnnotationsController } from './controller';
import type { AnnotationEventOf } from './drafts';
import { cardsFromState } from './model';
import { AnnotationCard } from './react/cards';
import { FeedbackRequestForm, composeAsk } from './react/form';
import { AnnotationMargin } from './react/margin';
import { FeedbackPanel } from './react/panel';

const harnesses: Harness[] = [];
afterEach(() => {
  cleanup();
  for (const h of harnesses.splice(0)) h.destroy();
  document.body.innerHTML = '';
});

function prefixState(name: Parameters<typeof fixtureCommits>[0]): ProjectState {
  return projectState(foldCommits(untilFirstReview(fixtureCommits(name))));
}

const EDITORS: EditorProfile[] = STARTER_EDITORS.map((e, i) => ({ ...e, id: `ed-${i + 1}` }));
const [MARGARET, THEO] = EDITORS as [EditorProfile, EditorProfile];

describe('<FeedbackRequestForm>', () => {
  it('asks the chosen editor: its lenses, intensity and a record of it, plus scope and ask', () => {
    const onRequest = vi.fn<(e: AnnotationEventOf<'FeedbackRequested'>) => void>();
    render(
      <FeedbackRequestForm
        documentId="doc-1"
        documentTitle="Chapter 1"
        editors={EDITORS}
        onRequest={onRequest}
        newId={() => 'req-x'}
      />,
    );
    const form = screen.getByTestId('feedback-form');
    // A short list of editors, one line each (name and role, never the brief), with no lens
    // or intensity pickers.
    expect(within(form).getAllByRole('radio', { name: /./ }).length).toBeGreaterThan(0);
    expect(form.querySelectorAll('.lh-editor-option')).toHaveLength(EDITORS.length);
    expect(within(form).queryByText('Light touch')).toBeNull();
    expect(within(form).queryByText('Word choice')).toBeNull();
    const theo = form.querySelector('[data-editor-id="ed-2"]')!;
    expect(theo.querySelector('.lh-editor-role')?.textContent).toBe('Line editor');
    expect(theo.textContent).toBe('TheoLine editor');
    // Selection is unavailable without a selection; the document is the default.
    expect((within(form).getByLabelText('Selection') as HTMLInputElement).disabled).toBe(true);
    expect(within(form).getByRole('button', { name: 'Ask Margaret' })).toBeTruthy();
    fireEvent.click(within(form).getByRole('radio', { name: /^Theo/ }));
    fireEvent.click(within(form).getByRole('button', { name: THEO.questions[1]! }));
    fireEvent.change(within(form).getByRole('textbox'), {
      target: { value: '  Especially the dialogue. ' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Ask Theo' }));
    expect(onRequest).toHaveBeenCalledTimes(1);
    const event = onRequest.mock.calls[0]![0];
    expect(event.type).toBe('FeedbackRequested');
    expect(event.payload).toEqual({
      requestId: 'req-x',
      scope: { kind: 'document', documentId: 'doc-1' },
      lenses: ['clarity', 'word-choice', 'tone-voice'],
      intensity: 'standard',
      ask: `${THEO.questions[1]}\nEspecially the dialogue.`,
      editor: { id: 'ed-2', name: 'Theo', role: 'Line editor', brief: THEO.brief },
    });
    expect(FeedbackRequestedSchema.safeParse(event.payload).success).toBe(true);
  });

  it('defaults to the selection, then the document; project on request; one canned question', () => {
    const onRequest = vi.fn<(e: AnnotationEventOf<'FeedbackRequested'>) => void>();
    const { rerender } = render(
      <FeedbackRequestForm
        documentId="doc-1"
        selection={{ documentId: 'doc-1', from: 3, to: 20, version: 42 }}
        editors={EDITORS}
        onRequest={onRequest}
        newId={() => 'r1'}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask Margaret' }));
    expect(onRequest.mock.calls[0]![0].payload).toMatchObject({
      scope: { kind: 'selection', documentId: 'doc-1', from: 3, to: 20, version: 42 },
      lenses: MARGARET.lenses,
      intensity: 'light',
      ask: null,
      editor: { id: 'ed-1', name: 'Margaret' },
    });
    rerender(
      <FeedbackRequestForm
        documentId="doc-1"
        editors={EDITORS}
        defaultEditorId="ed-3"
        onRequest={onRequest}
        newId={() => 'r2'}
      />,
    );
    fireEvent.click(screen.getByLabelText('Whole project'));
    const [q1, q2] = EDITORS[2]!.questions as [string, string];
    // Tapping a second question replaces the first; tapping it again clears it.
    fireEvent.click(screen.getByRole('button', { name: q1 }));
    fireEvent.click(screen.getByRole('button', { name: q2 }));
    expect(screen.getByRole('button', { name: q1 }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: q2 }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Ask Ruth' }));
    expect(onRequest.mock.calls[1]![0].payload).toMatchObject({
      scope: { kind: 'project' },
      intensity: 'thorough',
      ask: q2,
      editor: { id: 'ed-3', name: 'Ruth' },
    });
  });

  it('waits for editors, and points to setting one up when there are none', () => {
    const onRequest = vi.fn();
    const { rerender } = render(
      <FeedbackRequestForm documentId="d" editors={null} onRequest={onRequest} />,
    );
    expect(screen.getByRole('status').textContent).toContain('Loading your editors');
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <FeedbackRequestForm
        documentId="d"
        editors={[]}
        manageEditorsHref="/editors"
        onRequest={onRequest}
      />,
    );
    expect(screen.getByRole('link', { name: 'Set one up' }).getAttribute('href')).toBe('/editors');
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <FeedbackRequestForm
        documentId="d"
        editors={EDITORS}
        manageEditorsHref="/editors"
        onRequest={onRequest}
      />,
    );
    expect(screen.getByRole('link', { name: 'Manage editors' }).getAttribute('href')).toBe(
      '/editors',
    );
  });

  it('keeps the ask within the limit', () => {
    expect(composeAsk(null, '  ')).toBe('');
    expect(composeAsk(' Too slow? ', '')).toBe('Too slow?');
    expect(composeAsk('Too slow?', ' And long? ')).toBe('Too slow?\nAnd long?');
    const onRequest = vi.fn<(e: AnnotationEventOf<'FeedbackRequested'>) => void>();
    render(<FeedbackRequestForm documentId="d" editors={EDITORS} onRequest={onRequest} />);
    const q = MARGARET.questions[0]!;
    fireEvent.click(screen.getByRole('button', { name: q }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'x'.repeat(TEXT_LIMITS.feedbackAskMaxChars) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask Margaret' }));
    expect(onRequest.mock.calls[0]![0].payload.ask!.length).toBe(TEXT_LIMITS.feedbackAskMaxChars);
  });
});

describe('cards for every annotation kind', () => {
  it.each(ANNOTATION_FIXTURES)('renders a card for each annotation in %s', (name) => {
    for (const state of [fixtureState(name), prefixState(name)]) {
      const controller = new AnnotationsController({ documentId: '', state });
      const cards = cardsFromState(state);
      const { container, unmount } = render(
        <div>
          {cards.map((c) => (
            <AnnotationCard key={c.id} controller={controller} card={c} variant="list" />
          ))}
        </div>,
      );
      for (const c of cards) {
        const el = container.querySelector(`[data-card-id="${c.id}"]`) as HTMLElement;
        expect(el, c.id).not.toBeNull();
        expect(el.dataset.kind).toBe(c.kind);
        expect(el.dataset.phase).toBe(c.phase);
        if (c.aiSurfaced) expect(el.textContent).toContain('AI-surfaced — unverified');
        if (c.outcome) expect(el.textContent).toContain(c.outcome);
      }
      unmount();
    }
  });

  it('shows ghost alternatives on cards as unselectable, aria-hidden decoration', () => {
    const state = prefixState('suggestions');
    const controller = new AnnotationsController({ documentId: 'doc-s', state });
    const card = cardsFromState(state).find((c) => c.id === 'sug-adopt')!;
    const { container } = render(<AnnotationCard controller={controller} card={card} />);
    const ghosts = [...container.querySelectorAll('[data-lh-ghost]')];
    expect(ghosts.map((g) => g.textContent)).toEqual(['weathered', 'sagging']);
    for (const g of ghosts) expect(g.getAttribute('aria-hidden')).toBe('true');
    const article = container.querySelector('article')!;
    expect(article.getAttribute('aria-describedby')).toBe('lh-ann-desc-sug-adopt');
    // Rephrase hints carry guidance and no ghost text.
    const hint = cardsFromState(state).find((c) => c.id === 'sug-rephrase')!;
    const r = render(<AnnotationCard controller={controller} card={hint} />);
    expect(r.container.querySelector('[data-lh-ghost]')).toBeNull();
    expect(r.container.textContent).toContain('Name what makes the hedges black');
  });

  it('labels research cards and calls the citation picker', async () => {
    const onCite = vi.fn();
    const h = harness('research', { controller: { onCite } });
    harnesses.push(h);
    await settle();
    render(<FeedbackPanel controller={h.controller} editors={EDITORS} />);
    const panel = screen.getByTestId('panel-cards');
    const flag = panel.querySelector('[data-card-id="flag-1"]') as HTMLElement;
    expect(flag.textContent).toContain('AI-surfaced — unverified');
    fireEvent.click(within(flag).getByRole('button', { name: 'Cite' }));
    expect(onCite).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: 'flag-1', kind: 'citation-flag' }),
    );
    const surf = panel.querySelector('[data-card-id="surf-1"]') as HTMLElement;
    expect(surf.textContent).toContain('AI-surfaced — unverified');
    expect(surf.textContent).toContain('Flood farming forum thread');
  });
});

describe('card actions emit events', () => {
  it('dismiss with a reason', async () => {
    const h = harness('suggestions');
    harnesses.push(h);
    await settle();
    render(<AnnotationMargin controller={h.controller} />);
    const card = screen
      .getByTestId('annotation-margin')
      .querySelector('[data-card-id="sug-dismiss"]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Not my voice' }));
    expect(h.drafts.filter((d) => d.type === 'SuggestionDismissed').map((d) => d.payload)).toEqual([
      { targetId: 'sug-dismiss', reason: 'not-my-voice', note: null },
    ]);
    await act(async () => {
      await h.commit();
    });
    expect(h.transport.projectState().annotations.suggestions['sug-dismiss']!.status).toBe(
      'dismissed',
    );
  });

  it('discuss shows the thread with the editor’s reply', async () => {
    const h = harness('discuss');
    harnesses.push(h);
    await settle();
    render(<AnnotationMargin controller={h.controller} />);
    const margin = screen.getByTestId('annotation-margin');
    const card = margin.querySelector('[data-card-id="sug-d"]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Discuss' }));
    fireEvent.change(within(card).getByLabelText('Ask the editor about this'), {
      target: { value: 'Why not keep ruined?' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Ask' }));
    const d = h.drafts.find((x) => x.type === 'DiscussRequested')!;
    expect(d.payload).toMatchObject({ targetId: 'sug-d', message: 'Why not keep ruined?' });
    await act(async () => {
      await h.commit();
    });
    expect(within(card).getByRole('status').textContent).toContain('The editor is replying');
    // The agent answers in the annotation layer.
    const threadId = (d.payload as { threadId: string }).threadId;
    await act(async () => {
      h.transport.append({
        commitId: 'c-start',
        projectId: 'proj-1',
        clientTime: new Date().toISOString(),
        actor: { kind: 'agent', id: 'sonnet' },
        deviceId: 'server',
        sessionId: 'fs-x',
        type: 'FeedbackSessionStarted',
        schemaVersion: 1,
        payload: {
          feedbackSessionId: 'fs-x',
          trigger: { kind: 'discuss', threadId },
          model: 'sonnet',
        },
      });
      h.transport.append({
        commitId: 'c-answer',
        projectId: 'proj-1',
        clientTime: new Date().toISOString(),
        actor: { kind: 'agent', id: 'sonnet' },
        deviceId: 'server',
        sessionId: 'fs-x',
        type: 'DiscussAnswered',
        schemaVersion: 1,
        payload: {
          feedbackSessionId: 'fs-x',
          threadId,
          targetId: 'sug-d',
          body: 'Keep it if it is true.',
        },
      });
      await settle();
    });
    expect(h.transport.rejected).toEqual([]);
    const messages = within(card).getByRole('list', { name: 'Discussion' });
    expect(messages.textContent).toContain('Why not keep ruined?');
    expect(messages.textContent).toContain('Keep it if it is true.');
    expect(messages.querySelector('[data-role="editor"]')).not.toBeNull();
  });

  it('a failed discuss offers a retry of the same message', async () => {
    const h = harness('discuss', { prefix: 'all' });
    harnesses.push(h);
    await settle();
    render(<FeedbackPanel controller={h.controller} editors={EDITORS} />);
    // sug-d was dismissed in the full fixture: show resolved cards.
    fireEvent.click(screen.getByRole('button', { name: 'Everything' }));
    const card = screen
      .getByTestId('panel-cards')
      .querySelector('[data-card-id="sug-d"]') as HTMLElement;
    expect(card.textContent).toContain('couldn’t reply this time (model unavailable)');
    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(h.drafts.find((x) => x.type === 'DiscussRequested')!.payload).toEqual({
      threadId: 'thr-1',
      targetId: 'sug-d',
      message: 'And gone to seed?',
    });
  });

  it('accept and reject proposals', async () => {
    const h = harness('proposals');
    harnesses.push(h);
    await settle();
    render(<AnnotationMargin controller={h.controller} />);
    const margin = screen.getByTestId('annotation-margin');
    const reject = margin.querySelector('[data-card-id="cut-rejected"]') as HTMLElement;
    fireEvent.click(within(reject).getByRole('button', { name: 'Reject' }));
    fireEvent.click(within(reject).getByRole('button', { name: 'Wrong' }));
    const accept = margin.querySelector('[data-card-id="split-1"]') as HTMLElement;
    fireEvent.click(within(accept).getByRole('button', { name: 'Accept' }));
    expect(h.drafts.filter((d) => d.type !== 'TextEdited').map((d) => [d.type, d.payload])).toEqual(
      [
        ['ProposalRejected', { proposalId: 'cut-rejected', reason: 'wrong' }],
        [
          'ProposalAccepted',
          expect.objectContaining({ proposalId: 'split-1', documentId: 'doc-p' }),
        ],
      ],
    );
    await act(async () => {
      await h.commit();
      await settle(10);
    });
    expect(h.transport.rejected).toEqual([]);
    expect(h.text().split('\n').slice(0, 3)).toEqual([
      'The river floods every spring. Nobody here remembers a dry year. The town was built anyway.',
      'Farmers moved uphill after 1952.',
      'Their old fields became marsh.',
    ]);
  });
});

describe('<FeedbackPanel>', () => {
  it('offers only the request form until a review is requested', () => {
    const commits = fixtureCommits('feedback-session');
    const before = projectState(
      foldCommits(
        commits.slice(
          0,
          commits.findIndex((c) => c.type === 'FeedbackRequested'),
        ),
      ),
    );
    const controller = new AnnotationsController({ documentId: 'doc-ch1', state: before });
    render(<FeedbackPanel controller={controller} editors={EDITORS} />);
    expect(screen.getByTestId('feedback-form')).toBeTruthy();
    expect(screen.queryByTestId('review-session')).toBeNull();
    const margin = render(<AnnotationMargin controller={controller} />);
    expect(margin.container.querySelector('[data-card-id]')).toBeNull();
  });

  it('shows the summary, a calm failure with retry, and questions for the writer', async () => {
    const h = harness('feedback-session', { prefix: 'all' });
    harnesses.push(h);
    await settle();
    render(<FeedbackPanel controller={h.controller} editors={EDITORS} />);
    const sessions = screen.getAllByTestId('review-session');
    expect(sessions.map((s) => s.dataset.phase)).toEqual(['failed', 'finished']);
    expect(sessions[0]!.textContent).toContain('This review didn’t finish (model timeout)');
    const summary = within(sessions[1]!).getByTestId('review-summary');
    expect(summary.textContent).toContain('A quiet, confident opening.');
    expect(summary.textContent).toContain('Restraint');
    expect(summary.textContent).toContain('Plant the reason the light failed');
    const questions = screen.getByTestId('panel-questions');
    expect(questions.querySelectorAll('[data-kind="question"]')).toHaveLength(2);
    fireEvent.click(within(sessions[0]!).getByRole('button', { name: 'Try again' }));
    expect(h.drafts.find((d) => d.type === 'FeedbackRequested')!.payload).toMatchObject({
      lenses: ['word-choice'],
      intensity: 'light',
    });
  });

  it('groups open cards by kind with filters', async () => {
    const h = harness('suggestions');
    harnesses.push(h);
    await settle();
    render(<FeedbackPanel controller={h.controller} editors={EDITORS} />);
    const panel = screen.getByTestId('panel-cards');
    const groups = () =>
      [...panel.querySelectorAll('[data-group]')].map((g) => (g as HTMLElement).dataset.group);
    expect(groups()).toEqual(['suggestions', 'comments']);
    fireEvent.click(within(panel).getByRole('button', { name: /^Comments/ }));
    expect(groups()).toEqual(['comments']);
    fireEvent.click(within(panel).getByRole('button', { name: 'All' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Resolved' }));
    expect(panel.querySelectorAll('[data-card-id]')).toHaveLength(0);
  });

  it('streams a live review from progress events and new annotations', async () => {
    const commits = fixtureCommits('feedback-session');
    const started = commits.findIndex((c) => c.type === 'FeedbackSessionStarted');
    const controller = new AnnotationsController({
      documentId: 'doc-ch1',
      state: projectState(foldCommits(commits.slice(0, started + 1))),
    });
    render(<FeedbackPanel controller={controller} editors={EDITORS} />);
    const session = screen.getByTestId('review-session');
    expect(session.dataset.phase).toBe('reviewing');
    expect(session.textContent).toContain('Reviewing');
    act(() => {
      controller.pushProgress({ kind: 'started', feedbackSessionId: 'fs-1', model: 'opus' });
      controller.pushProgress({
        kind: 'model',
        feedbackSessionId: 'fs-1',
        event: { type: 'tool-call', id: 't1', name: 'mcp__longhand__comment', input: {} },
      });
    });
    expect(session.textContent).toContain('Writing a margin note');
    act(() => {
      controller.pushProgress({
        kind: 'annotation',
        seq: 10,
        draft: {
          type: 'CommentAdded',
          sessionId: 'fs-1',
          payload: { commentId: 'com-1', feedbackSessionId: 'fs-1' },
        },
      });
    });
    expect(session.textContent).toContain('1 note so far');
    act(() => controller.setState(projectState(foldCommits(commits.slice(0, started + 3)))));
    expect(session.textContent).toContain('2 notes so far');
    act(() => controller.setState(fixtureState('feedback-session')));
    const done = screen
      .getAllByTestId('review-session')
      .find((s) => s.dataset.requestId === 'req-1')!;
    expect(done.dataset.phase).toBe('finished');
    expect(done.textContent).toContain('4 notes');
  });
});
