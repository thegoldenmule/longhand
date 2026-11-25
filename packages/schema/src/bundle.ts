/**
 * The verification bundle (F7) and the authorship report's top-level shape.
 *
 * A bundle carries the full project ledger, the server's witnesses, the public key
 * and the report. The verifier checks the hash chain and every signature, re-folds
 * the ledger, recomputes the report, and fails if the recomputed report's canonical
 * JSON differs from the shared one.
 *
 * The report lane owns the report's computation and may add fields; this module
 * fixes the required top-level structure so the verifier, export and UI agree.
 */
import { z } from 'zod';
import { IdSchema, IsoTimeSchema, SeqSchema, Sha256HexSchema } from './ids';
import { CommitSchema, WitnessSchema } from './ledger';
import { ProvenanceClassSchema } from './provenance';

/** The bundle's `format` tag. */
export const BUNDLE_FORMAT = 'longhand-bundle';
/** Current bundle format version. */
export const BUNDLE_VERSION = 1;
/** Current report structure version. */
export const REPORT_VERSION = 1;

/**
 * What the record proves and does not prove — printed verbatim in every report
 * (spec "What the record proves, and what it doesn't").
 */
export const PROVES_TABLE = Object.freeze({
  proves: Object.freeze([
    "The text came in through the editor's input channel, at these times and this cadence",
    'Exactly which AI suggestions were visible, and which were retyped or used',
    "The history hasn't been changed since the server witnessed it",
  ]),
  doesNotProve: Object.freeze([
    'That the account holder was the one typing',
    'That nothing was transcribed from another screen or another AI',
    "That a modified client didn't misreport pastes as typing (the keystroke timeline makes this costly, not impossible)",
  ]),
});

const count = z.number().int().min(0);
const byClass = z.object(
  Object.fromEntries(ProvenanceClassSchema.options.map((c) => [c, count])) as Record<
    z.infer<typeof ProvenanceClassSchema>,
    typeof count
  >,
);
const pasteTotals = z.object({ count, characters: count, words: count });
const proposalOutcomes = z.object({
  proposed: count,
  accepted: count,
  rejected: count,
  stale: count,
  open: count,
});

/** What a report covers. */
export const ReportScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }),
  z.object({ kind: z.literal('document'), documentId: IdSchema }),
]);
/** What a report covers. */
export type ReportScope = z.infer<typeof ReportScopeSchema>;

/**
 * The authorship report. Every field is derived from the ledger (and, for
 * `unwitnessed`, the witnesses) by the report lane's pure function, so the
 * verifier can recompute it exactly. Extra fields are allowed (loose object); put
 * lane-specific data under `extensions`.
 */
export const AuthorshipReportSchema = z.looseObject({
  reportVersion: z.literal(REPORT_VERSION),
  scope: ReportScopeSchema,
  /** The report covers commits 1…throughSeq. */
  throughSeq: SeqSchema,
  /** Hash of commit `throughSeq`. */
  headHash: Sha256HexSchema,
  /** Words by provenance class (`pasted-internal` is always 0: internal pastes inherit). */
  words: z.object({ total: count, byClass }),
  characters: z.object({ total: count, byClass }),
  /** Sum of TextEdited `durationMs`. */
  activeWritingMs: count,
  sessions: z.object({
    count,
    /** Distinct UTC calendar days with at least one session. */
    days: count,
    firstAt: IsoTimeSchema.nullable(),
    lastAt: IsoTimeSchema.nullable(),
    list: z.array(
      z.looseObject({
        startTime: IsoTimeSchema,
        endTime: IsoTimeSchema,
        activeMs: count,
        charactersInserted: count,
      }),
    ),
  }),
  ai: z.looseObject({
    feedbackRequests: count,
    sessionsFinished: count,
    sessionsFailed: count,
    comments: count,
    questions: count,
    citationFlags: count,
    surfacedSources: count,
    discussThreads: count,
  }),
  suggestions: z.object({
    total: count,
    byKind: z.object({ 'word-choice': count, insertion: count, rephrase: count }),
    byOutcome: z.object({
      open: count,
      adopted: count,
      adapted: count,
      stale: count,
      dismissed: count,
    }),
  }),
  proposals: z.object({
    total: count,
    byKind: z.object({
      move: proposalOutcomes,
      cut: proposalOutcomes,
      split: proposalOutcomes,
      merge: proposalOutcomes,
    }),
  }),
  pastes: z.object({
    external: pasteTotals,
    internal: pasteTotals,
    events: z.array(
      z.looseObject({
        seq: SeqSchema,
        time: IsoTimeSchema,
        documentId: IdSchema,
        origin: z.enum(['external', 'internal']),
        via: z.enum(['clipboard', 'drop']),
        characters: count,
        words: count,
      }),
    ),
  }),
  imports: z.object({ documents: count, words: count }),
  /** Commits that reached the server late (queued offline): intervals not witnessed at the time. */
  unwitnessed: z.array(
    z.looseObject({
      fromSeq: SeqSchema,
      toSeq: SeqSchema,
      firstClientTime: IsoTimeSchema,
      lastClientTime: IsoTimeSchema,
      serverTime: IsoTimeSchema,
    }),
  ),
  /** Disclosure statement generated by template from the data (never by an LLM). */
  disclosure: z.string(),
  /** Always {@link PROVES_TABLE}. */
  provesTable: z.object({ proves: z.array(z.string()), doesNotProve: z.array(z.string()) }),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
/** The authorship report. */
export type AuthorshipReport = z.infer<typeof AuthorshipReportSchema>;

/**
 * Zod schema for a verification bundle. Note for verifiers: compute hashes over
 * the commits exactly as they appear in the bundle JSON, not over parsed output.
 */
export const VerificationBundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  projectId: IdSchema,
  /** Server time the bundle was produced (not part of the report). */
  createdAt: IsoTimeSchema,
  /** The full project ledger, seq 1…n in order. */
  commits: z.array(CommitSchema).min(1),
  /** One witness per commit, in seq order. */
  witnesses: z.array(WitnessSchema),
  /** SPKI PEM of the witness key. */
  publicKeyPem: z.string().min(1),
  /** `keyIdFromPublicKeyPem(publicKeyPem)`. */
  keyId: Sha256HexSchema,
  report: AuthorshipReportSchema,
});
/** A verification bundle. */
export type VerificationBundle = z.infer<typeof VerificationBundleSchema>;
