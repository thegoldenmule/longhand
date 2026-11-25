import { describe, expect, it } from 'vitest';
import {
  ACTOR_PERMISSIONS,
  EVENTS,
  EVENT_TYPES,
  EVENT_TYPES_BY_ACTOR,
  InputRunSchema,
  MANUSCRIPT_EVENT_TYPES,
  PasteOccurredSchema,
  SourceAddedSchema,
  SuggestionProposedSchema,
  SuggestionResolvedSchema,
  TextEditedSchema,
  canActorEmit,
  isManuscriptEventType,
  parsePayload,
  type EventType,
} from './events';
import { EXAMPLE_PAYLOADS } from './fixtures.test-helpers';

const SPEC_TABLE: Record<'human' | 'agent' | 'system', EventType[]> = {
  human: [
    'TextEdited',
    'PasteOccurred',
    'ProposalAccepted',
    'ProposalRejected',
    'SuggestionDismissed',
    'FeedbackRequested',
    'SourceAdded',
    'CitationInserted',
  ],
  agent: [
    'FeedbackSessionStarted',
    'CommentAdded',
    'SuggestionProposed',
    'MoveProposed',
    'CutProposed',
    'CitationNeededFlagged',
    'SourceSurfaced',
    'QuestionAsked',
    'ReviewFinished',
  ],
  system: ['SuggestionResolved', 'ChainHeadWitnessed'],
};

describe('event table', () => {
  it('contains every event in the spec ledger table, with the spec actor', () => {
    for (const [actor, types] of Object.entries(SPEC_TABLE)) {
      for (const t of types) expect(ACTOR_PERMISSIONS[t], t).toEqual([actor]);
    }
  });

  it('gives every event type exactly one actor kind', () => {
    for (const t of EVENT_TYPES) expect(ACTOR_PERMISSIONS[t]).toHaveLength(1);
    const all = [
      ...EVENT_TYPES_BY_ACTOR.human,
      ...EVENT_TYPES_BY_ACTOR.agent,
      ...EVENT_TYPES_BY_ACTOR.system,
    ];
    expect(all.sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('only human events can touch the manuscript', () => {
    expect([...MANUSCRIPT_EVENT_TYPES].sort()).toEqual([
      'DocumentImported',
      'ProposalAccepted',
      'TextEdited',
    ]);
    for (const t of MANUSCRIPT_EVENT_TYPES) {
      expect(ACTOR_PERMISSIONS[t]).toEqual(['human']);
      expect(canActorEmit(t, 'agent')).toBe(false);
      expect(canActorEmit(t, 'system')).toBe(false);
    }
    for (const t of [...EVENT_TYPES_BY_ACTOR.agent, ...EVENT_TYPES_BY_ACTOR.system]) {
      expect(isManuscriptEventType(t)).toBe(false);
    }
  });

  it('synopsis, settings and binder events are human-only', () => {
    for (const t of [
      'SynopsisEdited',
      'ProjectSettingsChanged',
      'DocumentCreated',
      'FolderCreated',
      'DiscussRequested',
      'SliceCopied',
    ] as const) {
      expect(ACTOR_PERMISSIONS[t]).toEqual(['human']);
    }
    expect(ACTOR_PERMISSIONS.DiscussAnswered).toEqual(['agent']);
  });

  it('canActorEmit rejects unknown types', () => {
    expect(canActorEmit('RewriteParagraph', 'agent')).toBe(false);
    expect(canActorEmit('TextEdited', 'human')).toBe(true);
  });

  it('tables are frozen', () => {
    expect(Object.isFrozen(ACTOR_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(MANUSCRIPT_EVENT_TYPES)).toBe(true);
    expect(() => (ACTOR_PERMISSIONS.TextEdited as string[]).push('agent')).toThrow();
  });

  it.each(EVENT_TYPES)('%s example payload validates', (type) => {
    const r = EVENTS[type].payload.safeParse(EXAMPLE_PAYLOADS[type]);
    expect(r.error?.issues ?? []).toEqual([]);
    expect(parsePayload(type, EXAMPLE_PAYLOADS[type])).toEqual(EXAMPLE_PAYLOADS[type]);
  });
});

describe('TextEdited', () => {
  const base = EXAMPLE_PAYLOADS.TextEdited;

  it('runs must partition the steps', () => {
    expect(
      TextEditedSchema.safeParse({ ...base, runs: [{ steps: 1, method: 'typed' }] }).success,
    ).toBe(false);
    expect(
      TextEditedSchema.safeParse({ ...base, runs: [{ steps: 2, method: 'typed' }] }).success,
    ).toBe(true);
    expect(
      TextEditedSchema.safeParse({ ...base, runs: [{ steps: 3, method: 'typed' }] }).success,
    ).toBe(false);
  });

  it('timeline must be ordered and within durationMs', () => {
    expect(
      TextEditedSchema.safeParse({
        ...base,
        timeline: [
          { t: 5, kind: 'insert', len: 1 },
          { t: 4, kind: 'insert', len: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      TextEditedSchema.safeParse({ ...base, timeline: [{ t: 901, kind: 'insert', len: 1 }] })
        .success,
    ).toBe(false);
  });

  it('rejects unknown step types and empty batches', () => {
    expect(
      TextEditedSchema.safeParse({
        ...base,
        steps: [{ stepType: 'docAttr' }, { stepType: 'replace' }],
      }).success,
    ).toBe(false);
    expect(TextEditedSchema.safeParse({ ...base, steps: [], runs: [] }).success).toBe(false);
  });

  it('input runs require exactly the references their method needs', () => {
    expect(InputRunSchema.safeParse({ steps: 1, method: 'pasted-external' }).success).toBe(false);
    expect(
      InputRunSchema.safeParse({ steps: 1, method: 'pasted-internal', pasteId: 'p' }).success,
    ).toBe(true);
    expect(InputRunSchema.safeParse({ steps: 1, method: 'typed', pasteId: 'p' }).success).toBe(
      false,
    );
    expect(InputRunSchema.safeParse({ steps: 1, method: 'citation' }).success).toBe(false);
    expect(
      InputRunSchema.safeParse({ steps: 1, method: 'citation', citationId: 'c' }).success,
    ).toBe(true);
    expect(
      InputRunSchema.safeParse({ steps: 1, method: 'clipping', clippingId: 'c' }).success,
    ).toBe(true);
    expect(
      InputRunSchema.safeParse({ steps: 1, method: 'typed', traceSuggestionId: 's' }).success,
    ).toBe(true);
    expect(
      InputRunSchema.safeParse({ steps: 1, method: 'history', traceSuggestionId: 's' }).success,
    ).toBe(false);
    expect(InputRunSchema.safeParse({ steps: 0, method: 'typed' }).success).toBe(false);
  });
});

describe('other payload rules', () => {
  it('internal pastes need a copyId, external ones must not have one', () => {
    const p = EXAMPLE_PAYLOADS.PasteOccurred;
    expect(PasteOccurredSchema.safeParse({ ...p, origin: 'internal' }).success).toBe(false);
    expect(PasteOccurredSchema.safeParse({ ...p, origin: 'internal', copyId: 'c1' }).success).toBe(
      true,
    );
    expect(PasteOccurredSchema.safeParse({ ...p, copyId: 'c1' }).success).toBe(false);
  });

  it('surfaced sources keep their link to the candidate', () => {
    const s = EXAMPLE_PAYLOADS.SourceAdded;
    expect(SourceAddedSchema.safeParse({ ...s, fromSurfacedId: 'surf1' }).success).toBe(false);
    expect(
      SourceAddedSchema.safeParse({
        ...s,
        origin: { kind: 'surfaced', value: null },
        fromSurfacedId: 'surf1',
        candidateIndex: 0,
      }).success,
    ).toBe(true);
  });

  it('proposals only resolve as stale through SuggestionResolved', () => {
    expect(
      SuggestionResolvedSchema.safeParse({
        targetId: 'p',
        targetKind: 'proposal',
        outcome: 'adopted',
        triggerSeq: 1,
      }).success,
    ).toBe(false);
    expect(
      SuggestionResolvedSchema.safeParse({
        targetId: 'p',
        targetKind: 'proposal',
        outcome: 'stale',
        triggerSeq: 1,
      }).success,
    ).toBe(true);
  });

  it('word-choice suggestions carry 1-3 alternatives', () => {
    const s = EXAMPLE_PAYLOADS.SuggestionProposed;
    const withAlts = (alternatives: string[]) => ({
      ...s,
      suggestion: { ...(s.suggestion as object), alternatives },
    });
    expect(SuggestionProposedSchema.safeParse(withAlts([])).success).toBe(false);
    expect(SuggestionProposedSchema.safeParse(withAlts(['a', 'b', 'c', 'd'])).success).toBe(false);
  });
});
