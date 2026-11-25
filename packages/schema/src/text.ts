/**
 * Deterministic, rule-based text utilities: word tokenizer/counter and sentence splitter.
 *
 * These run inside the fold and the verifier, so they avoid every locale- or
 * ICU-dependent API (`Intl.Segmenter`, `\p{…}` regexes, `localeCompare`,
 * `normalize`). Character classes are explicit code point ranges:
 *
 * - A **word character** is an ASCII letter or digit, or any non-ASCII code point
 *   outside the punctuation/symbol/space ranges in `NON_WORD_RANGES` (so letters
 *   in every script, combining marks and digits count; dashes, quotes, ellipses,
 *   currency, arrows and emoji do not).
 * - A **word** is a maximal run of word characters, where a single apostrophe
 *   (`'` or `’`) or hyphen (`-`, U+2010, U+2011) between two word characters joins
 *   (`don't`, `well-known`), and a single `.` or `,` between two ASCII digits joins
 *   (`3.14`, `1,000`). CJK text without spaces counts one word per run; v1 targets
 *   space-delimited languages.
 */

/** A half-open `[start, end)` range of UTF-16 offsets into a string. */
export interface TextRange {
  start: number;
  end: number;
}

/** A word token: its offsets and text. */
export interface WordToken extends TextRange {
  text: string;
}

// Inclusive code point ranges that are never word characters (non-ASCII part).
const NON_WORD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0080, 0x00a9], // C1 controls, NBSP, ¡ ¢ £ ¤ ¥ ¦ § ¨ ©
  [0x00ab, 0x00b4], // « ¬ SHY ® ¯ ° ± ² ³ ´
  [0x00b6, 0x00b9], // ¶ · ¸ ¹
  [0x00bb, 0x00bf], // » ¼ ½ ¾ ¿
  [0x00d7, 0x00d7], // ×
  [0x00f7, 0x00f7], // ÷
  [0x2000, 0x206f], // General Punctuation (spaces, dashes, quotes, ellipsis, ZWJ…)
  [0x20a0, 0x20cf], // Currency symbols
  [0x2100, 0x214f], // Letterlike symbols (™, ℅…)
  [0x2190, 0x2bff], // Arrows, math operators, technical, box drawing, shapes, dingbats
  [0x2e00, 0x2e7f], // Supplemental punctuation
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0xe000, 0xf8ff], // Private use
  [0xfe00, 0xfe0f], // Variation selectors
  [0xfe10, 0xfe1f], // Vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility + small form variants
  [0xfeff, 0xfeff], // BOM / ZWNBSP
  [0xff01, 0xff0f], // Fullwidth punctuation
  [0xff1a, 0xff20],
  [0xff3b, 0xff40],
  [0xff5b, 0xff65],
  [0xfff0, 0xffff], // Specials (incl. U+FFFC object replacement)
  [0x1f000, 0x1faff], // Emoji, mahjong, playing cards, pictographs
  [0x1fb00, 0x1fbff],
  [0xe0000, 0xe007f], // Tags
];

/** True if the code point is a word character (see module docs). */
export function isWordCodePoint(cp: number): boolean {
  if (cp < 0x80) {
    return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
  }
  for (const [lo, hi] of NON_WORD_RANGES) {
    if (cp < lo) return true;
    if (cp <= hi) return false;
  }
  return true;
}

const WORD_JOINERS = new Set([0x27, 0x2019, 0x2d, 0x2010, 0x2011]);
const DIGIT_JOINERS = new Set([0x2e, 0x2c]);

function isAsciiDigit(cp: number | undefined): boolean {
  return cp !== undefined && cp >= 0x30 && cp <= 0x39;
}

/** Splits text into word tokens (see module docs for the exact rule). */
export function tokenizeWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  // Decode once into code points with their UTF-16 offsets.
  const cps: number[] = [];
  const offs: number[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i) as number;
    cps.push(cp);
    offs.push(i);
    i += cp > 0xffff ? 2 : 1;
  }
  offs.push(text.length);
  let k = 0;
  while (k < cps.length) {
    if (!isWordCodePoint(cps[k] as number)) {
      k++;
      continue;
    }
    const startK = k;
    k++;
    for (;;) {
      if (k < cps.length && isWordCodePoint(cps[k] as number)) {
        k++;
        continue;
      }
      const j = cps[k];
      const next = cps[k + 1];
      if (j !== undefined && next !== undefined && isWordCodePoint(next)) {
        if (WORD_JOINERS.has(j)) {
          k += 2;
          continue;
        }
        if (DIGIT_JOINERS.has(j) && isAsciiDigit(cps[k - 1]) && isAsciiDigit(next)) {
          k += 2;
          continue;
        }
      }
      break;
    }
    const start = offs[startK] as number;
    const end = offs[k] as number;
    tokens.push({ start, end, text: text.slice(start, end) });
  }
  return tokens;
}

/** Number of words in `text` (the counter used for every word bound and word count in Longhand). */
export function countWords(text: string): number {
  return tokenizeWords(text).length;
}

// ---------------------------------------------------------------------------
// Sentence splitter
// ---------------------------------------------------------------------------

const WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

/** True for the whitespace characters recognised by the splitter. */
export function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE.has(ch.charCodeAt(0));
}

const TERMINALS = new Set(['.', '!', '?', '…', '‽', '。', '！', '？']);
const CJK_TERMINALS = new Set(['。', '！', '？']);
const CLOSERS = new Set(['"', "'", '”', '’', '»', '›', ')', ']', '}']);
const OPENERS = new Set(['"', "'", '“', '‘', '«', '‹', '(', '[', '{', '¿', '¡']);

/**
 * Abbreviations (lowercased, without the final period) after which a period never
 * ends a sentence, whatever follows.
 */
export const NON_TERMINAL_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'mr',
  'mrs',
  'ms',
  'mx',
  'messrs',
  'mmes',
  'mme',
  'mlle',
  'dr',
  'drs',
  'prof',
  'profs',
  'rev',
  'revd',
  'hon',
  'st',
  'ste',
  'mt',
  'gen',
  'lt',
  'maj',
  'capt',
  'cpt',
  'sgt',
  'cpl',
  'pvt',
  'adm',
  'cmdr',
  'sen',
  'rep',
  'gov',
  'pres',
  'supt',
  'insp',
  'fr',
  'e.g',
  'i.e',
  'cf',
  'viz',
  'vs',
  'v',
  'al',
  'approx',
  'esp',
  'incl',
  'resp',
  'op',
]);

/** Abbreviations after which a period does not end a sentence when the next word starts with a digit (`No. 5`, `pp. 12`). */
export const NUMERIC_PREFIX_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'no',
  'nos',
  'nr',
  'vol',
  'vols',
  'p',
  'pp',
  'para',
  'paras',
  'fig',
  'figs',
  'ch',
  'chap',
  'chs',
  'sec',
  'secs',
  'art',
  'arts',
  'eq',
  'eqs',
  'ex',
  'n',
  'nn',
  'l',
  'll',
  'ln',
  'col',
  'cols',
  'c',
  'ca',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'est',
]);

function isLower(ch: string): boolean {
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase();
}

function isUpperAsciiLetter(s: string): boolean {
  return s.length === 1 && s >= 'A' && s <= 'Z';
}

const ENUMERATOR_RE = /^(\d{1,3}|[A-Za-z]|[ivxlcdmIVXLCDM]{1,5})$/;

/**
 * Decides whether the terminal punctuation run at `[termPos, termEnd)` followed by
 * closers up to `end` ends the sentence that began at `sentStart`.
 */
function isBoundary(
  text: string,
  sentStart: number,
  termPos: number,
  termEnd: number,
  end: number,
): boolean {
  const run = text.slice(termPos, termEnd);
  for (const ch of run) if (CJK_TERMINALS.has(ch)) return true;
  if (end >= text.length) return true;
  if (!isWhitespace(text[end])) return false;
  let next = end;
  while (next < text.length && isWhitespace(text[next])) next++;
  if (next >= text.length) return true;
  while (next < text.length && OPENERS.has(text[next] as string)) next++;
  if (next >= text.length) return true;
  const cp = text.codePointAt(next) as number;
  const c = String.fromCodePoint(cp);
  if (!isWordCodePoint(cp)) return false; // next token starts with punctuation: —, …, ",", etc.
  if (isLower(c)) return false; // '"Help!" she cried.' / 'approx. ten'
  if (run.includes('!') || run.includes('?') || run.includes('‽')) return true;
  if (run.includes('…') || run.length >= 2) return true; // ellipsis before a capital
  // A single period: look at the token before it.
  let tokStart = termPos;
  while (tokStart > sentStart && !isWhitespace(text[tokStart - 1])) tokStart--;
  while (tokStart < termPos && OPENERS.has(text[tokStart] as string)) tokStart++;
  const token = text.slice(tokStart, termPos);
  const lower = token.toLowerCase();
  if (NON_TERMINAL_ABBREVIATIONS.has(lower)) return false;
  if (isAsciiDigit(cp) && NUMERIC_PREFIX_ABBREVIATIONS.has(lower)) return false;
  if (isUpperAsciiLetter(token)) return false; // initials: "J. K. Rowling"
  if (tokStart === sentStart && ENUMERATOR_RE.test(token)) return false; // "1. First…"
  return true;
}

/**
 * Splits text into sentences. Returns half-open UTF-16 ranges trimmed of surrounding
 * whitespace; whitespace-only text yields `[]`. Deterministic and rule-based:
 *
 * - Candidate boundaries are runs of `. ! ? … ‽ 。 ！ ？`, extended over closing quotes
 *   and brackets (`" ' ” ’ » › ) ] }`) and further terminals.
 * - A candidate ends a sentence only if followed by whitespace (or end of text),
 *   except CJK terminals, which always end one. So `3.14`, `e.g.,` and `U.S.A` never split.
 * - The next token (after skipping opening quotes/brackets) must start with a
 *   non-lowercase letter or a digit; lowercase or punctuation means no boundary
 *   (`"Help!" she cried.`, `Wait... what?`).
 * - A single period after a known abbreviation ({@link NON_TERMINAL_ABBREVIATIONS},
 *   or {@link NUMERIC_PREFIX_ABBREVIATIONS} before a digit), after a single capital
 *   letter (initials), or after a lone enumerator at sentence start (`1.`, `a.`, `iv.`)
 *   is not a boundary.
 * - Line breaks are ordinary whitespace.
 */
export function splitSentences(text: string): TextRange[] {
  const out: TextRange[] = [];
  const n = text.length;
  let start = 0;
  while (start < n && isWhitespace(text[start])) start++;
  let pos = start;
  while (pos < n) {
    if (!TERMINALS.has(text[pos] as string)) {
      pos++;
      continue;
    }
    let termEnd = pos;
    while (termEnd < n && TERMINALS.has(text[termEnd] as string)) termEnd++;
    let end = termEnd;
    while (end < n && (CLOSERS.has(text[end] as string) || TERMINALS.has(text[end] as string)))
      end++;
    if (isBoundary(text, start, pos, termEnd, end)) {
      out.push({ start, end });
      start = end;
      while (start < n && isWhitespace(text[start])) start++;
      pos = start;
    } else {
      pos = end;
    }
  }
  if (start < n) {
    let end = n;
    while (end > start && isWhitespace(text[end - 1])) end--;
    if (end > start) out.push({ start, end });
  }
  return out;
}
