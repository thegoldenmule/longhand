/**
 * @longhand/ledger — the deterministic fold (events → documents, provenance and
 * annotation state), ingest validation, the hash chain, word attribution, replay
 * helpers and a ledger builder for tests. See `packages/ledger/README.md`.
 */
export { applyCommit, emptyState, foldCommits } from './fold';
export {
  commitInfo,
  documentNode,
  documentProvenance,
  documentVersion,
  foldIssues,
  headHash,
  headSeq,
  nodeJSON,
  projectState,
} from './project';
export { FoldError, type FoldIssue, type LedgerErrorCode } from './issues';
export type { CommitInfo, LedgerState } from './state';
export { EDIT_DISTANCE_THRESHOLD, NGRAM_WORDS, normalizedEditDistance } from './matcher';
