/**
 * Verification bundles and the export appendix.
 *
 * A bundle is the whole ledger, the server's witnesses, the witness public key
 * and the report computed from them. Anyone can hand it to `@longhand/verifier`,
 * which recomputes the report and fails if it differs.
 */
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  provenanceSummaryFromReport,
  type AuthorshipReport,
  type Commit,
  type ProvenanceSummary,
  type VerificationBundle,
  type Witness,
} from '@longhand/schema';
import { computeReport, type ComputeReportOptions } from './compute';

/** Input for {@link buildBundle}. */
export interface BuildBundleInput {
  /** The whole ledger, seq 1…n. */
  commits: readonly Commit[];
  /** One witness per commit. */
  witnesses: readonly Witness[];
  /** SPKI PEM of the witness key. */
  publicKeyPem: string;
  /** `keyIdFromPublicKeyPem(publicKeyPem)`. */
  keyId: string;
  /** What the report covers. */
  scope: ComputeReportOptions['scope'];
  /**
   * When the bundle was made (ISO). The server passes its clock. Defaults to the
   * head commit's server time, so building a bundle stays deterministic.
   */
  createdAt?: string;
}

/**
 * Builds a verification bundle with a freshly computed report. It checks
 * nothing; run `verifyBundle` on the result to confirm it verifies.
 */
export function buildBundle(input: BuildBundleInput): VerificationBundle {
  const head = input.commits[input.commits.length - 1];
  if (!head) throw new Error('buildBundle: the ledger has no commits');
  const report = computeReport(input.commits, {
    scope: input.scope,
    witnesses: input.witnesses,
  });
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    projectId: head.projectId,
    createdAt: input.createdAt ?? head.serverTime,
    commits: [...input.commits],
    witnesses: [...input.witnesses],
    publicKeyPem: input.publicKeyPem,
    keyId: input.keyId,
    report,
  };
}

/**
 * The provenance appendix input for `@longhand/export`, from a report (a thin
 * wrapper over the schema's `provenanceSummaryFromReport`). `verificationNote` is
 * printed at the end of the appendix, e.g. the bundle's head hash or a link.
 */
export function provenanceSummaryForExport(
  report: Pick<AuthorshipReport, 'words' | 'disclosure' | 'provesTable'>,
  verificationNote?: string | null,
): ProvenanceSummary {
  return provenanceSummaryFromReport(report, verificationNote);
}
