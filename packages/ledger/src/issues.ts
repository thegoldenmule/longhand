/**
 * Error and issue codes shared by the fold, ingest validation and chain verification.
 *
 * - A {@link FoldError} is thrown when a commit cannot be folded at all (a gap in
 *   the chain, steps that do not apply, a base version mismatch…). A ledger that
 *   throws is invalid.
 * - A {@link FoldIssue} is recorded (and the commit otherwise ignored) when a commit
 *   is well-formed but semantically wrong: it references an unknown annotation, a
 *   session that is not running, disagrees with the fold's own derivation, etc. A
 *   valid ledger has no issues; `validateDraft` rejects any draft that would add one,
 *   and the verifier fails a bundle whose fold reports any.
 */

/** Machine-readable codes. */
export type LedgerErrorCode =
  // Thrown by the fold (FoldError)
  | 'seq-gap'
  | 'prev-hash-mismatch'
  | 'project-not-created'
  | 'project-already-created'
  | 'project-mismatch'
  | 'unknown-document'
  | 'base-version-mismatch'
  | 'invalid-step'
  | 'step-failed'
  | 'invalid-content'
  | 'proposal-failed'
  // Recorded by the fold (FoldIssue)
  | 'duplicate-id'
  | 'unknown-target'
  | 'unknown-parent'
  | 'invalid-placement'
  | 'area-mismatch'
  | 'cycle'
  | 'unknown-session'
  | 'session-not-running'
  | 'session-mismatch'
  | 'session-kind'
  | 'cap-exceeded'
  | 'invalid-version'
  | 'invalid-position'
  | 'target-mismatch'
  | 'not-open'
  | 'document-mismatch'
  | 'resolution-mismatch'
  | 'witness-mismatch'
  | 'unknown-source'
  | 'unknown-request'
  | 'unknown-thread'
  | 'unknown-message'
  | 'unknown-hint'
  // Ingest validation only
  | 'invalid-draft'
  | 'actor-not-permitted'
  | 'actor-mismatch'
  | 'stale-base-version'
  | 'future-base-version'
  | 'manuscript-change-forbidden';

/** A semantic problem found while folding one commit. */
export interface FoldIssue {
  seq: number;
  code: LedgerErrorCode;
  message: string;
}

/** Thrown when a commit cannot be folded. */
export class FoldError extends Error {
  readonly seq: number;
  readonly code: LedgerErrorCode;
  constructor(seq: number, code: LedgerErrorCode, message: string) {
    super(`seq ${seq}: ${message}`);
    this.name = 'FoldError';
    this.seq = seq;
    this.code = code;
  }
}
