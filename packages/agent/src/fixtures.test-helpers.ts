// Test-only helpers: hand-built ProjectStates. Not exported from the package.
import {
  GENESIS_PREV_HASH,
  docFromJSON,
  type DocumentState,
  type PMNodeJSON,
  type ProjectState,
} from '@longhand/schema';
import type { FeedbackRequest } from './context';

type BlockSpec =
  | string
  | { h: string; level?: 1 | 2 | 3 }
  | { quote: string[] }
  | { list: string[] }
  | { sceneBreak: true }
  | { p: string; footnote: string };

const text = (t: string): PMNodeJSON[] => (t ? [{ type: 'text', text: t }] : []);

/** Builds document JSON from simple block specs. */
export function docJSON(blocks: BlockSpec[]): PMNodeJSON {
  const content = blocks.map((b): PMNodeJSON => {
    if (typeof b === 'string') return { type: 'paragraph', content: text(b) };
    if ('h' in b) return { type: 'heading', attrs: { level: b.level ?? 1 }, content: text(b.h) };
    if ('quote' in b) {
      return {
        type: 'blockquote',
        content: b.quote.map((q) => ({ type: 'paragraph', content: text(q) })),
      };
    }
    if ('list' in b) {
      return {
        type: 'bullet_list',
        content: b.list.map((q) => ({
          type: 'list_item',
          content: [{ type: 'paragraph', content: text(q) }],
        })),
      };
    }
    if ('sceneBreak' in b) return { type: 'scene_break' };
    return {
      type: 'paragraph',
      content: [...text(b.p), { type: 'footnote', content: text(b.footnote) }],
    };
  });
  const json: PMNodeJSON = { type: 'doc', content };
  docFromJSON(json); // validate
  return json;
}

function doc(
  id: string,
  title: string,
  blocks: BlockSpec[],
  extra: Partial<DocumentState> = {},
): DocumentState {
  return {
    id,
    kind: 'manuscript',
    area: 'manuscript',
    title,
    parentId: null,
    synopsis: '',
    content: docJSON(blocks),
    version: 7,
    provenance: [],
    archived: false,
    imported: null,
    createdSeq: 2,
    contentSeq: 10,
    updatedSeq: 10,
    ...extra,
  };
}

/** Chapter 1 text (document `ch1`). Ids: p1 heading, p2–p3 paragraphs, p4 heading, p5 paragraph, p6 blockquote paragraph. */
export const CH1: BlockSpec[] = [
  { h: 'The Storm' },
  'The rain fell sideways. Nobody came to the door. The rain, the rain, the endless rain.',
  'Mara waited by the window for an hour. She thought about the letter. It said very little.',
  { h: 'Morning' },
  'Dawn came grey and slow. The street was empty.',
  { quote: ['Some quoted words stand here.'] },
];

/** A small project: prologue, two chapters in a folder, a style note, one library source, some history. */
export function makeState(overrides: { ch1?: BlockSpec[] } = {}): ProjectState {
  const ch1 = doc('ch1', 'Chapter 1', overrides.ch1 ?? CH1, {
    parentId: 'part1',
    synopsis: 'Mara waits out a storm for news that never comes.',
  });
  const prologue = doc('pro', 'Prologue', ['Years before, a letter went missing.'], {
    synopsis: 'A letter goes missing.',
  });
  const ch2 = doc('ch2', 'Chapter 2', ['The letter arrived on Tuesday.'], {
    parentId: 'part1',
    synopsis: 'The letter arrives, and it is not what Mara hoped.',
  });
  const archived = doc('old', 'Cut scene', ['Nothing here.'], { archived: true });
  const style = doc('style', 'Style guide', ['Short sentences. Keep adverbs rare.'], {
    kind: 'note',
    area: 'notes',
  });
  return {
    projectId: 'proj1',
    accountId: 'acct1',
    headSeq: 40,
    headHash: GENESIS_PREV_HASH,
    settings: {
      title: 'The Letter',
      genre: 'literary fiction',
      audience: 'adult readers of quiet novels',
      goals: 'Keep the tension low and steady.',
      styleNotes: 'Plain words. No exclamation marks.',
      dailyWordGoal: null,
      citationStyle: 'apa',
    },
    createdSeq: 1,
    binder: {
      manuscript: [
        { kind: 'document', id: 'pro' },
        { kind: 'folder', id: 'part1' },
        { kind: 'document', id: 'old' },
      ],
      notes: [{ kind: 'document', id: 'style' }],
    },
    folders: {
      part1: {
        id: 'part1',
        area: 'manuscript',
        title: 'Part One',
        parentId: null,
        children: [
          { kind: 'document', id: 'ch1' },
          { kind: 'document', id: 'ch2' },
        ],
        synopsis: '',
        archived: false,
        createdSeq: 2,
        updatedSeq: 2,
      },
    },
    documents: { pro: prologue, ch1, ch2, old: archived, style },
    annotations: {
      feedbackRequests: {},
      agentSessions: {
        s0: {
          id: 's0',
          kind: 'review',
          requestId: 'r0',
          threadId: null,
          model: 'opus',
          startedSeq: 20,
          startedAt: '2026-11-20T10:00:00.000Z',
          endedSeq: 30,
          status: 'finished',
          failureReason: null,
          review: {
            summary: 'A quiet opening that earns its mood.',
            strengths: ['Restraint'],
            topPriorities: ['Clarify what the letter is'],
          },
          counts: {
            items: 2,
            suggestions: 1,
            insertions: 0,
            proposals: 1,
            questions: 0,
            searches: 0,
          },
          annotationIds: ['sg0', 'pr0'],
        },
      },
      comments: {},
      questions: {},
      suggestions: {
        sg0: {
          id: 'sg0',
          feedbackSessionId: 's0',
          seq: 21,
          createdAt: '2026-11-20T10:01:00.000Z',
          status: 'dismissed',
          resolvedSeq: 31,
          dismissal: { seq: 31, reason: 'not-my-voice', note: null },
          range: null,
          kind: 'word-choice',
          anchor: { documentId: 'ch1', sentenceId: 'p2.s1', quote: 'sideways', occurrence: 0 },
          alternatives: ['slantwise', 'aslant'],
          rationale: 'More vivid.',
          adoptedAlternative: null,
        },
      },
      proposals: {
        pr0: {
          id: 'pr0',
          feedbackSessionId: 's0',
          seq: 22,
          createdAt: '2026-11-20T10:02:00.000Z',
          documentId: 'ch1',
          rationale: 'Open on the window.',
          status: 'rejected',
          resolvedSeq: 32,
          rejectReason: 'wrong',
          kind: 'move',
          span: { documentId: 'ch1', unit: 'paragraph', ids: ['p3'] },
          destination: { position: 'before', id: 'p2' },
          source: null,
          insertAt: null,
        },
      },
      citationFlags: {},
      surfacedSources: {},
      sourceSuggestions: {},
      discussions: {
        th1: {
          id: 'th1',
          targetId: 'sg0',
          messages: [
            {
              role: 'writer',
              body: 'Why slantwise?',
              seq: 33,
              createdAt: '2026-11-20T11:00:00.000Z',
              feedbackSessionId: null,
            },
          ],
          status: 'awaiting-editor',
        },
      },
    },
    sources: {
      src1: {
        id: 'src1',
        csl: { id: 'src1', type: 'book', title: 'Weather and Mood' },
        origin: { kind: 'manual', value: null },
        fromSurfacedId: null,
        candidateIndex: null,
        note: '',
        archived: false,
        addedSeq: 5,
        updatedSeq: 5,
      },
    },
    clippings: {},
    pastes: {},
    writingSessions: [],
  };
}

/** A document-scope request for `ch1`. */
export function docRequest(overrides: Partial<FeedbackRequest> = {}): FeedbackRequest {
  return {
    requestId: 'req1',
    scope: { kind: 'document', documentId: 'ch1' },
    lenses: ['structure', 'clarity'],
    intensity: 'standard',
    ask: 'Is the opening too slow?',
    ...overrides,
  };
}

/** A fixed clock and id generator for deterministic drafts. */
export function deterministic() {
  let n = 0;
  return {
    now: () => '2026-11-24T12:00:00.000Z',
    newId: () => `id${++n}`,
  };
}
