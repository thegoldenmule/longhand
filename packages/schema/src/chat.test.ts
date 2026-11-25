import { describe, expect, it } from 'vitest';
import { TEXT_LIMITS } from './domain';
import {
  ACTOR_PERMISSIONS,
  ChatMessageSentSchema,
  ChatRepliedSchema,
  FeedbackSessionFailedSchema,
  FeedbackSessionStartedSchema,
  isManuscriptEventType,
} from './events';
import { BOUNDS } from './bounds';
import { MatchedKindSchema } from './provenance';

const message = {
  chatId: 'chat1',
  messageId: 'm1',
  text: 'Where does it drag?',
  editor: { id: 'ed1', name: 'Margaret', role: 'Developmental editor', brief: 'Big picture.' },
  lenses: ['structure', 'pacing'],
  intensity: 'light',
  context: { scope: { kind: 'document', documentId: 'doc1' }, aboutId: null },
} as const;

describe('chat events', () => {
  it('ChatMessageSent is a human, non-manuscript event; ChatReplied is agent-only', () => {
    expect(ACTOR_PERMISSIONS.ChatMessageSent).toEqual(['human']);
    expect(ACTOR_PERMISSIONS.ChatReplied).toEqual(['agent']);
    expect(isManuscriptEventType('ChatMessageSent')).toBe(false);
    expect(isManuscriptEventType('ChatReplied')).toBe(false);
  });

  it('validates a message: text, editor, lenses, intensity and context', () => {
    expect(ChatMessageSentSchema.parse(message)).toEqual(message);
    const bad = [
      { text: '' },
      { text: '   ' },
      { text: 'x'.repeat(TEXT_LIMITS.chatMessageMaxChars + 1) },
      { lenses: [] },
      { lenses: ['pacing', 'pacing'] },
      { intensity: 'heavy' },
      { editor: { id: 'ed1', name: '', brief: '' } },
      { context: { scope: { kind: 'document' }, aboutId: null } },
      { context: { scope: { kind: 'project' } } },
    ];
    for (const b of bad)
      expect(ChatMessageSentSchema.safeParse({ ...message, ...b }).success, JSON.stringify(b)).toBe(
        false,
      );
    expect(
      ChatMessageSentSchema.safeParse({
        ...message,
        context: {
          scope: { kind: 'selection', documentId: 'doc1', from: 1, to: 9, version: 3 },
          aboutId: 'cmt1',
        },
      }).success,
    ).toBe(true);
  });

  it('validates a reply, a chat trigger and a chat failure', () => {
    const reply = { feedbackSessionId: 'fs1', chatId: 'chat1', replyTo: 'm1', body: 'It drags.' };
    expect(ChatRepliedSchema.parse(reply)).toEqual(reply);
    expect(ChatRepliedSchema.safeParse({ ...reply, body: '' }).success).toBe(false);
    expect(
      ChatRepliedSchema.safeParse({ ...reply, body: 'x'.repeat(BOUNDS.chatReplyMaxChars + 1) })
        .success,
    ).toBe(false);
    expect(
      FeedbackSessionStartedSchema.safeParse({
        feedbackSessionId: 'fs1',
        trigger: { kind: 'chat', chatId: 'chat1', messageId: 'm1' },
        model: 'sonnet',
      }).success,
    ).toBe(true);
    const failed = {
      feedbackSessionId: null,
      requestId: null,
      threadId: null,
      reason: 'model unavailable',
    };
    // `chat` is optional, so older failures parse unchanged.
    expect(FeedbackSessionFailedSchema.parse(failed)).toEqual(failed);
    expect(
      FeedbackSessionFailedSchema.parse({ ...failed, chat: { chatId: 'chat1', messageId: 'm1' } })
        .chat,
    ).toEqual({ chatId: 'chat1', messageId: 'm1' });
  });

  it('chat replies are a matched kind for the four-word rule', () => {
    expect(MatchedKindSchema.options).toContain('chat');
  });
});
