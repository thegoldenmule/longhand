// A one-paragraph project for the live smoke test and the fixture recorder.
// Test-support only; not exported from the package index.
import { GENESIS_PREV_HASH, type ProjectState } from '@longhand/schema';
import type { FeedbackRequest } from './context';

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
    },
    sources: {},
    clippings: {},
    pastes: {},
    writingSessions: [],
  };
}
