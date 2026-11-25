/**
 * Folding the annotation layer: agent events (which never touch documents), the
 * writer's responses to them (dismiss, reject, feedback and discuss requests) and
 * the system events.
 *
 * Positions in agent events are resolved by the ledger service at `readVersion` and
 * mapped to `version` (the document version at append). The fold checks them:
 * - `version` must not be ahead of the document; when it is behind, the fold maps
 *   the positions forward itself.
 * - When nothing changed since the agent read (`readVersion === version`) the
 *   positions must equal what the `@longhand/schema` resolvers give for the ids
 *   and quote; otherwise the event is rejected (`target-mismatch`).
 * - A suggestion or proposal whose text was edited between `readVersion` and
 *   `version` (any step touching it, or an anchor quote that no longer matches) is
 *   **stale on arrival**.
 */
import {
  capViolation,
  EMPTY_SESSION_COUNTS,
  countCall,
  inlineTextBetween,
  resolveAnchor,
  resolveInsertionPoint,
  resolveMerge,
  resolveMove,
  resolveSpan,
  resolveSplit,
  segmentDoc,
  TOOLS,
  type AgentSessionState,
  type Anchor,
  type CommitOf,
  type Commit,
  type MatchedKind,
  type ProposalState,
  type ResolvedAnchor,
  type SpanRef,
  type SuggestionState,
  type Target,
  type ToolName,
} from '@longhand/schema';
import { isCited } from './doccommit';
import { blockAt } from './doctext';
import { mapsBetween, touchedBetween } from './engine';
import { documentNgrams, ngramsOf } from './matcher';
import { pvecGet, pvecPush } from './pvec';
import type { Span, TrackedGroup, Tracker, Tx } from './state';

const DISMISSABLE: readonly TrackedGroup[] = [
  'suggestions',
  'comments',
  'questions',
  'citationFlags',
  'surfacedSources',
  'sourceSuggestions',
];
const ALL_GROUPS: readonly TrackedGroup[] = [...DISMISSABLE, 'proposals'];

/** The annotation group holding `id`, if any. */
export function groupOf(tx: Tx, id: string): TrackedGroup | null {
  for (const g of ALL_GROUPS) if (tx.s.ann[g][id]) return g;
  return null;
}

function idTaken(tx: Tx, id: string): boolean {
  if (groupOf(tx, id) !== null) {
    tx.issue('duplicate-id', `annotation id ${id} already exists`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessionFor(
  tx: Tx,
  c: Commit,
  feedbackSessionId: string,
  tool: ToolName,
): AgentSessionState | null {
  const s = tx.s.ann.agentSessions[feedbackSessionId];
  if (!s) {
    tx.issue('unknown-session', `no feedback session ${feedbackSessionId}`);
    return null;
  }
  if (s.status !== 'running') {
    tx.issue('session-not-running', `feedback session ${feedbackSessionId} is ${s.status}`);
    return null;
  }
  if (c.sessionId !== feedbackSessionId) {
    tx.issue(
      'session-mismatch',
      `envelope sessionId ${c.sessionId} is not feedback session ${feedbackSessionId}`,
    );
    return null;
  }
  if (!(TOOLS[tool].sessions as readonly string[]).includes(s.kind)) {
    tx.issue('session-kind', `${tool} is not available in a ${s.kind} session`);
    return null;
  }
  if (s.kind === 'review' && s.requestId) {
    const req = tx.s.ann.feedbackRequests[s.requestId];
    if (req) {
      const v = capViolation(tool, s.counts, req.intensity);
      if (v) {
        tx.issue('cap-exceeded', v);
        return null;
      }
    }
  }
  return s;
}

function countInSession(
  tx: Tx,
  s: AgentSessionState,
  tool: ToolName,
  annotationId: string | null,
): void {
  tx.ann('agentSessions')[s.id] = {
    ...s,
    counts: countCall(tool, s.counts),
    annotationIds: annotationId ? [...s.annotationIds, annotationId] : s.annotationIds,
  };
}

/** Registers AI-visible text for the four-word matcher (minus 4-grams already in the project). */
function addAiText(
  tx: Tx,
  id: string,
  kind: MatchedKind,
  texts: ReadonlyArray<string | undefined | null>,
): void {
  const grams = new Set<string>();
  for (const t of texts) if (t) for (const g of ngramsOf(t)) grams.add(g);
  if (grams.size === 0) return;
  for (const d of Object.values(tx.s.docs)) {
    const existing = documentNgrams(d.node);
    for (const g of [...grams]) if (existing.has(g)) grams.delete(g);
    if (grams.size === 0) return;
  }
  tx.s.aiTexts = pvecPush(tx.s.aiTexts, { id, kind, seq: tx.seq, ngrams: grams });
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

interface Placed {
  /** Range (or point) in the current version. */
  range: Span | null;
  /** Edited between readVersion and version. */
  staleOnArrival: boolean;
}

interface Stamp {
  from: number;
  to: number;
  readVersion: number;
  version: number;
}

/**
 * Checks and maps an agent position stamp to the current document version.
 * `exact` (called only when `readVersion === version`) returns true if the
 * positions equal what the resolvers give. Returns null (after recording an issue)
 * when the stamp is invalid.
 */
function place(
  tx: Tx,
  documentId: string,
  stamp: Stamp,
  opts: {
    point?: boolean;
    assoc?: 1 | -1;
    quote?: string;
    exact?: (doc: Tx['s']['docs'][string]['node']) => boolean;
  },
): Placed | null {
  const d = tx.s.docs[documentId];
  if (!d) {
    tx.issue('unknown-document', `no document ${documentId}`);
    return null;
  }
  if (stamp.version > d.version || stamp.readVersion > stamp.version) {
    tx.issue(
      'invalid-version',
      `versions ${stamp.readVersion}→${stamp.version} but document ${documentId} is at ${d.version}`,
    );
    return null;
  }
  if (stamp.from > stamp.to || (opts.point && stamp.from !== stamp.to)) {
    tx.issue('invalid-position', `invalid range ${stamp.from}-${stamp.to}`);
    return null;
  }
  const forward = mapsBetween(d.maps, stamp.version, d.version);
  const back = mapsBetween(d.maps, stamp.readVersion, stamp.version);
  if (!forward || !back) {
    tx.issue(
      'invalid-version',
      `step history does not cover versions ${stamp.readVersion}→${d.version}`,
    );
    return null;
  }
  if (stamp.version === d.version && stamp.to > d.node.content.size) {
    tx.issue(
      'invalid-position',
      `range ${stamp.from}-${stamp.to} is outside document ${documentId}`,
    );
    return null;
  }
  if (
    stamp.readVersion === stamp.version &&
    stamp.version === d.version &&
    opts.exact &&
    !opts.exact(d.node)
  ) {
    tx.issue('target-mismatch', `positions do not match the target at version ${stamp.version}`);
    return null;
  }
  let stale = touchedBetween(back, stamp.from, stamp.to);
  let from = stamp.from;
  let to = stamp.to;
  let dead = false;
  for (const m of forward) {
    if (opts.point) {
      const r = m.mapResult(from, opts.assoc ?? 1);
      if (r.deletedAcross) dead = true;
      from = to = r.pos;
    } else {
      from = m.map(from, 1);
      to = m.map(to, -1);
      if (to <= from) dead = true;
    }
  }
  if (forward.length > 0 && touchedBetween(forward, from, to)) stale = true;
  if (opts.quote !== undefined && !dead && inlineTextBetween(d.node, from, to) !== opts.quote)
    stale = true;
  if (!opts.point && to <= from) dead = true;
  return { range: dead ? null : { from, to }, staleOnArrival: stale || dead };
}

function sameRange(r: { ok: boolean; from?: number; to?: number }, s: Stamp): boolean {
  return r.ok && r.from === s.from && r.to === s.to;
}

function placeAnchor(tx: Tx, t: ResolvedAnchor): Placed | null {
  return place(tx, t.anchor.documentId, t, {
    quote: t.anchor.quote,
    exact: (doc) =>
      sameRange(resolveAnchor(doc, t.anchor) as { ok: boolean; from?: number; to?: number }, t),
  });
}

function placeSpan(tx: Tx, t: { span: SpanRef } & Stamp): Placed | null {
  return place(tx, t.span.documentId, t, {
    exact: (doc) =>
      sameRange(resolveSpan(doc, t.span) as { ok: boolean; from?: number; to?: number }, t),
  });
}

function placeTarget(tx: Tx, t: Target): Placed | null {
  return t.kind === 'anchor' ? placeAnchor(tx, t) : placeSpan(tx, t);
}

function targetDoc(t: Target | ResolvedAnchor): string {
  return 'anchor' in t ? t.anchor.documentId : t.span.documentId;
}

function anchorTarget(t: ResolvedAnchor): Target {
  return {
    kind: 'anchor',
    anchor: t.anchor,
    from: t.from,
    to: t.to,
    readVersion: t.readVersion,
    version: t.version,
  };
}

function newTracker(
  id: string,
  docId: string,
  group: TrackedGroup,
  range: Span | null,
  extra: Partial<Tracker> = {},
): Tracker {
  return {
    id,
    docId,
    group,
    range,
    isPoint: false,
    nodeRange: false,
    rangeAssoc: 1,
    point: null,
    pointAssoc: 1,
    region: null,
    ref: null,
    watch: false,
    ...extra,
  };
}

function current(
  docId: string,
  r: Span | null,
): { documentId: string; from: number; to: number } | null {
  return r ? { documentId: docId, from: r.from, to: r.to } : null;
}

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

/** Folds `FeedbackSessionStarted`. */
export function foldSessionStarted(tx: Tx, c: CommitOf<'FeedbackSessionStarted'>): void {
  const p = c.payload;
  if (tx.s.ann.agentSessions[p.feedbackSessionId]) {
    tx.issue('duplicate-id', `feedback session ${p.feedbackSessionId} already exists`);
    return;
  }
  if (c.sessionId !== p.feedbackSessionId) {
    tx.issue(
      'session-mismatch',
      `envelope sessionId ${c.sessionId} is not feedback session ${p.feedbackSessionId}`,
    );
    return;
  }
  let requestId: string | null = null;
  let threadId: string | null = null;
  if (p.trigger.kind === 'feedback') {
    const req = tx.s.ann.feedbackRequests[p.trigger.requestId];
    if (!req) {
      tx.issue('unknown-request', `no feedback request ${p.trigger.requestId}`);
      return;
    }
    if (req.status !== 'pending') {
      tx.issue('not-open', `feedback request ${req.id} is ${req.status}`);
      return;
    }
    tx.ann('feedbackRequests')[req.id] = {
      ...req,
      status: 'running',
      feedbackSessionId: p.feedbackSessionId,
    };
    requestId = req.id;
  } else {
    const thr = tx.s.ann.discussions[p.trigger.threadId];
    if (!thr) {
      tx.issue('unknown-thread', `no discuss thread ${p.trigger.threadId}`);
      return;
    }
    if (thr.status !== 'awaiting-editor') {
      tx.issue('not-open', `discuss thread ${thr.id} is ${thr.status}`);
      return;
    }
    threadId = thr.id;
  }
  tx.ann('agentSessions')[p.feedbackSessionId] = {
    id: p.feedbackSessionId,
    kind: p.trigger.kind === 'feedback' ? 'review' : 'discuss',
    requestId,
    threadId,
    model: p.model,
    systemPromptVersion: p.systemPromptVersion ?? null,
    startedSeq: c.seq,
    startedAt: c.serverTime,
    endedSeq: null,
    status: 'running',
    failureReason: null,
    review: null,
    counts: { ...EMPTY_SESSION_COUNTS },
    annotationIds: [],
  };
}

/** Folds `CommentAdded`. */
export function foldCommentAdded(tx: Tx, c: CommitOf<'CommentAdded'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'comment');
  if (!s || idTaken(tx, p.commentId)) return;
  const placed = placeTarget(tx, p.target);
  if (!placed) return;
  const docId = targetDoc(p.target);
  tx.addTracker(
    newTracker(p.commentId, docId, 'comments', placed.range, {
      nodeRange: p.target.kind === 'span' && p.target.span.unit !== 'sentence',
    }),
  );
  tx.ann('comments')[p.commentId] = {
    id: p.commentId,
    feedbackSessionId: p.feedbackSessionId,
    seq: c.seq,
    createdAt: c.serverTime,
    target: p.target,
    range: current(docId, placed.range),
    category: p.category,
    severity: p.severity,
    body: p.body,
    status: 'open',
    dismissal: null,
  };
  countInSession(tx, s, 'comment', p.commentId);
  addAiText(tx, p.commentId, 'comment', [p.body]);
}

/** Folds `QuestionAsked`. */
export function foldQuestionAsked(tx: Tx, c: CommitOf<'QuestionAsked'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'ask_question');
  if (!s || idTaken(tx, p.questionId)) return;
  let range: Span | null = null;
  if (p.target) {
    const placed = placeTarget(tx, p.target);
    if (!placed) return;
    range = placed.range;
    tx.addTracker(newTracker(p.questionId, targetDoc(p.target), 'questions', range));
  }
  tx.ann('questions')[p.questionId] = {
    id: p.questionId,
    feedbackSessionId: p.feedbackSessionId,
    seq: c.seq,
    createdAt: c.serverTime,
    target: p.target,
    range: p.target ? current(targetDoc(p.target), range) : null,
    question: p.question,
    status: 'open',
    dismissal: null,
  };
  countInSession(tx, s, 'ask_question', p.questionId);
  addAiText(tx, p.questionId, 'question', [p.question]);
}

/** Folds `SuggestionProposed`. */
export function foldSuggestionProposed(tx: Tx, c: CommitOf<'SuggestionProposed'>): void {
  const p = c.payload;
  const sg = p.suggestion;
  const tool: ToolName =
    sg.kind === 'word-choice'
      ? 'suggest_word_choice'
      : sg.kind === 'insertion'
        ? 'suggest_insertion'
        : 'suggest_rephrase';
  const s = sessionFor(tx, c, p.feedbackSessionId, tool);
  if (!s || idTaken(tx, p.suggestionId)) return;
  const common = {
    id: p.suggestionId,
    feedbackSessionId: p.feedbackSessionId,
    seq: c.seq,
    createdAt: c.serverTime,
    dismissal: null,
  };
  let record: SuggestionState;
  let tracker: Tracker;
  if (sg.kind === 'insertion') {
    const t = sg.target;
    const assoc: 1 | -1 = t.position === 'before' ? 1 : -1;
    const placed = place(
      tx,
      t.documentId,
      { from: t.pos, to: t.pos, readVersion: t.readVersion, version: t.version },
      {
        point: true,
        assoc,
        exact: (doc) => {
          const r = resolveInsertionPoint(doc, t.position, t.sentenceId);
          return r.ok && r.pos === t.pos;
        },
      },
    );
    if (!placed) return;
    let ref: Span | null = null;
    let stale = placed.staleOnArrival || placed.range === null;
    if (placed.range) {
      const pos = placed.range.from;
      const d = tx.s.docs[t.documentId]!;
      const sent = segmentDoc(d.node).sentences.find((x) =>
        t.position === 'before' ? x.from === pos : x.to === pos,
      );
      if (sent) ref = { from: sent.from, to: sent.to };
      else stale = true;
    }
    tracker = newTracker(p.suggestionId, t.documentId, 'suggestions', placed.range, {
      isPoint: true,
      rangeAssoc: assoc,
      region: stale ? null : { touched: false, original: '' },
      ref: stale ? null : ref,
      watch: !stale,
    });
    record = {
      ...common,
      kind: 'insertion',
      documentId: t.documentId,
      position: t.position,
      sentenceId: t.sentenceId,
      sentence: sg.sentence,
      purpose: sg.purpose,
      status: stale ? 'stale' : 'open',
      resolvedSeq: stale ? c.seq : null,
      range: current(t.documentId, placed.range),
    };
  } else {
    const placed = placeAnchor(tx, sg.target);
    if (!placed) return;
    const docId = sg.target.anchor.documentId;
    const stale = placed.staleOnArrival || placed.range === null;
    tracker = newTracker(p.suggestionId, docId, 'suggestions', placed.range, {
      region: stale ? null : { touched: false, original: sg.target.anchor.quote },
      watch: !stale,
    });
    const base = {
      ...common,
      anchor: sg.target.anchor as Anchor,
      status: (stale ? 'stale' : 'open') as 'stale' | 'open',
      resolvedSeq: stale ? c.seq : null,
      range: current(docId, placed.range),
    };
    record =
      sg.kind === 'word-choice'
        ? {
            ...base,
            kind: 'word-choice',
            alternatives: sg.alternatives,
            rationale: sg.rationale,
            adoptedAlternative: null,
          }
        : { ...base, kind: 'rephrase', guidance: sg.guidance };
  }
  tx.addTracker(tracker);
  tx.ann('suggestions')[p.suggestionId] = record;
  countInSession(tx, s, tool, p.suggestionId);
  if (sg.kind === 'word-choice')
    addAiText(tx, p.suggestionId, 'suggestion', [...sg.alternatives, sg.rationale]);
  else if (sg.kind === 'insertion')
    addAiText(tx, p.suggestionId, 'insertion', [sg.sentence, sg.purpose]);
  else addAiText(tx, p.suggestionId, 'suggestion', [sg.guidance]);
}

function proposalCommon(
  c: Commit,
  proposalId: string,
  feedbackSessionId: string,
  documentId: string,
  rationale: string,
  stale: boolean,
) {
  return {
    id: proposalId,
    feedbackSessionId,
    seq: c.seq,
    createdAt: c.serverTime,
    documentId,
    rationale,
    status: (stale ? 'stale' : 'open') as 'stale' | 'open',
    resolvedSeq: stale ? c.seq : null,
    rejectReason: null,
  };
}

/** Folds `MoveProposed`. */
export function foldMoveProposed(tx: Tx, c: CommitOf<'MoveProposed'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'propose_move');
  if (!s || idTaken(tx, p.proposalId)) return;
  const src = p.source;
  const docId = src.span.documentId;
  const placed = place(tx, docId, src, {
    exact: (doc) => {
      const r = resolveMove(doc, src.span, p.destination);
      return r.ok && r.from === src.from && r.to === src.to && r.insertAt === p.destination.pos;
    },
  });
  if (!placed) return;
  const assoc: 1 | -1 = p.destination.position === 'before' ? 1 : -1;
  const dest = place(
    tx,
    docId,
    {
      from: p.destination.pos,
      to: p.destination.pos,
      readVersion: src.readVersion,
      version: src.version,
    },
    { point: true, assoc },
  );
  if (!dest) return;
  const stale = placed.staleOnArrival || dest.staleOnArrival || !placed.range || !dest.range;
  tx.addTracker(
    newTracker(p.proposalId, docId, 'proposals', stale ? null : placed.range, {
      nodeRange: src.span.unit !== 'sentence',
      point: stale || !dest.range ? null : dest.range.from,
      pointAssoc: assoc,
      watch: !stale,
    }),
  );
  tx.ann('proposals')[p.proposalId] = {
    ...proposalCommon(c, p.proposalId, p.feedbackSessionId, docId, p.rationale, stale),
    kind: 'move',
    span: src.span,
    destination: { position: p.destination.position, id: p.destination.id },
    source: stale || !placed.range ? null : { ...placed.range },
    insertAt: stale || !dest.range ? null : dest.range.from,
  };
  countInSession(tx, s, 'propose_move', p.proposalId);
  addAiText(tx, p.proposalId, 'proposal', [p.rationale]);
}

/** Folds `CutProposed`. */
export function foldCutProposed(tx: Tx, c: CommitOf<'CutProposed'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'propose_cut');
  if (!s || idTaken(tx, p.proposalId)) return;
  const placed = placeTarget(tx, p.target);
  if (!placed) return;
  const docId = targetDoc(p.target);
  const stale = placed.staleOnArrival || !placed.range;
  tx.addTracker(
    newTracker(p.proposalId, docId, 'proposals', stale ? null : placed.range, {
      nodeRange: p.target.kind === 'span' && p.target.span.unit !== 'sentence',
      watch: !stale,
    }),
  );
  tx.ann('proposals')[p.proposalId] = {
    ...proposalCommon(c, p.proposalId, p.feedbackSessionId, docId, p.rationale, stale),
    kind: 'cut',
    target: p.target,
    range: stale || !placed.range ? null : { ...placed.range },
  };
  countInSession(tx, s, 'propose_cut', p.proposalId);
  addAiText(tx, p.proposalId, 'proposal', [p.rationale]);
}

/** Folds `SplitProposed`. */
export function foldSplitProposed(tx: Tx, c: CommitOf<'SplitProposed'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'propose_split');
  if (!s || idTaken(tx, p.proposalId)) return;
  const placed = place(
    tx,
    p.documentId,
    { from: p.pos, to: p.pos, readVersion: p.readVersion, version: p.version },
    {
      point: true,
      assoc: 1,
      exact: (doc) => {
        const r = resolveSplit(doc, p.paragraphId, p.sentenceId);
        return r.ok && r.pos === p.pos;
      },
    },
  );
  if (!placed) return;
  let stale = placed.staleOnArrival || !placed.range;
  let para: Span | null = null;
  if (placed.range) {
    const d = tx.s.docs[p.documentId]!;
    const b = blockAt(d.node, placed.range.from);
    if (!b || b.node.type.name !== 'paragraph' || b.from === placed.range.from) stale = true;
    else para = { from: b.from, to: b.to };
  }
  tx.addTracker(
    newTracker(p.proposalId, p.documentId, 'proposals', stale ? null : para, {
      point: stale || !placed.range ? null : placed.range.from,
      pointAssoc: 1,
      watch: !stale,
    }),
  );
  tx.ann('proposals')[p.proposalId] = {
    ...proposalCommon(c, p.proposalId, p.feedbackSessionId, p.documentId, p.rationale, stale),
    kind: 'split',
    paragraphId: p.paragraphId,
    sentenceId: p.sentenceId,
    pos: stale || !placed.range ? null : placed.range.from,
  };
  countInSession(tx, s, 'propose_split', p.proposalId);
  addAiText(tx, p.proposalId, 'proposal', [p.rationale]);
}

/** Folds `MergeProposed`. */
export function foldMergeProposed(tx: Tx, c: CommitOf<'MergeProposed'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'propose_merge');
  if (!s || idTaken(tx, p.proposalId)) return;
  if (!(p.from < p.joinPos && p.joinPos < p.to)) {
    tx.issue('invalid-position', `join ${p.joinPos} is not inside ${p.from}-${p.to}`);
    return;
  }
  const stamp = { from: p.from, to: p.to, readVersion: p.readVersion, version: p.version };
  const placed = place(tx, p.documentId, stamp, {
    exact: (doc) => {
      const r = resolveMerge(doc, p.firstParagraphId, p.secondParagraphId);
      return r.ok && r.joinPos === p.joinPos && r.first.pos === p.from && r.second.end === p.to;
    },
  });
  if (!placed) return;
  const join = place(
    tx,
    p.documentId,
    { ...stamp, from: p.joinPos, to: p.joinPos },
    { point: true, assoc: 1 },
  );
  if (!join) return;
  const stale = placed.staleOnArrival || join.staleOnArrival || !placed.range || !join.range;
  tx.addTracker(
    newTracker(p.proposalId, p.documentId, 'proposals', stale ? null : placed.range, {
      nodeRange: true,
      point: stale || !join.range ? null : join.range.from,
      watch: !stale,
    }),
  );
  tx.ann('proposals')[p.proposalId] = {
    ...proposalCommon(c, p.proposalId, p.feedbackSessionId, p.documentId, p.rationale, stale),
    kind: 'merge',
    firstParagraphId: p.firstParagraphId,
    secondParagraphId: p.secondParagraphId,
    joinPos: stale || !join.range ? null : join.range.from,
    range: stale || !placed.range ? null : { ...placed.range },
  };
  countInSession(tx, s, 'propose_merge', p.proposalId);
  addAiText(tx, p.proposalId, 'proposal', [p.rationale]);
}

/** Folds `CitationNeededFlagged`. */
export function foldCitationFlagged(tx: Tx, c: CommitOf<'CitationNeededFlagged'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'flag_citation_needed');
  if (!s || idTaken(tx, p.flagId)) return;
  const placed = placeAnchor(tx, p.target);
  if (!placed) return;
  const docId = p.target.anchor.documentId;
  tx.addTracker(newTracker(p.flagId, docId, 'citationFlags', placed.range));
  const d = tx.s.docs[docId]!;
  const cited = placed.range !== null && isCited(d.node, d.runs, placed.range);
  tx.ann('citationFlags')[p.flagId] = {
    id: p.flagId,
    feedbackSessionId: p.feedbackSessionId,
    seq: c.seq,
    createdAt: c.serverTime,
    target: anchorTarget(p.target),
    range: current(docId, placed.range),
    claim: p.claim,
    status: cited ? 'cited' : 'open',
    dismissal: null,
  };
  countInSession(tx, s, 'flag_citation_needed', p.flagId);
  addAiText(tx, p.flagId, 'citation-flag', [p.claim]);
}

/** Folds `SourceSurfaced`. */
export function foldSourceSurfaced(tx: Tx, c: CommitOf<'SourceSurfaced'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'search_sources');
  if (!s || idTaken(tx, p.surfacedId)) return;
  let range: Span | null = null;
  if (p.target) {
    const placed = placeAnchor(tx, p.target);
    if (!placed) return;
    range = placed.range;
    tx.addTracker(newTracker(p.surfacedId, p.target.anchor.documentId, 'surfacedSources', range));
  }
  tx.ann('surfacedSources')[p.surfacedId] = {
    id: p.surfacedId,
    feedbackSessionId: p.feedbackSessionId,
    seq: c.seq,
    createdAt: c.serverTime,
    query: p.query,
    target: p.target ? anchorTarget(p.target) : null,
    range: p.target ? current(p.target.anchor.documentId, range) : null,
    candidates: p.candidates,
    accepted: [],
    status: 'open',
    dismissal: null,
  };
  countInSession(tx, s, 'search_sources', p.surfacedId);
  addAiText(tx, p.surfacedId, 'surfaced-source', [
    p.query,
    ...p.candidates.map((x) => x.csl.title),
  ]);
}

/** Folds `SourceSuggested`. */
export function foldSourceSuggested(tx: Tx, c: CommitOf<'SourceSuggested'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'suggest_source');
  if (!s || idTaken(tx, p.sourceSuggestionId)) return;
  if (!tx.s.sources[p.sourceId]) {
    tx.issue('unknown-source', `no library source ${p.sourceId}`);
    return;
  }
  const placed = placeAnchor(tx, p.target);
  if (!placed) return;
  const docId = p.target.anchor.documentId;
  tx.addTracker(newTracker(p.sourceSuggestionId, docId, 'sourceSuggestions', placed.range));
  tx.ann('sourceSuggestions')[p.sourceSuggestionId] = {
    id: p.sourceSuggestionId,
    feedbackSessionId: p.feedbackSessionId,
    seq: c.seq,
    createdAt: c.serverTime,
    target: anchorTarget(p.target),
    range: current(docId, placed.range),
    sourceId: p.sourceId,
    rationale: p.rationale,
    status: 'open',
    dismissal: null,
  };
  countInSession(tx, s, 'suggest_source', p.sourceSuggestionId);
  addAiText(tx, p.sourceSuggestionId, 'source-suggestion', [p.rationale]);
}

/** Folds `ReviewFinished`. */
export function foldReviewFinished(tx: Tx, c: CommitOf<'ReviewFinished'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'finish_review');
  if (!s) return;
  tx.ann('agentSessions')[s.id] = {
    ...s,
    status: 'finished',
    endedSeq: c.seq,
    review: { summary: p.summary, strengths: p.strengths, topPriorities: p.topPriorities },
  };
  if (s.requestId) {
    const req = tx.s.ann.feedbackRequests[s.requestId];
    if (req) tx.ann('feedbackRequests')[req.id] = { ...req, status: 'finished' };
  }
  addAiText(tx, s.id, 'review', [p.summary, ...p.strengths, ...p.topPriorities]);
}

/** Folds `DiscussAnswered`. */
export function foldDiscussAnswered(tx: Tx, c: CommitOf<'DiscussAnswered'>): void {
  const p = c.payload;
  const s = sessionFor(tx, c, p.feedbackSessionId, 'answer_discussion');
  if (!s) return;
  const thr = tx.s.ann.discussions[p.threadId];
  if (!thr || s.threadId !== p.threadId) {
    tx.issue('unknown-thread', `discuss thread ${p.threadId} is not served by session ${s.id}`);
    return;
  }
  if (thr.targetId !== p.targetId) {
    tx.issue('target-mismatch', `thread ${thr.id} discusses ${thr.targetId}, not ${p.targetId}`);
    return;
  }
  tx.ann('discussions')[thr.id] = {
    ...thr,
    messages: [
      ...thr.messages,
      {
        role: 'editor',
        body: p.body,
        seq: c.seq,
        createdAt: c.serverTime,
        feedbackSessionId: s.id,
      },
    ],
    status: 'answered',
  };
  tx.ann('agentSessions')[s.id] = { ...s, status: 'finished', endedSeq: c.seq };
  addAiText(tx, thr.id, 'discuss', [p.body]);
}

// ---------------------------------------------------------------------------
// Human responses
// ---------------------------------------------------------------------------

function closeTracker(tx: Tx, id: string): void {
  const t = tx.s.trackers[id];
  if (!t) return;
  tx.setTracker({ ...t, region: null, watch: false });
}

/** Folds `SuggestionDismissed`. */
export function foldDismissed(tx: Tx, c: CommitOf<'SuggestionDismissed'>): void {
  const p = c.payload;
  const g = groupOf(tx, p.targetId);
  if (g === null) {
    tx.issue('unknown-target', `no annotation ${p.targetId}`);
    return;
  }
  if (g === 'proposals') {
    tx.issue('unknown-target', `${p.targetId} is a proposal; use ProposalRejected`);
    return;
  }
  const rec = tx.s.ann[g][p.targetId] as { status: string };
  if (rec.status !== 'open') {
    tx.issue('not-open', `${p.targetId} is ${rec.status}`);
    return;
  }
  const dismissal = { seq: c.seq, reason: p.reason, note: p.note };
  const next: Record<string, unknown> = { ...rec, status: 'dismissed', dismissal };
  if (g === 'suggestions') {
    next.resolvedSeq = c.seq;
    closeTracker(tx, p.targetId);
  }
  (tx.ann(g) as Record<string, unknown>)[p.targetId] = next;
}

/** Folds `ProposalRejected`. */
export function foldProposalRejected(tx: Tx, c: CommitOf<'ProposalRejected'>): void {
  const p = c.payload;
  const prop = tx.s.ann.proposals[p.proposalId];
  if (!prop) {
    tx.issue('unknown-target', `no proposal ${p.proposalId}`);
    return;
  }
  if (prop.status !== 'open') {
    tx.issue('not-open', `proposal ${prop.id} is ${prop.status}`);
    return;
  }
  const next = {
    ...prop,
    status: 'rejected',
    resolvedSeq: c.seq,
    rejectReason: p.reason,
  } as ProposalState;
  if (next.kind === 'move') {
    next.source = null;
    next.insertAt = null;
  } else if (next.kind === 'cut') next.range = null;
  else if (next.kind === 'split') next.pos = null;
  else {
    next.joinPos = null;
    next.range = null;
  }
  tx.ann('proposals')[prop.id] = next;
  const t = tx.s.trackers[prop.id];
  if (t) tx.setTracker({ ...t, range: null, point: null, watch: false });
}

/** Folds `FeedbackRequested`. */
export function foldFeedbackRequested(tx: Tx, c: CommitOf<'FeedbackRequested'>): void {
  const p = c.payload;
  if (tx.s.ann.feedbackRequests[p.requestId]) {
    tx.issue('duplicate-id', `feedback request ${p.requestId} already exists`);
    return;
  }
  if (p.scope.kind !== 'project' && !tx.s.docs[p.scope.documentId]) {
    tx.issue('unknown-document', `no document ${p.scope.documentId}`);
    return;
  }
  let scope = p.scope;
  if (scope.kind === 'selection') {
    // Selection positions are mapped to the current version, and then through every later step.
    const d = tx.s.docs[scope.documentId]!;
    const maps = scope.version <= d.version ? mapsBetween(d.maps, scope.version, d.version) : null;
    if (!maps || scope.from > scope.to) {
      tx.issue(
        'invalid-version',
        `selection at version ${scope.version} cannot be mapped to ${d.version}`,
      );
      return;
    }
    let from = scope.from;
    let to = scope.to;
    for (const m of maps) {
      from = m.map(from, 1);
      to = Math.max(from, m.map(to, -1));
    }
    if (to > d.node.content.size) {
      tx.issue(
        'invalid-position',
        `selection ${scope.from}-${scope.to} is outside document ${d.id}`,
      );
      return;
    }
    scope = { ...scope, from, to, version: d.version };
    tx.addTracker(newTracker(p.requestId, d.id, 'feedbackRequests', { from, to }));
  }
  tx.ann('feedbackRequests')[p.requestId] = {
    id: p.requestId,
    seq: c.seq,
    createdAt: c.serverTime,
    scope,
    lenses: p.lenses,
    intensity: p.intensity,
    ask: p.ask,
    status: 'pending',
    feedbackSessionId: null,
  };
}

/** Folds `DiscussRequested`. */
export function foldDiscussRequested(tx: Tx, c: CommitOf<'DiscussRequested'>): void {
  const p = c.payload;
  if (groupOf(tx, p.targetId) === null) {
    tx.issue('unknown-target', `no annotation ${p.targetId}`);
    return;
  }
  const thr = tx.s.ann.discussions[p.threadId];
  const msg = {
    role: 'writer' as const,
    body: p.message,
    seq: c.seq,
    createdAt: c.serverTime,
    feedbackSessionId: null,
  };
  if (thr && thr.targetId !== p.targetId) {
    tx.issue('target-mismatch', `thread ${thr.id} discusses ${thr.targetId}, not ${p.targetId}`);
    return;
  }
  tx.ann('discussions')[p.threadId] = thr
    ? { ...thr, messages: [...thr.messages, msg], status: 'awaiting-editor' }
    : { id: p.threadId, targetId: p.targetId, messages: [msg], status: 'awaiting-editor' };
}

// ---------------------------------------------------------------------------
// System events
// ---------------------------------------------------------------------------

/** Folds `SuggestionResolved`: checks it against the fold's own derivation. */
export function foldSuggestionResolved(tx: Tx, c: CommitOf<'SuggestionResolved'>): void {
  const p = c.payload;
  if (p.triggerSeq >= c.seq) {
    tx.issue('resolution-mismatch', `triggerSeq ${p.triggerSeq} is not before ${c.seq}`);
    return;
  }
  const rec =
    p.targetKind === 'suggestion'
      ? tx.s.ann.suggestions[p.targetId]
      : tx.s.ann.proposals[p.targetId];
  if (!rec) {
    tx.issue('unknown-target', `no ${p.targetKind} ${p.targetId}`);
    return;
  }
  if (rec.status !== p.outcome || rec.resolvedSeq !== p.triggerSeq) {
    tx.issue(
      'resolution-mismatch',
      `${p.targetKind} ${p.targetId}: the fold derived ${rec.status} at ${rec.resolvedSeq ?? 'none'}, the event says ${p.outcome} at ${p.triggerSeq}`,
    );
  }
}

/** Folds `ChainHeadWitnessed`: the embedded subject must match the chain. */
export function foldChainHeadWitnessed(tx: Tx, c: CommitOf<'ChainHeadWitnessed'>): void {
  const p = c.payload;
  const info = p.witnessedSeq < c.seq ? pvecGet(tx.s.commits, p.witnessedSeq - 1) : undefined;
  if (!info || info.hash !== p.witnessedHash || info.serverTime !== p.serverTime) {
    tx.issue(
      'witness-mismatch',
      `embedded witness of seq ${p.witnessedSeq} does not match the chain`,
    );
  }
}

/** Folds `FeedbackSessionFailed`. */
export function foldSessionFailed(tx: Tx, c: CommitOf<'FeedbackSessionFailed'>): void {
  const p = c.payload;
  if (p.feedbackSessionId === null && p.requestId === null && p.threadId === null) {
    tx.issue('unknown-target', 'FeedbackSessionFailed names no session, request or thread');
    return;
  }
  if (p.feedbackSessionId !== null) {
    const s = tx.s.ann.agentSessions[p.feedbackSessionId];
    if (!s) tx.issue('unknown-session', `no feedback session ${p.feedbackSessionId}`);
    else if (s.status !== 'running')
      tx.issue('session-not-running', `feedback session ${s.id} is ${s.status}`);
    else
      tx.ann('agentSessions')[s.id] = {
        ...s,
        status: 'failed',
        failureReason: p.reason,
        endedSeq: c.seq,
      };
  }
  if (p.requestId !== null) {
    const r = tx.s.ann.feedbackRequests[p.requestId];
    if (!r) tx.issue('unknown-request', `no feedback request ${p.requestId}`);
    else if (r.status === 'finished')
      tx.issue('not-open', `feedback request ${r.id} already finished`);
    else tx.ann('feedbackRequests')[r.id] = { ...r, status: 'failed' };
  }
  if (p.threadId !== null) {
    const t = tx.s.ann.discussions[p.threadId];
    if (!t) tx.issue('unknown-thread', `no discuss thread ${p.threadId}`);
    else tx.ann('discussions')[t.id] = { ...t, status: 'failed' };
  }
}
