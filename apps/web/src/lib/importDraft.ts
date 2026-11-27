/**
 * Turns an existing draft (Markdown or plain text) into ProseMirror JSON for
 * `DocumentImported`. Deliberately small: headings, paragraphs, block quotes,
 * lists, scene breaks, hard breaks, *emphasis*, **strong**, `inline code` and
 * [links](https://example.com). A link whose destination the schema's href
 * policy refuses (anything but http, https and mailto) stays literal text, as
 * does anything else. The fold labels the result `imported` (unverified).
 */
import { UNTITLED, titleOrUntitled } from '@longhand/binder';
import {
  TEXT_LIMITS,
  docFromJSON,
  normalizeHref,
  type PMMarkJSON,
  type PMNodeJSON,
} from '@longhand/schema';

type Inline = PMNodeJSON;

/** Mark rank order in the schema: marks must be listed in it. */
const MARK_ORDER = ['link', 'em', 'strong', 'code'];

function sortMarks(marks: PMMarkJSON[]): PMMarkJSON[] {
  return [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

/**
 * One pass over inline Markdown. Groups: 1–2 a code span (content literal),
 * 3–4 `[text](destination "optional title")`, 5–6 `**strong**` or `__strong__`,
 * 7–8 `*em*` or `_em_`.
 */
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(\s*<?([^()\s<>]+)>?(?:\s+"[^"\n]*")?\s*\)|(\*\*|__)(?=\S)([\s\S]*?\S)\5|(\*|_)(?=\S)([\s\S]*?\S)\7/g;

/** `**strong**`, `*em*`, `` `code` `` and `[text](url)` → text nodes with marks. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (t: string, marks: PMMarkJSON[] = []) => {
    if (!t) return;
    const node: Inline = { type: 'text', text: t };
    if (marks.length) node.marks = sortMarks(marks);
    out.push(node);
  };
  for (const m of text.matchAll(INLINE)) {
    const i = m.index;
    // `_` inside a word (snake_case) is not emphasis.
    if ((m[5] === '__' || m[7] === '_') && i > 0 && /\w/.test(text[i - 1] as string)) continue;
    let nodes: Inline[];
    if (m[1]) {
      // CommonMark strips one space on each side when both are there.
      let code = m[2] as string;
      if (/^ [\s\S]* $/.test(code) && code.trim() !== '') code = code.slice(1, -1);
      nodes = [{ type: 'text', text: code, marks: [{ type: 'code' }] }];
    } else if (m[3] !== undefined) {
      const href = normalizeHref(m[4] as string);
      if (!href) continue;
      const link: PMMarkJSON = { type: 'link', attrs: { href } };
      nodes = parseInline(m[3]).map((n) => ({
        ...n,
        marks: sortMarks([link, ...(n.marks ?? [])]),
      }));
    } else if (m[5]) {
      nodes = [{ type: 'text', text: m[6] as string, marks: [{ type: 'strong' }] }];
    } else {
      nodes = [{ type: 'text', text: m[8] as string, marks: [{ type: 'em' }] }];
    }
    push(text.slice(last, i));
    out.push(...nodes.filter((n) => n.text));
    last = i + m[0].length;
  }
  push(text.slice(last));
  return out;
}

function inlineWithBreaks(lines: string[], markdown: boolean): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push({ type: 'hard_break' });
    const t = line.replace(/\s+$/, '');
    if (markdown) out.push(...parseInline(t));
    else if (t) out.push({ type: 'text', text: t });
  });
  return out;
}

function paragraph(content: Inline[]): PMNodeJSON {
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

/** Parses Markdown into a document. */
export function markdownToDoc(source: string): PMNodeJSON {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: PMNodeJSON[] = [];
  let i = 0;
  const isBlank = (l: string | undefined) => l === undefined || l.trim() === '';
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = Math.min(3, (h[1] as string).length);
      const content = parseInline(h[2] as string);
      blocks.push(
        content.length
          ? { type: 'heading', attrs: { level }, content }
          : { type: 'heading', attrs: { level } },
      );
      i++;
      continue;
    }
    if (/^\s*([*\-_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'scene_break' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string)) {
        quoted.push((lines[i] as string).replace(/^\s*>\s?/, ''));
        i++;
      }
      const inner = markdownToDoc(quoted.join('\n')).content ?? [];
      blocks.push({ type: 'blockquote', content: inner.length ? inner : [paragraph([])] });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/;
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line);
      const re = isOrdered ? ordered : bullet;
      const items: PMNodeJSON[] = [];
      const start = isOrdered ? Number((ordered.exec(line) as RegExpExecArray)[1]) : 1;
      while (i < lines.length && re.test(lines[i] as string)) {
        const m = re.exec(lines[i] as string) as RegExpExecArray;
        const text = (isOrdered ? m[2] : m[1]) as string;
        items.push({ type: 'list_item', content: [paragraph(parseInline(text))] });
        i++;
      }
      blocks.push(
        isOrdered
          ? { type: 'ordered_list', attrs: { order: start }, content: items }
          : { type: 'bullet_list', content: items },
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i] as string) &&
      !/^\s*>/.test(lines[i] as string)
    ) {
      para.push((lines[i] as string).trim());
      i++;
    }
    // Markdown joins soft-wrapped lines with a space; two trailing spaces or a
    // backslash would be a hard break, which drafts rarely mean.
    blocks.push(paragraph(parseInline(para.join(' '))));
  }
  return { type: 'doc', content: blocks.length ? blocks : [paragraph([])] };
}

/** Plain text: blank lines separate paragraphs, single newlines are hard breaks. */
export function textToDoc(source: string): PMNodeJSON {
  const paras = source
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim() !== '');
  const blocks = paras.map((p) => paragraph(inlineWithBreaks(p.split('\n'), false)));
  return { type: 'doc', content: blocks.length ? blocks : [paragraph([])] };
}

/** SHA-256 hex of the original bytes (`DocumentImported.sourceHash`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Parses a draft by format and checks it against the schema. */
export function draftToDoc(text: string, format: 'markdown' | 'text'): PMNodeJSON {
  const json = format === 'markdown' ? markdownToDoc(text) : textToDoc(text);
  docFromJSON(json); // throws on anything the schema rejects
  return json;
}

/** Guesses the format from a file name (`.md`/`.markdown` → markdown). */
export function formatForName(name: string | null): 'markdown' | 'text' {
  return name && /\.(md|markdown|mdown)$/i.test(name) ? 'markdown' : 'text';
}

/** The plain text of an inline run (hard breaks read as spaces). */
function inlineText(node: PMNodeJSON): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hard_break') return ' ';
  return (node.content ?? []).map(inlineText).join('');
}

/**
 * The draft's title when its first block is a level-1 heading (`# Title`) with
 * text of 200 characters or fewer, else null.
 */
export function leadingTitle(doc: PMNodeJSON): string | null {
  const first = doc.content?.[0];
  if (first?.type !== 'heading' || first.attrs?.level !== 1) return null;
  const text = inlineText(first).replace(/\s+/g, ' ').trim();
  return text && text.length <= TEXT_LIMITS.titleMaxChars ? text : null;
}

/** The draft without its leading title heading. A draft left empty is one empty paragraph. */
export function withoutLeadingTitle(doc: PMNodeJSON): PMNodeJSON {
  if (leadingTitle(doc) === null) return doc;
  const rest = (doc.content ?? []).slice(1);
  return { ...doc, content: rest.length ? rest : [{ type: 'paragraph' }] };
}

/**
 * An imported draft's name, and its content: the Title field, else the leading
 * `# Heading`, else the file name without its extension, else Untitled. A leading
 * heading equal to that name becomes the name and leaves the body.
 */
export function importTitle(input: { title: string; doc: PMNodeJSON; fileName: string | null }): {
  title: string;
  content: PMNodeJSON;
} {
  const heading = leadingTitle(input.doc);
  const fromFile = (input.fileName ?? '')
    .replace(/\.[^.]+$/, '')
    .slice(0, TEXT_LIMITS.titleMaxChars);
  const pick = [input.title, heading ?? '', fromFile].find((t) => t.trim() !== '');
  const title = titleOrUntitled(pick ?? UNTITLED);
  const content =
    heading !== null && heading === title ? withoutLeadingTitle(input.doc) : input.doc;
  return { title, content };
}
