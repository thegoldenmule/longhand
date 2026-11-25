import { loadFixture } from '@longhand/ledger/fixtures';
import { VerificationBundleSchema, canonicalize } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { buildBundle, provenanceSummaryForExport } from './bundle';
import { computeReport } from './compute';

describe('buildBundle', () => {
  const f = loadFixture('novel');
  const bundle = buildBundle({
    commits: f.commits,
    witnesses: f.witnesses,
    publicKeyPem: f.publicKeyPem,
    keyId: f.keyId,
    scope: 'project',
  });

  it('builds a valid bundle with the computed report', () => {
    expect(VerificationBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.projectId).toBe(f.commits[0]!.projectId);
    expect(bundle.createdAt).toBe(f.commits[f.commits.length - 1]!.serverTime);
    expect(canonicalize(bundle.report)).toBe(
      canonicalize(computeReport(f.commits, { scope: 'project', witnesses: f.witnesses })),
    );
  });

  it('survives a JSON round trip unchanged', () => {
    const again = JSON.parse(JSON.stringify(bundle));
    expect(canonicalize(again)).toBe(canonicalize(bundle));
  });

  it('takes the server clock and a document scope', () => {
    const b = buildBundle({
      commits: f.commits,
      witnesses: f.witnesses,
      publicKeyPem: f.publicKeyPem,
      keyId: f.keyId,
      scope: { documentId: 'doc-2' },
      createdAt: '2026-12-01T00:00:00.000Z',
    });
    expect(b.createdAt).toBe('2026-12-01T00:00:00.000Z');
    expect(b.report.scope).toEqual({ kind: 'document', documentId: 'doc-2' });
  });

  it('rejects an empty ledger and an unknown document', () => {
    const input = { witnesses: [], publicKeyPem: f.publicKeyPem, keyId: f.keyId };
    expect(() => buildBundle({ ...input, commits: [], scope: 'project' })).toThrow(/no commits/);
    expect(() =>
      buildBundle({ ...input, commits: f.commits, scope: { documentId: 'nope' } }),
    ).toThrow(/no document nope/);
  });
});

describe('provenanceSummaryForExport', () => {
  it('copies the appendix fields from the report', () => {
    const f = loadFixture('suggestions');
    const report = computeReport(f.commits, { scope: 'project' });
    const summary = provenanceSummaryForExport(report, 'Verify with longhand-verify');
    expect(summary).toEqual({
      wordsByClass: report.words.byClass,
      disclosure: report.disclosure,
      provesTable: report.provesTable,
      verificationNote: 'Verify with longhand-verify',
    });
    expect(provenanceSummaryForExport(report).verificationNote).toBeNull();
  });
});
