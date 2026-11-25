/**
 * Copies tracker positions into the public annotation records.
 */
import type { CurrentRange, ProposalState } from '@longhand/schema';
import type { Span, Tracker, Tx } from './state';

function sameRange(a: { from: number; to: number } | null, b: { from: number; to: number } | null): boolean {
  if (a === null || b === null) return a === b;
  return a.from === b.from && a.to === b.to;
}

function current(t: Tracker, r: Span | null): CurrentRange | null {
  return r ? { documentId: t.docId, from: r.from, to: r.to } : null;
}

/** Writes `t`'s positions into its annotation record (only when they changed). */
export function syncTrackerRecord(tx: Tx, t: Tracker, version: number): void {
  switch (t.group) {
    case 'feedbackRequests': {
      const rec = tx.s.ann.feedbackRequests[t.id];
      if (!rec || rec.scope.kind !== 'selection' || !t.range) return;
      const sc = rec.scope;
      if (sc.from === t.range.from && sc.to === t.range.to && sc.version === version) return;
      tx.ann('feedbackRequests')[t.id] = { ...rec, scope: { ...sc, from: t.range.from, to: t.range.to, version } };
      return;
    }
    case 'comments':
    case 'questions':
    case 'citationFlags':
    case 'surfacedSources':
    case 'sourceSuggestions':
    case 'suggestions': {
      const rec = tx.s.ann[t.group][t.id];
      if (!rec) return;
      const range = current(t, t.range);
      if (sameRange(rec.range, range)) return;
      (tx.ann(t.group) as Record<string, unknown>)[t.id] = { ...rec, range };
      return;
    }
    case 'proposals': {
      const rec = tx.s.ann.proposals[t.id];
      if (!rec) return;
      let next: ProposalState = rec;
      switch (rec.kind) {
        case 'move':
          if (!sameRange(rec.source, t.range) || rec.insertAt !== t.point) {
            next = { ...rec, source: t.range ? { ...t.range } : null, insertAt: t.point };
          }
          break;
        case 'cut':
          if (!sameRange(rec.range, t.range)) next = { ...rec, range: t.range ? { ...t.range } : null };
          break;
        case 'split':
          if (rec.pos !== t.point) next = { ...rec, pos: t.point };
          break;
        case 'merge':
          if (!sameRange(rec.range, t.range) || rec.joinPos !== t.point) {
            next = { ...rec, range: t.range ? { ...t.range } : null, joinPos: t.point };
          }
          break;
      }
      if (next !== rec) tx.ann('proposals')[t.id] = next;
      return;
    }
  }
}
