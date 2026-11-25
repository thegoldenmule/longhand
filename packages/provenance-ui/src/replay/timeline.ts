/**
 * Replay timeline: which seqs the scrubber steps through, the markers drawn on
 * it, playback offsets from real inter-commit timing, and a plain-words summary
 * of each commit. Pure functions over a commit array and the head ProjectState.
 */
import type { AnnotationsState, Commit, ProjectState } from '@longhand/schema';
import { plural } from '../format';

/** Whole-project timeline, or only the commits that touch one document. */
export type ReplayScope = 'document' | 'project';

/** Default cap on one idle gap during playback, in ledger milliseconds. */
export const DEFAULT_MAX_GAP_MS = 4000;

function payloadDocumentId(c: Commit): string | null {
  const p = c.payload as { documentId?: unknown };
  return typeof p.documentId === 'string' ? p.documentId : null;
}

/**
 * The seqs the scrubber steps through, ascending, always starting with 0 (before
 * any commit). Project scope: every commit. Document scope: the commits whose
 * payload names the document (its creation, edits, pastes, accepted proposals…).
 */
export function replayFrames(
  commits: readonly Commit[],
  opts: { scope: ReplayScope; documentId?: string | null },
): number[] {
  const out = [0];
  for (const c of commits) {
    if (opts.scope === 'project' || !opts.documentId || payloadDocumentId(c) === opts.documentId)
      out.push(c.seq);
  }
  return out;
}

/** Index of the last frame whose seq is ≤ `seq` (0 when none). */
export function frameIndexForSeq(frames: readonly number[], seq: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((frames[mid] as number) <= seq) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** When a commit's effect was complete: `clientTime`, plus `durationMs` for a text batch. */
export function commitEndMs(c: Commit): number {
  const t = Date.parse(c.clientTime);
  const d = (c.payload as { durationMs?: unknown }).durationMs;
  return t + (c.type === 'TextEdited' && typeof d === 'number' ? d : 0);
}

/**
 * Playback offsets (ms of compressed ledger time) for each frame: real time
 * between consecutive frames, with each gap clamped to `[0, maxGapMs]` so long
 * idle stretches (overnight, between sessions) play as one short pause. Divide
 * by the playback speed to get wall time.
 */
export function playbackOffsets(
  commits: readonly Commit[],
  frames: readonly number[],
  opts: { maxGapMs?: number } = {},
): number[] {
  const cap = Math.max(0, opts.maxGapMs ?? DEFAULT_MAX_GAP_MS);
  const out: number[] = [];
  let prev: number | null = null;
  let acc = 0;
  for (const seq of frames) {
    const c = seq > 0 ? commits[seq - 1] : undefined;
    const t = c ? commitEndMs(c) : null;
    if (t !== null && prev !== null) acc += Math.min(cap, Math.max(0, t - prev));
    if (t !== null) prev = t;
    out.push(acc);
  }
  return out;
}

/** Index of the last offset ≤ `t` (binary search). */
export function frameAtTime(offsets: readonly number[], t: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid] as number) <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** A marker on the timeline: a band (sessions) or a point (pastes, accepted proposals). */
export interface ReplayMarker {
  kind: 'ai-session' | 'writing-session' | 'paste' | 'proposal';
  id: string;
  fromSeq: number;
  /** Equal to `fromSeq` for points. For a running AI session, the head seq. */
  toSeq: number;
  label: string;
}

/** The document an annotation belongs to, if it can be found. */
function annotationDocument(ann: AnnotationsState, id: string): string | null {
  const s = ann.suggestions[id];
  if (s) return s.kind === 'insertion' ? s.documentId : s.anchor.documentId;
  const groups = [
    ann.comments,
    ann.questions,
    ann.citationFlags,
    ann.surfacedSources,
    ann.sourceSuggestions,
  ];
  for (const g of groups) {
    const a = g[id] as { range?: { documentId: string } | null; target?: unknown } | undefined;
    if (a?.range) return a.range.documentId;
    const t = a?.target as
      { anchor?: { documentId?: string }; span?: { documentId?: string } } | null | undefined;
    if (t?.anchor?.documentId) return t.anchor.documentId;
    if (t?.span?.documentId) return t.span.documentId;
  }
  const p = ann.proposals[id];
  return p ? p.documentId : null;
}

const PROPOSAL_LABEL: Record<string, string> = {
  move: 'move',
  cut: 'cut',
  split: 'split',
  merge: 'merge',
};

/**
 * Markers for AI sessions (FeedbackSessionStarted → ReviewFinished, or the failure),
 * writing sessions, pastes and accepted proposals. Document scope keeps the
 * markers that concern the document.
 */
export function replayMarkers(
  head: ProjectState,
  opts: { scope: ReplayScope; documentId?: string | null },
): ReplayMarker[] {
  const doc = opts.scope === 'document' ? (opts.documentId ?? null) : null;
  const out: ReplayMarker[] = [];
  const ann = head.annotations;

  for (const s of Object.values(ann.agentSessions)) {
    if (doc) {
      if (s.kind === 'review') {
        const req = s.requestId ? ann.feedbackRequests[s.requestId] : undefined;
        const scope = req?.scope;
        if (scope && scope.kind !== 'project' && scope.documentId !== doc) continue;
      } else {
        const thread = s.threadId ? ann.discussions[s.threadId] : undefined;
        const target = thread ? annotationDocument(ann, thread.targetId) : null;
        if (target !== doc) continue;
      }
    }
    const what = s.kind === 'review' ? 'AI review' : 'AI Discuss reply';
    const status =
      s.status === 'failed' ? ' (failed)' : s.status === 'running' ? ' (still running)' : '';
    out.push({
      kind: 'ai-session',
      id: s.id,
      fromSeq: s.startedSeq,
      toSeq: s.endedSeq ?? head.headSeq,
      label: `${what}${status} · ${s.model}`,
    });
  }

  for (const w of head.writingSessions) {
    if (doc && !w.documentIds.includes(doc)) continue;
    out.push({
      kind: 'writing-session',
      id: `ws-${w.index}`,
      fromSeq: w.startSeq,
      toSeq: w.endSeq,
      label: `Writing session ${w.index + 1} · ${plural(w.commits, 'edit')}`,
    });
  }

  for (const p of Object.values(head.pastes)) {
    if (doc && p.documentId !== doc) continue;
    const at = p.insertedSeq ?? p.seq;
    const origin =
      p.origin === 'internal'
        ? p.verifiedInternal
          ? 'Internal paste'
          : 'Internal paste (unverified)'
        : p.via === 'drop'
          ? 'External drop'
          : 'External paste';
    out.push({
      kind: 'paste',
      id: p.id,
      fromSeq: at,
      toSeq: at,
      label: `${origin} · ${plural(p.characters, 'character')}`,
    });
  }

  for (const p of Object.values(ann.proposals)) {
    if (p.status !== 'accepted' || p.resolvedSeq === null) continue;
    if (doc && p.documentId !== doc) continue;
    const unit = p.kind === 'move' ? ` ${p.span.unit}` : '';
    out.push({
      kind: 'proposal',
      id: p.id,
      fromSeq: p.resolvedSeq,
      toSeq: p.resolvedSeq,
      label: `Accepted proposal · ${PROPOSAL_LABEL[p.kind] ?? p.kind}${unit}`,
    });
  }

  const order = { 'ai-session': 0, 'writing-session': 1, paste: 2, proposal: 3 };
  return out.sort((a, b) => a.fromSeq - b.fromSeq || order[a.kind] - order[b.kind]);
}

const TYPE_LABEL: Record<string, string> = {
  ProjectCreated: 'Project created',
  ProjectSettingsChanged: 'Settings changed',
  DocumentCreated: 'Document created',
  DocumentImported: 'Draft imported',
  DocumentRenamed: 'Document renamed',
  DocumentMoved: 'Document moved',
  DocumentArchived: 'Document archived',
  SynopsisEdited: 'Synopsis edited',
  FolderCreated: 'Folder created',
  FolderRenamed: 'Folder renamed',
  FolderMoved: 'Folder moved',
  FolderArchived: 'Folder archived',
  PasteOccurred: 'Paste recorded',
  SliceCopied: 'Text copied',
  ProposalAccepted: 'Proposal accepted',
  ProposalRejected: 'Proposal rejected',
  SuggestionDismissed: 'Card dismissed',
  FeedbackRequested: 'Feedback requested',
  DiscussRequested: 'Discuss requested',
  SourceAdded: 'Source added',
  SourceUpdated: 'Source updated',
  CitationInserted: 'Citation recorded',
  ClippingSaved: 'Clipping saved',
  ClippingRemoved: 'Clipping removed',
  FeedbackSessionStarted: 'AI session started',
  CommentAdded: 'AI comment',
  QuestionAsked: 'AI question',
  SuggestionProposed: 'AI suggestion',
  MoveProposed: 'AI proposed a move',
  CutProposed: 'AI proposed a cut',
  SplitProposed: 'AI proposed a split',
  MergeProposed: 'AI proposed a merge',
  CitationNeededFlagged: 'AI flagged a claim',
  SourceSurfaced: 'AI surfaced sources',
  SourceSuggested: 'AI suggested a source',
  ReviewFinished: 'AI review finished',
  DiscussAnswered: 'AI answered',
  SuggestionResolved: 'Suggestion resolved',
  ChainHeadWitnessed: 'Chain witnessed',
  FeedbackSessionFailed: 'AI session failed',
};

const METHOD_VERB: Record<string, string> = {
  typed: 'Typed',
  ime: 'Typed (IME)',
  autocorrect: 'Autocorrected',
  'pasted-external': 'Pasted',
  'pasted-internal': 'Pasted from the project',
  'drop-internal': 'Dragged',
  history: 'Undo or redo',
  citation: 'Cited',
  clipping: 'Placed a clipping',
};

/** A short description of a commit ("Typed 24 characters", "AI suggestion"). */
export function describeCommit(c: Commit): string {
  if (c.type === 'TextEdited') {
    const p = c.payload as { runs: Array<{ method: string }>; characters: number };
    const methods = [...new Set(p.runs.map((r) => r.method))];
    const verb = methods.length === 1 ? (METHOD_VERB[methods[0] as string] ?? 'Edited') : 'Edited';
    return p.characters > 0
      ? `${verb} · ${plural(p.characters, 'character')}`
      : `${verb} · deletion or formatting`;
  }
  if (c.type === 'SuggestionResolved') {
    const p = c.payload as { outcome?: string };
    return p.outcome ? `Suggestion ${p.outcome}` : 'Suggestion resolved';
  }
  return TYPE_LABEL[c.type] ?? c.type;
}
