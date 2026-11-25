/**
 * Word counts per document, selection and session, plus daily-goal progress.
 * Every count uses the schema's deterministic `countWords`.
 *
 * Footnote text counts toward the document (as separate text, so a note never
 * fuses with the word it is attached to). Citations contribute nothing.
 */
import { countWords } from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';

/** Word counts shown to the writer. */
export interface WordCounts {
  document: number;
  selection: number;
  /** Net words added since the editor opened (never below zero). */
  session: number;
  /** Daily goal progress, when a goal is set. */
  daily: { goal: number; written: number; progress: number } | null;
}

/** Text of a range for counting: blocks separated by newlines, footnotes separated by spaces. */
export function countingText(doc: PMNode, from = 0, to = doc.content.size): string {
  const parts: string[] = [];
  const notes: string[] = [];
  let line = '';
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'footnote') {
      let note = '';
      node.nodesBetween(Math.max(0, from - pos - 1), Math.min(node.content.size, to - pos - 1), (n, p) => {
        if (n.isText) {
          const start = pos + 1 + p;
          const t = n.text as string;
          note += t.slice(Math.max(0, from - start), Math.min(t.length, to - start));
        } else if (n.type.name === 'hard_break') note += '\n';
        return true;
      });
      notes.push(note);
      line += ' ';
      return false;
    }
    if (node.isTextblock) {
      if (line) parts.push(line);
      line = '';
      return true;
    }
    if (node.isText) {
      const t = node.text as string;
      line += t.slice(Math.max(0, from - pos), Math.min(t.length, to - pos));
    } else if (node.type.name === 'hard_break') line += '\n';
    return true;
  });
  if (line) parts.push(line);
  return [...parts, ...notes].join('\n');
}

/** Words in the whole document. */
export function countDocumentWords(doc: PMNode): number {
  return countWords(countingText(doc));
}

/** Words in the current selection (0 for a caret). */
export function countSelectionWords(state: EditorState): number {
  const { from, to, empty } = state.selection;
  return empty ? 0 : countWords(countingText(state.doc, from, to));
}

/** Minimal storage for the daily baseline (localStorage-compatible). */
export interface DailyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WordCounterOptions {
  documentId: string;
  dailyGoal?: number | null;
  /**
   * Words already written today before this editor opened. When omitted the
   * counter remembers the document's word count at the first open of the day in
   * `storage` and counts growth from there.
   */
  dailyBaseline?: number;
  storage?: DailyStorage | null;
  /** Local calendar day, `YYYY-MM-DD`. Default: today. */
  today?: () => string;
}

function localDay(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function defaultStorage(): DailyStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Tracks session and daily counts for one document. */
export class WordCounter {
  private sessionStart: number;
  private dayStart: number;
  private goal: number | null;
  private docCache: { doc: PMNode; words: number } | null = null;

  constructor(
    initial: PMNode,
    private readonly opts: WordCounterOptions,
  ) {
    const words = countDocumentWords(initial);
    this.sessionStart = words;
    this.goal = opts.dailyGoal ?? null;
    this.dayStart = this.loadDayStart(words);
  }

  private loadDayStart(words: number): number {
    if (this.opts.dailyBaseline !== undefined) return words - this.opts.dailyBaseline;
    const storage = this.opts.storage === undefined ? defaultStorage() : this.opts.storage;
    const key = `longhand:daily:${this.opts.documentId}:${(this.opts.today ?? localDay)()}`;
    try {
      const stored = storage?.getItem(key);
      if (stored !== null && stored !== undefined && Number.isFinite(Number(stored))) return Number(stored);
      storage?.setItem(key, String(words));
    } catch {
      // Storage unavailable: count from now.
    }
    return words;
  }

  setGoal(goal: number | null): void {
    this.goal = goal;
  }

  documentWords(doc: PMNode): number {
    if (this.docCache?.doc !== doc) this.docCache = { doc, words: countDocumentWords(doc) };
    return this.docCache.words;
  }

  counts(state: EditorState): WordCounts {
    const document = this.documentWords(state.doc);
    const written = Math.max(0, document - this.dayStart);
    return {
      document,
      selection: countSelectionWords(state),
      session: Math.max(0, document - this.sessionStart),
      daily: this.goal ? { goal: this.goal, written, progress: Math.min(1, written / this.goal) } : null,
    };
  }
}
