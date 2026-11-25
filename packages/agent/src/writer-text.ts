/**
 * Ids such as `p1.s2`, `p3`, `s3` or `fn1.s1` exist so the model can anchor its
 * annotations. The writer never sees them, so they must not appear in any text
 * the writer reads. The prompt says so (v2) and the executor enforces it here.
 */
import type { ToolInputs, ToolName } from '@longhand/schema';

/**
 * Block and sentence ids as the model might write them in prose: `p3`, `p3.s2`,
 * `fn1`, `fn1.s1`, and bare sentence ids `s3`, `s3–s4`, `s3-4`. Lowercase only,
 * and whole tokens only, so "S3", "mp3", "1990s" and "s" as a word pass.
 */
const ID_RE = /\b(?:p|fn)\d+(?:\.s\d+)?\b|\bs\d+(?:[–-]s?\d+)?\b/g;

/** A writer-facing text field of a tool call. */
export interface WriterText {
  /** Argument path, e.g. `body` or `strengths.1`. */
  field: string;
  text: string;
}

/** The fields of a tool call whose text the writer reads. Read tools and queries have none. */
export function writerFacingTexts(tool: ToolName, input: ToolInputs[ToolName]): WriterText[] {
  const one = (field: string, text: string): WriterText => ({ field, text });
  const many = (field: string, texts: readonly string[]) =>
    texts.map((text, i) => one(`${field}.${i}`, text));
  switch (tool) {
    case 'comment':
      return [one('body', (input as ToolInputs['comment']).body)];
    case 'ask_question':
      return [one('question', (input as ToolInputs['ask_question']).question)];
    case 'suggest_word_choice': {
      const i = input as ToolInputs['suggest_word_choice'];
      return [...many('alternatives', i.alternatives), one('rationale', i.rationale)];
    }
    case 'suggest_insertion': {
      const i = input as ToolInputs['suggest_insertion'];
      return [one('sentence', i.sentence), one('purpose', i.purpose)];
    }
    case 'suggest_rephrase':
      return [one('guidance', (input as ToolInputs['suggest_rephrase']).guidance)];
    case 'propose_move':
    case 'propose_cut':
    case 'propose_split':
    case 'propose_merge':
    case 'suggest_source':
      return [one('rationale', (input as { rationale: string }).rationale)];
    case 'flag_citation_needed':
      return [one('claim', (input as ToolInputs['flag_citation_needed']).claim)];
    case 'answer_discussion':
      return [one('body', (input as ToolInputs['answer_discussion']).body)];
    case 'finish_review': {
      const i = input as ToolInputs['finish_review'];
      return [
        one('summary', i.summary),
        ...many('strengths', i.strengths),
        ...many('topPriorities', i.topPriorities),
      ];
    }
    case 'read_document':
    case 'read_notes':
    case 'get_outline':
    case 'search_sources':
      return [];
  }
}

/** Every id-like token in `text`, in order. */
export function idTokens(text: string): string[] {
  return [...text.matchAll(ID_RE)].map((m) => m[0]);
}

/**
 * The model-facing rejection message when a writer-facing field mentions an id,
 * or null. Tokens in `allowed` (id-like words that occur in the writer's own
 * text, such as a gene called p53) are not ids and pass.
 */
export function writerFacingIdViolation(
  texts: readonly WriterText[],
  allowed: ReadonlySet<string> = new Set(),
): string | null {
  for (const { field, text } of texts) {
    const found = idTokens(text).filter((t) => !allowed.has(t));
    if (found.length === 0) continue;
    const list = [...new Set(found)].map((t) => `"${t}"`).join(', ');
    return `${field} mentions ${list}. The writer never sees sentence or paragraph ids, so text they read must not contain them. Refer to the text by a short quotation or a plain description ("the second sentence", "the start of paragraph 2") instead, and keep ids only in the anchor, span and id fields.`;
  }
  return null;
}
