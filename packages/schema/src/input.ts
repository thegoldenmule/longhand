/**
 * The shared transaction meta for declared input methods.
 *
 * Commands that put research material into the manuscript on a user gesture (Cite,
 * Place clipping) cannot be classified from DOM input events alone. They tag their
 * ProseMirror transaction with `tr.setMeta(INPUT_METHOD_META, input)`, where
 * `input` is a {@link DeclaredInput}. The editor's input guard reads it, checks that
 * a user gesture is recent and that the steps insert only what the method may
 * insert, and records the run and the companion events.
 *
 * Only methods the fold verifies against an earlier event can be declared
 * ({@link DECLARABLE_INPUT_METHODS}). The fold still checks every claim and
 * downgrades what it cannot verify to `pasted-external`.
 */
import type { EventPayloads, InputRun, Keystroke } from './events';

/** ProseMirror transaction meta key carrying a {@link DeclaredInput}. */
export const INPUT_METHOD_META = 'longhand/input-method';

/** Input methods a command may declare through {@link INPUT_METHOD_META}. */
export const DECLARABLE_INPUT_METHODS = ['citation', 'clipping'] as const;
/** An input method a command may declare. */
export type DeclarableInputMethod = (typeof DECLARABLE_INPUT_METHODS)[number];

/** A declared input: the value of {@link INPUT_METHOD_META}. */
export interface DeclaredInput {
  /**
   * The input-method run covering every step of the transaction
   * (`run.steps === tr.steps.length`): `citation` with `citationId`, or `clipping`
   * with `clippingId`.
   */
  run: InputRun & { method: DeclarableInputMethod };
  /**
   * Companion events to commit before the `TextEdited` carrying these steps (lower
   * seq). A citation has its `CitationInserted`; a clipping has none (its
   * `ClippingSaved` was committed when it was saved).
   */
  companions: Array<{ type: 'CitationInserted'; payload: EventPayloads['CitationInserted'] }>;
  /** Inline text characters inserted (0 for a citation; the clipping text without `\n`). */
  characters: number;
  /** Keystroke-timeline entry for the action: kind `cite` or `clip`, `len` = `characters`. */
  keystroke: Pick<Keystroke, 'kind' | 'len'>;
}
