import { describe, expect, it } from 'vitest';
import { docOf, expectValidDraft, StateHost } from '../test/helpers';
import { buildTextEdited, rebuildTextEdited, relativeTimeline, runsOf, stepTagsOf, type LocalBatch, type LocalStep } from './drafts';

const ctx = { projectId: 'proj', actorId: 'user1', deviceId: 'dev1', sessionId: 'sess1' };

function batchOf(host: StateHost, methods: Array<LocalStep['tag']>): LocalBatch {
  const steps: LocalStep[] = methods.map((tag, i) => {
    const tr = host.type(String.fromCharCode(97 + i));
    const step = tr.steps[0]!;
    return { step, inverted: step.invert(tr.docs[0]!), tag, chars: 1 };
  });
  return {
    commitId: '11111111-1111-4111-8111-111111111111',
    steps,
    timeline: methods.map((_m, i) => ({ at: 1_700_000_000_000 + i * 120, kind: 'insert', len: 1 })),
    firstAt: 1_700_000_000_000,
    lastAt: 1_700_000_000_000 + (methods.length - 1) * 120,
  };
}

describe('runsOf', () => {
  it('partitions steps into runs of equal tags, in order', () => {
    const t = { method: 'typed' as const };
    const p = { method: 'pasted-external' as const, pasteId: 'p1' };
    const p2 = { method: 'pasted-external' as const, pasteId: 'p2' };
    const steps = [t, t, p, p, p2, t].map((tag) => ({ tag }) as LocalStep);
    expect(runsOf(steps)).toEqual([
      { steps: 2, method: 'typed' },
      { steps: 2, method: 'pasted-external', pasteId: 'p1' },
      { steps: 1, method: 'pasted-external', pasteId: 'p2' },
      { steps: 1, method: 'typed' },
    ]);
    expect(stepTagsOf(runsOf(steps))).toHaveLength(6);
  });

  it('keeps citation runs separate from typed runs', () => {
    const steps = [{ method: 'typed' as const }, { method: 'citation' as const, citationId: 'c1' }, { method: 'typed' as const }].map(
      (tag) => ({ tag }) as LocalStep,
    );
    expect(runsOf(steps).map((r) => r.method)).toEqual(['typed', 'citation', 'typed']);
  });
});

describe('relativeTimeline', () => {
  it('makes times relative, non-decreasing and within the duration', () => {
    const b = {
      commitId: 'x',
      steps: [],
      firstAt: 1000,
      lastAt: 1300,
      timeline: [
        { at: 1000, kind: 'insert' as const, len: 1 },
        { at: 1200.4, kind: 'insert' as const, len: 1 },
        { at: 1150, kind: 'delete' as const, len: 1 },
        { at: 1400, kind: 'insert' as const, len: 1 },
      ],
    };
    const { timeline, durationMs } = relativeTimeline(b);
    expect(durationMs).toBe(300);
    expect(timeline.map((k) => k.t)).toEqual([0, 200, 200, 300]);
  });
});

describe('buildTextEdited', () => {
  it('produces a schema-valid TextEdited draft', () => {
    const host = new StateHost(docOf(''));
    const batch = batchOf(host, [{ method: 'typed' }, { method: 'typed' }, { method: 'ime' }]);
    const draft = buildTextEdited(ctx, 'doc1', batch, 7);
    expectValidDraft(draft);
    expect(draft.clientTime).toBe(new Date(1_700_000_000_000).toISOString());
    expect(draft.payload).toMatchObject({
      documentId: 'doc1',
      baseVersion: 7,
      characters: 3,
      durationMs: 240,
      runs: [
        { steps: 2, method: 'typed' },
        { steps: 1, method: 'ime' },
      ],
    });
    expect(draft.payload.steps).toHaveLength(3);
    expect(draft.payload.timeline).toEqual([
      { t: 0, kind: 'insert', len: 1 },
      { t: 120, kind: 'insert', len: 1 },
      { t: 240, kind: 'insert', len: 1 },
    ]);
    expect(draft.actor).toEqual({ kind: 'human', id: 'user1' });
  });

  it('rebuilds a draft after rebasing, keeping tags of surviving steps', () => {
    const host = new StateHost(docOf(''));
    const batch = batchOf(host, [{ method: 'typed' }, { method: 'pasted-external', pasteId: 'p1' }, { method: 'typed' }]);
    const draft = buildTextEdited(ctx, 'doc1', batch, 0);
    const steps = batch.steps.map((s) => s.step);
    const rebuilt = rebuildTextEdited(draft, [steps[1]!, steps[2]!], [1, 2], 5)!;
    expectValidDraft(rebuilt);
    expect(rebuilt.commitId).not.toBe(draft.commitId);
    expect(rebuilt.payload.baseVersion).toBe(5);
    expect(rebuilt.payload.runs).toEqual([
      { steps: 1, method: 'pasted-external', pasteId: 'p1' },
      { steps: 1, method: 'typed' },
    ]);
    expect(rebuilt.payload.timeline).toEqual(draft.payload.timeline);
    expect(rebuildTextEdited(draft, [], [], 5)).toBeNull();
  });
});
