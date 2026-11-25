/**
 * The fold's output: `ProjectState`. Types only — `packages/ledger` implements the
 * fold; UI lanes, the server's read model, export, report and verifier consume it.
 *
 * Conventions:
 * - Collections are `Record<id, T>`; every entity carries the `seq` that created it,
 *   so consumers order by seq. (Canonical JSON sorts keys, so records are
 *   deterministic.)
 * - Times are the *server* time of the relevant commit unless named `clientTime`.
 * - Every range is in the document's **current** version: the fold maps stored
 *   positions through every later step. A range is `null` when its text was deleted.
 * - Nothing here is editable state: it is recomputed from the ledger.
 */
import type { Anchor, SpanRef } from './anchors';
import type { SessionCounts, AgentSessionKind } from './tools';
import type {
  BinderArea,
  CslItem,
  DismissReason,
  DocumentKind,
  Intensity,
  Lens,
  ProjectSettings,
  Severity,
} from './domain';
import type { PMNodeJSON } from './document';
import type { FeedbackScope, SourceOrigin, SurfacedCandidate, Target } from './events';
import type { ProvenanceRun } from './provenance';

/** Gap in human activity (by commit `clientTime`) that ends a writing session: 30 minutes. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/** A reference to a binder node. */
export interface BinderRef {
  kind: 'folder' | 'document';
  id: string;
}

/** Ordered root children of each binder area. */
export interface BinderState {
  manuscript: BinderRef[];
  notes: BinderRef[];
}

/** A binder folder. */
export interface FolderState {
  id: string;
  area: BinderArea;
  title: string;
  /** Parent folder, or null at the area root. */
  parentId: string | null;
  /** Ordered children. */
  children: BinderRef[];
  /** Writer-authored corkboard synopsis (`SynopsisEdited` with `folderId`), '' if none. */
  synopsis: string;
  archived: boolean;
  createdSeq: number;
  updatedSeq: number;
}

/** Import metadata for documents created by `DocumentImported`. */
export interface ImportInfo {
  seq: number;
  sourceFormat: 'markdown' | 'docx' | 'text' | 'html';
  sourceName: string | null;
  sourceHash: string;
}

/** A document (manuscript or note) with its folded content and provenance. */
export interface DocumentState {
  id: string;
  kind: DocumentKind;
  /** `manuscript` for manuscript documents, `notes` for notes. */
  area: BinderArea;
  title: string;
  parentId: string | null;
  /** Writer-authored corkboard synopsis (`SynopsisEdited`), '' if none. */
  synopsis: string;
  /** ProseMirror document JSON (`Node#toJSON()`), valid against `schema`. */
  content: PMNodeJSON;
  /** Cumulative number of steps applied (TextEdited steps + steps derived from accepted proposals). */
  version: number;
  /** Canonical provenance runs over `content` (see `provenance.ts`). */
  provenance: ProvenanceRun[];
  archived: boolean;
  imported: ImportInfo | null;
  createdSeq: number;
  /** Seq of the last commit that changed `content`. */
  contentSeq: number;
  /** Seq of the last commit that changed anything about this document. */
  updatedSeq: number;
}

/** A position range in a document's current version. */
export interface CurrentRange {
  documentId: string;
  from: number;
  to: number;
}

/** Fields shared by every agent-created annotation. */
export interface AnnotationBase {
  id: string;
  feedbackSessionId: string;
  /** Seq of the creating agent commit. */
  seq: number;
  /** Server time of the creating commit. */
  createdAt: string;
}

/** Status of a comment, question, flag or source annotation. */
export type CardStatus = 'open' | 'dismissed';

/** Dismissal details (`SuggestionDismissed`). */
export interface Dismissal {
  seq: number;
  reason: DismissReason | null;
  note: string | null;
}

/** A margin comment. */
export interface CommentState extends AnnotationBase {
  target: Target;
  /** Where the target is now; null if its text was deleted. */
  range: CurrentRange | null;
  category: Lens;
  severity: Severity;
  body: string;
  status: CardStatus;
  dismissal: Dismissal | null;
}

/** A question for the writer. */
export interface QuestionState extends AnnotationBase {
  target: Target | null;
  range: CurrentRange | null;
  question: string;
  status: CardStatus;
  dismissal: Dismissal | null;
}

/**
 * Suggestion lifecycle. `adopted` (retyped to a full match) and `adapted` (writer
 * typed something different while the suggestion was in play) are the only outcomes
 * that put words on the page — words the writer typed. `stale`: the text under the
 * anchor changed otherwise (or had already changed on arrival). `dismissed`: the
 * writer dismissed it.
 */
export type SuggestionStatus = 'open' | 'adopted' | 'adapted' | 'stale' | 'dismissed';

interface SuggestionCommon extends AnnotationBase {
  status: SuggestionStatus;
  /** Seq of the commit that resolved it (the triggering human commit, or the dismissal). */
  resolvedSeq: number | null;
  dismissal: Dismissal | null;
  /** Current range of the anchored span (for insertions, a point: from === to). */
  range: CurrentRange | null;
}

/** A wording suggestion. */
export type SuggestionState =
  | (SuggestionCommon & {
      kind: 'word-choice';
      anchor: Anchor;
      alternatives: string[];
      rationale: string;
      /** Index of the alternative the writer retyped, when adopted. */
      adoptedAlternative: number | null;
    })
  | (SuggestionCommon & {
      kind: 'insertion';
      documentId: string;
      position: 'before' | 'after';
      sentenceId: string;
      sentence: string;
      purpose: string;
    })
  | (SuggestionCommon & { kind: 'rephrase'; anchor: Anchor; guidance: string });

/** Proposal lifecycle. */
export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'stale';

interface ProposalCommon extends AnnotationBase {
  documentId: string;
  rationale: string;
  status: ProposalStatus;
  /** Seq of the ProposalAccepted / ProposalRejected / staling commit. */
  resolvedSeq: number | null;
  rejectReason: DismissReason | null;
}

/** A structural proposal, with current positions for the diff preview. */
export type ProposalState =
  | (ProposalCommon & {
      kind: 'move';
      span: SpanRef;
      destination: { position: 'before' | 'after'; id: string };
      /** Current source range (null once stale or resolved). */
      source: { from: number; to: number } | null;
      /** Current insertion position (null once stale or resolved). */
      insertAt: number | null;
    })
  | (ProposalCommon & { kind: 'cut'; target: Target; range: { from: number; to: number } | null })
  | (ProposalCommon & {
      kind: 'split';
      paragraphId: string;
      sentenceId: string;
      pos: number | null;
    })
  | (ProposalCommon & {
      kind: 'merge';
      firstParagraphId: string;
      secondParagraphId: string;
      joinPos: number | null;
      range: { from: number; to: number } | null;
    });

/** A citation-needed flag. `cited` once a citation node exists inside its range. */
export interface CitationFlagState extends AnnotationBase {
  target: Target;
  range: CurrentRange | null;
  claim: string;
  status: 'open' | 'cited' | 'dismissed';
  dismissal: Dismissal | null;
}

/** AI-surfaced source candidates (unverified until the writer adds one with `SourceAdded`). */
export interface SurfacedSourceState extends AnnotationBase {
  query: string;
  target: Target | null;
  range: CurrentRange | null;
  candidates: SurfacedCandidate[];
  /** Candidates the writer verified and added, by candidate index. */
  accepted: Array<{ candidateIndex: number; sourceId: string }>;
  status: CardStatus;
  dismissal: Dismissal | null;
}

/** The agent's suggestion that a library source supports a claim. */
export interface SourceSuggestionState extends AnnotationBase {
  target: Target;
  range: CurrentRange | null;
  sourceId: string;
  rationale: string;
  status: CardStatus;
  dismissal: Dismissal | null;
}

/** A writer's feedback request and where it got to. */
export interface FeedbackRequestState {
  id: string;
  seq: number;
  createdAt: string;
  scope: FeedbackScope;
  lenses: Lens[];
  intensity: Intensity;
  ask: string | null;
  status: 'pending' | 'running' | 'finished' | 'failed';
  /** The agent session serving it, once started. */
  feedbackSessionId: string | null;
}

/** An agent session (a review, or a discuss reply). */
export interface AgentSessionState {
  id: string;
  kind: AgentSessionKind;
  /** For review sessions. */
  requestId: string | null;
  /** For discuss sessions. */
  threadId: string | null;
  model: string;
  startedSeq: number;
  startedAt: string;
  endedSeq: number | null;
  status: 'running' | 'finished' | 'failed';
  failureReason: string | null;
  /** The `finish_review` summary (review sessions). */
  review: { summary: string; strengths: string[]; topPriorities: string[] } | null;
  /** Annotation-producing calls recorded so far. */
  counts: SessionCounts;
  /** Ids of annotations created in this session, in seq order. */
  annotationIds: string[];
}

/** A Discuss thread on an annotation. */
export interface DiscussThreadState {
  id: string;
  targetId: string;
  messages: Array<{
    role: 'writer' | 'editor';
    body: string;
    seq: number;
    createdAt: string;
    /** Agent session that wrote an editor message. */
    feedbackSessionId: string | null;
  }>;
  status: 'awaiting-editor' | 'answered' | 'failed';
}

/** The annotation layer. AI text lives only here. */
export interface AnnotationsState {
  feedbackRequests: Record<string, FeedbackRequestState>;
  agentSessions: Record<string, AgentSessionState>;
  comments: Record<string, CommentState>;
  questions: Record<string, QuestionState>;
  suggestions: Record<string, SuggestionState>;
  proposals: Record<string, ProposalState>;
  citationFlags: Record<string, CitationFlagState>;
  surfacedSources: Record<string, SurfacedSourceState>;
  sourceSuggestions: Record<string, SourceSuggestionState>;
  discussions: Record<string, DiscussThreadState>;
}

/** A library source (writer-verified). */
export interface SourceState {
  id: string;
  csl: CslItem;
  origin: SourceOrigin;
  /** Set when the writer promoted an AI-surfaced candidate. */
  fromSurfacedId: string | null;
  candidateIndex: number | null;
  note: string;
  archived: boolean;
  addedSeq: number;
  updatedSeq: number;
}

/** A saved clipping. */
export interface ClippingState {
  id: string;
  sourceId: string;
  text: string;
  locator: string | null;
  note: string | null;
  savedSeq: number;
  removed: boolean;
}

/** A paste event (`PasteOccurred`), for reports and the span inspector. */
export interface PasteState {
  id: string;
  seq: number;
  documentId: string;
  origin: 'external' | 'internal';
  via: 'clipboard' | 'drop';
  characters: number;
  words: number;
  /** Seq of the `TextEdited` that inserted it, once seen. */
  insertedSeq: number | null;
  /** For internal pastes: whether the fold verified the source and inherited its class. */
  verifiedInternal: boolean;
}

/**
 * A writing session derived from human manuscript commits: a maximal run whose
 * consecutive `clientTime`s are less than {@link SESSION_GAP_MS} apart.
 */
export interface WritingSession {
  /** 0-based, in time order. */
  index: number;
  startSeq: number;
  endSeq: number;
  /** clientTime of the first input. */
  startTime: string;
  /** clientTime of the last input (plus that batch's durationMs). */
  endTime: string;
  /** Sum of TextEdited `durationMs` in the session. */
  activeMs: number;
  commits: number;
  charactersInserted: number;
  documentIds: string[];
}

/** The whole folded project. */
export interface ProjectState {
  projectId: string;
  accountId: string;
  /** Seq of the last folded commit (0 before any). */
  headSeq: number;
  /** Hash of the last folded commit (`GENESIS_PREV_HASH` before any). */
  headHash: string;
  settings: ProjectSettings;
  createdSeq: number;
  binder: BinderState;
  folders: Record<string, FolderState>;
  documents: Record<string, DocumentState>;
  annotations: AnnotationsState;
  sources: Record<string, SourceState>;
  clippings: Record<string, ClippingState>;
  pastes: Record<string, PasteState>;
  writingSessions: WritingSession[];
}
