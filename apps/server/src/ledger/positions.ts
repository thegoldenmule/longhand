/**
 * Agent event positions (agent README, "What the service must do", step 5).
 *
 * Every anchor, span, point, split and merge in an agent draft carries
 * `readVersion` (the document version the agent read) and positions resolved at
 * that version (`version === readVersion`). Under the append lock the service:
 *
 * 1. re-resolves the target against the document at `readVersion` with the
 *    schema's resolvers; an unresolvable target is a 422 with the resolver's code
 *    (`quote-not-found`, `unknown-sentence`, …), and positions that differ from the
 *    resolution are `target-mismatch`;
 * 2. maps the positions through every step since `readVersion` (ranges: `from`
 *    associates right, `to` left, clamped so `to >= from`; points by their side) and
 *    rewrites `version` to the current version.
 *
 * The fold then marks the annotation stale on arrival if its text changed.
 *
 * A draft whose positions are already expressed at the current version (with an
 * older `readVersion`) is accepted too, but only if they equal what step 2
 * produces; the service never trusts positions it did not compute.
 */
import {
  resolveAnchor,
  resolveInsertionPoint,
  resolveMerge,
  resolveMove,
  resolveSpan,
  resolveSplit,
  type CommitDraft,
} from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import type { StepMap } from 'prosemirror-transform';
import type { ProjectHistory } from './history';

/** A position failure, answered as 422. */
export interface PositionError {
  code: string;
  message: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: PositionError };

const fail = (code: string, message: string): { ok: false; error: PositionError } => ({
  ok: false,
  error: { code, message },
});

interface Ctx {
  history: ProjectHistory;
}

interface Located {
  doc: PMNode;
  maps: StepMap[];
  current: number;
}

function locate(
  ctx: Ctx,
  documentId: string,
  readVersion: number,
  version: number,
): Result<Located> {
  const h = ctx.history.get(documentId);
  if (!h) return fail('unknown-document', `No document ${documentId} in this project.`);
  const current = h.version;
  if (readVersion > current) {
    return fail(
      'invalid-version',
      `readVersion ${readVersion} is ahead of document ${documentId} (version ${current}).`,
    );
  }
  if (version !== readVersion && version !== current) {
    return fail(
      'invalid-version',
      `Positions must be at readVersion (${readVersion}); got version ${version}.`,
    );
  }
  const doc = h.docAt(readVersion);
  const maps = h.mapsSince(readVersion);
  if (!doc || !maps) {
    return fail(
      'invalid-version',
      `Document ${documentId} has no version ${readVersion}; re-read the document and try again.`,
    );
  }
  return { ok: true, value: { doc, maps, current } };
}

function mapRange(
  maps: readonly StepMap[],
  from: number,
  to: number,
): { from: number; to: number } {
  let f = from;
  let t = to;
  for (const m of maps) {
    f = m.map(f, 1);
    t = Math.max(f, m.map(t, -1));
  }
  return { from: f, to: t };
}

function mapPoint(maps: readonly StepMap[], pos: number, assoc: 1 | -1): number {
  let p = pos;
  for (const m of maps) p = m.map(p, assoc);
  return p;
}

/** Checks claimed positions against the resolution (at readVersion) or its mapping (at current). */
function check(
  claimed: number[],
  resolved: number[],
  mapped: number[],
  atRead: boolean,
): PositionError | null {
  const want = atRead ? resolved : mapped;
  for (let i = 0; i < want.length; i++) {
    if (claimed[i] !== want[i]) {
      return {
        code: 'target-mismatch',
        message: `The positions do not match the target at version ${atRead ? 'readVersion' : 'current'}; resolve them again.`,
      };
    }
  }
  return null;
}

interface Stamp {
  from: number;
  to: number;
  readVersion: number;
  version: number;
}

type AnchorLike = Stamp & {
  anchor: { documentId: string; sentenceId: string; quote: string; occurrence: number };
};
type SpanLike = Stamp & {
  span: { documentId: string; unit: 'sentence' | 'paragraph' | 'section'; ids: string[] };
};

function remapAnchor<T extends AnchorLike>(ctx: Ctx, t: T): Result<T> {
  const loc = locate(ctx, t.anchor.documentId, t.readVersion, t.version);
  if (!loc.ok) return loc;
  const r = resolveAnchor(loc.value.doc, t.anchor);
  if (!r.ok) return fail(r.error.code, r.error.message);
  if (r.anchor.occurrence !== t.anchor.occurrence) {
    return fail('target-mismatch', 'The anchor occurrence does not match the document.');
  }
  const m = mapRange(loc.value.maps, r.from, r.to);
  const err = check([t.from, t.to], [r.from, r.to], [m.from, m.to], t.version === t.readVersion);
  if (err) return { ok: false, error: err };
  return { ok: true, value: { ...t, from: m.from, to: m.to, version: loc.value.current } };
}

function remapSpan<T extends SpanLike>(ctx: Ctx, t: T): Result<T> {
  const loc = locate(ctx, t.span.documentId, t.readVersion, t.version);
  if (!loc.ok) return loc;
  const r = resolveSpan(loc.value.doc, t.span);
  if (!r.ok) return fail(r.error.code, r.error.message);
  const m = mapRange(loc.value.maps, r.from, r.to);
  const err = check([t.from, t.to], [r.from, r.to], [m.from, m.to], t.version === t.readVersion);
  if (err) return { ok: false, error: err };
  return { ok: true, value: { ...t, from: m.from, to: m.to, version: loc.value.current } };
}

function remapTarget<T extends (AnchorLike & { kind: 'anchor' }) | (SpanLike & { kind: 'span' })>(
  ctx: Ctx,
  t: T,
): Result<T> {
  return t.kind === 'anchor'
    ? (remapAnchor(ctx, t as AnchorLike & { kind: 'anchor' }) as Result<T>)
    : (remapSpan(ctx, t as SpanLike & { kind: 'span' }) as Result<T>);
}

/**
 * Rewrites an agent draft's positions to the current document versions. Drafts
 * without positions are returned unchanged.
 */
export function remapAgentDraft(draft: CommitDraft, history: ProjectHistory): Result<CommitDraft> {
  const ctx: Ctx = { history };
  const withPayload = (payload: unknown): Result<CommitDraft> => ({
    ok: true,
    value: { ...draft, payload } as CommitDraft,
  });
  switch (draft.type) {
    case 'CommentAdded':
    case 'CutProposed': {
      const r = remapTarget(ctx, draft.payload.target);
      return r.ok ? withPayload({ ...draft.payload, target: r.value }) : r;
    }
    case 'QuestionAsked': {
      if (!draft.payload.target) return { ok: true, value: draft };
      const r = remapTarget(ctx, draft.payload.target);
      return r.ok ? withPayload({ ...draft.payload, target: r.value }) : r;
    }
    case 'CitationNeededFlagged':
    case 'SourceSuggested': {
      const r = remapAnchor(ctx, draft.payload.target);
      return r.ok ? withPayload({ ...draft.payload, target: r.value }) : r;
    }
    case 'SourceSurfaced': {
      if (!draft.payload.target) return { ok: true, value: draft };
      const r = remapAnchor(ctx, draft.payload.target);
      return r.ok ? withPayload({ ...draft.payload, target: r.value }) : r;
    }
    case 'SuggestionProposed': {
      const s = draft.payload.suggestion;
      if (s.kind === 'insertion') {
        const t = s.target;
        const loc = locate(ctx, t.documentId, t.readVersion, t.version);
        if (!loc.ok) return loc;
        const r = resolveInsertionPoint(loc.value.doc, t.position, t.sentenceId);
        if (!r.ok) return fail(r.error.code, r.error.message);
        const pos = mapPoint(loc.value.maps, r.pos, t.position === 'before' ? 1 : -1);
        const err = check([t.pos], [r.pos], [pos], t.version === t.readVersion);
        if (err) return { ok: false, error: err };
        return withPayload({
          ...draft.payload,
          suggestion: { ...s, target: { ...t, pos, version: loc.value.current } },
        });
      }
      const r = remapAnchor(ctx, s.target);
      return r.ok ? withPayload({ ...draft.payload, suggestion: { ...s, target: r.value } }) : r;
    }
    case 'MoveProposed': {
      const src = draft.payload.source;
      const dst = draft.payload.destination;
      const loc = locate(ctx, src.span.documentId, src.readVersion, src.version);
      if (!loc.ok) return loc;
      const r = resolveMove(loc.value.doc, src.span, dst);
      if (!r.ok) return fail(r.error.code, r.error.message);
      const m = mapRange(loc.value.maps, r.from, r.to);
      const ins = mapPoint(loc.value.maps, r.insertAt, dst.position === 'before' ? 1 : -1);
      const err = check(
        [src.from, src.to, dst.pos],
        [r.from, r.to, r.insertAt],
        [m.from, m.to, ins],
        src.version === src.readVersion,
      );
      if (err) return { ok: false, error: err };
      return withPayload({
        ...draft.payload,
        source: { ...src, from: m.from, to: m.to, version: loc.value.current },
        destination: { ...dst, pos: ins },
      });
    }
    case 'SplitProposed': {
      const p = draft.payload;
      const loc = locate(ctx, p.documentId, p.readVersion, p.version);
      if (!loc.ok) return loc;
      const r = resolveSplit(loc.value.doc, p.paragraphId, p.sentenceId);
      if (!r.ok) return fail(r.error.code, r.error.message);
      const pos = mapPoint(loc.value.maps, r.pos, 1);
      const err = check([p.pos], [r.pos], [pos], p.version === p.readVersion);
      if (err) return { ok: false, error: err };
      return withPayload({ ...p, pos, version: loc.value.current });
    }
    case 'MergeProposed': {
      const p = draft.payload;
      const loc = locate(ctx, p.documentId, p.readVersion, p.version);
      if (!loc.ok) return loc;
      const r = resolveMerge(loc.value.doc, p.firstParagraphId, p.secondParagraphId);
      if (!r.ok) return fail(r.error.code, r.error.message);
      const m = mapRange(loc.value.maps, r.first.pos, r.second.end);
      const joinPos = mapPoint(loc.value.maps, r.joinPos, -1);
      const err = check(
        [p.joinPos, p.from, p.to],
        [r.joinPos, r.first.pos, r.second.end],
        [joinPos, m.from, m.to],
        p.version === p.readVersion,
      );
      if (err) return { ok: false, error: err };
      return withPayload({ ...p, joinPos, from: m.from, to: m.to, version: loc.value.current });
    }
    default:
      return { ok: true, value: draft };
  }
}
