/**
 * The "typed from a suggestion" matcher's text utilities. Deterministic: ASCII-only
 * case folding, explicit whitespace set, no `Intl`, no `normalize`.
 *
 * - **Edit-distance rule**: normalized Levenshtein distance (`d / max(len)`) of at
 *   most {@link EDIT_DISTANCE_THRESHOLD} between the text in an open suggestion's
 *   region and one of its alternatives (or an insertion's sentence).
 * - **Four-word rule**: {@link NGRAM_WORDS} or more consecutive words matching any
 *   AI-visible text, excluding 4-grams already in the project when that text
 *   arrived.
 */
import { isWhitespace, isWordCodePoint, segmentDoc, tokenizeWords, type PMNode } from '@longhand/schema';

/** Maximum normalized edit distance for the edit-distance rule. */
export const EDIT_DISTANCE_THRESHOLD = 0.15;
/** Consecutive words for the four-word rule. */
export const NGRAM_WORDS = 4;

/** ASCII lower-casing plus curly apostrophes folded to `'`. Length-preserving. */
export function foldChar(ch: string): string {
  const c = ch.charCodeAt(0);
  if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c + 32);
  if (c === 0x2019 || c === 0x2018) return "'";
  return ch;
}

/** Folds a whole string (see {@link foldChar}). */
export function foldText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += foldChar(s[i] as string);
  return out;
}

/** Text with per-character positions (`-1` for synthetic separators). */
export interface PositionedText {
  text: string;
  pos: number[];
}

/**
 * Normalizes for comparison: folds case, collapses whitespace runs to one space and
 * trims, keeping the position of every kept character.
 */
export function normalizePositioned(t: PositionedText): PositionedText {
  let text = '';
  const pos: number[] = [];
  let pendingSpace = -2;
  for (let i = 0; i < t.text.length; i++) {
    const ch = t.text[i] as string;
    if (isWhitespace(ch)) {
      if (text.length > 0 && pendingSpace === -2) pendingSpace = t.pos[i] as number;
      continue;
    }
    if (pendingSpace !== -2) {
      text += ' ';
      pos.push(pendingSpace);
      pendingSpace = -2;
    }
    text += foldChar(ch);
    pos.push(t.pos[i] as number);
  }
  return { text, pos };
}

/** {@link normalizePositioned} for a plain string. */
export function normalize(s: string): string {
  return normalizePositioned({ text: s, pos: Array.from({ length: s.length }, () => -1) }).text;
}

/** Levenshtein distance (UTF-16 code units). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] as number;
}

/** Normalized edit distance in `[0, 1]`: `editDistance / max(len)`. Both empty → 0. */
export function normalizedEditDistance(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  // Cheap lower bound first: the length difference.
  if (Math.abs(a.length - b.length) / max > EDIT_DISTANCE_THRESHOLD) {
    return Math.abs(a.length - b.length) / max;
  }
  return editDistance(a, b) / max;
}

/** True if `a` and `b` (already normalized) are within the edit-distance threshold. */
export function withinEditDistance(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return normalizedEditDistance(a, b) <= EDIT_DISTANCE_THRESHOLD;
}

/** Folded word keys of a text, in order. */
export function wordKeys(text: string): string[] {
  return tokenizeWords(text).map((t) => foldText(t.text));
}

/** All n-grams (`n` consecutive folded words joined by a space) of a text. */
export function ngramsOf(text: string, n = NGRAM_WORDS): Set<string> {
  const words = wordKeys(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

const docNgramCache = new WeakMap<PMNode, Set<string>>();

/** Every 4-gram in a document (per textblock and footnote). Memoized per node. */
export function documentNgrams(doc: PMNode): Set<string> {
  const hit = docNgramCache.get(doc);
  if (hit) return hit;
  const out = new Set<string>();
  const seg = segmentDoc(doc);
  for (const b of [...seg.blocks, ...seg.footnotes]) for (const g of ngramsOf(b.text)) out.add(g);
  docNgramCache.set(doc, out);
  return out;
}

/** True if the code unit at `i` of `s` is a word character (false outside the string). */
export function isWordAt(s: string, i: number): boolean {
  if (i < 0 || i >= s.length) return false;
  return isWordCodePoint(s.charCodeAt(i));
}

/** Start indexes of `needle` in `hay` that begin and end on word boundaries. */
export function wordBoundedIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const startOk = !isWordAt(hay, i - 1) || !isWordAt(needle, 0);
    const endOk = !isWordAt(hay, i + needle.length) || !isWordAt(needle, needle.length - 1);
    if (startOk && endOk) out.push(i);
  }
  return out;
}
