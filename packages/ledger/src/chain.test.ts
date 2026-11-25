import { computeCommitHash, derToPem, GENESIS_PREV_HASH, keyIdFromPublicKeyPem, type Commit } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../fixtures/index';
import { appendToChain, ChainError, signWitness, verifyChain, verifyWitnesses, webCryptoSigner } from './chain';

const commits = loadFixture('plain-typing').commits;

function clone(): Commit[] {
  return JSON.parse(JSON.stringify(commits)) as Commit[];
}

async function testSigner() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pem = derToPem(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
  return webCryptoSigner(pair.privateKey, pem);
}

describe('appendToChain', () => {
  it('assigns seq, prevHash, serverTime, accountId and hashes the parsed commit', () => {
    const { seq: _s, prevHash: _p, hash: _h, serverTime: _t, accountId: _a, ...draft } = commits[0]!;
    const c = appendToChain(null, draft, '2026-11-02T09:00:00.000Z', { accountId: 'acct-1' });
    expect(c).toMatchObject({ seq: 1, prevHash: GENESIS_PREV_HASH, accountId: 'acct-1', serverTime: '2026-11-02T09:00:00.000Z' });
    expect(c.hash).toBe(computeCommitHash(c));
    const { seq: _s2, prevHash: _p2, hash: _h2, serverTime: _t2, accountId: _a2, ...d2 } = commits[1]!;
    const c2 = appendToChain(c, d2, '2026-11-02T09:00:01.000Z');
    expect(c2).toMatchObject({ seq: 2, prevHash: c.hash, accountId: 'acct-1' });
  });

  it('rejects invalid drafts, wrong actors and other projects', () => {
    const { seq: _s, prevHash: _p, hash: _h, serverTime: _t, accountId: _a, ...draft } = commits[2]!;
    const head = commits[1]!;
    expect(() => appendToChain(head, { ...draft, actor: { kind: 'agent', id: 'opus' } }, head.serverTime)).toThrow(ChainError);
    expect(() => appendToChain(head, { ...draft, projectId: 'other' }, head.serverTime)).toThrow(/project/);
    expect(() => appendToChain(head, { ...draft, extra: 1 }, head.serverTime)).toThrow(/draft/);
    expect(() => appendToChain(null, draft, head.serverTime)).toThrow(/accountId/);
  });
});

describe('verifyChain', () => {
  it('accepts a valid ledger', () => {
    expect(verifyChain(commits)).toEqual({ ok: true, headSeq: commits.length, headHash: commits.at(-1)!.hash, length: commits.length });
  });

  it('detects an edited commit', () => {
    const cs = clone();
    (cs[3]!.payload as { durationMs: number }).durationMs += 1;
    const r = verifyChain(cs);
    expect(!r.ok && r.problems.map((p) => [p.code, p.seq])).toEqual([['hash-mismatch', 4]]);
  });

  it('detects reordering, drops, duplicates and a wrong genesis', () => {
    let cs = clone();
    [cs[2], cs[3]] = [cs[3]!, cs[2]!];
    let r = verifyChain(cs);
    expect(!r.ok && r.problems.map((p) => p.code)).toContain('seq-out-of-order');
    cs = clone();
    cs.splice(5, 1);
    r = verifyChain(cs);
    expect(!r.ok && r.problems.map((p) => [p.code, p.seq])).toEqual([['seq-gap', 7], ['prev-hash-mismatch', 7]]);
    cs = clone();
    cs.splice(3, 0, cs[2]!);
    r = verifyChain(cs);
    expect(!r.ok && r.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['duplicate-seq', 'duplicate-commit-id']));
    cs = clone();
    cs.shift();
    r = verifyChain(cs);
    expect(!r.ok && r.problems.map((p) => p.code)).toEqual(['seq-gap', 'genesis-mismatch']);
  });

  it('detects truncation only with an expected head', () => {
    const cs = clone().slice(0, 5);
    expect(verifyChain(cs).ok).toBe(true);
    const r = verifyChain(cs, { expectedHead: { seq: commits.length, hash: commits.at(-1)!.hash } });
    expect(!r.ok && r.problems[0]!.code).toBe('head-mismatch');
    expect(verifyChain([]).ok).toBe(false);
  });
});

describe('witnesses', () => {
  it('signs and verifies, and rejects mismatched subjects, keys and signatures', async () => {
    const signer = await testSigner();
    const witnesses = await Promise.all(commits.map((c) => signWitness(signer, c)));
    expect(signer.keyId).toBe(keyIdFromPublicKeyPem(signer.publicKeyPem));
    const ok = await verifyWitnesses(commits, witnesses, signer.publicKeyPem);
    expect(ok).toMatchObject({ ok: true, problems: [] });
    expect(ok.witnessed).toHaveLength(commits.length);

    const bad = witnesses.map((w) => ({ ...w }));
    bad[1] = { ...bad[1]!, serverTime: '2020-01-01T00:00:00.000Z' };
    bad[2] = { ...bad[2]!, signature: witnesses[3]!.signature };
    bad.pop();
    const r = await verifyWitnesses(commits, bad, signer.publicKeyPem);
    expect(r.problems.map((p) => [p.code, p.seq])).toEqual([
      ['subject-mismatch', 2],
      ['bad-signature', 3],
      ['missing-witness', commits.length],
    ]);
    const lax = await verifyWitnesses(commits, witnesses.slice(0, -1), signer.publicKeyPem, { requireAll: false });
    expect(lax.ok).toBe(true);
    const other = await testSigner();
    const wrongKey = await verifyWitnesses(commits, witnesses, other.publicKeyPem);
    expect(wrongKey.problems[0]!.code).toBe('key-mismatch');
  });

  it('verifies embedded ChainHeadWitnessed events', async () => {
    const f = loadFixture('novel');
    const r = await verifyWitnesses(f.commits, f.witnesses, f.publicKeyPem);
    expect(r.ok).toBe(true);
    const cs = JSON.parse(JSON.stringify(f.commits)) as Commit[];
    const i = cs.findIndex((c) => c.type === 'ChainHeadWitnessed');
    (cs[i]!.payload as { signature: string }).signature = f.witnesses[0]!.signature;
    const r2 = await verifyWitnesses(cs, f.witnesses, f.publicKeyPem, { requireAll: false });
    expect(r2.problems.map((p) => p.code)).toContain('embedded-bad-signature');
  });
});
