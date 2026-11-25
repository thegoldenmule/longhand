// Test-only helpers: one valid example payload per event type, and a commit builder.
// Not exported from the package (golden fixtures live in packages/ledger).
import type { EventPayloads, EventType } from './events';
import { EVENTS } from './events';
import { GENESIS_PREV_HASH, SCHEMA_VERSION, computeCommitHash, type Commit } from './ledger';
import { sha256Hex } from './canonical';

const H = sha256Hex('x');
const anchor = { documentId: 'doc1', sentenceId: 'p1.s1', quote: 'rain', occurrence: 0 };
const resolvedAnchor = { anchor, from: 5, to: 9, readVersion: 3, version: 4 };
const resolvedSpan = {
  span: { documentId: 'doc1', unit: 'paragraph' as const, ids: ['p2'] },
  from: 20,
  to: 40,
  readVersion: 3,
  version: 4,
};
const csl = { id: 'src1', type: 'book', title: 'A Book', author: [{ family: 'Doe', given: 'J.' }] };

export const EXAMPLE_PAYLOADS: { [K in EventType]: EventPayloads[K] } = {
  ProjectCreated: { title: 'My Novel' },
  ProjectSettingsChanged: { patch: { genre: 'literary fiction', dailyWordGoal: 500 } },
  DocumentCreated: {
    documentId: 'doc1',
    kind: 'manuscript',
    title: 'Chapter 1',
    parentId: null,
    index: 0,
  },
  DocumentImported: {
    documentId: 'doc2',
    kind: 'manuscript',
    title: 'Old draft',
    parentId: 'folder1',
    index: 1,
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old.' }] }],
    },
    sourceFormat: 'markdown',
    sourceName: 'draft.md',
    sourceHash: H,
  },
  DocumentRenamed: { documentId: 'doc1', title: 'Chapter One' },
  DocumentMoved: { documentId: 'doc1', parentId: 'folder1', index: 0 },
  DocumentArchived: { documentId: 'doc1', archived: true },
  SynopsisEdited: { documentId: 'doc1', synopsis: 'Rain. A stranger arrives.' },
  FolderCreated: {
    folderId: 'folder1',
    area: 'manuscript',
    title: 'Part One',
    parentId: null,
    index: 0,
  },
  FolderRenamed: { folderId: 'folder1', title: 'Part I' },
  FolderMoved: { folderId: 'folder1', parentId: null, index: 2 },
  FolderArchived: { folderId: 'folder1', archived: false },
  TextEdited: {
    documentId: 'doc1',
    baseVersion: 0,
    steps: [
      {
        stepType: 'replace',
        from: 1,
        to: 1,
        slice: { content: [{ type: 'text', text: 'The rain' }] },
      },
      {
        stepType: 'replace',
        from: 9,
        to: 9,
        slice: { content: [{ type: 'text', text: ' fell.' }] },
      },
    ],
    runs: [
      { steps: 1, method: 'typed' },
      { steps: 1, method: 'pasted-external', pasteId: 'paste1' },
    ],
    timeline: [
      { t: 0, kind: 'insert', len: 1 },
      { t: 140, kind: 'insert', len: 1 },
      { t: 900, kind: 'paste', len: 6 },
    ],
    characters: 14,
    durationMs: 900,
  },
  PasteOccurred: {
    pasteId: 'paste1',
    documentId: 'doc1',
    origin: 'external',
    via: 'clipboard',
    copyId: null,
    characters: 6,
    words: 1,
    textHash: H,
    mimeTypes: ['text/plain'],
  },
  SliceCopied: {
    copyId: 'copy1',
    documentId: 'doc1',
    from: 1,
    to: 9,
    version: 2,
    cut: false,
    textHash: H,
    characters: 8,
  },
  ProposalAccepted: { proposalId: 'prop1', documentId: 'doc1', baseVersion: 4 },
  ProposalRejected: { proposalId: 'prop1', reason: 'wrong' },
  SuggestionDismissed: { targetId: 'sug1', reason: 'not-my-voice', note: null },
  FeedbackRequested: {
    requestId: 'req1',
    scope: { kind: 'document', documentId: 'doc1' },
    lenses: ['pacing', 'clarity'],
    intensity: 'standard',
    ask: 'Is the opening too slow?',
  },
  DiscussRequested: { threadId: 'thr1', targetId: 'sug1', message: 'Why this word?' },
  SourceAdded: {
    sourceId: 'src1',
    csl,
    origin: { kind: 'isbn', value: '9780000000000' },
    fromSurfacedId: null,
    candidateIndex: null,
  },
  SourceUpdated: { sourceId: 'src1', note: 'Library copy.' },
  CitationInserted: { citationId: 'cit1', documentId: 'doc1', sourceId: 'src1', locator: 'p. 4' },
  ClippingSaved: {
    clippingId: 'clip1',
    sourceId: 'src1',
    text: 'A quoted line.',
    locator: 'p. 4',
    note: null,
  },
  ClippingRemoved: { clippingId: 'clip1' },
  FeedbackSessionStarted: {
    feedbackSessionId: 'fs1',
    trigger: { kind: 'feedback', requestId: 'req1' },
    model: 'opus',
  },
  CommentAdded: {
    commentId: 'com1',
    feedbackSessionId: 'fs1',
    target: { kind: 'anchor', ...resolvedAnchor },
    category: 'pacing',
    severity: 'moderate',
    body: 'The opening lingers on weather before anything happens.',
  },
  QuestionAsked: {
    questionId: 'q1',
    feedbackSessionId: 'fs1',
    target: null,
    question: 'Who is narrating?',
  },
  SuggestionProposed: {
    suggestionId: 'sug1',
    feedbackSessionId: 'fs1',
    suggestion: {
      kind: 'word-choice',
      target: resolvedAnchor,
      alternatives: ['drizzle', 'downpour'],
      rationale: 'More specific.',
    },
  },
  MoveProposed: {
    proposalId: 'prop1',
    feedbackSessionId: 'fs1',
    source: resolvedSpan,
    destination: { position: 'before', id: 'p1', pos: 0 },
    rationale: 'Open with action.',
  },
  CutProposed: {
    proposalId: 'prop2',
    feedbackSessionId: 'fs1',
    target: { kind: 'span', ...resolvedSpan },
    rationale: 'Repeats the previous paragraph.',
  },
  SplitProposed: {
    proposalId: 'prop3',
    feedbackSessionId: 'fs1',
    documentId: 'doc1',
    paragraphId: 'p2',
    sentenceId: 'p2.s3',
    pos: 30,
    readVersion: 3,
    version: 4,
    rationale: 'Two ideas.',
  },
  MergeProposed: {
    proposalId: 'prop4',
    feedbackSessionId: 'fs1',
    documentId: 'doc1',
    firstParagraphId: 'p2',
    secondParagraphId: 'p3',
    joinPos: 40,
    from: 20,
    to: 60,
    readVersion: 3,
    version: 4,
    rationale: 'One idea split in two.',
  },
  CitationNeededFlagged: {
    flagId: 'flag1',
    feedbackSessionId: 'fs1',
    target: resolvedAnchor,
    claim: 'Rain fell for forty days.',
  },
  SourceSurfaced: {
    surfacedId: 'surf1',
    feedbackSessionId: 'fs1',
    query: 'rainfall records',
    target: resolvedAnchor,
    candidates: [{ csl, provider: 'crossref', url: null }],
  },
  SourceSuggested: {
    sourceSuggestionId: 'ss1',
    feedbackSessionId: 'fs1',
    target: resolvedAnchor,
    sourceId: 'src1',
    rationale: 'Chapter 2 covers this.',
  },
  ReviewFinished: {
    feedbackSessionId: 'fs1',
    summary: 'A strong voice; the opening is slow.',
    strengths: ['Voice'],
    topPriorities: ['Start closer to the inciting event'],
  },
  DiscussAnswered: {
    feedbackSessionId: 'fs2',
    threadId: 'thr1',
    targetId: 'sug1',
    body: '"Drizzle" keeps the quiet mood.',
  },
  SuggestionResolved: {
    targetId: 'sug1',
    targetKind: 'suggestion',
    outcome: 'adopted',
    triggerSeq: 12,
  },
  ChainHeadWitnessed: {
    witnessedSeq: 12,
    witnessedHash: H,
    serverTime: '2026-11-24T18:00:00.000Z',
    signature: 'A'.repeat(86) + '==',
    keyId: H,
  },
  FeedbackSessionFailed: {
    feedbackSessionId: 'fs1',
    requestId: 'req1',
    threadId: null,
    reason: 'timeout',
  },
};

/** Builds a hashed commit for `type` with example (or given) payload. */
export function makeCommit<K extends EventType>(
  type: K,
  opts: {
    seq?: number;
    prevHash?: string;
    payload?: EventPayloads[K];
    actorKind?: 'human' | 'agent' | 'system';
  } = {},
): Commit {
  const actorKind = opts.actorKind ?? EVENTS[type].actor;
  const base = {
    commitId: `c-${type}-${opts.seq ?? 1}`,
    projectId: 'proj1',
    accountId: 'acct1',
    seq: opts.seq ?? 1,
    prevHash: opts.prevHash ?? GENESIS_PREV_HASH,
    clientTime: '2026-11-24T17:59:59.000Z',
    serverTime: '2026-11-24T18:00:00.000Z',
    actor: {
      kind: actorKind,
      id: actorKind === 'human' ? 'user1' : actorKind === 'agent' ? 'opus' : 'ledger',
    },
    deviceId: actorKind === 'human' ? 'dev1' : 'server',
    sessionId: actorKind === 'human' ? 'sess1' : actorKind === 'agent' ? 'fs1' : 'system',
    schemaVersion: SCHEMA_VERSION,
    type,
    payload: opts.payload ?? EXAMPLE_PAYLOADS[type],
  };
  return { ...base, hash: computeCommitHash(base as unknown as Commit) } as unknown as Commit;
}
