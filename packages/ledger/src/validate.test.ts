import { schema, type CommitDraft } from '@longhand/schema';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { LedgerBuilder } from './builder';
import { validateDraft } from './validate';

const human = { kind: 'human' as const, id: 'writer-1' };
const agent = { kind: 'agent' as const, id: 'opus' };

function setup() {
  const b = new LedgerBuilder({ seed: 5 });
  b.createDocument('d', 'Doc');
  b.type('d', 'Hello world.');
  return b;
}

function envelope(b: LedgerBuilder, actor: { kind: 'human' | 'agent' | 'system'; id: string }, sessionId = 'editor-1') {
  return {
    commitId: 'c-new',
    projectId: b.projectId,
    clientTime: b.now(),
    actor,
    deviceId: actor.kind === 'human' ? 'device-1' : 'server',
    sessionId,
    schemaVersion: 1,
  };
}

function textEdited(b: LedgerBuilder, baseVersion = b.version('d')): CommitDraft {
  const tr = new Transform(b.doc('d')).insert(1, schema.text('Oh, '));
  return {
    ...envelope(b, human),
    type: 'TextEdited',
    payload: {
      documentId: 'd',
      baseVersion,
      steps: tr.steps.map((s) => s.toJSON()),
      runs: [{ steps: 1, method: 'typed' }],
      timeline: [{ t: 0, kind: 'insert', len: 4 }],
      characters: 4,
      durationMs: 0,
    },
  } as CommitDraft;
}

describe('validateDraft', () => {
  it('accepts a valid draft and returns the folded state', () => {
    const b = setup();
    const r = validateDraft(b.state, textEdited(b), human);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.commit.seq).toBe(b.head.seq + 1);
      expect(r.commit.prevHash).toBe(b.head.hash);
      expect(r.resolutions).toEqual([]);
    }
  });

  it('enforces actor permissions: no agent or system actor can emit a manuscript event', () => {
    const b = setup();
    for (const actor of [agent, { kind: 'system' as const, id: 'ledger' }]) {
      const d = { ...textEdited(b), actor };
      const r = validateDraft(b.state, d, actor);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]!.code).toBe('actor-not-permitted');
    }
    const p = { ...envelope(b, agent, 'fs'), type: 'ProposalAccepted', payload: { proposalId: 'x', documentId: 'd', baseVersion: 0 } };
    const r = validateDraft(b.state, p, agent);
    expect(!r.ok && r.errors[0]!.code).toBe('actor-not-permitted');
  });

  it('rejects a draft whose actor is not the authenticated one', () => {
    const b = setup();
    const r = validateDraft(b.state, textEdited(b), { kind: 'human', id: 'someone-else' });
    expect(!r.ok && r.errors[0]!.code).toBe('actor-mismatch');
  });

  it('rejects schema errors with paths', () => {
    const b = setup();
    const d = textEdited(b) as unknown as { payload: { runs: unknown[] } };
    d.payload.runs = [{ steps: 2, method: 'typed' }];
    const r = validateDraft(b.state, d, human);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'invalid-draft', path: 'payload.runs' });
  });

  it('rebase policy: TextEdited behind the document is rejected, never rebased', () => {
    const b = setup();
    const stale = textEdited(b, b.version('d') - 1);
    const r = validateDraft(b.state, stale, human);
    expect(!r.ok && r.errors[0]!.code).toBe('stale-base-version');
    const future = textEdited(b, b.version('d') + 1);
    const f = validateDraft(b.state, future, human);
    expect(!f.ok && f.errors[0]!.code).toBe('future-base-version');
  });

  it('rejects steps that do not apply', () => {
    const b = setup();
    const d = textEdited(b) as unknown as { payload: { steps: unknown[] } };
    d.payload.steps = [{ stepType: 'replace', from: 500, to: 500, slice: { content: [{ type: 'text', text: 'x' }] } }];
    const r = validateDraft(b.state, d, human);
    expect(!r.ok && r.errors[0]!.code).toBe('step-failed');
  });

  it('rejects agent events with invalid targets or outside a running session', () => {
    const b = setup();
    b.requestFeedback('r', { scope: { kind: 'document', documentId: 'd' } });
    b.startReview('s', 'r');
    const comment = (target: unknown, sessionId = 's') => ({
      ...envelope(b, agent, sessionId),
      type: 'CommentAdded',
      payload: { commentId: 'c1', feedbackSessionId: 's', target, category: 'clarity', severity: 'minor', body: 'x' },
    });
    const v = b.version('d');
    const anchor = { documentId: 'd', sentenceId: 'p1.s1', quote: 'world', occurrence: 0 };
    const good = { kind: 'anchor', anchor, from: 7, to: 12, readVersion: v, version: v };
    expect(validateDraft(b.state, comment(good), agent).ok).toBe(true);
    const wrongPos = validateDraft(b.state, comment({ ...good, from: 6 }), agent);
    expect(!wrongPos.ok && wrongPos.errors[0]!.code).toBe('target-mismatch');
    const oldVersion = validateDraft(b.state, comment({ ...good, version: v - 1, readVersion: v - 1 }), agent);
    expect(!oldVersion.ok && oldVersion.errors[0]!.code).toBe('invalid-version');
    const unknownDoc = validateDraft(b.state, comment({ ...good, anchor: { ...anchor, documentId: 'zzz' } }), agent);
    expect(!unknownDoc.ok && unknownDoc.errors[0]!.code).toBe('unknown-document');
    const wrongSession = validateDraft(b.state, comment(good, 'other'), agent);
    expect(!wrongSession.ok && wrongSession.errors[0]!.code).toBe('session-mismatch');
    b.finishReview('s', 'done');
    const finished = validateDraft(b.state, comment(good), agent);
    expect(!finished.ok && finished.errors[0]!.code).toBe('session-not-running');
  });

  it('rejects a SuggestionResolved that disagrees with the fold', () => {
    const b = setup();
    b.requestFeedback('r', { scope: { kind: 'document', documentId: 'd' } });
    b.startReview('s', 'r');
    b.suggestWordChoice('s', 'w', { documentId: 'd', sentenceId: 'p1.s1', quote: 'world' }, ['planet'], 'r');
    const sys = { kind: 'system' as const, id: 'ledger' };
    const draft = {
      ...envelope(b, sys, 'system'),
      deviceId: 'server',
      type: 'SuggestionResolved',
      payload: { targetId: 'w', targetKind: 'suggestion', outcome: 'adopted', triggerSeq: b.head.seq },
    };
    const r = validateDraft(b.state, draft, sys);
    expect(!r.ok && r.errors[0]!.code).toBe('resolution-mismatch');
  });

  it('returns the SuggestionResolved events the service must append', () => {
    const b = new LedgerBuilder({ autoResolve: false });
    b.createDocument('d', 'Doc');
    b.type('d', 'Hello world.');
    b.requestFeedback('r', { scope: { kind: 'document', documentId: 'd' } });
    b.startReview('s', 'r');
    b.suggestWordChoice('s', 'w', { documentId: 'd', sentenceId: 'p1.s1', quote: 'world' }, ['planet'], 'r');
    const tr = new Transform(b.doc('d')).replaceWith(7, 12, schema.text('planet'));
    const draft = {
      ...envelope(b, human),
      type: 'TextEdited',
      payload: {
        documentId: 'd',
        baseVersion: b.version('d'),
        steps: tr.steps.map((s) => s.toJSON()),
        runs: [{ steps: 1, method: 'typed' }],
        timeline: [{ t: 0, kind: 'insert', len: 6 }],
        characters: 6,
        durationMs: 0,
      },
    };
    const r = validateDraft(b.state, draft, human);
    expect(r.ok && r.resolutions).toEqual([{ targetId: 'w', targetKind: 'suggestion', outcome: 'adopted', triggerSeq: b.head.seq + 1 }]);
  });

  it('accepts ProposalAccepted at an older baseVersion while open, not when stale', () => {
    const b = setup();
    b.type('d', ' Second sentence.');
    b.requestFeedback('r', { scope: { kind: 'document', documentId: 'd' } });
    b.startReview('s', 'r');
    b.proposeCut('s', 'p', { kind: 'span', documentId: 'd', unit: 'sentence', ids: ['p1.s2'] }, 'r');
    const seen = b.version('d');
    b.type('d', 'Hi. ', { at: 1 });
    const draft = { ...envelope(b, human), type: 'ProposalAccepted', payload: { proposalId: 'p', documentId: 'd', baseVersion: seen } };
    expect(validateDraft(b.state, draft, human).ok).toBe(true);
    b.type('d', 'X', { at: { after: 'Second' } });
    const r = validateDraft(b.state, draft, human);
    expect(!r.ok && r.errors[0]!.code).toBe('not-open');
  });

  it('requires ProjectCreated first and only once', () => {
    const b = setup();
    const d = { ...envelope(b, human), type: 'ProjectCreated', payload: { title: 'Again' } };
    const r = validateDraft(b.state, d, human);
    expect(!r.ok && r.errors[0]!.code).toBe('project-already-created');
  });
});
