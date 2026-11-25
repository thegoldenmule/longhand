/**
 * The agent tool catalog: zod input schemas, JSON Schemas (for the MCP server and
 * the model), bounds, caps and counting rules.
 *
 * None of these tools writes manuscript text. There is deliberately no
 * `rewrite_paragraph`, no `replace_text`, and no tool that takes free text bound for
 * the manuscript. Every annotation tool results in exactly one agent event.
 *
 * The zod schemas check everything that can be checked without the document
 * (lengths, word counts, the one-sentence rule). The agent's handler then resolves
 * anchors/spans against the document (`resolveAnchor`, `resolveSpan`, …), runs
 * {@link rephraseGuidanceViolation} for rephrase hints, and enforces caps with
 * {@link capViolation}.
 */
import { z } from 'zod';
import {
  AnchorSchema,
  BlockIdSchema,
  RelativePositionSchema,
  SentenceIdSchema,
  SpanRefSchema,
  SpanUnitSchema,
  type AnchorErrorCode,
} from './anchors';
import { BOUNDS, capsFor } from './bounds';
import { LensSchema, SeveritySchema, type Intensity } from './domain';
import type { EventType, SurfacedCandidate } from './events';
import { IdSchema } from './ids';
import { countWords, splitSentences } from './text';

const nonBlank = (max: number, what: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim().length > 0, `${what} must not be blank`);

const rationale = nonBlank(BOUNDS.rationaleMaxChars, 'rationale').describe(
  `Why, in at most ${BOUNDS.rationaleMaxChars} characters.`,
);
const proposalRationale = nonBlank(BOUNDS.proposalRationaleMaxChars, 'rationale').describe(
  `Why this change helps, in at most ${BOUNDS.proposalRationaleMaxChars} characters.`,
);
const anchor = AnchorSchema.describe(
  'Points at text: a sentence id plus an exact quote from that sentence (and an occurrence index if the quote repeats in it).',
);
const span = SpanRefSchema.describe(
  'A contiguous run of whole units: consecutive sentence ids of one paragraph, adjacent top-level paragraph ids, or top-level heading ids (sections).',
);

function exactlyOneTarget(v: { anchor?: unknown; span?: unknown }, ctx: z.RefinementCtx): void {
  if ((v.anchor === undefined) === (v.span === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['anchor'],
      message: 'pass exactly one of anchor or span',
    });
  }
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/** `read_document` — read one document, segmented into `[p3.s2]` sentences. */
export const ReadDocumentInput = z.object({
  documentId: IdSchema.describe('Id of the document to read.'),
});

/** `read_notes` — read notes (characters, outline, style guide, thesis…). */
export const ReadNotesInput = z.object({
  noteIds: z
    .array(IdSchema)
    .max(BOUNDS.readNotesMaxIds)
    .optional()
    .describe('Note document ids to read; omit to read all notes.'),
});

/** `get_outline` — the binder outline with titles and synopses. */
export const GetOutlineInput = z.object({});

/** `comment` — an anchored margin comment. */
export const CommentInput = z
  .object({
    anchor: anchor.optional(),
    span: span.optional(),
    category: LensSchema.describe('The lens this comment belongs to.'),
    severity: SeveritySchema.describe('How much this matters.'),
    body: nonBlank(BOUNDS.commentBodyMaxChars, 'body').describe(
      `The comment, at most ${BOUNDS.commentBodyMaxChars} characters. Diagnose and explain; do not write replacement prose.`,
    ),
  })
  .superRefine(exactlyOneTarget);

/** `ask_question` — a question for the writer, optionally anchored. */
export const AskQuestionInput = z.object({
  anchor: anchor.optional(),
  question: nonBlank(BOUNDS.questionMaxChars, 'question').describe(
    `The question, at most ${BOUNDS.questionMaxChars} characters.`,
  ),
});

/** `suggest_word_choice` — 1–3 short alternatives for a span of at most 4 words. */
export const SuggestWordChoiceInput = z
  .object({
    anchor: anchor.describe(
      `The word or phrase to replace: an exact quote of at most ${BOUNDS.wordChoiceAnchorMaxWords} words.`,
    ),
    alternatives: z
      .array(nonBlank(100, 'alternative'))
      .min(BOUNDS.wordChoiceMinAlternatives)
      .max(BOUNDS.wordChoiceMaxAlternatives)
      .describe(
        `${BOUNDS.wordChoiceMinAlternatives}-${BOUNDS.wordChoiceMaxAlternatives} alternatives of at most ${BOUNDS.wordChoiceAlternativeMaxWords} words each.`,
      ),
    rationale,
  })
  .superRefine((v, ctx) => {
    if (countWords(v.anchor.quote) > BOUNDS.wordChoiceAnchorMaxWords) {
      ctx.addIssue({
        code: 'custom',
        path: ['anchor', 'quote'],
        message: `the anchored span must be at most ${BOUNDS.wordChoiceAnchorMaxWords} words`,
      });
    }
    const seen = new Set<string>();
    v.alternatives.forEach((alt, i) => {
      const n = countWords(alt);
      if (n === 0 || n > BOUNDS.wordChoiceAlternativeMaxWords) {
        ctx.addIssue({
          code: 'custom',
          path: ['alternatives', i],
          message: `each alternative must be 1-${BOUNDS.wordChoiceAlternativeMaxWords} words`,
        });
      }
      const key = alt.trim().toLowerCase();
      if (key === v.anchor.quote.trim().toLowerCase()) {
        ctx.addIssue({
          code: 'custom',
          path: ['alternatives', i],
          message: 'alternative repeats the original',
        });
      }
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['alternatives', i],
          message: 'duplicate alternative',
        });
      }
      seen.add(key);
    });
  });

/** `suggest_insertion` — exactly one sentence (≤ 40 words) before or after a sentence. */
export const SuggestInsertionInput = z
  .object({
    documentId: IdSchema,
    position: RelativePositionSchema.describe('Insert before or after the sentence.'),
    sentenceId: SentenceIdSchema,
    sentence: nonBlank(BOUNDS.insertionMaxChars, 'sentence').describe(
      `Exactly one sentence of at most ${BOUNDS.insertionMaxWords} words.`,
    ),
    purpose: nonBlank(BOUNDS.purposeMaxChars, 'purpose').describe(
      `What the sentence is for, in at most ${BOUNDS.purposeMaxChars} characters.`,
    ),
  })
  .superRefine((v, ctx) => {
    if (splitSentences(v.sentence).length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['sentence'], message: 'must be exactly one sentence' });
    }
    if (countWords(v.sentence) > BOUNDS.insertionMaxWords) {
      ctx.addIssue({
        code: 'custom',
        path: ['sentence'],
        message: `must be at most ${BOUNDS.insertionMaxWords} words`,
      });
    }
  });

/** `suggest_rephrase` — a hint about what to change in one sentence, with no replacement text. */
export const SuggestRephraseInput = z.object({
  anchor: anchor.describe('The span to rephrase (within one sentence).'),
  guidance: nonBlank(BOUNDS.rephraseGuidanceMaxChars, 'guidance').describe(
    `What to change and why, at most ${BOUNDS.rephraseGuidanceMaxChars} characters. Never supply the new wording.`,
  ),
});

/** `propose_move` — move a contiguous run of sentences, paragraphs or sections. */
export const ProposeMoveInput = z.object({
  documentId: IdSchema,
  unit: SpanUnitSchema,
  ids: SpanRefSchema.shape.ids.describe('Contiguous ids of the unit to move, in order.'),
  destination: z
    .object({
      position: RelativePositionSchema,
      id: z.string().describe('A sentence id, paragraph id or heading id matching `unit`.'),
    })
    .describe('Where the span goes: before or after another unit of the same kind.'),
  rationale: proposalRationale,
});

/** `propose_cut` — cut an anchored span or whole units. */
export const ProposeCutInput = z
  .object({ anchor: anchor.optional(), span: span.optional(), rationale: proposalRationale })
  .superRefine(exactlyOneTarget);

/** `propose_split` — split a paragraph before one of its sentences. */
export const ProposeSplitInput = z.object({
  documentId: IdSchema,
  paragraphId: BlockIdSchema,
  sentenceId: SentenceIdSchema.describe(
    'Split before this sentence (not the first of the paragraph).',
  ),
  rationale: proposalRationale,
});

/** `propose_merge` — merge two adjacent paragraphs. */
export const ProposeMergeInput = z.object({
  documentId: IdSchema,
  firstParagraphId: BlockIdSchema,
  secondParagraphId: BlockIdSchema.describe('Must directly follow the first paragraph.'),
  rationale: proposalRationale,
});

/** `flag_citation_needed` — flag a claim that needs a source. */
export const FlagCitationNeededInput = z.object({
  anchor: anchor.describe('The claim.'),
  claim: nonBlank(BOUNDS.citationClaimMaxChars, 'claim').describe(
    `The claim restated in at most ${BOUNDS.citationClaimMaxChars} characters.`,
  ),
});

/** `search_sources` — search for candidate sources (results are labeled AI-surfaced, unverified). */
export const SearchSourcesInput = z.object({
  query: nonBlank(BOUNDS.searchQueryMaxChars, 'query'),
  anchor: anchor.optional().describe('The claim the sources are for, if any.'),
});

/** `suggest_source` — suggest which library source supports a claim. */
export const SuggestSourceInput = z.object({
  anchor: anchor.describe('The claim.'),
  sourceId: IdSchema.describe('Id of a source already in the library.'),
  rationale,
});

/** `answer_discussion` — the editor's reply in a Discuss thread (Longhand addition for F4). */
export const AnswerDiscussionInput = z.object({
  threadId: IdSchema,
  body: nonBlank(BOUNDS.discussAnswerMaxChars, 'body').describe(
    `Your answer, at most ${BOUNDS.discussAnswerMaxChars} characters.`,
  ),
});

/** `finish_review` — the review summary; ends the session (required). */
export const FinishReviewInput = z.object({
  summary: nonBlank(BOUNDS.reviewSummaryMaxChars, 'summary').describe('Your overall read.'),
  strengths: z
    .array(nonBlank(BOUNDS.reviewItemMaxChars, 'strength'))
    .max(BOUNDS.reviewMaxStrengths),
  topPriorities: z
    .array(nonBlank(BOUNDS.reviewItemMaxChars, 'priority'))
    .max(BOUNDS.reviewMaxPriorities)
    .describe(`At most ${BOUNDS.reviewMaxPriorities}, most important first.`),
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** What a tool call counts toward. */
export interface ToolCounts {
  item: boolean;
  suggestion: boolean;
  insertion: boolean;
  proposal: boolean;
  question: boolean;
  search: boolean;
}

/** Kind of agent session. Review sessions answer a `FeedbackRequested`; discuss sessions answer a `DiscussRequested`. */
export type AgentSessionKind = 'review' | 'discuss';

/** One tool in the catalog. */
export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  kind: 'read' | 'annotate' | 'research' | 'control';
  input: S;
  /** The agent event a successful call produces (null for read tools). */
  emits: EventType | null;
  counts: ToolCounts;
  /** Session kinds the tool is offered in. */
  sessions: readonly AgentSessionKind[];
}

const NONE: ToolCounts = {
  item: false,
  suggestion: false,
  insertion: false,
  proposal: false,
  question: false,
  search: false,
};
const ITEM: ToolCounts = { ...NONE, item: true };
const BOTH = ['review', 'discuss'] as const;
const REVIEW = ['review'] as const;

function tool<S extends z.ZodType>(d: ToolDefinition<S>): ToolDefinition<S> {
  return d;
}

/** The tool catalog, keyed by tool name. */
export const TOOLS = {
  read_document: tool({
    name: 'read_document',
    description:
      'Read one document of the project, segmented into sentences with ids like [p3.s2]. Read-only.',
    kind: 'read',
    input: ReadDocumentInput,
    emits: null,
    counts: NONE,
    sessions: BOTH,
  }),
  read_notes: tool({
    name: 'read_notes',
    description: "Read the writer's notes (characters, outline, style guide, thesis). Read-only.",
    kind: 'read',
    input: ReadNotesInput,
    emits: null,
    counts: NONE,
    sessions: BOTH,
  }),
  get_outline: tool({
    name: 'get_outline',
    description:
      'Get the binder outline: folders and documents in order, with titles and synopses. Read-only.',
    kind: 'read',
    input: GetOutlineInput,
    emits: null,
    counts: NONE,
    sessions: BOTH,
  }),
  comment: tool({
    name: 'comment',
    description:
      'Leave a margin comment anchored to exact text (or to whole sentences/paragraphs/sections). Diagnose and explain; never supply replacement prose.',
    kind: 'annotate',
    input: CommentInput,
    emits: 'CommentAdded',
    counts: ITEM,
    sessions: REVIEW,
  }),
  ask_question: tool({
    name: 'ask_question',
    description: 'Ask the writer a question, optionally anchored to text.',
    kind: 'annotate',
    input: AskQuestionInput,
    emits: 'QuestionAsked',
    counts: { ...ITEM, question: true },
    sessions: REVIEW,
  }),
  suggest_word_choice: tool({
    name: 'suggest_word_choice',
    description: `Offer ${BOUNDS.wordChoiceMinAlternatives}-${BOUNDS.wordChoiceMaxAlternatives} alternatives (each at most ${BOUNDS.wordChoiceAlternativeMaxWords} words) for a word or phrase of at most ${BOUNDS.wordChoiceAnchorMaxWords} words. Shown as ghost text; only the writer can type it.`,
    kind: 'annotate',
    input: SuggestWordChoiceInput,
    emits: 'SuggestionProposed',
    counts: { ...ITEM, suggestion: true },
    sessions: REVIEW,
  }),
  suggest_insertion: tool({
    name: 'suggest_insertion',
    description: `Suggest inserting exactly one sentence (at most ${BOUNDS.insertionMaxWords} words) before or after a sentence. Use sparingly.`,
    kind: 'annotate',
    input: SuggestInsertionInput,
    emits: 'SuggestionProposed',
    counts: { ...ITEM, suggestion: true, insertion: true },
    sessions: REVIEW,
  }),
  suggest_rephrase: tool({
    name: 'suggest_rephrase',
    description:
      'Point at a span within one sentence and say what to change and why, without supplying the new wording.',
    kind: 'annotate',
    input: SuggestRephraseInput,
    emits: 'SuggestionProposed',
    counts: { ...ITEM, suggestion: true },
    sessions: REVIEW,
  }),
  propose_move: tool({
    name: 'propose_move',
    description:
      'Propose moving a contiguous run of sentences, paragraphs or sections before or after another unit of the same kind. The words inside are never changed; the writer accepts or rejects with one click.',
    kind: 'annotate',
    input: ProposeMoveInput,
    emits: 'MoveProposed',
    counts: { ...ITEM, proposal: true },
    sessions: REVIEW,
  }),
  propose_cut: tool({
    name: 'propose_cut',
    description: 'Propose cutting an anchored span or a contiguous run of whole units.',
    kind: 'annotate',
    input: ProposeCutInput,
    emits: 'CutProposed',
    counts: { ...ITEM, proposal: true },
    sessions: REVIEW,
  }),
  propose_split: tool({
    name: 'propose_split',
    description: 'Propose splitting a paragraph into two before one of its sentences.',
    kind: 'annotate',
    input: ProposeSplitInput,
    emits: 'SplitProposed',
    counts: { ...ITEM, proposal: true },
    sessions: REVIEW,
  }),
  propose_merge: tool({
    name: 'propose_merge',
    description: 'Propose merging two adjacent paragraphs into one.',
    kind: 'annotate',
    input: ProposeMergeInput,
    emits: 'MergeProposed',
    counts: { ...ITEM, proposal: true },
    sessions: REVIEW,
  }),
  flag_citation_needed: tool({
    name: 'flag_citation_needed',
    description:
      'Flag a claim that needs a source, restating the claim briefly. Never write the claim yourself.',
    kind: 'research',
    input: FlagCitationNeededInput,
    emits: 'CitationNeededFlagged',
    counts: ITEM,
    sessions: REVIEW,
  }),
  search_sources: tool({
    name: 'search_sources',
    description:
      'Search Crossref, Open Library and the web for candidate sources. Results are shown to the writer labeled AI-surfaced and unverified.',
    kind: 'research',
    input: SearchSourcesInput,
    emits: 'SourceSurfaced',
    counts: { ...ITEM, search: true },
    sessions: REVIEW,
  }),
  suggest_source: tool({
    name: 'suggest_source',
    description:
      "Suggest which source already in the writer's library supports the claim at an anchor.",
    kind: 'research',
    input: SuggestSourceInput,
    emits: 'SourceSuggested',
    counts: ITEM,
    sessions: REVIEW,
  }),
  answer_discussion: tool({
    name: 'answer_discussion',
    description:
      "Answer the writer's follow-up question in a Discuss thread. Ends the discuss session.",
    kind: 'control',
    input: AnswerDiscussionInput,
    emits: 'DiscussAnswered',
    counts: NONE,
    sessions: ['discuss'],
  }),
  finish_review: tool({
    name: 'finish_review',
    description:
      'Finish the review with a summary, strengths and top priorities. Required: every review ends with exactly one call.',
    kind: 'control',
    input: FinishReviewInput,
    emits: 'ReviewFinished',
    counts: NONE,
    sessions: REVIEW,
  }),
} as const;

/** Name of a tool in the catalog. */
export type ToolName = keyof typeof TOOLS;

/** All tool names, in catalog order. */
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

/** Parsed input type of each tool. */
export type ToolInputs = { [K in ToolName]: z.infer<(typeof TOOLS)[K]['input']> };

/** Tools that must be called to end a session of each kind. */
export const SESSION_FINISH_TOOL: Readonly<Record<AgentSessionKind, ToolName>> = {
  review: 'finish_review',
  discuss: 'answer_discussion',
};

/** Tool names offered in a session of the given kind. */
export function toolsForSession(kind: AgentSessionKind): ToolName[] {
  return TOOL_NAMES.filter((n) =>
    (TOOLS[n].sessions as readonly AgentSessionKind[]).includes(kind),
  );
}

/** A JSON Schema object (draft 2020-12) for a tool's input. */
export type JsonSchemaObject = Record<string, unknown> & { type: 'object' };

/**
 * JSON Schema for a tool's input, as given to the MCP server and the model.
 * Refinements that need code (word counts, one-sentence rule, exactly-one-target)
 * are not expressible here and are enforced by parsing with `TOOLS[name].input`.
 */
export function toolJsonSchema(name: ToolName): JsonSchemaObject {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(TOOLS[name].input, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return schema as JsonSchemaObject;
}

/** JSON Schemas for every tool, keyed by name. */
export const TOOL_JSON_SCHEMAS: Readonly<Record<ToolName, JsonSchemaObject>> = Object.freeze(
  Object.fromEntries(TOOL_NAMES.map((n) => [n, toolJsonSchema(n)])) as Record<
    ToolName,
    JsonSchemaObject
  >,
);

// ---------------------------------------------------------------------------
// Caps and validation helpers
// ---------------------------------------------------------------------------

/** Running per-session counts. */
export interface SessionCounts {
  items: number;
  suggestions: number;
  insertions: number;
  proposals: number;
  questions: number;
  searches: number;
}

/** Counts at the start of a session. */
export const EMPTY_SESSION_COUNTS: Readonly<SessionCounts> = Object.freeze({
  items: 0,
  suggestions: 0,
  insertions: 0,
  proposals: 0,
  questions: 0,
  searches: 0,
});

/** Counts after a successful call to `tool`. */
export function countCall(tool: ToolName, counts: SessionCounts): SessionCounts {
  const c = TOOLS[tool].counts;
  return {
    items: counts.items + (c.item ? 1 : 0),
    suggestions: counts.suggestions + (c.suggestion ? 1 : 0),
    insertions: counts.insertions + (c.insertion ? 1 : 0),
    proposals: counts.proposals + (c.proposal ? 1 : 0),
    questions: counts.questions + (c.question ? 1 : 0),
    searches: counts.searches + (c.search ? 1 : 0),
  };
}

/** Returns an error message (for the model) if calling `tool` now would exceed a cap, else null. */
export function capViolation(
  tool: ToolName,
  counts: SessionCounts,
  intensity: Intensity,
): string | null {
  const caps = capsFor(intensity);
  const next = countCall(tool, counts);
  const checks: Array<[keyof SessionCounts, number, string]> = [
    ['items', caps.maxItems, 'items'],
    ['suggestions', caps.maxSuggestions, 'suggestions'],
    ['insertions', caps.maxInsertions, 'insertions'],
    ['proposals', caps.maxProposals, 'proposals'],
    ['questions', caps.maxQuestions, 'questions'],
    ['searches', caps.maxSearches, 'searches'],
  ];
  for (const [key, max, label] of checks) {
    if (next[key] > counts[key] && next[key] > max) {
      return `Cap reached: at most ${max} ${label} in a ${intensity} session. Prioritize, then call finish_review.`;
    }
  }
  return null;
}

const QUOTED_RE = /"([^"]*)"|“([^”]*)”|«([^»]*)»/g;

function normalize(s: string): string {
  return s.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Checks that rephrase guidance supplies no replacement wording: any quoted
 * passage (`"…"`, `“…”`, `«…»`) of {@link BOUNDS.rephraseMaxQuotedNewWords} or more
 * words must already appear in the anchored sentence (quoting the writer is fine,
 * quoting new prose is not). Returns an error message or null. A heuristic — the
 * suggestion matcher still classifies any retyped AI text.
 */
export function rephraseGuidanceViolation(guidance: string, sentenceText: string): string | null {
  const haystack = normalize(sentenceText);
  for (const m of guidance.matchAll(QUOTED_RE)) {
    const quoted = m[1] ?? m[2] ?? m[3] ?? '';
    if (
      countWords(quoted) >= BOUNDS.rephraseMaxQuotedNewWords &&
      !haystack.includes(normalize(quoted))
    ) {
      return 'Rephrase guidance must not supply new wording. Describe what to change instead of quoting a replacement.';
    }
  }
  return null;
}

/** Error codes a tool call can fail with (returned to the model so it can fix and retry). */
export type ToolErrorCode =
  | AnchorErrorCode
  | 'invalid-arguments'
  | 'unknown-tool'
  | 'tool-not-allowed'
  | 'unknown-document'
  | 'unknown-source'
  | 'unknown-thread'
  | 'cap-reached'
  | 'replacement-text'
  | 'session-finished'
  /** The target is outside the feedback request's scope, or in a note. */
  | 'out-of-scope'
  /** `search_sources` has no `SourceSearch`, or the search failed. */
  | 'search-unavailable'
  /** The ledger service (annotation sink) refused the resulting event. */
  | 'sink-rejected'
  /** An unexpected failure in the tool handler. */
  | 'internal-error';

/** Result of a tool call as returned to the model. */
export type ToolResult =
  | { ok: true; id?: string; content?: string }
  | { ok: false; error: { code: ToolErrorCode; message: string } };

/**
 * Candidate-source search behind the `search_sources` tool. The research lane
 * implements it (Crossref and Open Library); the agent lane calls it and records
 * the results as `SourceSurfaced.candidates`, labeled AI-surfaced and unverified.
 * Implementations return at most `limit` candidates (callers pass at most
 * `BOUNDS.searchMaxCandidates`), and an empty array for no results; they throw
 * when the search itself fails.
 */
export interface SourceSearch {
  search(query: string, limit: number): Promise<SurfacedCandidate[]>;
}
