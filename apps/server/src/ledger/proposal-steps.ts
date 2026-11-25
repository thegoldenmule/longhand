/**
 * The steps the fold derives for an accepted proposal, for the editor's
 * `RemoteUpdate` (`CommitTransport.fetchSince` and `subscribe`).
 *
 * `@longhand/ledger` applies these steps inside the fold but does not expose them,
 * so this module re-derives them from the proposal's mapped positions in the state
 * before the accept, following the fold's documented rules (`fold-proposals.ts`).
 * The result is always checked: applied to the document before the accept it must
 * give exactly the folded document, with exactly as many steps as the version
 * advanced. If the port ever disagrees with the fold, a verified fallback (one
 * minimal replace step plus no-op padding) is used instead, so clients still
 * converge on the ledger's document; only the mapping of concurrent local edits is
 * coarser.
 */
import { isWhitespace, schema, type ProposalState } from '@longhand/schema';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { ReplaceStep, StepMap, Transform, type Step } from 'prosemirror-transform';

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

const space = (): Slice => new Slice(Fragment.from(schema.text(' ')), 0, 0);

function cleanGap(tr: Transform, gap: number): void {
  const l = charBefore(tr.doc, gap);
  const r = charAfter(tr.doc, gap);
  const lw = l !== null && isWhitespace(l);
  const rw = r !== null && isWhitespace(r);
  if (lw && rw) tr.step(new ReplaceStep(gap, gap + 1, Slice.empty));
  else if (rw && charBefore(tr.doc, gap) === null)
    tr.step(new ReplaceStep(gap, gap + 1, Slice.empty));
  else if (lw && charAfter(tr.doc, gap) === null)
    tr.step(new ReplaceStep(gap - 1, gap, Slice.empty));
}

function move(tr: Transform, p: Extract<ProposalState, { kind: 'move' }>): void {
  const src = p.source;
  const insertAt = p.insertAt;
  if (!src || insertAt === null) throw new Error('move has no positions');
  const doc = tr.doc;
  const slice = doc.slice(src.from, src.to);
  const delMap = new StepMap([src.from, src.to - src.from, 0]);
  const ins = delMap.map(insertAt, insertAt < src.from ? 1 : -1);
  tr.step(new ReplaceStep(src.from, src.to, Slice.empty));
  tr.step(new ReplaceStep(ins, ins, slice));
  const a = ins;
  let b = ins + slice.size;
  let gap = delMap.map(src.from, -1);
  if (gap >= ins) gap += slice.size;
  if (p.span.unit === 'sentence') {
    const l = charBefore(tr.doc, a);
    const m0 = charAfter(tr.doc, a);
    if (l !== null && m0 !== null && !isWhitespace(l) && !isWhitespace(m0)) {
      if (gap >= a) gap += 1;
      tr.step(new ReplaceStep(a, a, space()));
      b += 1;
    }
    const m1 = charBefore(tr.doc, b);
    const r = charAfter(tr.doc, b);
    if (r !== null && m1 !== null && !isWhitespace(r) && !isWhitespace(m1)) {
      if (gap > b) gap += 1;
      tr.step(new ReplaceStep(b, b, space()));
    }
    cleanGap(tr, gap);
  }
}

function cut(tr: Transform, p: Extract<ProposalState, { kind: 'cut' }>): void {
  const r = p.range;
  if (!r) throw new Error('cut has no range');
  const inline = p.target.kind === 'anchor' || p.target.span.unit === 'sentence';
  if (!inline && r.from === 0 && r.to === tr.doc.content.size) {
    tr.step(
      new ReplaceStep(
        r.from,
        r.to,
        new Slice(Fragment.from(schema.nodes.paragraph!.create()), 0, 0),
      ),
    );
    return;
  }
  tr.step(new ReplaceStep(r.from, r.to, Slice.empty));
  if (inline) cleanGap(tr, r.from);
}

function split(tr: Transform, p: Extract<ProposalState, { kind: 'split' }>): void {
  const pos = p.pos;
  if (pos === null) throw new Error('split has no position');
  const $p = tr.doc.resolve(pos);
  let w = pos;
  for (;;) {
    const ch = charBefore(tr.doc, w);
    if (ch === null || !isWhitespace(ch)) break;
    w -= 1;
  }
  if (w === $p.start()) w = pos;
  const para = schema.nodes.paragraph!;
  tr.step(new ReplaceStep(w, pos, new Slice(Fragment.from([para.create(), para.create()]), 1, 1)));
}

function merge(tr: Transform, p: Extract<ProposalState, { kind: 'merge' }>): void {
  const j = p.joinPos;
  if (j === null) throw new Error('merge has no join position');
  const l = charBefore(tr.doc, j - 1);
  const r = charAfter(tr.doc, j + 1);
  const sp = l !== null && r !== null && !isWhitespace(l) && !isWhitespace(r);
  tr.step(new ReplaceStep(j - 1, j + 1, sp ? space() : Slice.empty));
}

/** Pads `steps` to `n` with no-op steps at position 0 (they apply anywhere and map nothing). */
function pad(steps: Step[], n: number): Step[] {
  const out = [...steps];
  while (out.length < n) out.push(new ReplaceStep(0, 0, Slice.empty));
  return out;
}

/** One replace step from `a` to `b` covering only the region where they differ. */
function diffStep(a: PMNode, b: PMNode): Step | null {
  const start = a.content.findDiffStart(b.content);
  if (start === null) return null;
  const end = a.content.findDiffEnd(b.content);
  if (!end) return null;
  let { a: endA, b: endB } = end;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return new ReplaceStep(start, endA, b.slice(start, endB));
}

function applies(steps: readonly Step[], before: PMNode, after: PMNode): boolean {
  let doc = before;
  for (const s of steps) {
    const r = s.apply(doc);
    if (!r.doc) return false;
    doc = r.doc;
  }
  return doc.eq(after);
}

/** Result of {@link deriveProposalSteps}. */
export interface DerivedSteps {
  steps: Step[];
  /** True when the port of the fold's rules matched exactly; false for the fallback. */
  exact: boolean;
}

/**
 * Steps that take `before` (the document when the proposal was accepted) to
 * `after` (the folded document), `count` of them.
 */
export function deriveProposalSteps(
  proposal: ProposalState | undefined,
  before: PMNode,
  after: PMNode,
  count: number,
): DerivedSteps {
  if (proposal) {
    try {
      const tr = new Transform(before);
      switch (proposal.kind) {
        case 'move':
          move(tr, proposal);
          break;
        case 'cut':
          cut(tr, proposal);
          break;
        case 'split':
          split(tr, proposal);
          break;
        case 'merge':
          merge(tr, proposal);
          break;
      }
      if (tr.steps.length === count && tr.doc.eq(after)) return { steps: tr.steps, exact: true };
    } catch {
      // fall through to the verified fallback
    }
  }
  const d = diffStep(before, after);
  const base = d ? [d] : [];
  if (base.length <= count) {
    const steps = pad(base, count);
    if (applies(steps, before, after)) return { steps, exact: false };
  }
  throw new Error(`cannot derive ${count} step(s) for an accepted proposal`);
}
