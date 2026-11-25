/**
 * The provenance classes the tint and legend show, with labels and their
 * non-colour cue (an underline style), plus labels for what AI text a
 * `typed-from-suggestion` run matched.
 */
import {
  PROVENANCE_CLASS_INFO,
  type InputMethod,
  type MatchedKind,
  type ProvenanceClass,
} from '@longhand/schema';

/**
 * A class that can appear as a provenance run. `pasted-internal` never does:
 * internally pasted text inherits its source's class.
 */
export type TintClass = Exclude<ProvenanceClass, 'pasted-internal'>;

/** The tinted classes, most trusted first (legend order). */
export const TINT_CLASSES: readonly TintClass[] = Object.freeze([
  'typed',
  'typed-from-suggestion',
  'pasted-external',
  'imported',
  'quoted',
]);

/** Underline style each class carries, so the tint never relies on colour alone. */
export type UnderlineStyle = 'none' | 'dotted' | 'wavy' | 'dashed' | 'double';

/** Display facts for one class. */
export interface ClassMeta {
  /** Label from the schema's `PROVENANCE_CLASS_INFO`. */
  label: string;
  /** Short label for tight spaces. */
  short: string;
  /** One line on what the class means. */
  description: string;
  underline: UnderlineStyle;
}

export const CLASS_META: Readonly<Record<TintClass, ClassMeta>> = {
  typed: {
    label: PROVENANCE_CLASS_INFO.typed.label,
    short: 'Typed',
    description: 'Typed in the editor. Left plain in the tint, so everything else stands out.',
    underline: 'none',
  },
  'typed-from-suggestion': {
    label: PROVENANCE_CLASS_INFO['typed-from-suggestion'].label,
    short: 'From a suggestion',
    description:
      'Typed while matching AI text was showing. The writer’s, disclosed as AI-assisted.',
    underline: 'dotted',
  },
  'pasted-external': {
    label: PROVENANCE_CLASS_INFO['pasted-external'].label,
    short: 'Pasted',
    description: 'Pasted from outside the project, or text the ledger could not verify.',
    underline: 'wavy',
  },
  imported: {
    label: PROVENANCE_CLASS_INFO.imported.label,
    short: 'Imported',
    description: 'Brought in with an imported draft. Not verified.',
    underline: 'dashed',
  },
  quoted: {
    label: PROVENANCE_CLASS_INFO.quoted.label,
    short: 'Quoted',
    description: 'A clipping or citation tied to a library source. Quoted, not authored.',
    underline: 'double',
  },
};

/** CSS class of a run's decoration. */
export function tintClassName(cls: TintClass): string {
  return `lh-prov lh-prov--${cls}`;
}

/** What a `typed-from-suggestion` run matched, as a noun phrase ("a margin comment"). */
export const MATCHED_KIND_LABEL: Readonly<Record<MatchedKind, string>> = {
  suggestion: 'a wording suggestion',
  insertion: 'an insertion suggestion',
  comment: 'a margin comment',
  question: 'a question',
  proposal: 'a proposal’s rationale',
  'citation-flag': 'a citation-needed flag',
  'surfaced-source': 'an AI-surfaced source',
  'source-suggestion': 'a source suggestion',
  discuss: 'a Discuss answer',
  review: 'a review summary',
  chat: 'a chat reply',
};

/** Short, capitalised form for legends ("Comments"). */
export const MATCHED_KIND_SHORT: Readonly<Record<MatchedKind, string>> = {
  suggestion: 'Wording suggestions',
  insertion: 'Insertion suggestions',
  comment: 'Comments',
  question: 'Questions',
  proposal: 'Proposal rationales',
  'citation-flag': 'Citation flags',
  'surfaced-source': 'Surfaced sources',
  'source-suggestion': 'Source suggestions',
  discuss: 'Discuss answers',
  review: 'Review summaries',
  chat: 'Chat replies',
};

/** Input method labels for the inspector. */
export const INPUT_METHOD_LABEL: Readonly<Record<InputMethod, string>> = {
  typed: 'typed on the keyboard',
  ime: 'typed with an input method (IME)',
  autocorrect: 'autocorrected',
  'pasted-external': 'pasted from outside the project',
  'pasted-internal': 'pasted from inside the project',
  'drop-internal': 'dragged within the document',
  history: 'restored by undo or redo',
  citation: 'inserted as a citation',
  clipping: 'placed from a clipping',
};
