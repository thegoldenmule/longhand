/**
 * Named editors: the writer's account-wide roster of AI editors. Each is a name,
 * the lenses and intensity it reviews with, a short brief (who it is, what it
 * cares about, how it phrases notes) and up to five one-tap questions.
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
  brief: EditorBriefSchema,
});
/** The editor recorded on a feedback request. */
export type FeedbackEditor = z.infer<typeof FeedbackEditorSchema>;

/** The snapshot of a profile that a request records. */
export function feedbackEditorOf(profile: EditorProfile): FeedbackEditor {
  return { id: profile.id, name: profile.name, brief: profile.brief };
}

/** A one-line summary of an editor's brief, for compact lists (first sentence, clipped). */
export function editorSummary(brief: string, maxChars = 90): string {
  const t = brief.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const end = /[.!?](\s|$)/.exec(t);
  const first = end ? t.slice(0, end.index + 1) : t;
  if (first.length <= maxChars) return first;
  const cut = first.slice(0, maxChars - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > maxChars / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, '')}…`;
}

/** A starter editor (seeded when a writer has none). */
export interface StarterEditor extends EditorProfileInput {
  lenses: Lens[];
  intensity: Intensity;
}

/**
 * The starter roster, seeded for a writer with no editors (and restored by
 * "reset to starters"). Together they cover every lens the full-stack e2e mock
 * reviewer reacts to (`structure`, `word-choice`).
 */
export const STARTER_EDITORS: readonly StarterEditor[] = Object.freeze([
  {
    name: 'Margaret',
    brief:
      'A developmental editor who reads for the shape of the whole: what the piece is trying to do, where it sags, and what is out of order. Big-picture notes, few of them, never commas.',
    lenses: ['structure', 'pacing', 'argument'],
    intensity: 'light',
    questions: [
      'Is the opening too slow?',
      'Does the structure hold together?',
      'Where does it lose momentum?',
    ],
  },
  {
    name: 'Theo',
    brief:
      'A line editor who listens to every sentence: precise word choice, clear syntax and a steady voice. Cuts flab and cliché, and keeps your voice your own.',
    lenses: ['word-choice', 'clarity', 'tone-voice'],
    intensity: 'standard',
    questions: [
      'Which sentences are doing too little?',
      'Where does the voice slip?',
      'Which words would you look at again?',
    ],
  },
  {
    name: 'Ruth',
    brief:
      'A meticulous copyeditor: grammar, punctuation, consistency, and every claim that needs a source. Small, exact notes with the rule behind each one.',
    lenses: ['grammar-mechanics', 'claims-citations'],
    intensity: 'thorough',
    questions: ['Is anything grammatically wrong?', 'Which claims need a citation?'],
  },
  {
    name: 'Sam',
    brief:
      'A first reader, not an editor: says honestly where they were gripped, confused or bored, and what they wanted more of. Plain reactions, no jargon.',
    lenses: ['pacing', 'character-dialogue', 'clarity'],
    intensity: 'light',
    questions: [
      'Where did you get confused?',
      'Do the characters feel real?',
      'What did you want more of?',
    ],
  },
] satisfies StarterEditor[]);
