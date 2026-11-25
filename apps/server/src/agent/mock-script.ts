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
