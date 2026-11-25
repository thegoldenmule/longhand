// A one-paragraph project for the live smoke test and the fixture recorder.
// Test-support only; not exported from the package index.
import { GENESIS_PREV_HASH, type ProjectState } from '@longhand/schema';
import type { ChatRequest, FeedbackRequest } from './context';

/** The paragraph under review. */
export const LIVE_PARAGRAPH =
  'The meeting started late because nobody could find the key to the room. When we finally got in, the projector didnt work, and Sam spent twenty minutes on hold with facilities. By the time the slides came up, half the team had already left for lunch. We decided to try again on Thursday.';

/** A light-touch, document-scope request on the paragraph. */
export const LIVE_PARAGRAPH_REQUEST: FeedbackRequest = {
  requestId: 'live-req',
  scope: { kind: 'document', documentId: 'doc1' },
  lenses: ['clarity', 'word-choice', 'grammar-mechanics'],
  intensity: 'light',
  ask: 'Is this paragraph clear and tight?',
  // A named editor: the brief shapes emphasis and tone, never the rules.
  editor: {
    id: 'live-editor',
    name: 'Theo',
    brief:
      'A blunt line editor who hates adverbs. Short, direct notes; no hedging and no praise for its own sake.',
  },
};

/** A project holding only the paragraph. */
export function liveParagraphState(): ProjectState {
  return {
    projectId: 'live-proj',
    accountId: 'acct',
    headSeq: 5,
    headHash: GENESIS_PREV_HASH,
    settings: {
      title: 'Team notes',
      genre: 'workplace memo',
      audience: 'colleagues',
      goals: 'A short, plain account of what happened.',
      styleNotes: '',
      dailyWordGoal: null,
      citationStyle: 'apa',
    },
    createdSeq: 1,
    binder: { manuscript: [{ kind: 'document', id: 'doc1' }], notes: [] },
    folders: {},
    documents: {
      doc1: {
        id: 'doc1',
        kind: 'manuscript',
        area: 'manuscript',
        title: 'Monday',
        parentId: null,
        synopsis: '',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: LIVE_PARAGRAPH }] }],
        },
        version: 3,
        provenance: [],
        archived: false,
        imported: null,
        createdSeq: 2,
        contentSeq: 5,
        updatedSeq: 5,
      },
    },
    annotations: {
      feedbackRequests: {},
      agentSessions: {},
      comments: {},
      questions: {},
      suggestions: {},
      proposals: {},
      citationFlags: {},
      surfacedSources: {},
      sourceSuggestions: {},
      discussions: {},
      chats: {},
    },
    sources: {},
    clippings: {},
    pastes: {},
    writingSessions: [],
  };
}

/** A chat message about the paragraph, by the line editor in {@link LIVE_PARAGRAPH_REQUEST}. */
export function liveChatRequest(messageId: string, text: string): ChatRequest {
  return {
    chatId: 'live-chat',
    messageId,
    text,
    editor: { ...LIVE_PARAGRAPH_REQUEST.editor!, role: 'Line editor' },
    lenses: ['clarity', 'word-choice', 'grammar-mechanics'],
    intensity: 'light',
    context: { scope: { kind: 'document', documentId: 'doc1' }, aboutId: null },
  };
}

/** The paragraph's project with the chat message pending, as the fold has it. */
export function liveChatState(request: ChatRequest): ProjectState {
  const state = liveParagraphState();
  state.annotations.chats[request.chatId] = {
    id: request.chatId,
    createdSeq: 6,
    createdAt: '2026-11-25T10:00:00.000Z',
    updatedSeq: 6,
    messages: [
      {
        role: 'writer',
        id: request.messageId,
        seq: 6,
        createdAt: '2026-11-25T10:00:00.000Z',
        text: request.text,
        editor: request.editor,
        lenses: request.lenses,
        intensity: request.intensity,
        scope: request.context.scope,
        aboutId: null,
        status: 'pending',
        feedbackSessionId: null,
      },
    ],
  };
  return state;
}
