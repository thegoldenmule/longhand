/**
 * Folding `TextEdited`: input-method runs, provenance classes and their
 * verification, and the companion events (`PasteOccurred`, `SliceCopied`,
 * `CitationInserted`).
 *
 * | Method | Inserted text gets |
 * | --- | --- |
 * | `typed`, `ime`, `autocorrect` | `typed` (a common prefix/suffix with the text it replaces keeps the old provenance); `typed-from-suggestion` with a valid `traceSuggestionId` |
 * | `pasted-external` | `pasted-external` |
 * | `pasted-internal` | the `SliceCopied` snapshot's provenance (plus this seq in `moves`) if the inserted units equal the snapshot exactly, else `pasted-external` |
 * | `drop-internal` | the provenance of the units this run deleted, if the inserted units equal them exactly, else `pasted-external` |
 * | `history` | the provenance of matching deleted content (tombstones), else `pasted-external` |
 * | `citation` | `quoted` if it inserts only `citation` nodes of the `CitationInserted` source, else `pasted-external` |
 * | `clipping` | `quoted` if it inserts exactly one whole `quote_block` of that clipping, else `pasted-external` |
 */
import {
  countWords,
  inlineTextBetween,
  schema,
  sha256Hex,
  type CommitOf,
  type InputRun,
  type PMNode,
} from '@longhand/schema';
import { Step } from 'prosemirror-transform';
import { beginDocCommit, buryAll, finishDocCommit, stepDoc, type DocCommit } from './doccommit';
import { quoteBlockText } from './doctext';
import { findInTombs, type DeadUnit, type Tomb } from './engine';
import { FoldError } from './issues';
import {
  canonicalRuns,
  matchOf,
  prov,
  provAt,
  remapUnits,
  withMove,
  type Match,
  type Prov,
} from './prov';
import type { Tx } from './state';
import { isCitationKey, keyText, unitsBetween, type UnitRef } from './units';

const TYPED_METHODS = new Set(['typed', 'ime', 'autocorrect']);
const PENDING_METHODS = new Set(['pasted-internal', 'drop-internal', 'citation', 'clipping']);

/** Units of the current document whose provenance satisfies `test`, ascending. */
function unitsWhere(dc: DocCommit, test: (p: Prov) => boolean): UnitRef[] {
  const out: UnitRef[] = [];
  for (const r of dc.runs) {
    if (!test(r.p)) continue;
    out.push(...unitsBetween(dc.node, r.from, r.to));
  }
  return out;
}

/** Inline text of a list of units: `\n` wherever positions jump (block boundaries). */
function unitsText(units: readonly UnitRef[]): string {
  let s = '';
  let last = -2;
  for (const u of units) {
    if (last >= 0 && u.pos !== last + 1 && s.length > 0) s += '\n';
    s += keyText(u.key);
    last = u.pos;
  }
  return s;
}

function sameKeys(a: readonly { key: string }[], b: readonly { key: string }[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++)
    if ((a[i] as { key: string }).key !== (b[i] as { key: string }).key) return false;
  return true;
}

/**
 * Clipping text compared with blank lines collapsed on both sides (coordinator
 * decision): empty paragraphs and `\n\n` runs carry no words, and editors and
 * `inlineTextBetween` drop them.
 */
export function collapseBlankLines(s: string): string {
  return s.replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '');
}

function verifyClipping(dc: DocCommit, pending: readonly UnitRef[], clippingId: string): boolean {
  const clip = dc.tx.s.clippings[clippingId];
  if (!clip || clip.removed || pending.length === 0) return false;
  const $p = dc.node.resolve((pending[0] as UnitRef).pos);
  let qb: PMNode | null = null;
  let qbPos = -1;
  for (let d = $p.depth; d > 0; d--) {
    if ($p.node(d).type.name === 'quote_block') {
      qb = $p.node(d);
      qbPos = $p.before(d);
      break;
    }
  }
  if (!qb) return false;
  if (qb.attrs.clippingId !== clippingId || qb.attrs.sourceId !== clip.sourceId) return false;
  const inside = unitsBetween(dc.node, qbPos + 1, qbPos + qb.nodeSize - 1);
  if (inside.length !== pending.length) return false;
  for (let i = 0; i < inside.length; i++)
    if ((inside[i] as UnitRef).pos !== (pending[i] as UnitRef).pos) return false;
  return collapseBlankLines(quoteBlockText(qb)) === collapseBlankLines(clip.text);
}

function verifyCitation(dc: DocCommit, pending: readonly UnitRef[], citationId: string): boolean {
  const rec = dc.tx.s.citations[citationId];
  if (!rec || rec.used || rec.documentId !== dc.base.id || pending.length === 0) return false;
  if (!dc.tx.s.sources[rec.sourceId]) return false;
  for (const u of pending) {
    if (!isCitationKey(u.key)) return false;
    const node = dc.node.nodeAt(u.pos);
    if (
      !node ||
      node.attrs.sourceId !== rec.sourceId ||
      (node.attrs.locator ?? null) !== rec.locator
    )
      return false;
  }
  return true;
}

function recordPaste(
  tx: Tx,
  pasteId: string,
  seq: number,
  units: readonly UnitRef[],
  verifiedInternal: boolean,
): void {
  const paste = tx.s.pastes[pasteId];
  if (!paste || paste.insertedSeq !== null) return;
  const text = unitsText(units);
  let characters = 0;
  for (const u of units) if (keyText(u.key).length > 0) characters++;
  tx.rec('pastes')[pasteId] = {
    ...paste,
    insertedSeq: seq,
    characters,
    words: countWords(text),
    verifiedInternal,
  };
}

/** Folds one input-method run. */
function foldRun(dc: DocCommit, run: InputRun, steps: readonly Step[]): void {
  const { tx, seq } = dc;
  const method = run.method;
  const token = {};
  const typedLike = TYPED_METHODS.has(method);
  let hint: Match | null = null;
  if (run.traceSuggestionId !== undefined) {
    const sug = tx.s.ann.suggestions[run.traceSuggestionId];
    const docOf = sug ? (sug.kind === 'insertion' ? sug.documentId : sug.anchor.documentId) : null;
    if (!sug)
      tx.issue('unknown-hint', `traceSuggestionId ${run.traceSuggestionId} names no suggestion`);
    else if (docOf !== dc.base.id)
      tx.issue('document-mismatch', `suggestion ${sug.id} is in another document`);
    else hint = { id: sug.id, kind: sug.kind === 'insertion' ? 'insertion' : 'suggestion' };
  }
  const typedProv = hint ? prov('typed-from-suggestion', seq, hint) : prov('typed', seq);
  const pasteProv: Prov = { class: 'pasted-external', originSeq: seq, pend: token };
  const pendProv: Prov = { class: 'pasted-external', originSeq: seq, pend: token };
  const pendingMethod = PENDING_METHODS.has(method);

  for (const step of steps) {
    stepDoc(
      dc,
      step,
      (applied) => {
        const assigned: Prov[][] = [];
        const buried: Array<Array<{ pos: number; unit: DeadUnit }>> = [];
        let tombs: Tomb[] | undefined;
        const extra: Tomb[] = [];
        applied.changes.forEach((c, ci) => {
          const ins = c.inserted;
          const del = c.deleted;
          if (typedLike) {
            let k = 0;
            while (k < ins.length && k < del.length && ins[k]!.key === del[k]!.key) k++;
            let s = 0;
            while (
              s < ins.length - k &&
              s < del.length - k &&
              ins[ins.length - 1 - s]!.key === del[del.length - 1 - s]!.key
            ) {
              s++;
            }
            assigned[ci] = ins.map((_, j) =>
              j < k
                ? del[j]!.p
                : j >= ins.length - s
                  ? del[del.length - (ins.length - j)]!.p
                  : typedProv,
            );
            buried[ci] = del
              .slice(k, del.length - s)
              .map((u) => ({ pos: u.pos, unit: { key: u.key, p: u.p, seq, tag: token } }));
            return;
          }
          buried[ci] = (buryAll([c], seq, token)[0] ?? []) as Array<{
            pos: number;
            unit: DeadUnit;
          }>;
          if (method === 'history' && ins.length > 0) {
            const current: Tomb[] = tombs ?? [...dc.tombs];
            const m = findInTombs(
              current,
              ins.map((u) => u.key),
              c.oldStart,
              c.oldEnd,
            );
            if (m) {
              const tomb = current[m.tombIndex] as Tomb;
              const matched = tomb.units.slice(m.start, m.start + m.length);
              const left = tomb.units.slice(0, m.start);
              const right = tomb.units.slice(m.start + m.length);
              if (tomb.pos >= c.oldStart && tomb.pos <= c.oldEnd) {
                current[m.tombIndex] = { pos: tomb.pos, units: left };
                extra.push({ pos: c.newEnd, units: right });
              } else {
                current[m.tombIndex] = { pos: tomb.pos, units: [...left, ...right] };
              }
              tombs = current.filter((t) => t.units.length > 0);
              assigned[ci] = matched.map((u) => u.p);
              return;
            }
            assigned[ci] = ins.map(() => prov('pasted-external', seq));
            return;
          }
          if (method === 'pasted-external') {
            assigned[ci] = ins.map(() => pasteProv);
            return;
          }
          if (pendingMethod) {
            assigned[ci] = ins.map(() => pendProv);
            return;
          }
          assigned[ci] = ins.map(() => prov('pasted-external', seq));
        });
        return { assigned, buried, tombs, extra };
      },
      { typed: typedLike, hint: hint?.id ?? null },
    );
  }

  // Resolve the run.
  if (method === 'pasted-external') {
    const units = unitsWhere(dc, (p) => p === pasteProv);
    const plain = prov('pasted-external', seq);
    dc.runs = remapUnits(
      dc.runs,
      units.map((u) => u.pos),
      () => plain,
    );
    const paste = run.pasteId ? tx.s.pastes[run.pasteId] : undefined;
    if (paste && paste.documentId === dc.base.id) recordPaste(tx, paste.id, seq, units, false);
  }
  if (!pendingMethod) return;
  const pending = unitsWhere(dc, (p) => p.pend === token);
  let resolved: Prov[] | null = null;
  if (method === 'pasted-internal') {
    const paste = run.pasteId ? tx.s.pastes[run.pasteId] : undefined;
    const copyId = run.pasteId ? tx.s.pasteCopyIds[run.pasteId] : null;
    const snap = copyId ? tx.s.copies[copyId] : undefined;
    const ok =
      paste !== undefined &&
      paste.origin === 'internal' &&
      paste.documentId === dc.base.id &&
      paste.insertedSeq === null &&
      snap !== undefined &&
      snap.units !== null &&
      sameKeys(snap.units, pending);
    if (ok) resolved = (snap.units ?? []).map((u) => withMove(u.p, seq));
    if (paste && paste.documentId === dc.base.id) recordPaste(tx, paste.id, seq, pending, ok);
  } else if (method === 'drop-internal') {
    const removed: DeadUnit[] = [];
    for (const t of dc.tombs) for (const u of t.units) if (u.tag === token) removed.push(u);
    if (removed.length > 0 && sameKeys(removed, pending)) {
      resolved = removed.map((u) => withMove(u.p, seq));
      dc.tombs = dc.tombs
        .map((t) => ({ pos: t.pos, units: t.units.filter((u) => u.tag !== token) }))
        .filter((t) => t.units.length > 0);
    }
  } else if (method === 'citation') {
    if (run.citationId !== undefined && verifyCitation(dc, pending, run.citationId)) {
      const q = prov('quoted', seq);
      resolved = pending.map(() => q);
    }
    if (run.citationId !== undefined) {
      const rec = tx.s.citations[run.citationId];
      if (rec && rec.documentId === dc.base.id && !rec.used) {
        tx.rec('citations')[rec.citationId] = { ...rec, used: true };
      }
    }
  } else if (method === 'clipping') {
    if (run.clippingId !== undefined && verifyClipping(dc, pending, run.clippingId)) {
      const q = prov('quoted', seq);
      resolved = pending.map(() => q);
    }
  }
  const fallback = prov('pasted-external', seq);
  const byPos = new Map<number, Prov>();
  pending.forEach((u, i) => byPos.set(u.pos, resolved ? (resolved[i] as Prov) : fallback));
  dc.runs = remapUnits(
    dc.runs,
    pending.map((u) => u.pos),
    (_p, pos) => byPos.get(pos) ?? fallback,
  );
  // Pending units deleted within the run itself are buried as pasted-external.
  if (dc.tombs.some((t) => t.units.some((u) => u.p.pend === token))) {
    dc.tombs = dc.tombs.map((t) => ({
      pos: t.pos,
      units: t.units.map((u) => (u.p.pend === token ? { ...u, p: fallback } : u)),
    }));
  }
}

/** Folds `TextEdited`. */
export function foldTextEdited(tx: Tx, c: CommitOf<'TextEdited'>): number {
  const p = c.payload;
  const base = tx.s.docs[p.documentId];
  if (!base) throw new FoldError(c.seq, 'unknown-document', `no document ${p.documentId}`);
  if (p.baseVersion !== base.version) {
    throw new FoldError(
      c.seq,
      'base-version-mismatch',
      `baseVersion ${p.baseVersion} but document ${p.documentId} is at version ${base.version}`,
    );
  }
  let steps: Step[];
  try {
    steps = p.steps.map((j) => Step.fromJSON(schema, j));
  } catch (e) {
    throw new FoldError(c.seq, 'invalid-step', `invalid step JSON: ${(e as Error).message}`);
  }
  const dc = beginDocCommit(tx, base);
  let i = 0;
  for (const run of p.runs) {
    foldRun(dc, run, steps.slice(i, i + run.steps));
    i += run.steps;
  }
  // No placeholder survives the commit (defensive: e.g. undo of a paste within one batch).
  const plain = (p: Prov): Prov =>
    p.pend !== undefined ? prov(p.class, p.originSeq, matchOf(p), p.moves) : p;
  if (dc.runs.some((r) => r.p.pend !== undefined)) {
    dc.runs = canonicalRuns(
      dc.runs.map((r) => (r.p.pend !== undefined ? { ...r, p: plain(r.p) } : r)),
    );
  }
  if (dc.tombs.some((t) => t.units.some((u) => u.p.pend !== undefined))) {
    dc.tombs = dc.tombs.map((t) => ({
      pos: t.pos,
      units: t.units.map((u) => ({ ...u, p: plain(u.p) })),
    }));
  }
  finishDocCommit(dc, { matcher: true, contentChanged: !dc.node.eq(base.node) });
  return dc.insertedChars;
}

/** Folds `SliceCopied`: snapshots the copied span's provenance. */
export function foldSliceCopied(tx: Tx, c: CommitOf<'SliceCopied'>): void {
  const p = c.payload;
  if (tx.s.copies[p.copyId]) {
    tx.issue('duplicate-id', `copyId ${p.copyId} already exists`);
    return;
  }
  const d = tx.s.docs[p.documentId];
  if (!d) {
    tx.issue('unknown-document', `no document ${p.documentId}`);
    return;
  }
  let units: Array<{ key: string; p: Prov }> | null = null;
  if (p.version === d.version && p.to <= d.node.content.size) {
    const text = inlineTextBetween(d.node, p.from, p.to, '\n');
    if (sha256Hex(text) === p.textHash) {
      units = unitsBetween(d.node, p.from, p.to).map((u) => ({
        key: u.key,
        p: provAt(d.runs, u.pos) as Prov,
      }));
      if (units.length === 0) units = null;
    }
  }
  tx.rec('copies')[p.copyId] = { copyId: p.copyId, seq: c.seq, documentId: p.documentId, units };
}

/** Folds `PasteOccurred`. */
export function foldPasteOccurred(tx: Tx, c: CommitOf<'PasteOccurred'>): void {
  const p = c.payload;
  if (tx.s.pastes[p.pasteId]) {
    tx.issue('duplicate-id', `pasteId ${p.pasteId} already exists`);
    return;
  }
  if (!tx.s.docs[p.documentId]) {
    tx.issue('unknown-document', `no document ${p.documentId}`);
    return;
  }
  tx.rec('pastes')[p.pasteId] = {
    id: p.pasteId,
    seq: c.seq,
    documentId: p.documentId,
    origin: p.origin,
    via: p.via,
    characters: p.characters,
    words: p.words,
    insertedSeq: null,
    verifiedInternal: false,
  };
  tx.rec('pasteCopyIds')[p.pasteId] = p.copyId;
}

/** Folds `CitationInserted`. */
export function foldCitationInserted(tx: Tx, c: CommitOf<'CitationInserted'>): void {
  const p = c.payload;
  if (tx.s.citations[p.citationId]) {
    tx.issue('duplicate-id', `citationId ${p.citationId} already exists`);
    return;
  }
  if (!tx.s.docs[p.documentId]) {
    tx.issue('unknown-document', `no document ${p.documentId}`);
    return;
  }
  if (!tx.s.sources[p.sourceId]) {
    tx.issue('unknown-source', `no source ${p.sourceId}`);
    return;
  }
  tx.rec('citations')[p.citationId] = {
    citationId: p.citationId,
    seq: c.seq,
    documentId: p.documentId,
    sourceId: p.sourceId,
    locator: p.locator,
    used: false,
  };
}
