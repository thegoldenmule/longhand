import { FIXTURE_NAMES, TAMPERED_FIXTURE_NAMES, loadFixture } from '@longhand/ledger/fixtures';
import { keyIdFromPublicKeyPem, type Commit } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { diffJson } from './diff';
import {
  clone,
  fixtureBundle,
  otherPublicKeyPem,
  rechainAndResign,
  tamperedBundle,
} from './test-helpers';
import { verifyBundle, type CheckId, type VerificationResult } from './verify';

const status = (r: VerificationResult) =>
  Object.fromEntries(r.checks.map((c) => [c.id, c.status])) as Record<CheckId, string>;
const detail = (r: VerificationResult, id: CheckId) =>
  r.checks.find((c) => c.id === id)!.details.join('\n');

const ALL_PASS = {
  schema: 'pass',
  key: 'pass',
  chain: 'pass',
  witnesses: 'pass',
  fold: 'pass',
  report: 'pass',
};

describe('verifyBundle on good bundles', () => {
  it.each(FIXTURE_NAMES)('passes %s (project report)', async (name) => {
    const r = await verifyBundle(clone(fixtureBundle(name)));
    expect(status(r)).toEqual(ALL_PASS);
    expect(r.ok).toBe(true);
    expect(r.report?.disclosure).toBe(fixtureBundle(name).report.disclosure);
  });

  it.each(FIXTURE_NAMES)('passes %s (a document report)', async (name) => {
    const docId = Object.keys(loadFixture(name).expected.state.documents).sort()[0]!;
    const r = await verifyBundle(clone(fixtureBundle(name, { documentId: docId })));
    expect(status(r)).toEqual(ALL_PASS);
  });

  it('passes with the expected key id, and fails with another', async () => {
    const b = clone(fixtureBundle('novel'));
    expect((await verifyBundle(b, { expectedKeyId: b.keyId })).ok).toBe(true);
    const r = await verifyBundle(b, { expectedKeyId: 'ab'.repeat(32) });
    expect(status(r).key).toBe('fail');
    expect(r.ok).toBe(false);
  });
});

describe('verifyBundle on tampered bundles', () => {
  it.each(TAMPERED_FIXTURE_NAMES)('fails %s at the hash chain', async (name) => {
    const r = await verifyBundle(clone(tamperedBundle(name)));
    expect(r.ok).toBe(false);
    expect(status(r).chain).toBe('fail');
    // A broken ledger is never re-folded or trusted for a report.
    expect(status(r).fold).toBe('skip');
    expect(status(r).report).toBe('skip');
  });

  it('names the problem for each tampered fixture', async () => {
    const expected: Record<string, { chain: string; schema?: string; witnesses?: string }> = {
      'tampered-edited': { chain: 'hash-mismatch' },
      'tampered-rehashed': { chain: 'prev-hash-mismatch', witnesses: 'subject-mismatch' },
      'tampered-reordered': { chain: 'seq-out-of-order' },
      'tampered-dropped': { chain: 'seq-gap', witnesses: 'extra-witness' },
      'tampered-actor': { chain: 'invalid-commit', schema: 'fail' },
      'tampered-truncated': { chain: 'head-mismatch', witnesses: 'extra-witness' },
    };
    for (const name of TAMPERED_FIXTURE_NAMES) {
      const r = await verifyBundle(clone(tamperedBundle(name)));
      const e = expected[name]!;
      expect(detail(r, 'chain'), name).toContain(e.chain);
      if (e.schema) expect(status(r).schema, name).toBe(e.schema);
      if (e.witnesses) expect(detail(r, 'witnesses'), name).toContain(e.witnesses);
    }
  });

  it('fails a wrong key at the witnesses', async () => {
    const b = clone(fixtureBundle('suggestions'));
    b.publicKeyPem = await otherPublicKeyPem();
    b.keyId = keyIdFromPublicKeyPem(b.publicKeyPem);
    const r = await verifyBundle(b);
    expect(status(r).key).toBe('pass');
    expect(status(r).witnesses).toBe('fail');
    expect(detail(r, 'witnesses')).toContain('key-mismatch');
    expect(r.ok).toBe(false);
  });

  it('fails a key id that is not the public key’s', async () => {
    const b = clone(fixtureBundle('suggestions'));
    b.keyId = 'cd'.repeat(32);
    const r = await verifyBundle(b);
    expect(status(r).key).toBe('fail');
    expect(detail(r, 'key')).toContain('the bundle says keyId');
  });

  it('fails an unusable public key', async () => {
    const b = clone(fixtureBundle('ime'));
    b.publicKeyPem = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----';
    const r = await verifyBundle(b);
    expect(status(r).key).toBe('fail');
    expect(status(r).witnesses).toBe('skip');
  });

  it('fails a dropped witness', async () => {
    const b = clone(fixtureBundle('novel'));
    b.witnesses.splice(5, 1);
    const r = await verifyBundle(b);
    expect(status(r).witnesses).toBe('fail');
    expect(detail(r, 'witnesses')).toContain('missing-witness: seq 6 has no witness');
    expect(r.ok).toBe(false);
  });

  it('fails a dropped last witness at the chain head too', async () => {
    const b = clone(fixtureBundle('novel'));
    b.witnesses.pop();
    const r = await verifyBundle(b);
    expect(status(r).chain).toBe('fail');
    expect(detail(r, 'chain')).toContain('head-mismatch');
    expect(status(r).witnesses).toBe('fail');
  });

  it('fails a doctored report with a precise diff', async () => {
    const b = clone(fixtureBundle('plain-typing'));
    const typed = b.report.words.byClass.typed;
    b.report.words.byClass.typed = typed + 1;
    const r = await verifyBundle(b);
    expect(status(r)).toEqual({ ...ALL_PASS, report: 'fail' });
    expect(detail(r, 'report')).toBe(
      `words.byClass.typed: bundled ${typed + 1}, recomputed ${typed}`,
    );
  });

  it('fails a doctored disclosure', async () => {
    const b = clone(fixtureBundle('suggestions'));
    b.report.disclosure = b.report.disclosure.replace('26.9%', '2.0%');
    const r = await verifyBundle(b);
    expect(status(r).report).toBe('fail');
    expect(detail(r, 'report')).toBe(
      `disclosure: bundled "… 73.1% typed directly; 2.0% retyped from AI text (2 word…", recomputed "… 73.1% typed directly; 26.9% retyped from AI text (2 wor…"`,
    );
  });

  it('fails a truncated chain', async () => {
    const b = clone(fixtureBundle('proposals'));
    b.commits = b.commits.slice(0, -4);
    const r = await verifyBundle(b);
    expect(status(r).chain).toBe('fail');
    expect(detail(r, 'chain')).toContain('head-mismatch');
    expect(detail(r, 'witnesses')).toContain('extra-witness');
  });

  it('fails a truncated chain whose witnesses were truncated too, at the report', async () => {
    const b = clone(fixtureBundle('proposals'));
    b.commits = b.commits.slice(0, -4);
    b.witnesses = b.witnesses.slice(0, -4);
    const r = await verifyBundle(b);
    expect(status(r)).toEqual({ ...ALL_PASS, report: 'fail' });
    expect(detail(r, 'report')).toContain('throughSeq');
  });

  it('fails a re-signed ledger in which the server lied about an outcome', async () => {
    const b = clone(fixtureBundle('suggestions'));
    const i = b.commits.findIndex(
      (c) => c.type === 'SuggestionResolved' && c.payload.outcome === 'adopted',
    );
    const c = b.commits[i] as Commit & { payload: { outcome: string } };
    c.payload.outcome = 'adapted';
    b.witnesses = await rechainAndResign(b.commits, i);
    const r = await verifyBundle(b);
    expect(status(r).chain).toBe('pass');
    expect(status(r).witnesses).toBe('pass');
    expect(status(r).fold).toBe('fail');
    expect(status(r).report).toBe('skip');
  });

  it('fails a bundle naming another project', async () => {
    const b = clone(fixtureBundle('ime'));
    b.projectId = 'someone-else';
    const r = await verifyBundle(b);
    expect(status(r).schema).toBe('fail');
  });

  it('fails things that are not bundles', async () => {
    for (const v of [null, 42, 'bundle', [], {}]) {
      const r = await verifyBundle(v);
      expect(r.ok).toBe(false);
      expect(status(r).schema).toBe('fail');
    }
  });
});

describe('diffJson', () => {
  it('lists every differing path', () => {
    expect(
      diffJson(
        { a: 1, b: { c: [1, 2, 3] }, d: 'x', 'odd key': 1 },
        { a: 1, b: { c: [1, 5] }, e: true, 'odd key': 2 },
      ),
    ).toEqual([
      { path: 'b.c[1]', bundled: 2, recomputed: 5 },
      { path: 'b.c[2]', bundled: 3, recomputed: undefined },
      { path: 'd', bundled: 'x', recomputed: undefined },
      { path: 'e', bundled: undefined, recomputed: true },
      { path: '["odd key"]', bundled: 1, recomputed: 2 },
    ]);
  });
});
