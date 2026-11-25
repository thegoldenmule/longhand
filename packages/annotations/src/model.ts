/**
 * The annotation view model: plain functions from a folded `ProjectState` to the
 * cards, review sessions and discuss threads the UI draws. Nothing here talks to
 * the editor or the DOM, so it is easy to test against the golden fixtures.
 *
 * Every range a card carries is in its document's **current ledger version**
 * (`ProjectState.documents[id].version`), exactly as the fold reports it. The
 * controller maps those positions onto the editor's local document.
 */
import {
  LENS_LABELS,
  docFromJSON,
  inlineTextBetween,
  type AgentSessionState,
  type CitationFlagState,
  type CommentState,
  type DiscussThreadState,
  type DismissReason,
  type Dismissal,
  type FeedbackRequestState,
  type PMNode,
  type PMNodeJSON,
  type ProjectState,
  type ProposalState,
  type QuestionState,
  type SourceSuggestionState,
  type SuggestionState,
  type SurfacedSourceState,
  type Target,
} from '@longhand/schema';

/** What a card is. */
export type CardKind =
  | 'comment'
  | 'question'
  | 'suggestion'
  | 'proposal'
  | 'citation-flag'
  | 'surfaced-source'
  | 'source-suggestion';

/** How cards are grouped in the feedback panel. */
export type CardGroup = 'comments' | 'questions' | 'suggestions' | 'proposals' | 'research';

/** All groups, in display order. */
export const CARD_GROUPS: readonly CardGroup[] = [
  'suggestions',
  'proposals',
  'comments',
  'questions',
  'research',
];

/** Group labels. */
export const CARD_GROUP_LABELS: Readonly<Record<CardGroup, string>> = {
  comments: 'Comments',
  questions: 'Questions',
  suggestions: 'Suggestions',
  proposals: 'Proposals',
  research: 'Research',
};

/**
 * Where a card is in its life:
 * - `open`: waiting for the writer;
 * - `stale`: the text under it changed (or was deleted), so it no longer applies;
 * - `resolved`: adopted, adapted, accepted, rejected, dismissed or cited.
 */
export type CardPhase = 'open' | 'stale' | 'resolved';

/** Labels for dismissal reasons. */
export const DISMISS_REASON_LABELS: Readonly<Record<DismissReason, string>> = {
  'not-my-voice': 'Not my voice',
  wrong: 'Wrong',
  later: 'Later',
};

/** The label the UI uses for every AI research card. */
export const AI_SURFACED_LABEL = 'AI-surfaced — unverified';

interface CardCommon {
  id: string;
  group: CardGroup;
  seq: number;
  feedbackSessionId: string;
  createdAt: string;
  /** The document the card points into, or null (unanchored questions and searches). */
  documentId: string | null;
  /** Current range of the text the card is about, or null. For points, `from === to`. */
  range: { from: number; to: number } | null;
  /** Position the margin card lines up with, or null when it has nowhere to sit. */
  anchorPos: number | null;
  /** Raw status from the fold. */
  status: string;
  phase: CardPhase;
  /** Short outcome label for resolved and stale cards ("Adopted · retyped"). */
  outcome: string | null;
  /** The text the card is about: the anchor quote, or a snippet of the span. */
  quote: string | null;
  /** True for the research cards that carry the AI-surfaced label. */
  aiSurfaced: boolean;
}

/** A card, with the folded annotation it shows. */
export type Card =
  | (CardCommon & { kind: 'comment'; data: CommentState })
  | (CardCommon & { kind: 'question'; data: QuestionState })
  | (CardCommon & { kind: 'suggestion'; data: SuggestionState })
  | (CardCommon & { kind: 'proposal'; data: ProposalState })
  | (CardCommon & { kind: 'citation-flag'; data: CitationFlagState })
  | (CardCommon & { kind: 'surfaced-source'; data: SurfacedSourceState })
  | (CardCommon & { kind: 'source-suggestion'; data: SourceSuggestionState });

/** A card of one kind. */
export type CardOf<K extends CardKind> = Extract<Card, { kind: K }>;

const docCache = new WeakMap<object, PMNode>();

/** The ProseMirror node of a folded document (cached per content object). */
export function documentNodeOf(state: ProjectState, documentId: string): PMNode | null {
  const d = state.documents[documentId];
  if (!d) return null;
  const key = d.content as unknown as object;
  let node = docCache.get(key);
  if (!node) {
    try {
      node = docFromJSON(d.content as PMNodeJSON);
    } catch {
      return null;
    }
    docCache.set(key, node);
  }
  return node;
}

/** The text between two positions of a folded document, shortened to `max` characters. */
export function snippet(
  state: ProjectState,
  documentId: string,
  from: number,
  to: number,
  max = 140,
): string | null {
  const doc = documentNodeOf(state, documentId);
  if (!doc) return null;
  const size = doc.content.size;
  const f = Math.max(0, Math.min(from, size));
  const t = Math.max(f, Math.min(to, size));
  let text: string;
  try {
    text = inlineTextBetween(doc, f, t, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function targetQuote(
  state: ProjectState,
  target: Target,
  range: { from: number; to: number } | null,
) {
  if (target.kind === 'anchor') return target.anchor.quote;
  if (range) return snippet(state, target.span.documentId, range.from, range.to);
  return null;
}

function targetDoc(target: Target): string {
  return target.kind === 'anchor' ? target.anchor.documentId : target.span.documentId;
}

function dismissedLabel(d: Dismissal | null): string {
  return d?.reason ? `Dismissed · ${DISMISS_REASON_LABELS[d.reason].toLowerCase()}` : 'Dismissed';
}

function plainRange(r: { from: number; to: number } | null): { from: number; to: number } | null {
  return r ? { from: r.from, to: r.to } : null;
}

function cardStatus(
  status: 'open' | 'dismissed' | 'cited',
  range: unknown,
  dismissal: Dismissal | null,
): { phase: CardPhase; outcome: string | null } {
  if (status === 'dismissed') return { phase: 'resolved', outcome: dismissedLabel(dismissal) };
  if (status === 'cited') return { phase: 'resolved', outcome: 'Cited' };
  if (range === null) return { phase: 'stale', outcome: 'Text removed' };
  return { phase: 'open', outcome: null };
}

/** Outcome label for a suggestion. */
export function suggestionOutcome(s: SuggestionState): string | null {
  switch (s.status) {
    case 'open':
      return null;
    case 'adopted':
      return 'Adopted · retyped';
    case 'adapted':
      return 'Adapted';
    case 'stale':
      return 'Stale · the text changed';
    case 'dismissed':
      return dismissedLabel(s.dismissal);
  }
}

/** Outcome label for a proposal. */
export function proposalOutcome(p: ProposalState): string | null {
  switch (p.status) {
    case 'open':
      return null;
    case 'accepted':
      return 'Accepted';
    case 'rejected':
      return p.rejectReason
        ? `Rejected · ${DISMISS_REASON_LABELS[p.rejectReason].toLowerCase()}`
        : 'Rejected';
    case 'stale':
      return 'Stale · the text changed';
  }
}

/** Current positions a proposal's preview draws at, or null once resolved or stale. */
export function proposalRange(p: ProposalState): { from: number; to: number } | null {
  switch (p.kind) {
    case 'move':
      return p.source ? { from: p.source.from, to: p.source.to } : null;
    case 'cut':
      return plainRange(p.range);
    case 'split':
      return p.pos === null ? null : { from: p.pos, to: p.pos };
    case 'merge':
      return plainRange(p.range);
  }
}

/** Short description of a proposal ("Move this sentence"). */
export function proposalTitle(p: ProposalState): string {
  switch (p.kind) {
    case 'move': {
      const unit = p.span.unit;
      const n = p.span.ids.length;
      const what = n > 1 ? `${unit}s` : unit;
      return `Move ${n > 1 ? 'these' : 'this'} ${what} ${p.destination.position} ${p.destination.id}`;
    }
    case 'cut':
      return p.target.kind === 'span' && p.target.span.ids.length > 0
        ? `Cut ${p.target.span.ids.length > 1 ? 'these' : 'this'} ${p.target.span.unit}${p.target.span.ids.length > 1 ? 's' : ''}`
        : 'Cut these words';
    case 'split':
      return `Split the paragraph before ${p.sentenceId}`;
    case 'merge':
      return `Merge ${p.firstParagraphId} with ${p.secondParagraphId}`;
  }
}

/** Short heading for a suggestion. */
export function suggestionTitle(s: SuggestionState): string {
  switch (s.kind) {
    case 'word-choice':
      return 'Word choice';
    case 'insertion':
      return 'Add a sentence';
    case 'rephrase':
      return 'Rephrase';
  }
}

/** Label of a comment category. */
export function lensLabel(lens: keyof typeof LENS_LABELS): string {
  return LENS_LABELS[lens];
}

function commentCard(state: ProjectState, c: CommentState): Card {
  const range = plainRange(c.range);
  const s = cardStatus(c.status, c.range, c.dismissal);
  return {
    kind: 'comment',
    data: c,
    id: c.id,
    group: 'comments',
    seq: c.seq,
    feedbackSessionId: c.feedbackSessionId,
    createdAt: c.createdAt,
    documentId: targetDoc(c.target),
    range,
    anchorPos: range?.from ?? null,
    status: c.status,
    ...s,
    quote: targetQuote(state, c.target, range),
    aiSurfaced: false,
  };
}

function questionCard(state: ProjectState, q: QuestionState): Card {
  const range = plainRange(q.range);
  const anchored = q.target !== null;
  const s = anchored
    ? cardStatus(q.status, q.range, q.dismissal)
    : cardStatus(q.status, true, q.dismissal);
  return {
    kind: 'question',
    data: q,
    id: q.id,
    group: 'questions',
    seq: q.seq,
    feedbackSessionId: q.feedbackSessionId,
    createdAt: q.createdAt,
    documentId: q.target ? targetDoc(q.target) : null,
    range,
    anchorPos: range?.from ?? null,
    status: q.status,
    ...s,
    quote: q.target ? targetQuote(state, q.target, range) : null,
    aiSurfaced: false,
  };
}

function suggestionCard(_state: ProjectState, s: SuggestionState): Card {
  const range = plainRange(s.range);
  let phase: CardPhase;
  if (s.status === 'open') phase = range ? 'open' : 'stale';
  else if (s.status === 'stale') phase = 'stale';
  else phase = 'resolved';
  const outcome = s.status === 'open' && !range ? 'Text removed' : suggestionOutcome(s);
  return {
    kind: 'suggestion',
    data: s,
    id: s.id,
    group: 'suggestions',
    seq: s.seq,
    feedbackSessionId: s.feedbackSessionId,
    createdAt: s.createdAt,
    documentId: s.kind === 'insertion' ? s.documentId : s.anchor.documentId,
    range,
    anchorPos: range?.from ?? null,
    status: s.status,
    phase,
    outcome,
    quote: s.kind === 'insertion' ? null : s.anchor.quote,
    aiSurfaced: false,
  };
}

function proposalCard(state: ProjectState, p: ProposalState): Card {
  const range = proposalRange(p);
  let phase: CardPhase;
  if (p.status === 'open') phase = range ? 'open' : 'stale';
  else if (p.status === 'stale') phase = 'stale';
  else phase = 'resolved';
  let quote: string | null = null;
  if (p.kind === 'cut' && p.target.kind === 'anchor') quote = p.target.anchor.quote;
  else if (range && range.to > range.from)
    quote = snippet(state, p.documentId, range.from, range.to);
  let anchorPos = range?.from ?? null;
  if (p.kind === 'merge' && p.joinPos !== null) anchorPos = range?.from ?? p.joinPos;
  return {
    kind: 'proposal',
    data: p,
    id: p.id,
    group: 'proposals',
    seq: p.seq,
    feedbackSessionId: p.feedbackSessionId,
    createdAt: p.createdAt,
    documentId: p.documentId,
    range,
    anchorPos,
    status: p.status,
    phase,
    outcome: p.status === 'open' && !range ? 'Text removed' : proposalOutcome(p),
    quote,
    aiSurfaced: false,
  };
}

function flagCard(state: ProjectState, f: CitationFlagState): Card {
  const range = plainRange(f.range);
  return {
    kind: 'citation-flag',
    data: f,
    id: f.id,
    group: 'research',
    seq: f.seq,
    feedbackSessionId: f.feedbackSessionId,
    createdAt: f.createdAt,
    documentId: targetDoc(f.target),
    range,
    anchorPos: range?.from ?? null,
    status: f.status,
    ...cardStatus(f.status, f.range, f.dismissal),
    quote: targetQuote(state, f.target, range),
    aiSurfaced: true,
  };
}

function surfacedCard(state: ProjectState, s: SurfacedSourceState): Card {
  const range = plainRange(s.range);
  const s2 = s.target
    ? cardStatus(s.status, s.range, s.dismissal)
    : cardStatus(s.status, true, s.dismissal);
  return {
    kind: 'surfaced-source',
    data: s,
    id: s.id,
    group: 'research',
    seq: s.seq,
    feedbackSessionId: s.feedbackSessionId,
    createdAt: s.createdAt,
    documentId: s.target ? targetDoc(s.target) : null,
    range,
    anchorPos: range?.from ?? null,
    status: s.status,
    ...s2,
    quote: s.target ? targetQuote(state, s.target, range) : null,
    aiSurfaced: true,
  };
}

function sourceSuggestionCard(state: ProjectState, s: SourceSuggestionState): Card {
  const range = plainRange(s.range);
  return {
    kind: 'source-suggestion',
    data: s,
    id: s.id,
    group: 'research',
    seq: s.seq,
    feedbackSessionId: s.feedbackSessionId,
    createdAt: s.createdAt,
    documentId: targetDoc(s.target),
    range,
    anchorPos: range?.from ?? null,
    status: s.status,
    ...cardStatus(s.status, s.range, s.dismissal),
    quote: targetQuote(state, s.target, range),
    aiSurfaced: true,
  };
}

/** Options for {@link cardsFromState}. */
export interface CardsOptions {
  /** Only cards for this document, plus unanchored ones (questions and searches). */
  documentId?: string | null;
}

/**
 * Every card in the annotation layer, in document order (by anchor position, then
 * seq). Unanchored cards come last.
 */
export function cardsFromState(state: ProjectState | null, opts: CardsOptions = {}): Card[] {
  if (!state) return [];
  const a = state.annotations;
  const out: Card[] = [];
  for (const c of Object.values(a.comments)) out.push(commentCard(state, c));
  for (const q of Object.values(a.questions)) out.push(questionCard(state, q));
  for (const s of Object.values(a.suggestions)) out.push(suggestionCard(state, s));
  for (const p of Object.values(a.proposals)) out.push(proposalCard(state, p));
  for (const f of Object.values(a.citationFlags)) out.push(flagCard(state, f));
  for (const s of Object.values(a.surfacedSources)) out.push(surfacedCard(state, s));
  for (const s of Object.values(a.sourceSuggestions)) out.push(sourceSuggestionCard(state, s));
  const doc = opts.documentId;
  const kept = doc ? out.filter((c) => c.documentId === doc || c.documentId === null) : out;
  return kept.sort(compareCards);
}

function compareCards(x: Card, y: Card): number {
  if (x.documentId !== y.documentId) {
    if (x.documentId === null) return 1;
    if (y.documentId === null) return -1;
    return x.documentId < y.documentId ? -1 : 1;
  }
  const px = x.anchorPos ?? Number.MAX_SAFE_INTEGER;
  const py = y.anchorPos ?? Number.MAX_SAFE_INTEGER;
  return px - py || x.seq - y.seq;
}

/** Card filters for the feedback panel. */
export interface CardFilter {
  /** Groups to show (all when empty or missing). */
  groups?: readonly CardGroup[];
  /** Phases to show. Default: open and stale. */
  phase?: 'open' | 'resolved' | 'all';
  /** Only cards from one review session. */
  feedbackSessionId?: string | null;
}

/** Applies a {@link CardFilter}. */
export function filterCards(cards: readonly Card[], filter: CardFilter = {}): Card[] {
  const phase = filter.phase ?? 'open';
  return cards.filter((c) => {
    if (filter.groups && filter.groups.length > 0 && !filter.groups.includes(c.group)) return false;
    if (filter.feedbackSessionId && c.feedbackSessionId !== filter.feedbackSessionId) return false;
    if (phase === 'open') return c.phase !== 'resolved';
    if (phase === 'resolved') return c.phase === 'resolved';
    return true;
  });
}

/** Cards grouped by {@link CardGroup}, in {@link CARD_GROUPS} order, omitting empty groups. */
export function groupCards(cards: readonly Card[]): Array<{ group: CardGroup; cards: Card[] }> {
  return CARD_GROUPS.map((group) => ({
    group,
    cards: cards.filter((c) => c.group === group),
  })).filter((g) => g.cards.length > 0);
}

/** A review session as the panel shows it: the writer's request and the session serving it. */
export interface ReviewView {
  requestId: string;
  request: FeedbackRequestState;
  session: AgentSessionState | null;
  /**
   * `waiting` (requested, no session yet), `reviewing`, `finished` or `failed`.
   */
  phase: 'waiting' | 'reviewing' | 'finished' | 'failed';
  failureReason: string | null;
  /** Annotation ids the session has produced so far, in seq order. */
  annotationIds: string[];
}

/** Review sessions, newest first. */
export function reviewsFromState(state: ProjectState | null): ReviewView[] {
  if (!state) return [];
  const a = state.annotations;
  const sessions = Object.values(a.agentSessions);
  return Object.values(a.feedbackRequests)
    .sort((x, y) => y.seq - x.seq)
    .map((request) => {
      const session =
        (request.feedbackSessionId ? a.agentSessions[request.feedbackSessionId] : undefined) ??
        sessions.find((s) => s.requestId === request.id) ??
        null;
      let phase: ReviewView['phase'];
      if (request.status === 'failed' || session?.status === 'failed') phase = 'failed';
      else if (request.status === 'finished' || session?.status === 'finished') phase = 'finished';
      else if (session) phase = 'reviewing';
      else phase = 'waiting';
      return {
        requestId: request.id,
        request,
        session,
        phase,
        failureReason:
          session?.failureReason ?? (phase === 'failed' ? 'The review did not finish.' : null),
        annotationIds: session?.annotationIds ?? [],
      };
    });
}

/** The discuss thread on an annotation, if any. */
export function threadFor(state: ProjectState | null, targetId: string): DiscussThreadState | null {
  if (!state) return null;
  let best: DiscussThreadState | null = null;
  for (const t of Object.values(state.annotations.discussions)) {
    if (t.targetId !== targetId) continue;
    if (!best || (t.messages[0]?.seq ?? 0) > (best.messages[0]?.seq ?? 0)) best = t;
  }
  return best;
}

/** The discuss session that most recently failed on a thread, with its reason. */
export function threadFailure(state: ProjectState | null, threadId: string): string | null {
  if (!state) return null;
  let last: AgentSessionState | null = null;
  for (const s of Object.values(state.annotations.agentSessions))
    if (s.threadId === threadId && (!last || s.startedSeq > last.startedSeq)) last = s;
  return last?.status === 'failed' ? (last.failureReason ?? 'The editor could not answer.') : null;
}

/** True if the annotation layer holds anything at all (the AI speaks only when asked). */
export function hasAnyAnnotations(state: ProjectState | null): boolean {
  if (!state) return false;
  const a = state.annotations;
  return (
    Object.keys(a.feedbackRequests).length > 0 ||
    Object.keys(a.comments).length > 0 ||
    Object.keys(a.questions).length > 0 ||
    Object.keys(a.suggestions).length > 0 ||
    Object.keys(a.proposals).length > 0 ||
    Object.keys(a.citationFlags).length > 0 ||
    Object.keys(a.surfacedSources).length > 0 ||
    Object.keys(a.sourceSuggestions).length > 0
  );
}

/** Card kinds that are dismissed with `SuggestionDismissed` (everything but proposals). */
export function isDismissible(card: Card): boolean {
  return card.kind !== 'proposal';
}

/** Short label for an annotation kind (for lists and the live review stream). */
export function cardKindLabel(card: Card): string {
  switch (card.kind) {
    case 'comment':
      return 'Comment';
    case 'question':
      return 'Question';
    case 'suggestion':
      return suggestionTitle(card.data);
    case 'proposal':
      return `${card.data.kind[0]!.toUpperCase()}${card.data.kind.slice(1)} proposal`;
    case 'citation-flag':
      return 'Citation needed';
    case 'surfaced-source':
      return 'Possible sources';
    case 'source-suggestion':
      return 'Source from your library';
  }
}

/** Scope label for a feedback request. */
export function scopeLabel(state: ProjectState | null, req: FeedbackRequestState): string {
  const s = req.scope;
  if (s.kind === 'project') return 'Whole project';
  const title = state?.documents[s.documentId]?.title ?? s.documentId;
  if (s.kind === 'document') return title;
  return `Selection in ${title}`;
}
