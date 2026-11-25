/**
 * Turns an existing draft (Markdown or plain text) into ProseMirror JSON for
 * `DocumentImported`. Deliberately small: headings, paragraphs, block quotes,
 * lists, scene breaks, hard breaks, *emphasis* and **strong**. Anything else
 * stays as literal text. The fold labels the result `imported` (unverified).
 */
import { docFromJSON, type PMNodeJSON } from '@longhand/schema';

type Inline = PMNodeJSON;

/** `**strong**`, `__strong__`, `*em*`, `_em_` → text nodes with marks. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3/g;
  let last = 0;
  const push = (t: string, marks?: string[]) => {
    if (!t) return;
    const node: Inline = { type: 'text', text: t };
    if (marks?.length) node.marks = marks.map((m) => ({ type: m }));
    out.push(node);
  };
  for (const m of text.matchAll(re)) {
    const i = m.index;
    // `_` inside a word (snake_case) is not emphasis.
    if (m[3] === '_' && i > 0 && /\w/.test(text[i - 1] as string)) continue;
    push(text.slice(last, i));
    if (m[1]) push(m[2] as string, ['strong']);
    else push(m[4] as string, ['em']);
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
