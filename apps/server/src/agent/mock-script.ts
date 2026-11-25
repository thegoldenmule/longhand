/**
 * The canned script `MODEL_ADAPTER=mock` plays (e2e tests and offline demos). It
 * reads the first segmented sentence of the prompt, comments on it, asks a
 * question about it and finishes the review; a discuss session answers once.
 * Every call goes through the real MCP tool server, relay and ledger ingest.
 */
import { MockModelAdapter, type MockStep, type ModelRunInput } from '@longhand/agent';

/** What the script needs from the request. */
export interface MockScriptContext {
  kind: 'review' | 'discuss';
  lens?: string;
  /**
   * Every lens asked for. `word-choice` adds a word-choice suggestion and
   * `structure` adds move proposals (a paragraph move and a sentence move), so the
   * full-stack e2e suite can exercise trace-over, accept and reject.
   */
  lenses?: readonly string[];
  threadId?: string;
  /** Milliseconds between steps, so annotations visibly stream (default 0). */
  stepDelayMs?: number;
}

const SENTENCE_RE = /\[(p\d+\.s\d+)\]\s+(.+?)(?=\s+\[p\d+\.s\d+\]|$)/m;
const DOC_RE = /<document id="([^"]+)"/;

/** The first anchorable sentence in a prompt: document id, sentence id and a short quote. */
export function firstAnchor(
  prompt: string,
): { documentId: string; sentenceId: string; quote: string } | null {
  const doc = DOC_RE.exec(prompt);
  if (!doc) return null;
  const rest = prompt.slice(doc.index);
  // A selection pass names the sentences it covers; anchor inside them.
  const covered = /selection covers sentences? (p\d+\.s\d+)/.exec(prompt)?.[1];
  let m: RegExpExecArray | null = null;
  if (covered) {
    const re = new RegExp(
      `\\[${covered.replace('.', '\\.')}\\]\\s+(.+?)(?=\\s+\\[p\\d+\\.s\\d+\\]|$)`,
      'm',
    );
    const hit = re.exec(rest);
    if (hit) m = [hit[0], covered, hit[1] as string] as unknown as RegExpExecArray;
  }
  m ??= SENTENCE_RE.exec(rest);
  if (!m) return null;
  const words = (m[2] as string).split(/\s+/).filter(Boolean);
  const quote = words.slice(0, Math.min(3, words.length)).join(' ');
  if (!quote) return null;
  return { documentId: doc[1] as string, sentenceId: m[1] as string, quote };
}

/** A segmented block of the target document, as the prompt shows it. */
export interface PromptBlock {
  id: string;
  /** The `· …` note after the id (`heading 1`, `in blockquote`, `context`, …), or null. */
  note: string | null;
  sentences: Array<{ id: string; text: string }>;
}

const BLOCK_LINE_RE = /^\[(p\d+)(?: · ([^\]]+))?\]\s+(.*)$/;
const SENTENCE_ALL_RE = /\[(p\d+\.s\d+)\]\s+(.+?)(?=\s+\[p\d+\.s\d+\]|$)/g;

/** The blocks of the first `<document>` in a prompt. */
export function promptBlocks(prompt: string): { documentId: string; blocks: PromptBlock[] } | null {
  const doc = DOC_RE.exec(prompt);
  if (!doc) return null;
  const body = prompt.slice(doc.index);
  const end = body.indexOf('</document>');
  const blocks: PromptBlock[] = [];
  for (const line of (end >= 0 ? body.slice(0, end) : body).split('\n')) {
    const m = BLOCK_LINE_RE.exec(line.trim());
    if (!m) continue;
    const sentences = [...(m[3] as string).matchAll(SENTENCE_ALL_RE)].map((x) => ({
      id: x[1] as string,
      text: x[2] as string,
    }));
    blocks.push({ id: m[1] as string, note: m[2] ?? null, sentences });
  }
  return { documentId: doc[1] as string, blocks };
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

/** The longest word (5+ letters) that occurs exactly once in the sentence. */
function wordChoiceAnchor(text: string): string | null {
  const words = (text.match(/[A-Za-z]{5,}/g) ?? []).filter((w) => occurrences(text, w) === 1);
  words.sort((a, b) => b.length - a.length);
  return words[0] ?? null;
}

const ALTERNATIVES = ['softly', 'steadily', 'quietly'];

/** Lens-driven extras: a word-choice suggestion and move proposals. */
function lensSteps(prompt: string, lenses: readonly string[], delay: MockStep[]): MockStep[] {
  const parsed = promptBlocks(prompt);
  if (!parsed) return [];
  const { documentId, blocks } = parsed;
  const plain = blocks.filter((b) => b.note === null && b.sentences.length > 0);
  const steps: MockStep[] = [];
  if (lenses.includes('word-choice')) {
    const first = plain[0]?.sentences[0];
    const word = first ? wordChoiceAnchor(first.text) : null;
    if (first && word) {
      steps.push(...delay, {
        tool: 'suggest_word_choice',
        input: {
          anchor: { documentId, sentenceId: first.id, quote: word },
          alternatives: ALTERNATIVES.filter((a) => a !== word.toLowerCase()).slice(0, 2),
          rationale: 'A plainer word keeps the sentence moving.',
        },
      });
    }
  }
  if (lenses.includes('structure')) {
    const last = plain.length >= 3 ? plain[plain.length - 1] : undefined;
    if (last && plain[0]) {
      steps.push(...delay, {
        tool: 'propose_move',
        input: {
          documentId,
          unit: 'paragraph',
          ids: [last.id],
          destination: { position: 'before', id: plain[0].id },
          rationale: 'Opening on this paragraph puts the stakes first.',
        },
      });
    }
    const inner =
      plain.find((b) => b !== last && b.sentences.length >= 2 && b !== plain[0]) ??
      plain.find((b) => b !== last && b.sentences.length >= 2);
    if (inner) {
      steps.push(...delay, {
        tool: 'propose_move',
        input: {
          documentId,
          unit: 'sentence',
          ids: [(inner.sentences[1] as { id: string }).id],
          destination: { position: 'before', id: (inner.sentences[0] as { id: string }).id },
          rationale: 'Leading with the action sharpens this paragraph.',
        },
      });
    }
  }
  return steps;
}

/** Builds the canned script for one run. */
export function mockScript(ctx: MockScriptContext): (input: ModelRunInput) => MockStep[] {
  const delay: MockStep[] = ctx.stepDelayMs ? [{ delayMs: ctx.stepDelayMs }] : [];
  return (input) => {
    if (ctx.kind === 'discuss') {
      return [
        ...delay,
        {
          tool: 'answer_discussion',
          input: {
            threadId: ctx.threadId,
            body: 'The point is that the reader needs the stakes earlier; the choice of words is yours.',
          },
        },
      ];
    }
    const anchor = firstAnchor(input.prompt);
    const steps: MockStep[] = [{ text: 'Reading the text.' }];
    if (anchor) {
      steps.push(...delay, {
        tool: 'comment',
        input: {
          anchor,
          category: ctx.lens ?? 'clarity',
          severity: 'moderate',
          body: 'This opening carries the scene; consider what the reader should feel first.',
        },
      });
      steps.push(...delay, {
        tool: 'ask_question',
        input: { anchor, question: 'What do you want the reader to expect after this line?' },
      });
    }
    if (ctx.lenses?.length) steps.push(...lensSteps(input.prompt, ctx.lenses, delay));
    steps.push(...delay, {
      tool: 'finish_review',
      input: {
        summary: 'A clear start. The main question is what the reader should expect next.',
        strengths: ['A confident opening line'],
        topPriorities: ['Decide what the reader should expect after the opening'],
      },
    });
    return steps;
  };
}

/** A `MockModelAdapter` playing {@link mockScript}. */
export function mockAdapter(ctx: MockScriptContext): MockModelAdapter {
  return new MockModelAdapter(mockScript(ctx));
}
