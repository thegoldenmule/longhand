/**
 * @longhand/verifier — checks a Longhand verification bundle from scratch:
 * format, witness key, hash chain, witness signatures, a full re-fold and the
 * recomputed report. Runs in Node and browsers. See `packages/verifier/README.md`.
 */
export {
  verifyBundle,
  type Check,
  type CheckId,
  type CheckStatus,
  type VerificationResult,
  type VerifyOptions,
} from './verify';
export { describeDifference, diffJson, preview, type JsonDifference } from './diff';
export { formatResult } from './format';
