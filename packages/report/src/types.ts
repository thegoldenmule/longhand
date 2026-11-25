/**
 * The report's types: the schema's `AuthorshipReport` with this lane's extra
 * fields typed (`ai.sessions`, `unwitnessed[].reason`, `extensions`).
 */
import type { AgentSessionState, AuthorshipReport, MatchedKind } from '@longhand/schema';

type SuggestionKind = 'word-choice' | 'insertion' | 'rephrase';
type MoveUnit = 'sentence' | 'paragraph' | 'section';

/** A loose object type without its index signature (so `Omit` keeps the named fields). */
type KnownFields<T> = { [K in keyof T as string extends K ? never : K]: T[K] };

/** Suggestion counts per outcome. */
export type SuggestionOutcomeCounts = Record<
  'open' | 'adopted' | 'adapted' | 'stale' | 'dismissed',
  number
>;

/** What a run of retyped AI text matched, with word-choice and rephrase suggestions told apart. */
export type AssistedKind = Exclude<MatchedKind, 'suggestion'> | 'word-choice' | 'rephrase';

/** Every {@link AssistedKind}, in the order the disclosure lists them. */
export const ASSISTED_KINDS: readonly AssistedKind[] = Object.freeze([
  'word-choice',
  'rephrase',
  'insertion',
  'comment',
  'question',
  'proposal',
  'citation-flag',
  'surfaced-source',
  'source-suggestion',
  'discuss',
  'review',
  'chat',
]);

/**
 * Assisted kinds a report always lists, with zeros. `chat` appears only when
 * nonzero, so reports of ledgers without chats are unchanged.
 */
export type ListedAssistedKind = Exclude<AssistedKind, 'chat'>;

/** Report data beyond the schema's required fields (`report.extensions`). */
export type ReportExtensions = {
  /** The lag above which a human commit counts as queued offline ({@link UNWITNESSED_LAG_MS}). */
  unwitnessedThresholdMs: number;
  /** Project title, from the ledger. */
  projectTitle: string;
  /** The documents whose words are counted, by id. */
  documents: Array<{ id: string; title: string; kind: 'manuscript' | 'note'; words: number }>;
  /**
   * The AI texts behind `typed-from-suggestion` words: how many distinct
   * annotations (or discuss threads, or reviews) the counted words matched.
   */
  assisted: {
    annotations: number;
    byKind: Record<ListedAssistedKind, number> & { chat?: number };
  };
  /** Distinct library sources behind `quoted` words. */
  quoted: { sources: number };
  /** Suggestion outcomes per kind. */
  suggestions: { byKind: Record<SuggestionKind, SuggestionOutcomeCounts> };
  /** Move proposals by span unit. */
  proposals: {
    moves: Record<MoveUnit, { proposed: number; accepted: number }>;
  };
  /** Imported documents, in seq order. */
  imports: Array<{
    seq: number;
    documentId: string;
    title: string;
    sourceFormat: string;
    sourceName: string | null;
    /** Words in the imported content, at import. */
    words: number;
    clientTime: string;
  }>;
};

/** An AI session as listed in `report.ai.sessions`. */
export interface ReportAiSession {
  id: string;
  kind: AgentSessionState['kind'];
  model: string;
  systemPromptVersion: string | null;
  status: AgentSessionState['status'];
  startedAt: string;
  startedSeq: number;
  /** The feedback request it served (review sessions). */
  requestId: string | null;
  /** The Discuss thread it answered (discuss sessions). */
  threadId: string | null;
  lenses: string[] | null;
  intensity: string | null;
  /** What the request covered: `project`, `document` or `selection` (review sessions). */
  scope: 'project' | 'document' | 'selection' | null;
  /** Annotations it created. */
  annotations: number;
  failureReason: string | null;
  /** The chat a chat session answered in (chat sessions only). */
  chatId?: string;
}

/** The report `computeReport` returns: the schema's shape with this lane's extensions typed. */
export type Report = Omit<KnownFields<AuthorshipReport>, 'ai' | 'unwitnessed' | 'extensions'> & {
  ai: AuthorshipReport['ai'] & {
    sourceSuggestions: number;
    sessions: ReportAiSession[];
    /** Messages the writer sent the editors in the feedback chat (present only when nonzero). */
    chatMessages?: number;
  };
  unwitnessed: Array<
    AuthorshipReport['unwitnessed'][number] & {
      reason: 'queued-offline' | 'not-witnessed';
      commits: number;
      maxLagMs: number;
    }
  >;
  extensions: ReportExtensions;
};
