import { describe, expect, it } from 'vitest';
import {
  AuthorshipReportSchema,
  PROVES_TABLE,
  VerificationBundleSchema,
  type AuthorshipReport,
} from './bundle';
import { makeCommit } from './fixtures.test-helpers';

const zeros = {
  typed: 0,
  'typed-from-suggestion': 0,
  'pasted-external': 0,
  'pasted-internal': 0,
  imported: 0,
  quoted: 0,
};
const outcomes = { proposed: 0, accepted: 0, rejected: 0, stale: 0, open: 0 };

const sampleReport: AuthorshipReport = {
  reportVersion: 1,
  scope: { kind: 'project' },
  throughSeq: 1,
  headHash: 'a'.repeat(64),
  words: { total: 0, byClass: zeros },
  characters: { total: 0, byClass: zeros },
  activeWritingMs: 0,
  sessions: { count: 0, days: 0, firstAt: null, lastAt: null, list: [] },
  ai: {
    feedbackRequests: 0,
    sessionsFinished: 0,
    sessionsFailed: 0,
    comments: 0,
    questions: 0,
    citationFlags: 0,
    surfacedSources: 0,
    discussThreads: 0,
  },
  suggestions: {
    total: 0,
    byKind: { 'word-choice': 0, insertion: 0, rephrase: 0 },
    byOutcome: { open: 0, adopted: 0, adapted: 0, stale: 0, dismissed: 0 },
  },
  proposals: {
    total: 0,
    byKind: { move: outcomes, cut: outcomes, split: outcomes, merge: outcomes },
  },
  pastes: {
    external: { count: 0, characters: 0, words: 0 },
    internal: { count: 0, characters: 0, words: 0 },
    events: [],
  },
  imports: { documents: 0, words: 0 },
  unwitnessed: [],
  disclosure: 'Written in 0 sessions.',
  provesTable: { proves: [...PROVES_TABLE.proves], doesNotProve: [...PROVES_TABLE.doesNotProve] },
};

describe('bundle', () => {
  it('validates a minimal bundle', () => {
    const bundle = {
      format: 'longhand-bundle',
      version: 1,
      projectId: 'proj1',
      createdAt: '2026-11-24T18:00:00.000Z',
      commits: [makeCommit('ProjectCreated')],
      witnesses: [],
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----\n',
      keyId: 'b'.repeat(64),
      report: sampleReport,
    };
    const r = VerificationBundleSchema.safeParse(bundle);
    expect(r.error?.issues ?? []).toEqual([]);
    expect(VerificationBundleSchema.safeParse({ ...bundle, format: 'other' }).success).toBe(false);
    expect(VerificationBundleSchema.safeParse({ ...bundle, commits: [] }).success).toBe(false);
  });

  it('report is open (extra fields allowed) but typed', () => {
    expect(
      AuthorshipReportSchema.safeParse({ ...sampleReport, extensions: { lane: 1 }, extra: true })
        .success,
    ).toBe(true);
    const { disclosure: _d, ...missing } = sampleReport;
    expect(AuthorshipReportSchema.safeParse(missing).success).toBe(false);
    expect(
      AuthorshipReportSchema.safeParse({
        ...sampleReport,
        words: { total: 1, byClass: { ...zeros, typed: -1 } },
      }).success,
    ).toBe(false);
  });

  it('proves table matches the spec and is frozen', () => {
    expect(PROVES_TABLE.proves).toHaveLength(3);
    expect(PROVES_TABLE.doesNotProve).toHaveLength(3);
    expect(Object.isFrozen(PROVES_TABLE.proves)).toBe(true);
  });
});
