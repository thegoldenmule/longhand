// Test-only helpers (not exported from the package).
import { inlineTextBetween, type ProvenanceRun } from '@longhand/schema';
import type { LedgerBuilder } from './builder';
import { documentNode } from './project';

/** Text of a document (blocks joined by `¶`). */
export function textOf(b: LedgerBuilder, id: string): string {
  const n = documentNode(b.state, id)!;
  return inlineTextBetween(n, 0, n.content.size, '¶');
}

/** Runs as `[text, class, originSeq, extras]` for readable assertions. */
export function runsOf(b: LedgerBuilder, id: string): Array<[string, string, number, string?]> {
  const n = documentNode(b.state, id)!;
  return b.project.documents[id]!.provenance.map((r: ProvenanceRun) => {
    const extra = [
      r.suggestionId ? `sug=${r.suggestionId}` : '',
      r.moves ? `moves=${r.moves.join(',')}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const row: [string, string, number, string?] = [
      inlineTextBetween(n, r.from, r.to),
      r.class,
      r.originSeq,
    ];
    if (extra) row.push(extra);
    return row;
  });
}

/** Class of the unit holding the first character of `text`. */
export function classOf(b: LedgerBuilder, id: string, text: string): string | undefined {
  const pos = b.pos(id, { before: text });
  return b.project.documents[id]!.provenance.find((r) => r.from <= pos && pos < r.to)?.class;
}

/** Seq of the last commit. */
export function lastSeq(b: LedgerBuilder): number {
  return b.head.seq;
}
