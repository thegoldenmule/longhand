/**
 * Folding `ProposalAccepted`: the fold derives the steps itself from the positions
 * it has been mapping for the proposal (never by re-resolving ids), so no new words
 * can enter and moved words keep their provenance.
 *
 * - **move**: delete the source, insert the same slice at the mapped insertion
 *   point. Moved units keep `class`/`originSeq` and gain the accept seq in `moves`.
 *   Annotations inside the moved text move with it. For sentence moves, one U+0020
 *   is inserted on a side where neither the neighbour nor the moved text has
 *   whitespace, and one whitespace character is removed where the source left two
 *   in a row (or a leading/trailing one at a block edge).
 * - **cut**: delete the range (whole nodes for paragraph/section spans), with the
 *   same whitespace clean-up at the gap for inline cuts.
 * - **split**: split the paragraph at the sentence start, removing the whitespace
 *   that separated the two sentences.
 * - **merge**: join the two paragraphs, inserting one U+0020 when neither side has
 *   whitespace at the join.
 *
 * Inserted spaces are class `typed` with `originSeq` = the accept seq (they carry
 * no words).
 */
import { isWhitespace, schema, type CommitOf, type PMNode, type ProposalState } from '@longhand/schema';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep, StepMap } from 'prosemirror-transform';
import { beginDocCommit, buryAll, finishDocCommit, stepDoc, type DocCommit } from './doccommit';
import { FoldError } from './issues';
import { prov, provAt, withMove, type Prov } from './prov';
import type { Span, Tracker, Tx } from './state';
import { unitsBetween } from './units';

function charBefore(doc: PMNode, pos: number): string | null {
  if (pos <= 0 || pos > doc.content.size) return null;
  const $p = doc.resolve(pos);
  if (!$p.parent.isTextblock || $p.parentOffset === 0) return null;
  const n = $p.nodeBefore;
  if (!n || !n.isText) return null;
  const t = n.text as string;
  return t[t.length - 1] ?? null;
}

function charAfter(doc: PMNode, pos: number): string | null {
  if (pos < 0 || pos >= doc.content.size) return null;
  const $p = doc.resolve(pos);
  if (!$p.parent.isTextblock || $p.parentOffset === $p.parent.content.size) return null;
  const n = $p.nodeAfter;
  if (!n || !n.isText) return null;
  return (n.text as string)[0] ?? null;
}

const SPACE = (): Slice => new Slice(Fragment.from(schema.text(' ')), 0, 0);

function insertSpace(dc: DocCommit, pos: number): void {
  const p = prov('typed', dc.seq);
  stepDoc(
    dc,
    new ReplaceStep(pos, pos, SPACE()),
    (a) => ({ assigned: a.changes.map((c) => c.inserted.map(() => p)), buried: a.changes.map(() => []) }),
    { typed: false, hint: null },
  );
}

function deleteRange(dc: DocCommit, from: number, to: number, slice: Slice = Slice.empty): void {
  const token = {};
  const p = prov('typed', dc.seq);
  stepDoc(
    dc,
    new ReplaceStep(from, to, slice),
    (a) => ({ assigned: a.changes.map((c) => c.inserted.map(() => p)), buried: buryAll(a.changes, dc.seq, token) }),
    { typed: false, hint: null },
  );
}

/** Removes one whitespace character where a deletion at `gap` left a double or edge space. */
function cleanGap(dc: DocCommit, gap: number): void {
  const l = charBefore(dc.node, gap);
  const r = charAfter(dc.node, gap);
  const lw = l !== null && isWhitespace(l);
  const rw = r !== null && isWhitespace(r);
  if (lw && rw) deleteRange(dc, gap, gap + 1);
  else if (rw && charBefore(dc.node, gap) === null) deleteRange(dc, gap, gap + 1);
  else if (lw && charAfter(dc.node, gap) === null) deleteRange(dc, gap - 1, gap);
}

function fail(seq: number, msg: string): never {
  throw new FoldError(seq, 'proposal-failed', msg);
}

function acceptMove(dc: DocCommit, t: Tracker, unit: 'sentence' | 'paragraph' | 'section'): void {
  const src = t.range;
  const insertAt = t.point;
  if (!src || insertAt === null) fail(dc.seq, 'move proposal has no current positions');
  if (insertAt >= src.from && insertAt <= src.to) fail(dc.seq, 'move destination lies inside its source');
  const doc = dc.node;
  if (unit !== 'sentence') {
    for (const p of [src.from, src.to, insertAt]) {
      if (doc.resolve(p).depth !== 0) fail(dc.seq, 'move positions are no longer top-level boundaries');
    }
  }
  const slice = doc.slice(src.from, src.to);
  const moved = unitsBetween(doc, src.from, src.to).map((u) => ({ key: u.key, p: provAt(dc.runs, u.pos) as Prov }));
  const delMap = new StepMap([src.from, src.to - src.from, 0]);
  const ins = delMap.map(insertAt, insertAt < src.from ? 1 : -1);
  // Annotations wholly inside the moved text move with it.
  const relocated = new Map<string, { range: Span | null; point: number | null }>();
  const shift = (x: number): number => ins + (x - src.from);
  for (const o of dc.trackers) {
    if (o.id === t.id) continue;
    const r = o.range;
    if (!r || r.from < src.from || r.to > src.to) continue;
    if (o.point !== null && (o.point < src.from || o.point > src.to)) continue;
    if (o.ref && (o.ref.from < src.from || o.ref.to > src.to)) continue;
    relocated.set(o.id, {
      range: { from: shift(r.from), to: shift(r.to) },
      point: o.point === null ? null : shift(o.point),
    });
  }
  const facts = { typed: false, hint: null, relocated };
  stepDoc(dc, new ReplaceStep(src.from, src.to, Slice.empty), (a) => ({
    assigned: a.changes.map((c) => c.inserted.map(() => prov('typed', dc.seq))),
    buried: a.changes.map(() => []),
  }), facts);
  stepDoc(dc, new ReplaceStep(ins, ins, slice), (a) => {
    const assigned = a.changes.map((c) => {
      if (c.inserted.length !== moved.length) fail(dc.seq, 'moved content changed shape');
      return c.inserted.map((u, i) => {
        const m = moved[i] as { key: string; p: Prov };
        if (m.key !== u.key) fail(dc.seq, 'moved content changed');
        return withMove(m.p, dc.seq);
      });
    });
    return { assigned, buried: a.changes.map(() => []) };
  }, facts);
  // Relocated trackers are already at their final positions; restore ref ranges too.
  for (const o of dc.trackers) {
    if (!relocated.has(o.id) || !o.ref) continue;
    o.ref = { from: shift(o.ref.from), to: shift(o.ref.to) };
  }
  let a = ins;
  let b = ins + slice.size;
  let gap = delMap.map(src.from, -1);
  if (gap >= ins) gap += slice.size;
  if (unit === 'sentence') {
    const mapGap = (pos: number): void => {
      if (gap >= pos) gap += 1;
    };
    const l = charBefore(dc.node, a);
    const m0 = charAfter(dc.node, a);
    if (l !== null && m0 !== null && !isWhitespace(l) && !isWhitespace(m0)) {
      mapGap(a);
      insertSpace(dc, a);
      a += 1;
      b += 1;
    }
    const m1 = charBefore(dc.node, b);
    const r = charAfter(dc.node, b);
    if (r !== null && m1 !== null && !isWhitespace(r) && !isWhitespace(m1)) {
      if (gap > b) gap += 1;
      insertSpace(dc, b);
    }
    cleanGap(dc, gap);
  }
}

function acceptCut(dc: DocCommit, t: Tracker, inline: boolean): void {
  const r = t.range;
  if (!r) fail(dc.seq, 'cut proposal has no current range');
  const doc = dc.node;
  if (!inline && r.from === 0 && r.to === doc.content.size) {
    deleteRange(dc, r.from, r.to, new Slice(Fragment.from(schema.nodes.paragraph!.create()), 0, 0));
    return;
  }
  if (!inline) {
    for (const p of [r.from, r.to]) if (doc.resolve(p).depth !== 0) fail(dc.seq, 'cut range is no longer whole nodes');
  }
  deleteRange(dc, r.from, r.to);
  if (inline) cleanGap(dc, r.from);
}

function acceptSplit(dc: DocCommit, t: Tracker): void {
  const pos = t.point;
  if (pos === null) fail(dc.seq, 'split proposal has no current position');
  const $p = dc.node.resolve(pos);
  if ($p.parent.type.name !== 'paragraph' || $p.parentOffset === 0) fail(dc.seq, 'split position is not inside a paragraph');
  let w = pos;
  for (;;) {
    const ch = charBefore(dc.node, w);
    if (ch === null || !isWhitespace(ch)) break;
    w -= 1;
  }
  if (w === $p.start()) w = pos;
  const para = schema.nodes.paragraph!;
  deleteRange(dc, w, pos, new Slice(Fragment.from([para.create(), para.create()]), 1, 1));
}

function acceptMerge(dc: DocCommit, t: Tracker): void {
  const j = t.point;
  if (j === null) fail(dc.seq, 'merge proposal has no current join position');
  const $j = dc.node.resolve(j);
  const before = $j.nodeBefore;
  const after = $j.nodeAfter;
  if (before?.type.name !== 'paragraph' || after?.type.name !== 'paragraph') {
    fail(dc.seq, 'merge join no longer sits between two paragraphs');
  }
  const l = charBefore(dc.node, j - 1);
  const r = charAfter(dc.node, j + 1);
  const space = l !== null && r !== null && !isWhitespace(l) && !isWhitespace(r);
  deleteRange(dc, j - 1, j + 1, space ? SPACE() : Slice.empty);
}

/** Folds `ProposalAccepted`. */
export function foldProposalAccepted(tx: Tx, c: CommitOf<'ProposalAccepted'>): boolean {
  const p = c.payload;
  const prop = tx.s.ann.proposals[p.proposalId];
  if (!prop) {
    tx.issue('unknown-target', `no proposal ${p.proposalId}`);
    return false;
  }
  if (prop.documentId !== p.documentId) {
    tx.issue('document-mismatch', `proposal ${prop.id} is for document ${prop.documentId}`);
    return false;
  }
  if (prop.status !== 'open') {
    tx.issue('not-open', `proposal ${prop.id} is ${prop.status}`);
    return false;
  }
  const base = tx.s.docs[p.documentId];
  if (!base) throw new FoldError(c.seq, 'unknown-document', `no document ${p.documentId}`);
  if (p.baseVersion !== base.version) {
    throw new FoldError(
      c.seq,
      'base-version-mismatch',
      `baseVersion ${p.baseVersion} but document ${p.documentId} is at version ${base.version}`,
    );
  }
  const dc = beginDocCommit(tx, base);
  const t = dc.trackers.find((x) => x.id === prop.id);
  if (!t) fail(c.seq, `proposal ${prop.id} has no positions`);
  t.watch = false;
  switch (prop.kind) {
    case 'move':
      acceptMove(dc, t, prop.span.unit);
      break;
    case 'cut':
      acceptCut(dc, t, prop.target.kind === 'anchor' || prop.target.span.unit === 'sentence');
      break;
    case 'split':
      acceptSplit(dc, t);
      break;
    case 'merge':
      acceptMerge(dc, t);
      break;
  }
  t.range = null;
  t.point = null;
  t.ref = null;
  tx.ann('proposals')[prop.id] = { ...prop, status: 'accepted', resolvedSeq: c.seq } as ProposalState;
  finishDocCommit(dc, { matcher: false, contentChanged: !dc.node.eq(base.node) });
  return true;
}
