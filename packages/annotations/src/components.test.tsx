import { foldCommits, projectState } from '@longhand/ledger';
import { STARTER_EDITORS, type EditorProfile, type ProjectState } from '@longhand/schema';
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
import { AnnotationMargin } from './react/margin';
import { FeedbackChat } from './react/chat';

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
    const snap = h.controller.getSnapshot();
    const { container: panel } = render(
      <div>
        {snap.cards.map((c) => (
          <AnnotationCard
            key={c.id}
            controller={h.controller}
            card={c}
            snapshot={snap}
            variant="list"
          />
        ))}
      </div>,
    );
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
    const snap = h.controller.getSnapshot();
    const sug = snap.cards.find((c) => c.id === 'sug-d')!;
    const { container } = render(
      <AnnotationCard controller={h.controller} card={sug} snapshot={snap} variant="list" />,
    );
    const card = container.querySelector('[data-card-id="sug-d"]') as HTMLElement;
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

describe('<FeedbackChat>', () => {
  const THEO = EDITORS[1]!;

  function chatHarness(fixture: Parameters<typeof harness>[0] = 'chat', extra = {}) {
    const onOpenChat = vi.fn();
    const onCancelSession = vi.fn();
    const h = harness(fixture, {
      prefix: 'all',
      controller: { onOpenChat, onCancelSession, newId: idGen(), ...extra },
    });
    harnesses.push(h);
    return { h, onOpenChat, onCancelSession };
  }

  function idGen() {
    let n = 0;
    return () => `new-${++n}`;
  }

  const chatDrafts = (h: Harness) =>
    h.drafts
      .filter((d) => d.type === 'ChatMessageSent')
      .map((d) => d.payload as AnnotationEventOf<'ChatMessageSent'>['payload']);

  it('shows the latest chat: writer and editor turns, who replied, paragraphs and note chips', async () => {
    const { h } = chatHarness();
    await settle();
    render(<FeedbackChat controller={h.controller} editors={EDITORS} documentTitle="Chapter 1" />);
    // chat-2 (the newest) failed before starting; history holds chat-1.
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const history = screen.getByRole('navigation', { name: 'Chat history' });
    expect(
      within(history)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      expect.stringContaining('Anything else?'),
      expect.stringContaining('Is the title working?'),
    ]);
    fireEvent.click(within(history).getByRole('button', { name: /Is the title working/ }));
    const msgs = screen.getAllByTestId('chat-message');
    expect(msgs.map((m) => m.dataset.role)).toEqual([
      'writer',
      'editor',
      'writer',
      'editor',
      'writer',
    ]);
    expect(msgs[1]!.textContent).toContain('Theo');
    expect(msgs[1]!.querySelectorAll('.lh-chat-body p')).toHaveLength(2);
    expect(msgs[3]!.textContent).toContain('Margaret');
    // The selection the writer attached, mapped to the current text.
    expect(msgs[2]!.textContent).toContain('“The rain fell sideways');
    // The review's notes: chips that focus their cards.
    const notes = within(msgs[3]!).getByTestId('chat-reply-notes');
    const chips = within(notes).getAllByRole('button');
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[0]!);
    expect(h.controller.getSnapshot().activeId).toBe('cmt-c');
    // A question about a note that failed: inline, with Retry.
    expect(msgs[4]!.dataset.status).toBe('failed');
    expect(msgs[4]!.textContent).toContain('About: Comment');
    expect(msgs[4]!.textContent).toContain('Margaret couldn’t reply (model unavailable)');
    fireEvent.click(within(msgs[4]!).getByRole('button', { name: 'Retry' }));
    expect(chatDrafts(h)[0]).toMatchObject({
      chatId: 'chat-1',
      text: 'Why does the door matter?',
      editor: { id: 'ed-margaret', name: 'Margaret' },
      lenses: ['structure', 'word-choice'],
      intensity: 'light',
      context: { aboutId: 'cmt-c' },
    });
  });

  it('sends with Enter (Shift+Enter is a newline) to the chosen editor, in a new chat', async () => {
    const { h } = chatHarness();
    await settle();
    render(<FeedbackChat controller={h.controller} editors={EDITORS} documentTitle="Chapter 1" />);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    // An empty chat offers the editor's questions; tapping one fills the composer.
    fireEvent.change(screen.getByRole('combobox', { name: 'Editor' }), {
      target: { value: THEO.id },
    });
    const starters = screen.getByTestId('chat-starters');
    fireEvent.click(within(starters).getByRole('button', { name: THEO.questions[0]! }));
    const box = screen.getByRole('textbox', { name: 'Message Theo' }) as HTMLTextAreaElement;
    expect(box.value).toBe(THEO.questions[0]);
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(chatDrafts(h)).toHaveLength(0);
    fireEvent.keyDown(box, { key: 'Enter' });
    const sent = chatDrafts(h)[0]!;
    expect(sent).toMatchObject({
      chatId: 'new-1',
      messageId: 'new-2',
      text: THEO.questions[0],
      editor: { id: THEO.id, name: 'Theo', role: THEO.role },
      lenses: THEO.lenses,
      intensity: THEO.intensity,
      context: { scope: { kind: 'document', documentId: h.documentId }, aboutId: null },
    });
    // It shows at once, then the editor is reading; Stop is offered.
    expect(screen.getAllByTestId('chat-message').at(-1)!.dataset.status).toBe('sending');
    expect(screen.getByTestId('chat-working').textContent).toContain('Theo');
    expect(box.value).toBe('');
  });

  it('attaches the selection as a removable quote, or the whole project', async () => {
    const { h } = chatHarness('suggestions');
    await settle();
    render(<FeedbackChat controller={h.controller} editors={EDITORS} documentTitle="Chapter 1" />);
    act(() => h.select(1, 12));
    await settle();
    const chip = screen.getByTestId('chat-attach-selection');
    expect(chip.textContent).toContain('“');
    const box = screen.getByRole('textbox', { name: /Message/ });
    fireEvent.change(box, { target: { value: 'Is this clear?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(chatDrafts(h)[0]!.context.scope).toMatchObject({
      kind: 'selection',
      documentId: h.documentId,
      from: 1,
      to: 12,
    });
    // After sending, the selection chip clears.
    expect(screen.queryByTestId('chat-attach-selection')).toBeNull();
  });

  it('Whole project switches the scope', async () => {
    const { h } = chatHarness('suggestions');
    await settle();
    render(<FeedbackChat controller={h.controller} editors={EDITORS} documentTitle="Chapter 1" />);
    const toggle = screen.getByRole('button', { name: 'Whole project' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByRole('textbox', { name: /Message/ }), {
      target: { value: 'How does it hang together?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(chatDrafts(h)[0]!.context.scope).toEqual({ kind: 'project' });
  });

  it('Discuss on a card opens the chat with the note attached; no thread on the card', async () => {
    const { h, onOpenChat } = chatHarness('suggestions');
    await settle();
    render(
      <>
        <AnnotationMargin controller={h.controller} />
        <FeedbackChat controller={h.controller} editors={EDITORS} documentTitle="Chapter 1" />
      </>,
    );
    const card = document.querySelector('.lh-margin [data-card-id]') as HTMLElement;
    const id = card.dataset.cardId!;
    fireEvent.click(within(card).getByRole('button', { name: 'Discuss' }));
    expect(onOpenChat).toHaveBeenCalled();
    expect(card.querySelector('.lh-thread')).toBeNull();
    expect(screen.getByTestId('chat-attach-note').textContent).toContain('About:');
    fireEvent.change(screen.getByRole('textbox', { name: /Message/ }), {
      target: { value: 'Why this one?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(chatDrafts(h)[0]!.context.aboutId).toBe(id);
    expect(h.drafts.some((d) => d.type === 'DiscussRequested')).toBe(false);
  });

  it('shows live progress for a running reply, and Stop cancels its session', async () => {
    const { h, onCancelSession } = chatHarness();
    await settle();
    render(<FeedbackChat controller={h.controller} editors={EDITORS} documentTitle="Chapter 1" />);
    // Fold a new message and the start of its session.
    const s0 = h.transport.projectState();
    const draft = {
      commitId: 'c-x',
      projectId: s0.projectId,
      clientTime: '2026-11-25T10:00:00.000Z',
      actor: { kind: 'human' as const, id: 'writer-1' },
      deviceId: 'd',
      sessionId: 'e',
      type: 'ChatMessageSent' as const,
      schemaVersion: 1 as const,
      payload: {
        chatId: 'chat-2',
        messageId: 'm-9',
        text: 'Review this.',
        editor: { id: THEO.id, name: 'Theo', brief: '' },
        lenses: ['clarity' as const],
        intensity: 'light' as const,
        context: { scope: { kind: 'project' as const }, aboutId: null },
      },
    };
    act(() => {
      h.transport.append(draft);
      h.transport.append({
        ...draft,
        commitId: 'c-y',
        actor: { kind: 'agent', id: 'sonnet' },
        sessionId: 'fs-live',
        deviceId: 'server',
        type: 'FeedbackSessionStarted',
        payload: {
          feedbackSessionId: 'fs-live',
          trigger: { kind: 'chat', chatId: 'chat-2', messageId: 'm-9' },
          model: 'sonnet',
        },
      } as never);
    });
    await settle();
    act(() => {
      h.controller.pushProgress({ kind: 'started', feedbackSessionId: 'fs-live', model: 'sonnet' });
      h.controller.pushProgress({
        kind: 'annotation',
        seq: 99,
        draft: {
          type: 'CommentAdded',
          sessionId: 'fs-live',
          payload: {
            commentId: 'c1',
            feedbackSessionId: 'fs-live',
            target: { kind: 'anchor', anchor: { quote: 'sideways' } },
          },
        },
      });
    });
    const working = screen.getByTestId('chat-working');
    expect(working.textContent).toContain('Theo');
    expect(working.textContent).toContain('Left a note on “sideways”');
    fireEvent.click(screen.getByTestId('chat-stop'));
    expect(onCancelSession).toHaveBeenCalledWith('fs-live');
  });

  it('keeps older reviews readable in history', async () => {
    const { h } = chatHarness('feedback-session');
    await settle();
    render(<FeedbackChat controller={h.controller} editors={EDITORS} documentTitle="Chapter 1" />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const history = screen.getByRole('navigation', { name: 'Chat history' });
    const reviews = within(history).getAllByRole('button', { name: /^Review/ });
    expect(reviews.length).toBe(2);
    fireEvent.click(reviews[reviews.length - 1]!);
    const review = screen.getByTestId('chat-legacy-review');
    expect(review.textContent).toContain('A quiet, confident opening.');
    expect(screen.queryByTestId('chat-composer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(screen.getByTestId('chat-composer')).toBeTruthy();
  });

  it('waits for editors, and points to setting one up when there are none', () => {
    const controller = new AnnotationsController({ documentId: 'd', state: null });
    const { rerender } = render(
      <FeedbackChat controller={controller} editors={null} documentTitle={null} />,
    );
    expect(screen.getByRole('status').textContent).toContain('Loading editors');
    rerender(
      <FeedbackChat
        controller={controller}
        editors={[]}
        documentTitle={null}
        manageEditorsHref="/editors"
      />,
    );
    expect(screen.getByRole('link', { name: 'Set one up' }).getAttribute('href')).toBe('/editors');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
