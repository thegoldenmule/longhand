/**
 * Ledger event types: every event that can appear in a project's ledger, its zod
 * payload schema, which actor kind may emit it, and whether it can change
 * manuscript text.
 *
 * Read `packages/schema/README.md` for the full table and the rules the fold
 * applies. The short version:
 *
 * - Exactly one actor kind may emit each event type (`ACTOR_PERMISSIONS`).
 * - Only {@link MANUSCRIPT_EVENT_TYPES} (`TextEdited`, `ProposalAccepted`,
 *   `DocumentImported`) may change manuscript text, and all three are human-only.
 * - Agent events only ever create annotations. Their text is AI text and never
 *   enters a document.
 * - Positions in agent events are resolved by the ledger service at append time
 *   and expressed in the document's *current* version (`version`); `readVersion`
 *   is the version the agent read when it chose its anchor.
 */
import { z } from 'zod';
import {
  RelativePositionSchema,
  SentenceIdSchema,
  BlockIdSchema,
  SpanRefSchema,
  StoredAnchorSchema,
  type Anchor,
  type SpanRef,
} from './anchors';
import {
  BinderAreaSchema,
  CslItemSchema,
  DismissReasonSchema,
  DocumentKindSchema,
  InputMethodSchema,
  IntensitySchema,
  KeystrokeKindSchema,
  LensSchema,
  LocatorSchema,
  ProjectSettingsSchema,
  SeveritySchema,
  TEXT_LIMITS,
  TitleSchema,
} from './domain';
import { DocJSONSchema } from './document';
import {
  IdSchema,
  IsoTimeSchema,
  PosSchema,
  SeqSchema,
  Sha256HexSchema,
  VersionSchema,
} from './ids';
import { BOUNDS } from './bounds';

// ---------------------------------------------------------------------------
// Shared payload parts
// ---------------------------------------------------------------------------

/** Kinds of actor that can author a commit. */
export const ActorKindSchema = z.enum(['human', 'agent', 'system']);
/** Kinds of actor that can author a commit. */
export type ActorKind = z.infer<typeof ActorKindSchema>;

/** ProseMirror step types accepted inside `TextEdited`. `docAttr` is excluded (the doc has no attrs). */
export const STEP_TYPES = [
  'replace',
  'replaceAround',
  'addMark',
  'removeMark',
  'addNodeMark',
  'removeNodeMark',
  'attr',
] as const;

/**
 * A `prosemirror-transform` `Step#toJSON()` value. Shape-checked only; the ledger
 * service re-applies every step to its own copy of the document and rejects the
 * commit if any step fails.
 */
export const StepJSONSchema = z.looseObject({ stepType: z.enum(STEP_TYPES) });
/** A serialized ProseMirror step. */
export type StepJSON = z.infer<typeof StepJSONSchema>;

/** Maximum steps in one `TextEdited` (the client flushes after ~2 s idle or 50 steps). */
export const MAX_STEPS_PER_COMMIT = 500;
/** Maximum keystroke timeline entries in one `TextEdited`. */
export const MAX_TIMELINE_ENTRIES = 20000;

/**
 * One keystroke-timeline entry: `t` ms after the commit's `clientTime` (the first
 * input event of the batch), what kind of input it was, and how many characters it
 * inserted or removed.
 */
export const KeystrokeSchema = z.object({
  t: z.number().int().min(0),
  kind: KeystrokeKindSchema,
  len: z.number().int().min(0),
});
/** One keystroke-timeline entry. */
export type Keystroke = z.infer<typeof KeystrokeSchema>;

/**
 * A run of consecutive steps that share an input method. Runs partition the
 * commit's steps in order: run k covers the `steps` steps after those covered by
 * runs 0…k-1, and the counts sum to `steps.length`.
 */
export const InputRunSchema = z
  .object({
    /** Number of consecutive steps this run covers (≥ 1). */
    steps: z.number().int().min(1),
    method: InputMethodSchema,
    /** `PasteOccurred.pasteId` (required for `pasted-external` and `pasted-internal`). */
    pasteId: IdSchema.optional(),
    /** `CitationInserted.citationId` (required for `citation`). */
    citationId: IdSchema.optional(),
    /** `ClippingSaved.clippingId` (required for `clipping`). */
    clippingId: IdSchema.optional(),
    /**
     * Optional client hint: these steps were typed in trace-over mode over this
     * suggestion. The fold's matcher decides the class and outcome regardless; the
     * hint can only add disclosure, never remove it.
     */
    traceSuggestionId: IdSchema.optional(),
  })
  .superRefine((run, ctx) => {
    const needs = {
      pasteId: run.method === 'pasted-external' || run.method === 'pasted-internal',
      citationId: run.method === 'citation',
      clippingId: run.method === 'clipping',
    } as const;
    for (const key of ['pasteId', 'citationId', 'clippingId'] as const) {
      if (needs[key] && run[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${run.method} runs require ${key}` });
      }
      if (!needs[key] && run[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is not allowed on ${run.method} runs`,
        });
      }
    }
    if (
      run.traceSuggestionId !== undefined &&
      !(run.method === 'typed' || run.method === 'ime' || run.method === 'autocorrect')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['traceSuggestionId'],
        message: 'trace-over applies to typed input only',
      });
    }
  });
/** A run of steps sharing an input method. */
export type InputRun = z.infer<typeof InputRunSchema>;

/**
 * Where a feedback request points: a selection (positions at `version`), a
 * document, or the whole project.
 */
export const FeedbackScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('selection'),
    documentId: IdSchema,
    from: PosSchema,
    to: PosSchema,
    version: VersionSchema,
  }),
  z.object({ kind: z.literal('document'), documentId: IdSchema }),
  z.object({ kind: z.literal('project') }),
]);
/** Scope of a feedback request. */
export type FeedbackScope = z.infer<typeof FeedbackScopeSchema>;

const positionStamp = {
  /** Start position, in the document at `version`. */
  from: PosSchema,
  /** End position, in the document at `version`. */
  to: PosSchema,
  /** Document version the agent read when it chose this target. */
  readVersion: VersionSchema,
  /** Document version `from`/`to` are expressed in (the current version when the event was appended). */
  version: VersionSchema,
};

/** An anchor resolved by the ledger service: the agent's normalized anchor plus positions. */
export const ResolvedAnchorSchema = z.object({ anchor: StoredAnchorSchema, ...positionStamp });
/** An anchor resolved to positions. */
export type ResolvedAnchor = z.infer<typeof ResolvedAnchorSchema>;

/** A span resolved by the ledger service: the agent's span reference plus positions. */
export const ResolvedSpanSchema = z.object({ span: SpanRefSchema, ...positionStamp });
/** A span resolved to positions. */
export type ResolvedSpan = z.infer<typeof ResolvedSpanSchema>;

/** What an annotation points at: an exact-quote anchor or a structural span. */
export const TargetSchema = z.discriminatedUnion('kind', [
  ResolvedAnchorSchema.extend({ kind: z.literal('anchor') }),
  ResolvedSpanSchema.extend({ kind: z.literal('span') }),
]);
/** What an annotation points at. */
export type Target = z.infer<typeof TargetSchema>;

/** The document a target lives in. */
export function targetDocumentId(target: { anchor: Anchor } | { span: SpanRef }): string {
  return 'anchor' in target ? target.anchor.documentId : target.span.documentId;
}

/** An insertion point before/after a sentence, resolved to a position. */
export const ResolvedPointSchema = z.object({
  documentId: IdSchema,
  position: RelativePositionSchema,
  sentenceId: SentenceIdSchema,
  pos: PosSchema,
  readVersion: VersionSchema,
  version: VersionSchema,
});
/** A resolved insertion point. */
export type ResolvedPoint = z.infer<typeof ResolvedPointSchema>;

const feedbackSessionId = IdSchema.describe('The feedback session this annotation belongs to.');

/** A source candidate surfaced by the AI (unverified until the writer adds it). */
export const SurfacedCandidateSchema = z.object({
  csl: CslItemSchema,
  provider: z.enum(['crossref', 'openlibrary', 'web']),
  url: z.string().max(2000).nullable(),
});
/** An AI-surfaced source candidate. */
export type SurfacedCandidate = z.infer<typeof SurfacedCandidateSchema>;

/** Where a library source came from. */
export const SourceOriginSchema = z.object({
  kind: z.enum(['url', 'doi', 'isbn', 'manual', 'surfaced']),
  /** The URL / DOI / ISBN the writer entered; null for manual entry. */
  value: z.string().max(2000).nullable(),
});
/** Where a library source came from. */
export type SourceOrigin = z.infer<typeof SourceOriginSchema>;

const binderPlacement = {
  /** Parent folder id, or null for the root of the area. */
  parentId: IdSchema.nullable(),
  /** 0-based index among the parent's children after the node is (re)inserted; clamped to the child count. */
  index: z.number().int().min(0),
};

// ---------------------------------------------------------------------------
// Human events
// ---------------------------------------------------------------------------

/** Creates the project. Must be the first commit (seq 1). */
export const ProjectCreatedSchema = z.object({ title: TitleSchema });

/** Changes project settings (genre, audience, goals, style notes, daily goal, citation style, title). */
export const ProjectSettingsChangedSchema = z.object({
  patch: ProjectSettingsSchema.partial().refine((p) => Object.keys(p).length > 0, 'empty patch'),
});

/** Creates an empty document (content `EMPTY_DOC_JSON`, version 0). Notes are documents of kind `note`. */
export const DocumentCreatedSchema = z.object({
  documentId: IdSchema,
  kind: DocumentKindSchema,
  title: TitleSchema,
  ...binderPlacement,
});

/**
 * Creates a document from an existing draft. All of its text is provenance class
 * `imported` (unverified). Manuscript event: the only way text enters without
 * steps.
 */
export const DocumentImportedSchema = z.object({
  documentId: IdSchema,
  kind: DocumentKindSchema,
  title: TitleSchema,
  ...binderPlacement,
  content: DocJSONSchema,
  sourceFormat: z.enum(['markdown', 'docx', 'text', 'html']),
  /** Original file name, if any. */
  sourceName: z.string().max(500).nullable(),
  /** SHA-256 of the original file bytes. */
  sourceHash: Sha256HexSchema,
});

/** Renames a document. */
export const DocumentRenamedSchema = z.object({ documentId: IdSchema, title: TitleSchema });

/** Moves/reorders a document within its area (never across areas). */
export const DocumentMovedSchema = z.object({ documentId: IdSchema, ...binderPlacement });

/** Archives (true) or restores (false) a document. Its content and history are kept. */
export const DocumentArchivedSchema = z.object({ documentId: IdSchema, archived: z.boolean() });

const synopsisText = z.string().max(TEXT_LIMITS.synopsisMaxChars);

/**
 * Replaces the corkboard synopsis of a document (`{documentId, synopsis}`) or a
 * folder (`{folderId, synopsis}`). Exactly one of `documentId` and `folderId` is
 * present. Writer text, not manuscript; human-only.
 */
export const SynopsisEditedSchema = z.union([
  z.object({ documentId: IdSchema, folderId: z.never().optional(), synopsis: synopsisText }),
  z.object({ folderId: IdSchema, documentId: z.never().optional(), synopsis: synopsisText }),
]);

/** Creates a folder in an area. */
export const FolderCreatedSchema = z.object({
  folderId: IdSchema,
  area: BinderAreaSchema,
  title: TitleSchema,
  ...binderPlacement,
});

/** Renames a folder. */
export const FolderRenamedSchema = z.object({ folderId: IdSchema, title: TitleSchema });

/** Moves/reorders a folder within its area (never into itself or a descendant). */
export const FolderMovedSchema = z.object({ folderId: IdSchema, ...binderPlacement });

/** Archives (true) or restores (false) a folder and, for display, its subtree. */
export const FolderArchivedSchema = z.object({ folderId: IdSchema, archived: z.boolean() });

/**
 * A batch of editor steps on one document. The only event carrying steps.
 * `clientTime` (envelope) is the time of the batch's first input event.
 */
export const TextEditedSchema = z
  .object({
    documentId: IdSchema,
    /** Document version the steps apply to; the ledger service rejects a mismatch. */
    baseVersion: VersionSchema,
    steps: z.array(StepJSONSchema).min(1).max(MAX_STEPS_PER_COMMIT),
    /** Input method per run of steps; partitions `steps` in order. */
    runs: z.array(InputRunSchema).min(1),
    /** Full keystroke timeline of the batch (always recorded). */
    timeline: z.array(KeystrokeSchema).max(MAX_TIMELINE_ENTRIES),
    /** Characters inserted by the steps (sum of inserted inline text lengths). */
    characters: z.number().int().min(0),
    /** Milliseconds from the first to the last input event of the batch. */
    durationMs: z.number().int().min(0),
  })
  .superRefine((p, ctx) => {
    const covered = p.runs.reduce((n, r) => n + r.steps, 0);
    if (covered !== p.steps.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['runs'],
        message: `runs cover ${covered} steps but the commit has ${p.steps.length}`,
      });
    }
    let prev = 0;
    p.timeline.forEach((k, i) => {
      if (k.t < prev)
        ctx.addIssue({
          code: 'custom',
          path: ['timeline', i, 't'],
          message: 'timeline must be non-decreasing',
        });
      if (k.t > p.durationMs)
        ctx.addIssue({
          code: 'custom',
          path: ['timeline', i, 't'],
          message: 't exceeds durationMs',
        });
      prev = k.t;
    });
  });

/**
 * Records a paste or drop into a document. Does not change text by itself: the
 * inserted content arrives in a later-or-same-batch `TextEdited` run that names this
 * `pasteId`, and the `PasteOccurred` must have a lower seq than that `TextEdited`.
 */
export const PasteOccurredSchema = z
  .object({
    pasteId: IdSchema,
    documentId: IdSchema,
    origin: z.enum(['external', 'internal']),
    via: z.enum(['clipboard', 'drop']),
    /** For internal pastes: the `SliceCopied.copyId` the clipboard content came from. */
    copyId: IdSchema.nullable(),
    /** Characters of inline text inserted. */
    characters: z.number().int().min(0),
    /** Words inserted (`countWords`). */
    words: z.number().int().min(0),
    /** SHA-256 of the inserted inline text (`inlineTextBetween(…, '\n')`). */
    textHash: Sha256HexSchema,
    /** Clipboard MIME types offered (e.g. `text/plain`, `text/html`). */
    mimeTypes: z.array(z.string().max(100)).max(20),
  })
  .refine((p) => (p.origin === 'internal') === (p.copyId !== null), {
    message: 'copyId is required for internal pastes and forbidden for external ones',
    path: ['copyId'],
  });

/**
 * Records a copy or cut from a document, so a later internal paste can inherit the
 * copied span's provenance. Positions refer to the document after every earlier
 * commit (the client flushes pending steps first). A cut's deletion arrives as a
 * normal `TextEdited`.
 */
export const SliceCopiedSchema = z
  .object({
    copyId: IdSchema,
    documentId: IdSchema,
    from: PosSchema,
    to: PosSchema,
    /** Document version the positions refer to. */
    version: VersionSchema,
    cut: z.boolean(),
    /** SHA-256 of the copied inline text (`inlineTextBetween(…, '\n')`). */
    textHash: Sha256HexSchema,
    characters: z.number().int().min(0),
  })
  .refine((p) => p.to > p.from, { message: 'empty slice', path: ['to'] });

/**
 * The writer accepts a move/cut/split/merge proposal. Manuscript event: the fold
 * derives the steps from the proposal and the current document, so no new words can
 * enter and moved words keep their provenance.
 */
export const ProposalAcceptedSchema = z.object({
  proposalId: IdSchema,
  documentId: IdSchema,
  /** Document version the writer saw when accepting; the ledger service rejects a mismatch. */
  baseVersion: VersionSchema,
});

/** The writer rejects a proposal. */
export const ProposalRejectedSchema = z.object({
  proposalId: IdSchema,
  reason: DismissReasonSchema.nullable(),
});

/**
 * The writer dismisses an annotation card. Applies to suggestions, comments,
 * questions, citation flags, surfaced sources and source suggestions (proposals use
 * `ProposalRejected`).
 */
export const SuggestionDismissedSchema = z.object({
  targetId: IdSchema,
  reason: DismissReasonSchema.nullable(),
  note: z.string().max(TEXT_LIMITS.dismissNoteMaxChars).nullable(),
});

/** The writer asks for feedback. The ledger service then starts an agent session. */
export const FeedbackRequestedSchema = z.object({
  requestId: IdSchema,
  scope: FeedbackScopeSchema,
  lenses: z
    .array(LensSchema)
    .min(1)
    .refine((l) => new Set(l).size === l.length, 'duplicate lens'),
  intensity: IntensitySchema,
  /** The writer's free-text ask ("Is the opening too slow?"). Never manuscript. */
  ask: z.string().max(TEXT_LIMITS.feedbackAskMaxChars).nullable(),
});

/**
 * The writer asks the editor a follow-up about an annotation (F4 "Discuss").
 * The first message on a target opens thread `threadId`; follow-ups reuse it.
 */
export const DiscussRequestedSchema = z.object({
  threadId: IdSchema,
  /** The annotation being discussed (suggestion, comment, proposal, question, flag…). */
  targetId: IdSchema,
  message: z
    .string()
    .min(1)
    .max(TEXT_LIMITS.discussMessageMaxChars)
    .refine((s) => s.trim().length > 0, 'message must not be blank'),
});

/** Adds a source to the library (writer-verified). `fromSurfacedId` when promoting an AI-surfaced candidate. */
export const SourceAddedSchema = z
  .object({
    sourceId: IdSchema,
    csl: CslItemSchema,
    origin: SourceOriginSchema,
    /** `SourceSurfaced.surfacedId` the writer checked and accepted, if any. */
    fromSurfacedId: IdSchema.nullable(),
    /** Index of the accepted candidate within that `SourceSurfaced`. */
    candidateIndex: z.number().int().min(0).nullable(),
  })
  .refine((p) => (p.fromSurfacedId === null) === (p.candidateIndex === null), {
    message: 'fromSurfacedId and candidateIndex go together',
    path: ['candidateIndex'],
  })
  .refine((p) => (p.origin.kind === 'surfaced') === (p.fromSurfacedId !== null), {
    message: 'origin.kind "surfaced" iff fromSurfacedId is set',
    path: ['origin'],
  });

/** Updates a library source: replace its CSL metadata, set its note, or archive/restore it. */
export const SourceUpdatedSchema = z
  .object({
    sourceId: IdSchema,
    csl: CslItemSchema.optional(),
    note: z.string().max(TEXT_LIMITS.sourceNoteMaxChars).optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (p) => p.csl !== undefined || p.note !== undefined || p.archived !== undefined,
    'empty update',
  );

/**
 * Records the Cite command. Does not change text by itself: the `citation` node
 * arrives in a `TextEdited` run with method `citation` naming this `citationId`
 * (lower seq first, like `PasteOccurred`).
 */
export const CitationInsertedSchema = z.object({
  citationId: IdSchema,
  documentId: IdSchema,
  sourceId: IdSchema,
  locator: LocatorSchema.nullable(),
});

/**
 * Saves a clipping (a quote with its location) to a source. Clipping text is
 * external text: placing it in the manuscript (a `TextEdited` run with method
 * `clipping`) yields provenance class `quoted`, never `typed`. Paragraphs are
 * separated by `"\n"`.
 */
export const ClippingSavedSchema = z.object({
  clippingId: IdSchema,
  sourceId: IdSchema,
  text: z
    .string()
    .min(1)
    .max(TEXT_LIMITS.clippingMaxChars)
    .refine((s) => s.trim().length > 0, 'clipping must not be blank'),
  locator: LocatorSchema.nullable(),
  note: z.string().max(TEXT_LIMITS.clippingNoteMaxChars).nullable(),
});

/** Removes a clipping from the library (quote blocks already placed are unaffected). */
export const ClippingRemovedSchema = z.object({ clippingId: IdSchema });

// ---------------------------------------------------------------------------
// Agent events (annotation layer only)
// ---------------------------------------------------------------------------

/** An agent session starts, for a feedback request or a discuss message. */
export const FeedbackSessionStartedSchema = z.object({
  feedbackSessionId: IdSchema,
  trigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('feedback'), requestId: IdSchema }),
    z.object({ kind: z.literal('discuss'), threadId: IdSchema }),
  ]),
  /** Model alias or id actually used (e.g. `opus`, `sonnet`). */
  model: z.string().min(1).max(100),
});

/** A margin comment. */
export const CommentAddedSchema = z.object({
  commentId: IdSchema,
  feedbackSessionId,
  target: TargetSchema,
  category: LensSchema,
  severity: SeveritySchema,
  body: z.string().min(1).max(BOUNDS.commentBodyMaxChars),
});

/** A question for the writer, optionally anchored. */
export const QuestionAskedSchema = z.object({
  questionId: IdSchema,
  feedbackSessionId,
  target: TargetSchema.nullable(),
  question: z.string().min(1).max(BOUNDS.questionMaxChars),
});

/** A wording suggestion: word choice (ghost alternatives), insertion (ghost sentence) or rephrase hint (no text). */
export const SuggestionProposedSchema = z.object({
  suggestionId: IdSchema,
  feedbackSessionId,
  suggestion: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('word-choice'),
      target: ResolvedAnchorSchema,
      alternatives: z
        .array(z.string().min(1))
        .min(BOUNDS.wordChoiceMinAlternatives)
        .max(BOUNDS.wordChoiceMaxAlternatives),
      rationale: z.string().min(1).max(BOUNDS.rationaleMaxChars),
    }),
    z.object({
      kind: z.literal('insertion'),
      target: ResolvedPointSchema,
      sentence: z.string().min(1).max(BOUNDS.insertionMaxChars),
      purpose: z.string().min(1).max(BOUNDS.purposeMaxChars),
    }),
    z.object({
      kind: z.literal('rephrase'),
      target: ResolvedAnchorSchema,
      guidance: z.string().min(1).max(BOUNDS.rephraseGuidanceMaxChars),
    }),
  ]),
});

/** Proposes moving a contiguous span before/after another unit. */
export const MoveProposedSchema = z.object({
  proposalId: IdSchema,
  feedbackSessionId,
  source: ResolvedSpanSchema,
  destination: z.object({
    position: RelativePositionSchema,
    /** Sentence id / paragraph id / heading id, matching `source.span.unit`. */
    id: z.string(),
    /** Insertion position in the document at `source.version`. */
    pos: PosSchema,
  }),
  rationale: z.string().min(1).max(BOUNDS.proposalRationaleMaxChars),
});

/** Proposes cutting a span (an anchor quote or whole units). */
export const CutProposedSchema = z.object({
  proposalId: IdSchema,
  feedbackSessionId,
  target: TargetSchema,
  rationale: z.string().min(1).max(BOUNDS.proposalRationaleMaxChars),
});

/** Proposes splitting a paragraph before one of its sentences. */
export const SplitProposedSchema = z.object({
  proposalId: IdSchema,
  feedbackSessionId,
  documentId: IdSchema,
  paragraphId: BlockIdSchema,
  sentenceId: SentenceIdSchema,
  /** Split position (start of the sentence) at `version`. */
  pos: PosSchema,
  readVersion: VersionSchema,
  version: VersionSchema,
  rationale: z.string().min(1).max(BOUNDS.proposalRationaleMaxChars),
});

/** Proposes merging two adjacent sibling paragraphs. */
export const MergeProposedSchema = z.object({
  proposalId: IdSchema,
  feedbackSessionId,
  documentId: IdSchema,
  firstParagraphId: BlockIdSchema,
  secondParagraphId: BlockIdSchema,
  /** Position between the two paragraph nodes at `version`. */
  joinPos: PosSchema,
  /** Range of both paragraphs (start of the first node to end of the second) at `version`. */
  from: PosSchema,
  to: PosSchema,
  readVersion: VersionSchema,
  version: VersionSchema,
  rationale: z.string().min(1).max(BOUNDS.proposalRationaleMaxChars),
});

/** Flags a claim that needs a source. */
export const CitationNeededFlaggedSchema = z.object({
  flagId: IdSchema,
  feedbackSessionId,
  target: ResolvedAnchorSchema,
  claim: z.string().min(1).max(BOUNDS.citationClaimMaxChars),
});

/** Candidate sources found by `search_sources`, labeled AI-surfaced and unverified. */
export const SourceSurfacedSchema = z.object({
  surfacedId: IdSchema,
  feedbackSessionId,
  query: z.string().min(1).max(BOUNDS.searchQueryMaxChars),
  target: ResolvedAnchorSchema.nullable(),
  candidates: z.array(SurfacedCandidateSchema).max(BOUNDS.searchMaxCandidates),
});

/** The agent suggests that a library source supports the claim at an anchor (`suggest_source`). */
export const SourceSuggestedSchema = z.object({
  sourceSuggestionId: IdSchema,
  feedbackSessionId,
  target: ResolvedAnchorSchema,
  sourceId: IdSchema,
  rationale: z.string().min(1).max(BOUNDS.rationaleMaxChars),
});

/** The agent's review summary; ends a feedback session (`finish_review`). */
export const ReviewFinishedSchema = z.object({
  feedbackSessionId,
  summary: z.string().min(1).max(BOUNDS.reviewSummaryMaxChars),
  strengths: z
    .array(z.string().min(1).max(BOUNDS.reviewItemMaxChars))
    .max(BOUNDS.reviewMaxStrengths),
  topPriorities: z
    .array(z.string().min(1).max(BOUNDS.reviewItemMaxChars))
    .max(BOUNDS.reviewMaxPriorities),
});

/** The editor's answer in a discuss thread (`answer_discussion`); ends a discuss session. */
export const DiscussAnsweredSchema = z.object({
  feedbackSessionId,
  threadId: IdSchema,
  targetId: IdSchema,
  body: z.string().min(1).max(BOUNDS.discussAnswerMaxChars),
});

// ---------------------------------------------------------------------------
// System events
// ---------------------------------------------------------------------------

/**
 * Records a suggestion or proposal outcome the fold derived from a human commit
 * (`triggerSeq`). The fold is authoritative: it derives outcomes itself and treats a
 * `SuggestionResolved` that disagrees with its derivation as a fold error, so the
 * verifier catches a lying server.
 */
export const SuggestionResolvedSchema = z
  .object({
    targetId: IdSchema,
    targetKind: z.enum(['suggestion', 'proposal']),
    outcome: z.enum(['adopted', 'adapted', 'stale']),
    triggerSeq: SeqSchema,
  })
  .refine((p) => p.targetKind === 'suggestion' || p.outcome === 'stale', {
    message: 'proposals only resolve as stale (accept/reject are human events)',
    path: ['outcome'],
  });

/**
 * Embeds the witness of an earlier commit into the chain itself, so dropping
 * out-of-band witnesses is detectable and later public anchoring has a hook.
 */
export const ChainHeadWitnessedSchema = z.object({
  witnessedSeq: SeqSchema,
  witnessedHash: Sha256HexSchema,
  serverTime: IsoTimeSchema,
  signature: z.string().min(1),
  keyId: Sha256HexSchema,
});

/** An agent session failed or could not start (CLI error, timeout, cap exhaustion without finish). */
export const FeedbackSessionFailedSchema = z.object({
  feedbackSessionId: IdSchema.nullable(),
  requestId: IdSchema.nullable(),
  threadId: IdSchema.nullable(),
  reason: z.string().min(1).max(500),
});

// ---------------------------------------------------------------------------
// The event table
// ---------------------------------------------------------------------------

interface EventDefinition<S extends z.ZodType = z.ZodType> {
  /** The only actor kind allowed to emit this event. */
  readonly actor: ActorKind;
  /** True if folding this event can change manuscript text. */
  readonly manuscript: boolean;
  readonly payload: S;
}

const def = <S extends z.ZodType>(
  actor: ActorKind,
  manuscript: boolean,
  payload: S,
): EventDefinition<S> => ({
  actor,
  manuscript,
  payload,
});

/**
 * Every ledger event type with its actor, manuscript flag and payload schema.
 * The single source of truth for {@link EVENT_TYPES}, {@link ACTOR_PERMISSIONS} and
 * {@link MANUSCRIPT_EVENT_TYPES}.
 */
export const EVENTS = {
  // Human
  ProjectCreated: def('human', false, ProjectCreatedSchema),
  ProjectSettingsChanged: def('human', false, ProjectSettingsChangedSchema),
  DocumentCreated: def('human', false, DocumentCreatedSchema),
  DocumentImported: def('human', true, DocumentImportedSchema),
  DocumentRenamed: def('human', false, DocumentRenamedSchema),
  DocumentMoved: def('human', false, DocumentMovedSchema),
  DocumentArchived: def('human', false, DocumentArchivedSchema),
  SynopsisEdited: def('human', false, SynopsisEditedSchema),
  FolderCreated: def('human', false, FolderCreatedSchema),
  FolderRenamed: def('human', false, FolderRenamedSchema),
  FolderMoved: def('human', false, FolderMovedSchema),
  FolderArchived: def('human', false, FolderArchivedSchema),
  TextEdited: def('human', true, TextEditedSchema),
  PasteOccurred: def('human', false, PasteOccurredSchema),
  SliceCopied: def('human', false, SliceCopiedSchema),
  ProposalAccepted: def('human', true, ProposalAcceptedSchema),
  ProposalRejected: def('human', false, ProposalRejectedSchema),
  SuggestionDismissed: def('human', false, SuggestionDismissedSchema),
  FeedbackRequested: def('human', false, FeedbackRequestedSchema),
  DiscussRequested: def('human', false, DiscussRequestedSchema),
  SourceAdded: def('human', false, SourceAddedSchema),
  SourceUpdated: def('human', false, SourceUpdatedSchema),
  CitationInserted: def('human', false, CitationInsertedSchema),
  ClippingSaved: def('human', false, ClippingSavedSchema),
  ClippingRemoved: def('human', false, ClippingRemovedSchema),
  // Agent
  FeedbackSessionStarted: def('agent', false, FeedbackSessionStartedSchema),
  CommentAdded: def('agent', false, CommentAddedSchema),
  QuestionAsked: def('agent', false, QuestionAskedSchema),
  SuggestionProposed: def('agent', false, SuggestionProposedSchema),
  MoveProposed: def('agent', false, MoveProposedSchema),
  CutProposed: def('agent', false, CutProposedSchema),
  SplitProposed: def('agent', false, SplitProposedSchema),
  MergeProposed: def('agent', false, MergeProposedSchema),
  CitationNeededFlagged: def('agent', false, CitationNeededFlaggedSchema),
  SourceSurfaced: def('agent', false, SourceSurfacedSchema),
  SourceSuggested: def('agent', false, SourceSuggestedSchema),
  ReviewFinished: def('agent', false, ReviewFinishedSchema),
  DiscussAnswered: def('agent', false, DiscussAnsweredSchema),
  // System
  SuggestionResolved: def('system', false, SuggestionResolvedSchema),
  ChainHeadWitnessed: def('system', false, ChainHeadWitnessedSchema),
  FeedbackSessionFailed: def('system', false, FeedbackSessionFailedSchema),
} as const satisfies Record<string, EventDefinition>;

/** Name of a ledger event type. */
export type EventType = keyof typeof EVENTS;

/** Payload type of each event type. */
export type EventPayloads = { [K in EventType]: z.infer<(typeof EVENTS)[K]['payload']> };

/** Payload type of event type `K`. */
export type EventPayload<K extends EventType> = EventPayloads[K];

/** Every event type, in table order. */
export const EVENT_TYPES = Object.keys(EVENTS) as EventType[];

/** Zod schema for an event type name. */
export const EventTypeSchema = z.enum(EVENT_TYPES as [EventType, ...EventType[]]);

/** Which actor kinds may emit each event type (exactly one per type). */
export const ACTOR_PERMISSIONS: Readonly<Record<EventType, readonly ActorKind[]>> = Object.freeze(
  Object.fromEntries(EVENT_TYPES.map((t) => [t, Object.freeze([EVENTS[t].actor])])) as Record<
    EventType,
    readonly ActorKind[]
  >,
);

/**
 * The only event types whose fold may change manuscript text. All are human-only;
 * the ledger service rejects any other event that would change text.
 */
export const MANUSCRIPT_EVENT_TYPES: readonly EventType[] = Object.freeze(
  EVENT_TYPES.filter((t) => EVENTS[t].manuscript),
);

/** Event types each actor kind may emit. */
export const EVENT_TYPES_BY_ACTOR: Readonly<Record<ActorKind, readonly EventType[]>> =
  Object.freeze({
    human: Object.freeze(EVENT_TYPES.filter((t) => EVENTS[t].actor === 'human')),
    agent: Object.freeze(EVENT_TYPES.filter((t) => EVENTS[t].actor === 'agent')),
    system: Object.freeze(EVENT_TYPES.filter((t) => EVENTS[t].actor === 'system')),
  });

/** True if an actor of `actorKind` may emit an event of `type`. Unknown types are never allowed. */
export function canActorEmit(type: string, actorKind: ActorKind): boolean {
  const perms = (ACTOR_PERMISSIONS as Record<string, readonly ActorKind[] | undefined>)[type];
  return perms !== undefined && perms.includes(actorKind);
}

/** True if `type` is a manuscript event type. */
export function isManuscriptEventType(type: string): boolean {
  return (MANUSCRIPT_EVENT_TYPES as readonly string[]).includes(type);
}

/** Validates a payload against its event type's schema. */
export function parsePayload<K extends EventType>(type: K, payload: unknown): EventPayload<K> {
  return EVENTS[type].payload.parse(payload) as EventPayload<K>;
}
