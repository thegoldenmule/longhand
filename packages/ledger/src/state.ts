/**
 * The fold's internal state (opaque to consumers as {@link LedgerState}) and the
 * copy-on-write transaction used while folding one commit.
 *
 * Every container in {@link Internal} is treated as immutable once a commit has
 * been folded: a {@link Tx} shallow-copies a container the first time it writes to
 * it, and entries are replaced rather than mutated. Older states therefore stay
 * valid (structural sharing), which `stateAtSeq` snapshots rely on.
 */
import {
  DEFAULT_PROJECT_SETTINGS,
  GENESIS_PREV_HASH,
  type ActorKind,
  type AnnotationsState,
  type BinderArea,
  type BinderState,
  type ClippingState,
  type DocumentKind,
  type EventType,
  type FolderState,
  type ImportInfo,
  type InputMethod,
  type PasteState,
  type PMNode,
  type ProjectSettings,
  type SourceState,
  type WritingSession,
} from '@longhand/schema';
import type { MapNode, Tomb } from './engine';
import type { FoldIssue, LedgerErrorCode } from './issues';
import type { IRun, Prov } from './prov';
import { pvecEmpty, pvecPush, type PVec } from './pvec';

/** A document with its folded content, provenance and history. */
export interface DocInternal {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly area: BinderArea;
  readonly title: string;
  readonly parentId: string | null;
  readonly synopsis: string;
  readonly archived: boolean;
  readonly imported: ImportInfo | null;
  readonly createdSeq: number;
  readonly contentSeq: number;
  readonly updatedSeq: number;
  readonly node: PMNode;
  readonly version: number;
  readonly runs: readonly IRun[];
  readonly tombs: readonly Tomb[];
  readonly maps: MapNode | null;
}

/** A position range. */
export interface Span {
  from: number;
  to: number;
}

/** Annotation groups that carry document positions. */
export type TrackedGroup =
  | 'comments'
  | 'questions'
  | 'suggestions'
  | 'proposals'
  | 'citationFlags'
  | 'surfacedSources'
  | 'sourceSuggestions';

/**
 * Lifecycle state of an open suggestion (see `lifecycle.ts`). While a suggestion is
 * open its tracker `range` is the region the writer is working in.
 */
export interface Region {
  /** The writer has edited inside it since it was last back to its original text. */
  touched: boolean;
  /** Inline text of the anchored span when the suggestion arrived ('' for insertions). */
  original: string;
}

/** Positions an annotation follows through every step of its document. */
export interface Tracker {
  id: string;
  docId: string;
  group: TrackedGroup;
  /** Main range (null once its text is deleted). Points have `from === to`. */
  range: Span | null;
  isPoint: boolean;
  /** The range covers whole nodes (paragraph/section spans, merges): edits at its edges touch it. */
  nodeRange: boolean;
  /** Association used when mapping a point range. */
  rangeAssoc: 1 | -1;
  /** Secondary position: a move's insertion point, a split position or a merge join. */
  point: number | null;
  pointAssoc: 1 | -1;
  /** For open word-choice, insertion and rephrase suggestions. */
  region: Region | null;
  /** For insertion suggestions: the sentence the point is relative to. */
  ref: Span | null;
  /** Open proposals and suggestions: check every step for edits that touch them. */
  watch: boolean;
}

/** Envelope facts kept per commit (index `seq - 1`), for sessions and the span inspector. */
export interface CommitInfo {
  seq: number;
  type: EventType;
  actorKind: ActorKind;
  clientTime: string;
  serverTime: string;
  sessionId: string;
  deviceId: string;
  hash: string;
  documentId: string | null;
  /** Input methods used (TextEdited). */
  methods: InputMethod[] | null;
  /** Accepted proposal (ProposalAccepted). */
  proposalId: string | null;
}

/** One human manuscript commit, for writing sessions. */
export interface MsEntry {
  seq: number;
  timeMs: number;
  clientTime: string;
  durationMs: number;
  characters: number;
  documentId: string;
}

/** AI-visible text and its 4-grams eligible for the matcher. */
export interface AiText {
  id: string;
  seq: number;
  ngrams: ReadonlySet<string>;
}

/** Provenance snapshot of a copied span (`SliceCopied`); `units` null if it could not be verified. */
export interface CopySnap {
  copyId: string;
  seq: number;
  documentId: string;
  units: ReadonlyArray<{ key: string; p: Prov }> | null;
}

/** A `CitationInserted` companion. */
export interface CitationRec {
  citationId: string;
  seq: number;
  documentId: string;
  sourceId: string;
  locator: string | null;
  used: boolean;
}

/** The full internal fold state. */
export interface Internal {
  readonly projectId: string;
  readonly accountId: string;
  readonly headSeq: number;
  readonly headHash: string;
  readonly settings: ProjectSettings;
  readonly createdSeq: number;
  readonly binder: BinderState;
  readonly folders: Readonly<Record<string, FolderState>>;
  readonly docs: Readonly<Record<string, DocInternal>>;
  readonly ann: AnnotationsState;
  readonly trackers: Readonly<Record<string, Tracker>>;
  readonly docTrackers: Readonly<Record<string, readonly string[]>>;
  readonly sources: Readonly<Record<string, SourceState>>;
  readonly clippings: Readonly<Record<string, ClippingState>>;
  readonly pastes: Readonly<Record<string, PasteState>>;
  readonly pasteCopyIds: Readonly<Record<string, string | null>>;
  readonly copies: Readonly<Record<string, CopySnap>>;
  readonly citations: Readonly<Record<string, CitationRec>>;
  readonly aiTexts: PVec<AiText>;
  readonly commits: PVec<CommitInfo>;
  readonly msEntries: PVec<MsEntry>;
  readonly sessions: readonly WritingSession[];
  readonly issues: PVec<FoldIssue>;
}

declare const brand: unique symbol;

/**
 * The fold state: an opaque, immutable value. Read it with `projectState`,
 * `documentNode`, `foldIssues` and the other accessors; advance it with
 * `applyCommit`.
 */
export interface LedgerState {
  readonly [brand]: true;
}

/** Internal view of a state. */
export function internal(state: LedgerState): Internal {
  return state as unknown as Internal;
}

/** Opaque view of an internal state. */
export function opaque(s: Internal): LedgerState {
  return s as unknown as LedgerState;
}

function emptyAnnotations(): AnnotationsState {
  return {
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
  };
}

/** The state before any commit. */
export function emptyInternal(): Internal {
  return {
    projectId: '',
    accountId: '',
    headSeq: 0,
    headHash: GENESIS_PREV_HASH,
    settings: { ...DEFAULT_PROJECT_SETTINGS, title: '' } as ProjectSettings,
    createdSeq: 0,
    binder: { manuscript: [], notes: [] },
    folders: {},
    docs: {},
    ann: emptyAnnotations(),
    trackers: {},
    docTrackers: {},
    sources: {},
    clippings: {},
    pastes: {},
    pasteCopyIds: {},
    copies: {},
    citations: {},
    aiTexts: pvecEmpty(),
    commits: pvecEmpty(),
    msEntries: pvecEmpty(),
    sessions: [],
    issues: pvecEmpty(),
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type RecordKey =
  | 'folders'
  | 'docs'
  | 'trackers'
  | 'docTrackers'
  | 'sources'
  | 'clippings'
  | 'pastes'
  | 'pasteCopyIds'
  | 'copies'
  | 'citations';
type Rec<K extends RecordKey> = Record<string, Internal[K][string]>;
type AnnGroup = keyof AnnotationsState;

/** Copy-on-write transaction over one commit. */
export class Tx {
  readonly s: Mutable<Internal>;
  readonly seq: number;
  readonly serverTime: string;
  private readonly owned = new Set<string>();

  constructor(base: Internal, seq: number, serverTime: string) {
    this.s = { ...base };
    this.seq = seq;
    this.serverTime = serverTime;
  }

  /** A writable copy of a top-level record (copied once per commit). */
  rec<K extends RecordKey>(key: K): Rec<K> {
    if (!this.owned.has(key)) {
      (this.s as Record<string, unknown>)[key] = { ...(this.s[key] as object) };
      this.owned.add(key);
    }
    return this.s[key] as Rec<K>;
  }

  /** A writable copy of an annotation group (copied once per commit). */
  ann<G extends AnnGroup>(group: G): Record<string, AnnotationsState[G][string]> {
    if (!this.owned.has('ann')) {
      this.s.ann = { ...this.s.ann };
      this.owned.add('ann');
    }
    const key = `ann.${group}`;
    if (!this.owned.has(key)) {
      (this.s.ann as unknown as Record<string, unknown>)[group] = { ...this.s.ann[group] };
      this.owned.add(key);
    }
    return this.s.ann[group] as Record<string, AnnotationsState[G][string]>;
  }

  /** A writable copy of the binder (both area lists copied once per commit). */
  binder(): BinderState {
    if (!this.owned.has('binder')) {
      this.s.binder = { manuscript: [...this.s.binder.manuscript], notes: [...this.s.binder.notes] };
      this.owned.add('binder');
    }
    return this.s.binder;
  }

  /** Records a fold issue for this commit. */
  issue(code: LedgerErrorCode, message: string): void {
    this.s.issues = pvecPush(this.s.issues, { seq: this.seq, code, message });
  }

  /** Replaces a document. */
  setDoc(doc: DocInternal): void {
    this.rec('docs')[doc.id] = doc;
  }

  /** Replaces a tracker. */
  setTracker(t: Tracker): void {
    this.rec('trackers')[t.id] = t;
  }

  /** Registers a new tracker for a document. */
  addTracker(t: Tracker): void {
    this.setTracker(t);
    const list = this.rec('docTrackers');
    list[t.docId] = [...(list[t.docId] ?? []), t.id];
  }
}
