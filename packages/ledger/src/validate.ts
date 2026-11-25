/**
 * Ingest validation: what the ledger service calls before appending a draft.
 *
 * A draft is accepted only if:
 * 1. its actor kind may emit its type, and it is the authenticated actor;
 * 2. it parses as a `CommitDraft` (payload schema included);
 * 3. it belongs to this project (or is the `ProjectCreated` of an empty ledger);
 * 4. **rebase policy — reject, never rebase:** a `TextEdited` must carry
 *    `baseVersion` equal to the document's current version. A lower one is
 *    rejected with `stale-base-version` (the client must rebase its pending steps
 *    over the steps it has not seen, as in prosemirror-collab, and resubmit); a
 *    higher one with `future-base-version`. The service never transforms a
 *    writer's steps, so the ledger holds exactly what the client applied and its
 *    keystroke timeline describes. A `ProposalAccepted` is accepted at any
 *    `baseVersion` up to the current one while the proposal is open (not stale):
 *    the fold derives its steps from the proposal's mapped positions, so there is
 *    nothing to rebase;
 * 5. agent position stamps are at the document's current `version`;
 * 6. folding it raises no `FoldError` and records no fold issue (unknown or
 *    closed targets, sessions not running, caps, positions that do not match the
 *    anchor, a `SuggestionResolved` that disagrees with the fold, …);
 * 7. no agent or system event changes manuscript text (also enforced inside
 *    `applyCommit`, which throws if a non-manuscript event changes any document).
 *
 * On success it returns the folded next state (for the given `serverTime`) and
 * the `SuggestionResolved` events the service should append after it.
 */
import {
  CommitDraftSchema,
  GENESIS_PREV_HASH,
  canActorEmit,
  computeCommitHash,
  isManuscriptEventType,
  type Actor,
  type Commit,
  type CommitDraft,
  type EventPayload,
} from '@longhand/schema';
import { applyCommit } from './fold';
import { FoldError, type LedgerErrorCode } from './issues';
import { pvecGet } from './pvec';
import { internal, type LedgerState } from './state';

/** One reason a draft was rejected. */
export interface ValidationError {
  code: LedgerErrorCode;
  message: string;
  /** Payload path for schema errors. */
  path?: string;
}

/** Result of {@link validateDraft}. */
export type ValidationResult =
  | {
      ok: true;
      /** The commit as it was folded for validation (seq, prevHash, serverTime filled; hashed). */
      commit: Commit;
      /** State after folding it. */
      state: LedgerState;
      /** `SuggestionResolved` payloads to append after it, in id order. */
      resolutions: Array<EventPayload<'SuggestionResolved'>>;
    }
  | { ok: false; errors: ValidationError[] };

/** Options for {@link validateDraft}. */
export interface ValidateOptions {
  /** Server time to fold with (defaults to the draft's clientTime). */
  serverTime?: string;
  /** Account id for the first commit (later commits use the project's). */
  accountId?: string;
}

function fail(
  code: LedgerErrorCode,
  message: string,
  path?: string,
): { ok: false; errors: ValidationError[] } {
  return { ok: false, errors: [path === undefined ? { code, message } : { code, message, path }] };
}

interface StampRef {
  documentId: string;
  version: number;
}

function stamps(d: CommitDraft): StampRef[] {
  const out: StampRef[] = [];
  const t = (
    x:
      | { anchor: { documentId: string }; version: number }
      | { span: { documentId: string }; version: number },
  ) =>
    out.push({
      documentId: 'anchor' in x ? x.anchor.documentId : x.span.documentId,
      version: x.version,
    });
  switch (d.type) {
    case 'CommentAdded':
    case 'CutProposed':
    case 'CitationNeededFlagged':
    case 'SourceSuggested':
      t(d.payload.target);
      break;
    case 'QuestionAsked':
    case 'SourceSurfaced':
      if (d.payload.target) t(d.payload.target);
      break;
    case 'SuggestionProposed': {
      const s = d.payload.suggestion;
      if (s.kind === 'insertion')
        out.push({ documentId: s.target.documentId, version: s.target.version });
      else t(s.target);
      break;
    }
    case 'MoveProposed':
      t(d.payload.source);
      break;
    case 'SplitProposed':
    case 'MergeProposed':
      out.push({ documentId: d.payload.documentId, version: d.payload.version });
      break;
    default:
      break;
  }
  return out;
}

/**
 * The `SuggestionResolved` events implied by folding commit `seq`: suggestions that
 * became adopted, adapted or stale, and proposals that became stale, at `seq`.
 */
export function resolutionsBetween(
  prev: LedgerState,
  next: LedgerState,
  seq: number,
): Array<EventPayload<'SuggestionResolved'>> {
  const a = internal(prev).ann;
  const b = internal(next).ann;
  const out: Array<EventPayload<'SuggestionResolved'>> = [];
  for (const id of Object.keys(b.suggestions).sort()) {
    const s = b.suggestions[id]!;
    if (s.resolvedSeq !== seq || a.suggestions[id]?.status === s.status) continue;
    if (s.status === 'adopted' || s.status === 'adapted' || s.status === 'stale') {
      out.push({ targetId: id, targetKind: 'suggestion', outcome: s.status, triggerSeq: seq });
    }
  }
  for (const id of Object.keys(b.proposals).sort()) {
    const p = b.proposals[id]!;
    if (p.resolvedSeq !== seq || p.status !== 'stale' || a.proposals[id]?.status === 'stale')
      continue;
    out.push({ targetId: id, targetKind: 'proposal', outcome: 'stale', triggerSeq: seq });
  }
  return out;
}

/** Validates a draft against the current state (see module docs). Pure. */
export function validateDraft(
  state: LedgerState,
  draft: unknown,
  actor: Actor,
  opts: ValidateOptions = {},
): ValidationResult {
  const s = internal(state);
  const raw = draft as { type?: unknown; actor?: { kind?: unknown; id?: unknown } } | null;
  if (!raw || typeof raw.type !== 'string' || !raw.actor || typeof raw.actor.kind !== 'string') {
    return fail('invalid-draft', 'a draft needs a type and an actor');
  }
  if (!canActorEmit(raw.type, raw.actor.kind as Actor['kind'])) {
    return fail('actor-not-permitted', `a ${raw.actor.kind} actor may not emit ${raw.type}`);
  }
  if (raw.actor.kind !== actor.kind || raw.actor.id !== actor.id) {
    return fail(
      'actor-mismatch',
      `the draft claims actor ${raw.actor.kind}:${String(raw.actor.id)}, authenticated as ${actor.kind}:${actor.id}`,
    );
  }
  const parsed = CommitDraftSchema.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        code: 'invalid-draft' as const,
        message: i.message,
        path: i.path.map(String).join('.'),
      })),
    };
  }
  const d = parsed.data;
  if (s.headSeq === 0 && d.type !== 'ProjectCreated') {
    return fail('project-not-created', 'the first commit must be ProjectCreated');
  }
  if (s.headSeq > 0) {
    if (d.type === 'ProjectCreated')
      return fail('project-already-created', 'the project already exists');
    if (d.projectId !== s.projectId)
      return fail('project-mismatch', `draft is for project ${d.projectId}`);
  }
  if (d.type === 'TextEdited' || d.type === 'ProposalAccepted') {
    const doc = s.docs[d.payload.documentId];
    if (!doc)
      return fail('unknown-document', `no document ${d.payload.documentId}`, 'payload.documentId');
    if (d.type === 'TextEdited' && d.payload.baseVersion < doc.version) {
      return fail(
        'stale-base-version',
        `baseVersion ${d.payload.baseVersion} is behind document ${doc.id} (version ${doc.version}); rebase and resubmit`,
        'payload.baseVersion',
      );
    }
    if (d.payload.baseVersion > doc.version) {
      return fail(
        'future-base-version',
        `baseVersion ${d.payload.baseVersion} is ahead of version ${doc.version}`,
        'payload.baseVersion',
      );
    }
  }
  for (const st of stamps(d)) {
    const doc = s.docs[st.documentId];
    if (!doc) return fail('unknown-document', `no document ${st.documentId}`);
    if (st.version !== doc.version) {
      return fail(
        'invalid-version',
        `positions are at version ${st.version}, document ${doc.id} is at ${doc.version}`,
      );
    }
  }
  const accountId = s.headSeq === 0 ? (opts.accountId ?? 'pending') : s.accountId;
  const unhashed = {
    ...d,
    seq: s.headSeq + 1,
    prevHash: s.headSeq === 0 ? GENESIS_PREV_HASH : s.headHash,
    serverTime: opts.serverTime ?? d.clientTime,
    accountId,
    hash: GENESIS_PREV_HASH,
  } as unknown as Commit;
  const commit = { ...unhashed, hash: computeCommitHash(unhashed) } as Commit;
  let next: LedgerState;
  try {
    next = applyCommit(state, commit);
  } catch (e) {
    if (e instanceof FoldError) {
      const code: LedgerErrorCode =
        e.code === 'invalid-content' && !isManuscriptEventType(d.type)
          ? 'manuscript-change-forbidden'
          : e.code;
      return fail(code, e.message);
    }
    throw e;
  }
  const before = s.issues.length;
  const after = internal(next).issues;
  if (after.length > before) {
    const errors: ValidationError[] = [];
    for (let i = before; i < after.length; i++) {
      const issue = pvecGet(after, i)!;
      errors.push({ code: issue.code, message: issue.message });
    }
    return { ok: false, errors };
  }
  return {
    ok: true,
    commit,
    state: next,
    resolutions: resolutionsBetween(state, next, commit.seq),
  };
}
