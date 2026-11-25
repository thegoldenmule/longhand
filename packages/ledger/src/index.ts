/**
 * @longhand/ledger — the deterministic fold (events → documents, provenance and
 * annotation state), ingest validation, the hash chain and witnesses, word
 * attribution, replay helpers and a ledger builder for tests. See
 * `packages/ledger/README.md` for the API and the semantics decisions.
 */

// The fold
export {
  applyCommit,
  applyCommitWithSteps,
  derivedStepsFor,
  emptyState,
  foldCommits,
  type DerivedSteps,
} from './fold';
export type { CommitInfo, LedgerState } from './state';
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

// Ingest validation
export {
  resolutionsBetween,
  validateDraft,
  type ValidateOptions,
  type ValidationError,
  type ValidationResult,
} from './validate';

// Hash chain and witnesses
export {
  ChainError,
  appendToChain,
  signWitness,
  verifyChain,
  verifyWitnesses,
  webCryptoSigner,
  type ChainHead,
  type ChainProblem,
  type ChainProblemCode,
  type ChainVerification,
  type WitnessProblem,
  type WitnessProblemCode,
  type WitnessVerification,
} from './chain';

// Word attribution
export {
  addCounts,
  attributeWords,
  charactersByClass,
  projectCharactersByClass,
  projectWordsByClass,
  wordsByClass,
  type ClassCounts,
  type CountScope,
  type WordAttribution,
} from './words';
export { TRUST_ORDER } from './prov';

// Replay and the span inspector
export {
  DEFAULT_SNAPSHOT_EVERY,
  Replay,
  spanHistory,
  stateAtSeq,
  type SpanHistory,
  type SpanMove,
} from './replay';

// The matcher's parameters
export {
  EDIT_DISTANCE_THRESHOLD,
  NGRAM_WORDS,
  editDistance,
  normalize as normalizeForMatch,
  normalizedEditDistance,
} from './matcher';

// Test support
export {
  LedgerBuilder,
  docEnd,
  type AnchorSpec,
  type At,
  type BuilderOptions,
  type SpanSpec,
  type TargetSpec,
  type TypeOptions,
} from './builder';
