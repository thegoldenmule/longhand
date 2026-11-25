/**
 * Folding manuscript changes to one document within one commit: a working copy of
 * the document and its trackers, step application, and the end-of-commit pass
 * (matcher upgrades, suggestion lifecycle, proposal staleness, citation flags).
 */
import { splitSentences, tokenizeWords, type ProposalState, type SuggestionState } from '@longhand/schema';
import type { Step } from 'prosemirror-transform';
import { blockAt, blockText, textBetween } from './doctext';
import {
  applyStep,
  carryRuns,
  carryTombs,
  type AppliedStep,
  type Change,
  type DeadUnit,
  type MapNode,
  type Tomb,
} from './engine';
import { FoldError } from './issues';
import {
  foldText,
  normalize,
  normalizePositioned,
  ngramsOf,
  wordBoundedIndexes,
  withinEditDistance,
} from './matcher';
import { asFromSuggestion, provAt, remapUnits, type IRun, type Prov } from './prov';
import { pvecToArray } from './pvec';
import type { DocInternal, Tracker, Tx } from './state';
import { cloneTracker, mapTracker, newScratch, type Scratch, type StepFacts } from './trackers';
import { syncTrackerRecord } from './records';
import { isTextKey } from './units';

/** A document being changed by one commit. */
export interface DocCommit {
  tx: Tx;
  seq: number;
  base: DocInternal;
  node: DocInternal['node'];
  runs: readonly IRun[];
  tombs: readonly Tomb[];
  maps: MapNode | null;
  version: number;
  trackers: Tracker[];
  scratch: Scratch;
  /** Text characters inserted by this commit's steps (gross). */
  insertedChars: number;
}

/** Starts changing a document. */
export function beginDocCommit(tx: Tx, base: DocInternal): DocCommit {
  const ids = tx.s.docTrackers[base.id] ?? [];
  const trackers: Tracker[] = [];
  for (const id of ids) {
    const t = tx.s.trackers[id];
    if (t && (t.range !== null || t.point !== null || t.ref !== null)) trackers.push(cloneTracker(t));
  }
  return {
    tx,
    seq: tx.seq,
    base,
    node: base.node,
    runs: base.runs,
    tombs: base.tombs,
    maps: base.maps,
    version: base.version,
    trackers,
    scratch: newScratch(),
    insertedChars: 0,
  };
}

/** What a caller decides for one applied step. */
export interface StepPlan {
  /** Provenance per change, per inserted unit. */
  assigned: Prov[][];
  /** Units to bury per change (with their old positions). */
  buried: Array<Array<{ pos: number; unit: DeadUnit }>>;
  /** Tombs to use instead of the current ones (after undo/redo matches removed units). */
  tombs?: readonly Tomb[];
  /** Extra tombs at new positions. */
  extra?: Tomb[];
}

/** Applies one step, letting `plan` decide provenance. Throws FoldError if it does not apply. */
export function stepDoc(
  dc: DocCommit,
  step: Step,
  plan: (applied: AppliedStep) => StepPlan,
  facts: Omit<StepFacts, 'map' | 'changes'>,
): AppliedStep {
  const applied = applyStep(dc.node, dc.runs, step);
  if (!applied) {
    throw new FoldError(dc.seq, 'step-failed', `a step does not apply to document ${dc.base.id} at version ${dc.version}`);
  }
  const p = plan(applied);
  dc.runs = carryRuns(dc.runs, applied.map, applied.changes, p.assigned);
  dc.tombs = carryTombs(p.tombs ?? dc.tombs, applied.map, applied.changes, p.buried, p.extra);
  const sf: StepFacts = { ...facts, map: applied.map, changes: applied.changes };
  for (const t of dc.trackers) mapTracker(t, sf, dc.scratch);
  dc.version += 1;
  dc.maps = { map: applied.map, version: dc.version, prev: dc.maps };
  dc.node = applied.doc;
  for (const c of applied.changes) {
    for (const u of c.inserted) if (isTextKey(u.key)) dc.insertedChars++;
  }
  return applied;
}

/** Buries every deleted unit of every change. */
export function buryAll(changes: readonly Change[], seq: number, tag: object): Array<Array<{ pos: number; unit: DeadUnit }>> {
  return changes.map((c) => c.deleted.map((u) => ({ pos: u.pos, unit: { key: u.key, p: u.p, seq, tag } })));
}

// ---------------------------------------------------------------------------
// End of commit
// ---------------------------------------------------------------------------

interface Upgrade {
  positions: number[];
  id: string;
  afterSeq: number;
}

function applyUpgrades(dc: DocCommit, upgrades: readonly Upgrade[]): void {
  for (const u of upgrades) {
    const positions = [...new Set(u.positions)].filter((p) => p >= 0).sort((a, b) => a - b);
    dc.runs = remapUnits(dc.runs, positions, (p) =>
      p.class === 'typed' && p.originSeq > u.afterSeq ? asFromSuggestion(p, u.id) : p,
    );
  }
}

function typedAt(dc: DocCommit, positions: readonly number[]): boolean {
  for (const pos of positions) {
    if (pos < 0) continue;
    const p = provAt(dc.runs, pos);
    if (!p || (p.class !== 'typed' && p.class !== 'typed-from-suggestion')) return false;
  }
  return true;
}

type Outcome =
  | { status: 'open'; resetTouched: boolean }
  | { status: 'adopted'; alternative: number }
  | { status: 'adapted' | 'stale' };

function evaluateSuggestion(dc: DocCommit, t: Tracker, sug: SuggestionState, upgrades: Upgrade[]): Outcome {
  const s = dc.scratch;
  const range = t.range;
  const region = range ? normalizePositioned(textBetween(dc.node, range.from, range.to)) : { text: '', pos: [] };
  const typed = s.typedTouch.has(t.id);
  const other = s.otherTouch.has(t.id);
  if (sug.kind === 'rephrase') {
    if (!s.regionTouched.has(t.id)) return { status: 'open', resetTouched: false };
    return region.text.length > 0 && typed ? { status: 'adapted' } : { status: 'stale' };
  }
  const alts = (sug.kind === 'word-choice' ? sug.alternatives : [sug.sentence]).map(normalize);
  const original = normalize(t.region?.original ?? '');
  if (s.regionTouched.has(t.id)) {
    // Edit-distance rule (matcher): typed text in the region close to an alternative.
    if (typed && alts.some((a) => withinEditDistance(region.text, a))) {
      upgrades.push({ positions: region.pos, id: sug.id, afterSeq: sug.seq });
    }
    // 1. Adopted: an alternative retyped (word-bounded) inside the region.
    let best: { i: number; len: number; at: number } | null = null;
    alts.forEach((a, i) => {
      if (a.length === 0) return;
      for (const at of wordBoundedIndexes(region.text, a)) {
        const positions = region.pos.slice(at, at + a.length);
        if (!typedAt(dc, positions)) continue;
        if (!best || a.length > best.len) best = { i, len: a.length, at };
        break;
      }
    });
    if (best !== null) {
      const b = best as { i: number; len: number; at: number };
      upgrades.push({ positions: region.pos.slice(b.at, b.at + b.len), id: sug.id, afterSeq: sug.seq });
      return { status: 'adopted', alternative: b.i };
    }
    // An insertion whose sentence was deleted is stale.
    if (sug.kind === 'insertion' && s.refTouched.has(t.id)) return { status: 'stale' };
    // 2. Back to the original text: still open.
    if (region.text === original) return { status: 'open', resetTouched: true };
    // 3. Retyping in progress: a proper prefix of an alternative, typed only.
    if (
      region.text.length > 0 &&
      typed &&
      !other &&
      alts.some((a) => a.length > region.text.length && a.startsWith(region.text))
    ) {
      return { status: 'open', resetTouched: false };
    }
    // 4. Adapted: typed something different that still shows the suggestion's influence.
    if (region.text.length > 0 && typed) {
      const hinted = s.hinted.has(t.id);
      const close = alts.some((a) => withinEditDistance(region.text, a));
      const sugGrams = new Set<string>();
      for (const a of alts) for (const g of ngramsOf(a)) sugGrams.add(g);
      const shares = [...ngramsOf(region.text)].some((g) => sugGrams.has(g));
      if (hinted || close || shares) return { status: 'adapted' };
    }
    // For insertions, an untouched empty point is still open.
    if (sug.kind === 'insertion' && region.text.length === 0 && !s.refTouched.has(t.id)) {
      return { status: 'open', resetTouched: true };
    }
    return { status: 'stale' };
  }
  if (s.refTouched.has(t.id)) return { status: 'stale' };
  return { status: 'open', resetTouched: false };
}

function fourWordUpgrades(dc: DocCommit, upgrades: Upgrade[]): void {
  const ai = pvecToArray(dc.tx.s.aiTexts);
  if (ai.length === 0) return;
  const fresh: number[] = [];
  for (const r of dc.runs) {
    if (r.p.originSeq === dc.seq && r.p.class === 'typed') for (let p = r.from; p < r.to; p++) fresh.push(p);
  }
  if (fresh.length === 0) return;
  const freshSet = new Set(fresh);
  const seenBlocks = new Set<number>();
  for (const pos of fresh) {
    const block = blockAt(dc.node, pos);
    if (!block || seenBlocks.has(block.from)) continue;
    seenBlocks.add(block.from);
    const bt = blockText(block);
    const tokens = tokenizeWords(bt.text);
    const isFresh = tokens.map((tk) => {
      for (let i = tk.start; i < tk.end; i++) if (freshSet.has(bt.pos[i] as number)) return true;
      return false;
    });
    for (let i = 0; i + 4 <= tokens.length; i++) {
      if (!isFresh.slice(i, i + 4).some(Boolean)) continue;
      const key = tokens
        .slice(i, i + 4)
        .map((tk) => foldText(tk.text))
        .join(' ');
      const hit = ai.find((a) => a.ngrams.has(key));
      if (!hit) continue;
      const start = (tokens[i] as { start: number }).start;
      const end = (tokens[i + 3] as { end: number }).end;
      upgrades.push({ positions: bt.pos.slice(start, end), id: hit.id, afterSeq: hit.seq });
    }
  }
}

/**
 * True if a verified (`quoted`) citation node sits inside a flag's range or after
 * it in the same sentence (up to the first character of the next sentence).
 */
export function isCited(node: DocCommit['node'], runs: readonly IRun[], range: { from: number; to: number }): boolean {
  const block = blockAt(node, range.from);
  if (!block) return false;
  let hasCitation = false;
  block.node.forEach((c) => {
    if (c.type.name === 'citation') hasCitation = true;
  });
  if (!hasCitation) return false;
  const bt = blockText(block);
  let zoneEnd = block.to;
  const after = bt.pos.findIndex((p) => p >= range.to);
  const claimEndIdx = after === -1 ? bt.text.length : after;
  for (const s of splitSentences(bt.text)) {
    if (s.start >= claimEndIdx && s.start > 0) {
      zoneEnd = bt.pos[s.start] as number;
      break;
    }
  }
  let cited = false;
  block.node.forEach((c, offset) => {
    const p = block.from + offset;
    if (c.type.name !== 'citation' || p < range.from || p > zoneEnd) return;
    if (provAt(runs, p)?.class === 'quoted') cited = true;
  });
  return cited;
}

/** Options for {@link finishDocCommit}. */
export interface FinishOptions {
  /** Run the typed-from-suggestion matcher (TextEdited only). */
  matcher: boolean;
  /** Content changed (sets `contentSeq`). */
  contentChanged: boolean;
}

/** Ends the commit: matcher, lifecycle, staleness, flags; writes everything back. */
export function finishDocCommit(dc: DocCommit, opts: FinishOptions): void {
  const { tx, seq } = dc;
  const upgrades: Upgrade[] = [];
  const outcomes = new Map<string, Outcome>();
  for (const t of dc.trackers) {
    if (t.group !== 'suggestions' || !t.region) continue;
    const sug = tx.s.ann.suggestions[t.id];
    if (!sug || sug.status !== 'open') continue;
    if (!dc.scratch.regionTouched.has(t.id) && !dc.scratch.refTouched.has(t.id)) continue;
    outcomes.set(t.id, evaluateSuggestion(dc, t, sug, upgrades));
  }
  if (opts.matcher) fourWordUpgrades(dc, upgrades);
  applyUpgrades(dc, upgrades);

  for (const t of dc.trackers) {
    const o = outcomes.get(t.id);
    if (o) {
      const sug = tx.s.ann.suggestions[t.id] as SuggestionState;
      if (o.status === 'open') {
        if (o.resetTouched && t.region) t.region = { ...t.region, touched: false };
      } else {
        t.region = null;
        t.watch = false;
        if (t.range && t.range.from === t.range.to && sug.kind !== 'insertion') t.range = null;
        if (t.range && t.range.from < t.range.to) t.isPoint = false;
        const next = { ...sug, status: o.status, resolvedSeq: seq } as SuggestionState;
        if (next.kind === 'word-choice' && o.status === 'adopted') next.adoptedAlternative = o.alternative;
        tx.ann('suggestions')[t.id] = next;
      }
    }
    if (t.group === 'proposals' && t.watch && dc.scratch.proposalTouched.has(t.id)) {
      const prop = tx.s.ann.proposals[t.id] as ProposalState;
      if (prop.status === 'open') {
        tx.ann('proposals')[t.id] = { ...prop, status: 'stale', resolvedSeq: seq } as ProposalState;
      }
      t.watch = false;
      t.range = null;
      t.point = null;
    }
    if (t.group === 'citationFlags') {
      const flag = tx.s.ann.citationFlags[t.id];
      if (flag && flag.status === 'open' && t.range && isCited(dc.node, dc.runs, t.range)) {
        tx.ann('citationFlags')[t.id] = { ...flag, status: 'cited' };
      }
    }
  }

  for (const t of dc.trackers) {
    tx.setTracker(t);
    syncTrackerRecord(tx, t, dc.version);
  }
  tx.setDoc({
    ...dc.base,
    node: dc.node,
    runs: dc.runs,
    tombs: dc.tombs,
    maps: dc.maps,
    version: dc.version,
    contentSeq: opts.contentChanged ? seq : dc.base.contentSeq,
    updatedSeq: seq,
  });
}
