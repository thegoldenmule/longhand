/**
 * The fold: `applyCommit(state, commit) → state`, pure and deterministic.
 *
 * Commits must be valid against `CommitSchema` (run `verifyChain` first for
 * untrusted input) and contiguous: `seq === headSeq + 1` and `prevHash ===
 * headHash`, otherwise a {@link FoldError} is thrown.
 */
import {
  DEFAULT_PROJECT_SETTINGS,
  SESSION_GAP_MS,
  type Commit,
  type CommitOf,
  type WritingSession,
} from '@longhand/schema';
import * as agent from './fold-agent';
import * as binder from './fold-binder';
import { foldProposalAccepted } from './fold-proposals';
import {
  foldCitationInserted,
  foldPasteOccurred,
  foldSliceCopied,
  foldTextEdited,
} from './fold-text';
import { FoldError } from './issues';
import { pvecFrom, pvecGet, pvecPush, pvecToArray } from './pvec';
import {
  emptyInternal,
  internal,
  opaque,
  Tx,
  type Internal,
  type LedgerState,
  type MsEntry,
} from './state';

/** The state before any commit. */
export function emptyState(): LedgerState {
  return opaque(emptyInternal());
}

function sessionsFrom(entries: readonly MsEntry[]): WritingSession[] {
  const out: WritingSession[] = [];
  let prev: MsEntry | null = null;
  let endMs = 0;
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && prev && e.timeMs - prev.timeMs < SESSION_GAP_MS) {
      endMs = Math.max(endMs, e.timeMs + e.durationMs);
      out[out.length - 1] = {
        ...last,
        endSeq: e.seq,
        endTime: new Date(endMs).toISOString(),
        activeMs: last.activeMs + e.durationMs,
        commits: last.commits + 1,
        charactersInserted: last.charactersInserted + e.characters,
        documentIds: last.documentIds.includes(e.documentId)
          ? last.documentIds
          : [...last.documentIds, e.documentId],
      };
    } else {
      endMs = e.timeMs + e.durationMs;
      out.push({
        index: out.length,
        startSeq: e.seq,
        endSeq: e.seq,
        startTime: e.clientTime,
        endTime: new Date(endMs).toISOString(),
        activeMs: e.durationMs,
        commits: 1,
        charactersInserted: e.characters,
        documentIds: [e.documentId],
      });
    }
    prev = e;
  }
  return out;
}

function addSessionEntry(
  tx: Tx,
  c: Commit,
  documentId: string,
  characters: number,
  durationMs: number,
): void {
  const entry: MsEntry = {
    seq: c.seq,
    timeMs: Date.parse(c.clientTime),
    clientTime: c.clientTime,
    durationMs,
    characters,
    documentId,
  };
  const entries = tx.s.msEntries;
  const last = pvecGet(entries, entries.length - 1);
  if (!last || entry.timeMs >= last.timeMs) {
    tx.s.msEntries = pvecPush(entries, entry);
    const sessions = tx.s.sessions;
    const ls = sessions[sessions.length - 1];
    if (ls && last && entry.timeMs - last.timeMs < SESSION_GAP_MS) {
      const endMs = Math.max(Date.parse(ls.endTime), entry.timeMs + durationMs);
      tx.s.sessions = [
        ...sessions.slice(0, -1),
        {
          ...ls,
          endSeq: entry.seq,
          endTime: new Date(endMs).toISOString(),
          activeMs: ls.activeMs + durationMs,
          commits: ls.commits + 1,
          charactersInserted: ls.charactersInserted + characters,
          documentIds: ls.documentIds.includes(documentId)
            ? ls.documentIds
            : [...ls.documentIds, documentId],
        },
      ];
    } else {
      tx.s.sessions = [
        ...sessions,
        ...sessionsFrom([entry]).map((s) => ({ ...s, index: sessions.length })),
      ];
    }
    return;
  }
  // Out of clientTime order (e.g. a second device): rebuild in (time, seq) order.
  const all = [...pvecToArray(entries), entry].sort((a, b) => a.timeMs - b.timeMs || a.seq - b.seq);
  tx.s.msEntries = pvecFrom(all);
  tx.s.sessions = sessionsFrom(all);
}

function dispatch(tx: Tx, c: Commit): void {
  switch (c.type) {
    case 'ProjectCreated':
      tx.s.projectId = c.projectId;
      tx.s.accountId = c.accountId;
      tx.s.settings = { ...DEFAULT_PROJECT_SETTINGS, title: c.payload.title };
      tx.s.createdSeq = c.seq;
      return;
    case 'ProjectSettingsChanged':
      tx.s.settings = { ...tx.s.settings, ...c.payload.patch };
      return;
    case 'DocumentCreated':
      return binder.foldDocumentCreated(tx, c);
    case 'DocumentImported':
      return binder.foldDocumentImported(tx, c);
    case 'DocumentRenamed':
      return binder.foldDocumentRenamed(tx, c);
    case 'DocumentMoved':
      return binder.foldDocumentMoved(tx, c);
    case 'DocumentArchived':
      return binder.foldDocumentArchived(tx, c);
    case 'SynopsisEdited':
      return binder.foldSynopsisEdited(tx, c);
    case 'FolderCreated':
      return binder.foldFolderCreated(tx, c);
    case 'FolderRenamed':
      return binder.foldFolderRenamed(tx, c);
    case 'FolderMoved':
      return binder.foldFolderMoved(tx, c);
    case 'FolderArchived':
      return binder.foldFolderArchived(tx, c);
    case 'TextEdited': {
      const chars = foldTextEdited(tx, c);
      addSessionEntry(tx, c, c.payload.documentId, chars, c.payload.durationMs);
      return;
    }
    case 'PasteOccurred':
      return foldPasteOccurred(tx, c);
    case 'SliceCopied':
      return foldSliceCopied(tx, c);
    case 'ProposalAccepted': {
      const before = tx.s.docs[c.payload.documentId];
      if (foldProposalAccepted(tx, c)) {
        const after = tx.s.docs[c.payload.documentId];
        let chars = 0;
        if (before && after)
          for (const r of after.runs) if (r.p.originSeq === c.seq) chars += r.to - r.from;
        addSessionEntry(tx, c, c.payload.documentId, chars, 0);
      }
      return;
    }
    case 'ProposalRejected':
      return agent.foldProposalRejected(tx, c);
    case 'SuggestionDismissed':
      return agent.foldDismissed(tx, c);
    case 'FeedbackRequested':
      return agent.foldFeedbackRequested(tx, c);
    case 'DiscussRequested':
      return agent.foldDiscussRequested(tx, c);
    case 'SourceAdded':
      return binder.foldSourceAdded(tx, c);
    case 'SourceUpdated':
      return binder.foldSourceUpdated(tx, c);
    case 'CitationInserted':
      return foldCitationInserted(tx, c);
    case 'ClippingSaved':
      return binder.foldClippingSaved(tx, c);
    case 'ClippingRemoved':
      return binder.foldClippingRemoved(tx, c);
    case 'FeedbackSessionStarted':
      return agent.foldSessionStarted(tx, c);
    case 'CommentAdded':
      return agent.foldCommentAdded(tx, c);
    case 'QuestionAsked':
      return agent.foldQuestionAsked(tx, c);
    case 'SuggestionProposed':
      return agent.foldSuggestionProposed(tx, c);
    case 'MoveProposed':
      return agent.foldMoveProposed(tx, c);
    case 'CutProposed':
      return agent.foldCutProposed(tx, c);
    case 'SplitProposed':
      return agent.foldSplitProposed(tx, c);
    case 'MergeProposed':
      return agent.foldMergeProposed(tx, c);
    case 'CitationNeededFlagged':
      return agent.foldCitationFlagged(tx, c);
    case 'SourceSurfaced':
      return agent.foldSourceSurfaced(tx, c);
    case 'SourceSuggested':
      return agent.foldSourceSuggested(tx, c);
    case 'ReviewFinished':
      return agent.foldReviewFinished(tx, c);
    case 'DiscussAnswered':
      return agent.foldDiscussAnswered(tx, c);
    case 'SuggestionResolved':
      return agent.foldSuggestionResolved(tx, c);
    case 'ChainHeadWitnessed':
      return agent.foldChainHeadWitnessed(tx, c);
    case 'FeedbackSessionFailed':
      return agent.foldSessionFailed(tx, c);
  }
}

const MANUSCRIPT = new Set(['TextEdited', 'ProposalAccepted', 'DocumentImported']);

/** Folds one commit. Pure: `state` is not modified. Throws {@link FoldError} on an unfoldable commit. */
export function applyCommit(state: LedgerState, commit: Commit): LedgerState {
  const s: Internal = internal(state);
  if (commit.seq !== s.headSeq + 1) {
    throw new FoldError(commit.seq, 'seq-gap', `expected seq ${s.headSeq + 1}, got ${commit.seq}`);
  }
  if (commit.prevHash !== s.headHash) {
    throw new FoldError(
      commit.seq,
      'prev-hash-mismatch',
      `prevHash does not match the hash of seq ${s.headSeq}`,
    );
  }
  if (s.headSeq === 0 && commit.type !== 'ProjectCreated') {
    throw new FoldError(
      commit.seq,
      'project-not-created',
      'the first commit must be ProjectCreated',
    );
  }
  if (s.headSeq > 0 && commit.type === 'ProjectCreated') {
    throw new FoldError(
      commit.seq,
      'project-already-created',
      'ProjectCreated must be the first commit',
    );
  }
  if (s.headSeq > 0 && (commit.projectId !== s.projectId || commit.accountId !== s.accountId)) {
    throw new FoldError(
      commit.seq,
      'project-mismatch',
      `commit belongs to project ${commit.projectId}`,
    );
  }
  const tx = new Tx(s, commit.seq, commit.serverTime);
  dispatch(tx, commit);
  // The invariant, enforced again at the fold: only manuscript events change text.
  if (!MANUSCRIPT.has(commit.type)) {
    for (const [id, d] of Object.entries(s.docs)) {
      if (tx.s.docs[id]?.node !== d.node) {
        throw new FoldError(
          commit.seq,
          'invalid-content',
          `${commit.type} changed the text of ${id}`,
        );
      }
    }
  }
  const p = commit.payload as { documentId?: unknown; proposalId?: unknown };
  tx.s.commits = pvecPush(tx.s.commits, {
    seq: commit.seq,
    type: commit.type,
    actorKind: commit.actor.kind,
    clientTime: commit.clientTime,
    serverTime: commit.serverTime,
    sessionId: commit.sessionId,
    deviceId: commit.deviceId,
    hash: commit.hash,
    documentId: typeof p.documentId === 'string' ? p.documentId : null,
    methods:
      commit.type === 'TextEdited'
        ? [...new Set((commit as CommitOf<'TextEdited'>).payload.runs.map((r) => r.method))]
        : null,
    proposalId: commit.type === 'ProposalAccepted' ? (p.proposalId as string) : null,
  });
  tx.s.headSeq = commit.seq;
  tx.s.headHash = commit.hash;
  return opaque(tx.s);
}

/** Folds a whole ledger (seq 1…n in order). */
export function foldCommits(
  commits: readonly Commit[],
  from: LedgerState = emptyState(),
): LedgerState {
  let s = from;
  for (const c of commits) s = applyCommit(s, c);
  return s;
}
