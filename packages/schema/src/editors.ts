/**
 * Named editors: the writer's account-wide roster of AI editors. Each is a name,
 * a short role ("Line editor"), the lenses and intensity it reviews with, a brief
 * (what it looks for first, how it phrases notes) and up to five one-tap
 * questions. Lists show the name and role; the brief is for the editor.
 *
 * Profiles live outside the ledger (the ledger service keeps them per account).
 * A `FeedbackRequested` records which editor was asked and its name and brief at
 * that moment (`FeedbackEditorSchema`); its lenses and intensity are already on
 * the payload, so every request stays self-contained.
 *
 * Everything here is writer text, never manuscript.
 */
import { z } from 'zod';
import { IntensitySchema, LensSchema, TEXT_LIMITS, type Intensity, type Lens } from './domain';
import { IdSchema } from './ids';

/** At most this many canned questions per editor. */
export const EDITOR_MAX_QUESTIONS = 5;

/** An editor's display name: 1–60 chars, not blank. */
export const EditorNameSchema = z
  .string()
  .min(1)
  .max(TEXT_LIMITS.editorNameMaxChars)
  .refine((s) => s.trim().length > 0, 'name must not be blank');

/** An editor's role, a short label shown beside its name ("Line editor"); may be empty. */
export const EditorRoleSchema = z.string().max(TEXT_LIMITS.editorRoleMaxChars);

/** An editor's brief: who it is and what it prioritizes (may be empty). */
export const EditorBriefSchema = z.string().max(TEXT_LIMITS.editorBriefMaxChars);

/** One canned question ("Is the opening too slow?"): 1–160 chars, not blank. */
export const EditorQuestionSchema = z
  .string()
  .min(1)
  .max(TEXT_LIMITS.editorQuestionMaxChars)
  .refine((s) => s.trim().length > 0, 'question must not be blank');

/** An editor's lenses: at least one, no duplicates. */
export const EditorLensesSchema = z
  .array(LensSchema)
  .min(1)
  .refine((l) => new Set(l).size === l.length, 'duplicate lens');

/** What the writer edits: everything but the id. */
export const EditorProfileInputSchema = z.object({
  name: EditorNameSchema,
  /** Profiles saved before roles existed read as no role. */
  role: EditorRoleSchema.default(''),
  brief: EditorBriefSchema,
  lenses: EditorLensesSchema,
  intensity: IntensitySchema,
  questions: z
    .array(EditorQuestionSchema)
    .max(EDITOR_MAX_QUESTIONS)
    .refine((q) => new Set(q).size === q.length, 'duplicate question'),
});
/** An editor without its id. */
export type EditorProfileInput = z.infer<typeof EditorProfileInputSchema>;

/** A named editor in the writer's roster. */
export const EditorProfileSchema = EditorProfileInputSchema.extend({ id: IdSchema });
/** A named editor. */
export type EditorProfile = z.infer<typeof EditorProfileSchema>;

/**
 * The editor a `FeedbackRequested` names, as it was when the writer asked. Its
 * lenses and intensity are the request's own `lenses` and `intensity`.
 */
export const FeedbackEditorSchema = z.object({
  id: IdSchema,
  name: EditorNameSchema,
  /** Present only when the editor had a role. */
  role: EditorRoleSchema.min(1).optional(),
  brief: EditorBriefSchema,
});
/** The editor recorded on a feedback request. */
export type FeedbackEditor = z.infer<typeof FeedbackEditorSchema>;

/** The snapshot of a profile that a request records. */
export function feedbackEditorOf(profile: EditorProfile): FeedbackEditor {
  const role = profile.role.trim();
  return { id: profile.id, name: profile.name, ...(role ? { role } : {}), brief: profile.brief };
}

/** A starter editor (seeded when a writer has none). */
export interface StarterEditor extends EditorProfileInput {
  lenses: Lens[];
  intensity: Intensity;
}

/**
 * The starter roster, seeded for a writer with no editors (and restored by
 * "reset to starters"). Lenses are in display order (`LENSES`). Together they cover every lens the full-stack e2e mock
 * reviewer reacts to (`structure`, `word-choice`).
 */
export const STARTER_EDITORS: readonly StarterEditor[] = Object.freeze([
  {
    name: 'Margaret',
    role: 'Developmental editor',
    brief:
      'Reads for the shape of the whole. What the piece is trying to do, where it sags, what is out of order. A few notes that matter, never commas.',
    lenses: ['structure', 'argument', 'pacing'],
    intensity: 'light',
    questions: [
      'Is the opening too slow?',
      'Does the structure hold together?',
      'Where does it lose momentum?',
    ],
  },
  {
    name: 'Theo',
    role: 'Line editor',
    brief:
      'Listens for precise words, clear syntax and a steady voice. Cuts flab and cliché. Keeps your voice your own.',
    lenses: ['clarity', 'word-choice', 'tone-voice'],
    intensity: 'standard',
    questions: [
      'Which sentences are doing too little?',
      'Where does the voice slip?',
      'Which words would you look at again?',
    ],
  },
  {
    name: 'Ruth',
    role: 'Copyeditor',
    brief:
      'Checks grammar, punctuation and consistency, and flags every claim that needs a source. Small notes, each with the rule behind it.',
    lenses: ['claims-citations', 'grammar-mechanics'],
    intensity: 'thorough',
    questions: ['Is anything grammatically wrong?', 'Which claims need a citation?'],
  },
  {
    name: 'Sam',
    role: 'First reader',
    brief:
      'Says where they were gripped, confused or bored, and what they wanted more of. Plain words, no jargon.',
    lenses: ['clarity', 'pacing', 'character-dialogue'],
    intensity: 'light',
    questions: [
      'Where did you get confused?',
      'Do the characters feel real?',
      'What did you want more of?',
    ],
  },
] satisfies StarterEditor[]);
