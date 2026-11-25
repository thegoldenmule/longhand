/**
 * @longhand/report — the authorship report (F7): `computeReport`, the
 * disclosure template, verification bundles, the export appendix input and the
 * `<AuthorshipReport>` page. See `packages/report/README.md`.
 */
export { computeReport, normalizeScope, type ComputeReportOptions } from './compute';
export { disclosureStatement, wordShares, type DisclosureInput } from './disclosure';
export { buildBundle, provenanceSummaryForExport, type BuildBundleInput } from './bundle';
export {
  UNWITNESSED_LAG_MS,
  unwitnessedIntervals,
  type UnwitnessedInterval,
  type UnwitnessedReason,
} from './unwitnessed';
export {
  ASSISTED_KINDS,
  type AssistedKind,
  type Report,
  type ReportAiSession,
  type ReportExtensions,
  type SuggestionOutcomeCounts,
} from './types';
export {
  allocateTenths,
  count,
  formatDuration,
  formatInt,
  formatUtc,
  joinList,
  percentLabel,
} from './format';
export { AuthorshipReport, type AuthorshipReportProps } from './AuthorshipReport';
