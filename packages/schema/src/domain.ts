/**
 * Shared domain vocabularies: feedback lenses and intensity, comment categories,
 * dismissal reasons, input methods, keystroke kinds, project settings and CSL-JSON.
 */
import { z } from 'zod';

/** Feedback lenses (F3). A request picks one or more; a comment is filed under one. */
export const LensSchema = z.enum([
  'structure',
  'argument',
  'clarity',
  'pacing',
  'character-dialogue',
  'word-choice',
  'tone-voice',
  'claims-citations',
  'grammar-mechanics',
]);
/** Feedback lens. */
export type Lens = z.infer<typeof LensSchema>;
/** All lenses, in display order. */
export const LENSES = LensSchema.options;

/** Human-readable lens labels (UI and prompt). */
export const LENS_LABELS: Readonly<Record<Lens, string>> = {
  structure: 'Structure',
  argument: 'Argument and logic',
  clarity: 'Clarity',
  pacing: 'Pacing',
  'character-dialogue': 'Character and dialogue',
  'word-choice': 'Word choice',
  'tone-voice': 'Tone and voice consistency',
  'claims-citations': 'Claims and citations',
  'grammar-mechanics': 'Grammar and mechanics',
};

/** Feedback intensity: light touch (≤ 5 items total), standard, thorough. See `CAPS`. */
export const IntensitySchema = z.enum(['light', 'standard', 'thorough']);
/** Feedback intensity. */
export type Intensity = z.infer<typeof IntensitySchema>;

/** Severity of a margin comment. */
export const SeveritySchema = z.enum(['minor', 'moderate', 'major']);
/** Severity of a margin comment. */
export type Severity = z.infer<typeof SeveritySchema>;

/** Why the writer dismissed an annotation (F4: "not my voice, wrong, later"). */
export const DismissReasonSchema = z.enum(['not-my-voice', 'wrong', 'later']);
/** Why the writer dismissed an annotation. */
export type DismissReason = z.infer<typeof DismissReasonSchema>;

/**
 * How the text inserted by a run of editor steps entered the manuscript. The client
 * *reports* the method; the fold *derives* the provenance class from it and can
 * only ever downgrade a claim it cannot verify (see `docs/BUILD.md`, Contract decisions):
 *
 * - `typed` — keyboard input (also deletions, Enter, formatting, input rules).
 * - `ime` — IME composition result.
 * - `autocorrect` — browser/OS spelling replacement the writer chose (`insertReplacementText`).
 * - `pasted-external` — clipboard or drop content not copied from this project. Requires `pasteId`.
 * - `pasted-internal` — clipboard content copied from this project. Requires `pasteId`;
 *   the referenced `PasteOccurred` names the `SliceCopied` it came from.
 * - `drop-internal` — drag-and-drop move inside the editor (content deleted and
 *   re-inserted by the same run).
 * - `history` — undo/redo re-inserting content that was previously deleted.
 * - `citation` — inserts `citation` nodes only. Requires `citationId`.
 * - `clipping` — inserts one `quote_block` with a saved clipping's text. Requires `clippingId`.
 */
export const InputMethodSchema = z.enum([
  'typed',
  'ime',
  'autocorrect',
  'pasted-external',
  'pasted-internal',
  'drop-internal',
  'history',
  'citation',
  'clipping',
]);
/** How a run of steps entered the manuscript. */
export type InputMethod = z.infer<typeof InputMethodSchema>;

/**
 * Kind of one entry in a keystroke timeline. No key identities are recorded,
 * only what kind of input happened and how many characters it affected.
 */
export const KeystrokeKindSchema = z.enum([
  'insert',
  'delete',
  'compose',
  'break',
  'paste',
  'drop',
  'cut',
  'undo',
  'redo',
  'format',
  'autocorrect',
]);
/** Kind of keystroke timeline entry. */
export type KeystrokeKind = z.infer<typeof KeystrokeKindSchema>;

/** Area of the binder a folder or document lives in. Documents of kind `note` live in `notes`. */
export const BinderAreaSchema = z.enum(['manuscript', 'notes']);
/** Binder area. */
export type BinderArea = z.infer<typeof BinderAreaSchema>;

/** Document kind: manuscript text (chapters, scenes, essays) or a note (characters, outline, style guide…). */
export const DocumentKindSchema = z.enum(['manuscript', 'note']);
/** Document kind. */
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

/** Text limits for writer-authored, non-manuscript text. */
export const TEXT_LIMITS = {
  titleMaxChars: 200,
  synopsisMaxChars: 2000,
  genreMaxChars: 100,
  audienceMaxChars: 300,
  goalsMaxChars: 2000,
  styleNotesMaxChars: 4000,
  feedbackAskMaxChars: 1000,
  discussMessageMaxChars: 1000,
  dismissNoteMaxChars: 300,
  clippingMaxChars: 10000,
  clippingNoteMaxChars: 1000,
  sourceNoteMaxChars: 2000,
  locatorMaxChars: 100,
} as const;

/** Zod schema for a title (documents, folders, projects): 1–200 chars, not blank. */
export const TitleSchema = z
  .string()
  .min(1)
  .max(TEXT_LIMITS.titleMaxChars)
  .refine((s) => s.trim().length > 0, 'title must not be blank');

/** Zod schema for a citation/clipping locator, e.g. `p. 12`, `ch. 3`, `00:14:05`. */
export const LocatorSchema = z.string().min(1).max(TEXT_LIMITS.locatorMaxChars);

/** Project settings: context the writer gives the AI editor, plus goals. Writer text, never manuscript. */
export const ProjectSettingsSchema = z.object({
  title: TitleSchema,
  genre: z.string().max(TEXT_LIMITS.genreMaxChars),
  audience: z.string().max(TEXT_LIMITS.audienceMaxChars),
  goals: z.string().max(TEXT_LIMITS.goalsMaxChars),
  styleNotes: z.string().max(TEXT_LIMITS.styleNotesMaxChars),
  /** Optional daily word goal (F1). */
  dailyWordGoal: z.number().int().min(1).max(100000).nullable(),
  /** CSL style id for the bibliography, e.g. `apa`, `modern-language-association`, `chicago-author-date`. */
  citationStyle: z.string().min(1).max(100),
});
/** Project settings. */
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/** Settings of a new project (title comes from `ProjectCreated`). */
export const DEFAULT_PROJECT_SETTINGS: Readonly<Omit<ProjectSettings, 'title'>> = Object.freeze({
  genre: '',
  audience: '',
  goals: '',
  styleNotes: '',
  dailyWordGoal: null,
  citationStyle: 'apa',
});

/** A CSL-JSON name. */
export const CslNameSchema = z.looseObject({
  family: z.string().optional(),
  given: z.string().optional(),
  literal: z.string().optional(),
  suffix: z.string().optional(),
  'dropping-particle': z.string().optional(),
  'non-dropping-particle': z.string().optional(),
});

/** A CSL-JSON date. */
export const CslDateSchema = z.looseObject({
  'date-parts': z
    .array(
      z
        .array(z.union([z.number().int(), z.string()]))
        .min(1)
        .max(3),
    )
    .min(1)
    .max(2)
    .optional(),
  literal: z.string().optional(),
  raw: z.string().optional(),
  circa: z.union([z.boolean(), z.number(), z.string()]).optional(),
});

/**
 * A CSL-JSON item (citeproc-js input). The common fields are typed; any other CSL
 * variable is allowed (loose object). `id` is the Longhand source id.
 */
export const CslItemSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string().optional(),
  'container-title': z.string().optional(),
  author: z.array(CslNameSchema).optional(),
  editor: z.array(CslNameSchema).optional(),
  issued: CslDateSchema.optional(),
  accessed: CslDateSchema.optional(),
  publisher: z.string().optional(),
  'publisher-place': z.string().optional(),
  volume: z.union([z.string(), z.number()]).optional(),
  issue: z.union([z.string(), z.number()]).optional(),
  page: z.string().optional(),
  edition: z.union([z.string(), z.number()]).optional(),
  DOI: z.string().optional(),
  ISBN: z.string().optional(),
  ISSN: z.string().optional(),
  URL: z.string().optional(),
  abstract: z.string().optional(),
  language: z.string().optional(),
});
/** A CSL-JSON item. */
export type CslItem = z.infer<typeof CslItemSchema>;
