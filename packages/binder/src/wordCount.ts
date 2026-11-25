/**
 * Word counts for binder rows: per document (from its folded content) and per folder
 * (the sum of its non-archived subtree).
 */
import { countWords, type BinderRef, type PMNodeJSON } from '@longhand/schema';
import type { BinderModel } from './model';

/**
 * Plain text of a ProseMirror JSON document for counting: text nodes verbatim (so
 * words split across marks stay whole), `hard_break` as a newline, citations as
 * nothing, and a newline around every other node so words never join across blocks.
 * Footnote text is included.
 */
export function documentText(node: PMNodeJSON): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? [])
    .map((child) => {
      if (child.type === 'text') return child.text ?? '';
      if (child.type === 'hard_break') return '\n';
      if (child.type === 'citation') return '';
      return `\n${documentText(child)}\n`;
    })
    .join('');
}

/** Word count of one document's content. */
export function documentWordCount(
  model: Pick<BinderModel, 'documents'>,
  documentId: string,
): number {
  const doc = model.documents[documentId];
  return doc ? countWords(documentText(doc.content)) : 0;
}

/**
 * Word count of a node: a document's own count, or the sum over a folder's
 * non-archived subtree. `counts` overrides per-document counts when given.
 */
export function nodeWordCount(
  model: BinderModel,
  ref: BinderRef,
  counts?: Readonly<Record<string, number>>,
): number {
  const seen = new Set<string>();
  const count = (r: BinderRef): number => {
    if (r.kind === 'document') {
      if (!model.documents[r.id]) return 0;
      return counts?.[r.id] ?? documentWordCount(model, r.id);
    }
    if (seen.has(r.id)) return 0;
    seen.add(r.id);
    const folder = model.folders[r.id];
    if (!folder) return 0;
    let total = 0;
    for (const child of folder.children) {
      const node = child.kind === 'folder' ? model.folders[child.id] : model.documents[child.id];
      if (node && !node.archived) total += count(child);
    }
    return total;
  };
  return count(ref);
}
