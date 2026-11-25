/**
 * Live review progress. The agent runner reports `SessionProgressEvent`s
 * (`@longhand/agent`) while a session runs; the server relays them to the browser.
 * This module accepts that shape structurally (no dependency on the agent
 * package) and folds it into a small per-session view: what the editor is doing
 * now, and which items have arrived before the ledger state catches up.
 */

/** A progress event, structurally compatible with `@longhand/agent`'s `SessionProgressEvent`. */
export type ReviewProgressEvent =
  | { kind: 'started'; feedbackSessionId: string; model: string; seq?: number }
  | {
      kind: 'model';
      /** Not in the agent's event; the relay may add it. */
      feedbackSessionId?: string;
      event: { type: string; name?: string; [key: string]: unknown };
    }
  | {
      kind: 'annotation';
      seq: number;
      draft: { type: string; sessionId?: string; payload: unknown };
    }
  | { kind: 'finished'; feedbackSessionId: string }
  | { kind: 'failed'; feedbackSessionId: string | null; reason: string };

/** One item that arrived during a session. */
export interface ArrivedItem {
  seq: number;
  type: string;
  /** Annotation id from the payload, when it has one. */
  id: string | null;
  /** Short description ("Comment", "Word choice"). */
  label: string;
}

/** What the panel shows for a live session. */
export interface SessionProgress {
  feedbackSessionId: string;
  model: string | null;
  /** What the editor is doing right now ("Reading the document"), or null. */
  activity: string | null;
  arrived: ArrivedItem[];
  state: 'running' | 'finished' | 'failed';
  failureReason: string | null;
}

const TOOL_ACTIVITY: Readonly<Record<string, string>> = {
  read_document: 'Reading the document',
  read_notes: 'Reading your notes',
  get_outline: 'Reading the outline',
  comment: 'Writing a margin note',
  ask_question: 'Writing a question',
  suggest_word_choice: 'Weighing a word choice',
  suggest_insertion: 'Considering a missing sentence',
  suggest_rephrase: 'Marking a sentence to rephrase',
  propose_move: 'Considering the order',
  propose_cut: 'Considering a cut',
  propose_split: 'Considering a paragraph break',
  propose_merge: 'Considering a paragraph join',
  flag_citation_needed: 'Checking claims',
  search_sources: 'Searching for sources',
  suggest_source: 'Matching claims to your library',
  finish_review: 'Writing the summary',
  answer_discussion: 'Writing a reply',
};

const TYPE_LABEL: Readonly<Record<string, string>> = {
  CommentAdded: 'Comment',
  QuestionAsked: 'Question',
  SuggestionProposed: 'Suggestion',
  MoveProposed: 'Move proposal',
  CutProposed: 'Cut proposal',
  SplitProposed: 'Split proposal',
  MergeProposed: 'Merge proposal',
  CitationNeededFlagged: 'Citation needed',
  SourceSurfaced: 'Possible sources',
  SourceSuggested: 'Source from your library',
  ReviewFinished: 'Summary',
  DiscussAnswered: 'Reply',
};

/** The activity label for a tool name (with or without the MCP prefix). */
export function toolActivity(name: string): string | null {
  const bare = name.replace(/^mcp__[^_]+__/, '');
  return TOOL_ACTIVITY[bare] ?? null;
}

function payloadId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  for (const k of [
    'commentId',
    'questionId',
    'suggestionId',
    'proposalId',
    'flagId',
    'surfacedId',
    'sourceSuggestionId',
  ])
    if (typeof p[k] === 'string') return p[k] as string;
  return null;
}

function itemLabel(type: string, payload: unknown): string {
  if (type === 'SuggestionProposed' && payload && typeof payload === 'object') {
    const kind = (payload as { suggestion?: { kind?: string } }).suggestion?.kind;
    if (kind === 'word-choice') return 'Word choice';
    if (kind === 'insertion') return 'Add a sentence';
    if (kind === 'rephrase') return 'Rephrase';
  }
  return TYPE_LABEL[type] ?? type;
}

/** Folds progress events into per-session views. Pure; returns a new record when anything changed. */
export function reduceProgress(
  prev: Readonly<Record<string, SessionProgress>>,
  event: ReviewProgressEvent,
  fallbackSessionId: string | null = null,
): Record<string, SessionProgress> {
  const sessionOf = (): string | null => {
    switch (event.kind) {
      case 'started':
      case 'finished':
        return event.feedbackSessionId;
      case 'failed':
        return event.feedbackSessionId ?? fallbackSessionId;
      case 'model':
        return event.feedbackSessionId ?? fallbackSessionId;
      case 'annotation': {
        const fromPayload = (event.draft.payload as { feedbackSessionId?: unknown } | null)
          ?.feedbackSessionId;
        if (typeof fromPayload === 'string') return fromPayload;
        return event.draft.sessionId ?? fallbackSessionId;
      }
    }
  };
  const id = sessionOf();
  if (!id) return prev as Record<string, SessionProgress>;
  const cur: SessionProgress = prev[id] ?? {
    feedbackSessionId: id,
    model: null,
    activity: null,
    arrived: [],
    state: 'running',
    failureReason: null,
  };
  let next: SessionProgress = cur;
  switch (event.kind) {
    case 'started':
      next = { ...cur, model: event.model, activity: 'Reading the document', state: 'running' };
      break;
    case 'model': {
      const e = event.event;
      if (e.type === 'tool-call' && typeof e.name === 'string') {
        const a = toolActivity(e.name);
        if (a && a !== cur.activity) next = { ...cur, activity: a };
      } else if (e.type === 'thinking' && cur.activity === null) {
        next = { ...cur, activity: 'Thinking' };
      }
      break;
    }
    case 'annotation': {
      const { type, payload } = event.draft;
      if (cur.arrived.some((a) => a.seq === event.seq)) break;
      const item: ArrivedItem = {
        seq: event.seq,
        type,
        id: payloadId(payload),
        label: itemLabel(type, payload),
      };
      next = { ...cur, arrived: [...cur.arrived, item].sort((x, y) => x.seq - y.seq) };
      if (type === 'ReviewFinished' || type === 'DiscussAnswered')
        next = { ...next, state: 'finished', activity: null };
      break;
    }
    case 'finished':
      next = { ...cur, state: 'finished', activity: null };
      break;
    case 'failed':
      next = { ...cur, state: 'failed', activity: null, failureReason: event.reason };
      break;
  }
  if (next === cur && prev[id]) return prev as Record<string, SessionProgress>;
  return { ...prev, [id]: next };
}
