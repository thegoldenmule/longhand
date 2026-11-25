/**
 * Building commit drafts: the envelope, `TextEdited` batches (runs, keystroke
 * timeline, characters, duration) and the companion events.
 */
import {
  MAX_STEPS_PER_COMMIT,
  SCHEMA_VERSION,
  type CommitDraft,
  type CommitDraftOf,
  type EventPayloads,
  type EventType,
  type InputMethod,
  type InputRun,
  type Keystroke,
  type KeystrokeKind,
} from '@longhand/schema';
import type { Step } from 'prosemirror-transform';
import { insertedChars } from '../steps';
import { iso, newId } from '../util';

/** Who and where: the envelope fields the editor fills in. */
export interface DraftContext {
  projectId: string;
  /** Human actor id (the account's user id). */
  actorId: string;
  deviceId: string;
  sessionId: string;
}

/** Builds a commit draft for a human event. */
export function makeDraft<K extends EventType>(
  ctx: DraftContext,
  type: K,
  payload: EventPayloads[K],
  clientTimeMs: number,
  commitId: string = newId(),
): CommitDraftOf<K> {
  return {
    commitId,
    projectId: ctx.projectId,
    clientTime: iso(clientTimeMs),
    actor: { kind: 'human', id: ctx.actorId },
    deviceId: ctx.deviceId,
    sessionId: ctx.sessionId,
    schemaVersion: SCHEMA_VERSION,
    type,
    payload,
  } as unknown as CommitDraftOf<K>;
}

/** The run-relevant part of an input tag. */
export interface RunTag {
  method: InputMethod;
  pasteId?: string;
  citationId?: string;
  clippingId?: string;
  traceSuggestionId?: string;
}

/** A captured local step. */
export interface LocalStep {
  step: Step;
  inverted: Step;
  tag: RunTag;
  /** Inline characters this step inserts. */
  chars: number;
}

/** One keystroke-timeline entry with an absolute time. */
export interface TimelineEntry {
  at: number;
  kind: KeystrokeKind;
  len: number;
}

/** A batch of local steps on its way to becoming one `TextEdited`. */
export interface LocalBatch {
  commitId: string;
  steps: LocalStep[];
  timeline: TimelineEntry[];
  /** Epoch ms of the first input event (the commit's `clientTime`). */
  firstAt: number;
  /** Epoch ms of the last input event. */
  lastAt: number;
}

/** An empty batch. */
export function emptyBatch(): LocalBatch {
  return { commitId: newId(), steps: [], timeline: [], firstAt: 0, lastAt: 0 };
}

function sameRun(a: RunTag, b: RunTag): boolean {
  return (
    a.method === b.method &&
    a.pasteId === b.pasteId &&
    a.citationId === b.citationId &&
    a.clippingId === b.clippingId &&
    a.traceSuggestionId === b.traceSuggestionId
  );
}

/** Partitions steps into input-method runs (consecutive steps with the same tag). */
export function runsOf(steps: readonly LocalStep[]): InputRun[] {
  const runs: InputRun[] = [];
  let current: (RunTag & { steps: number }) | null = null;
  for (const s of steps) {
    if (current && sameRun(current, s.tag)) {
      current.steps++;
      continue;
    }
    current = { ...s.tag, steps: 1 };
    runs.push(current as InputRun);
  }
  return runs.map((r) => {
    const out: InputRun = { steps: r.steps, method: r.method };
    if (r.pasteId !== undefined) out.pasteId = r.pasteId;
    if (r.citationId !== undefined) out.citationId = r.citationId;
    if (r.clippingId !== undefined) out.clippingId = r.clippingId;
    if (r.traceSuggestionId !== undefined) out.traceSuggestionId = r.traceSuggestionId;
    return out;
  });
}

/** Relative keystroke timeline: `t` in ms after `firstAt`, non-decreasing, clamped to the duration. */
export function relativeTimeline(batch: LocalBatch): { timeline: Keystroke[]; durationMs: number } {
  const durationMs = Math.max(0, Math.round(batch.lastAt - batch.firstAt));
  let prev = 0;
  const timeline = batch.timeline.map((e) => {
    const t = Math.min(durationMs, Math.max(prev, Math.round(e.at - batch.firstAt)));
    prev = t;
    return { t, kind: e.kind, len: Math.max(0, Math.round(e.len)) };
  });
  return { timeline, durationMs };
}

/** Builds the `TextEdited` draft for a batch at `baseVersion`. */
export function buildTextEdited(
  ctx: DraftContext,
  documentId: string,
  batch: LocalBatch,
  baseVersion: number,
): CommitDraftOf<'TextEdited'> {
  if (batch.steps.length === 0) throw new RangeError('empty batch');
  if (batch.steps.length > MAX_STEPS_PER_COMMIT)
    throw new RangeError('batch exceeds MAX_STEPS_PER_COMMIT');
  const { timeline, durationMs } = relativeTimeline(batch);
  return makeDraft(
    ctx,
    'TextEdited',
    {
      documentId,
      baseVersion,
      steps: batch.steps.map(
        (s) => s.step.toJSON() as EventPayloads['TextEdited']['steps'][number],
      ),
      runs: runsOf(batch.steps),
      timeline,
      characters: batch.steps.reduce((n, s) => n + s.chars, 0),
      durationMs,
    },
    batch.firstAt,
    batch.commitId,
  );
}

/** Narrowing helper. */
export function isTextEdited(d: CommitDraft): d is CommitDraftOf<'TextEdited'> {
  return d.type === 'TextEdited';
}

/** Expands runs into one tag per step. */
export function stepTagsOf(runs: readonly InputRun[]): RunTag[] {
  const out: RunTag[] = [];
  for (const r of runs) {
    const { steps, ...tag } = r;
    for (let i = 0; i < steps; i++) out.push(tag);
  }
  return out;
}

/**
 * Rebuilds a queued `TextEdited` after its steps were rebased: keeps the timeline
 * and client time, recomputes runs and characters, assigns a new `commitId`.
 * Returns null when no step survived.
 */
export function rebuildTextEdited(
  draft: CommitDraftOf<'TextEdited'>,
  steps: readonly Step[],
  kept: readonly number[],
  baseVersion: number,
  commitId: string = newId(),
): CommitDraftOf<'TextEdited'> | null {
  if (steps.length === 0) return null;
  const tags = stepTagsOf(draft.payload.runs);
  const local: LocalStep[] = steps.map((step, i) => ({
    step,
    inverted: step,
    tag: tags[kept[i] as number] ?? { method: 'pasted-external' },
    chars: insertedChars(step),
  }));
  return {
    ...draft,
    commitId,
    payload: {
      ...draft.payload,
      baseVersion,
      steps: steps.map((s) => s.toJSON() as EventPayloads['TextEdited']['steps'][number]),
      runs: runsOf(local),
      characters: local.reduce((n, s) => n + s.chars, 0),
    },
  };
}
