import { describe, expect, it } from 'vitest';
import { canonicalize, sha256Hex } from './canonical';
import { EVENT_TYPES } from './events';
import { EXAMPLE_PAYLOADS, makeCommit } from './fixtures.test-helpers';
import {
  CommitDraftSchema,
  CommitSchema,
  GENESIS_PREV_HASH,
  SCHEMA_VERSION,
  WitnessSchema,
  base64Decode,
  base64Encode,
  computeCommitHash,
  derToPem,
  keyIdFromPublicKeyPem,
  pemToDer,
  verifyCommitHash,
  verifyWitnessSignature,
  witnessMessage,
  type Commit,
  type Witness,
} from './ledger';

describe('commit envelope', () => {
  it('genesis prev hash is 64 zeros', () => {
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64));
    expect(SCHEMA_VERSION).toBe(1);
  });

  it.each(EVENT_TYPES)('a %s commit from its permitted actor validates', (type) => {
    const c = makeCommit(type);
    const r = CommitSchema.safeParse(c);
    expect(r.error?.issues ?? []).toEqual([]);
    expect(verifyCommitHash(c)).toBe(true);
  });

  it('rejects an agent or system actor on every human event and vice versa', () => {
    for (const type of EVENT_TYPES) {
      for (const kind of ['human', 'agent', 'system'] as const) {
        const ok = CommitSchema.safeParse(makeCommit(type, { actorKind: kind })).success;
        expect(ok, `${type} by ${kind}`).toBe(makeCommit(type).actor.kind === kind);
      }
    }
  });

  it('an agent can never emit TextEdited, ProposalAccepted or DocumentImported', () => {
    for (const type of ['TextEdited', 'ProposalAccepted', 'DocumentImported'] as const) {
      const r = CommitSchema.safeParse(makeCommit(type, { actorKind: 'agent' }));
      expect(r.success).toBe(false);
    }
  });

  it('rejects unknown types, wrong payloads and wrong schema versions', () => {
    const c = makeCommit('DocumentRenamed') as Commit;
    expect(CommitSchema.safeParse({ ...c, type: 'RewriteParagraph' }).success).toBe(false);
    expect(CommitSchema.safeParse({ ...c, payload: { documentId: 'doc1' } }).success).toBe(false);
    expect(CommitSchema.safeParse({ ...c, payload: EXAMPLE_PAYLOADS.TextEdited }).success).toBe(
      false,
    );
    expect(CommitSchema.safeParse({ ...c, schemaVersion: 2 }).success).toBe(false);
    expect(CommitSchema.safeParse({ ...c, clientTime: '2026-11-24T18:00:00Z' }).success).toBe(
      false,
    );
  });

  it('drafts omit server-assigned fields', () => {
    const {
      seq: _s,
      prevHash: _p,
      hash: _h,
      serverTime: _t,
      accountId: _a,
      ...draft
    } = makeCommit('TextEdited');
    expect(CommitDraftSchema.safeParse(draft).success).toBe(true);
    expect(
      CommitDraftSchema.safeParse({ ...draft, actor: { kind: 'agent', id: 'x' } }).success,
    ).toBe(false);
  });

  it('hash covers every field except hash, and is key-order independent', () => {
    const c = makeCommit('SynopsisEdited');
    const { hash, ...rest } = c;
    expect(hash).toBe(sha256Hex(canonicalize(rest)));
    expect(computeCommitHash(c)).toBe(hash);
    const reordered = Object.fromEntries(Object.entries(c).reverse()) as Commit;
    expect(computeCommitHash(reordered)).toBe(hash);
    for (const tamper of [
      { seq: 2 },
      { prevHash: 'f'.repeat(64) },
      { serverTime: '2026-11-24T18:00:00.001Z' },
      { payload: { ...EXAMPLE_PAYLOADS.SynopsisEdited, synopsis: 'changed' } },
      { actor: { kind: 'human', id: 'someone-else' } },
    ]) {
      expect(verifyCommitHash({ ...c, ...tamper } as Commit)).toBe(false);
    }
  });

  it('chains through prevHash', () => {
    const c1 = makeCommit('ProjectCreated', { seq: 1 });
    const c2 = makeCommit('DocumentCreated', { seq: 2, prevHash: c1.hash });
    expect(c2.prevHash).toBe(c1.hash);
    expect(c1.hash).not.toBe(c2.hash);
  });
});

describe('witnesses', async () => {
  const subtle = globalThis.crypto.subtle;
  const genKey = () =>
    subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]) as Promise<CryptoKeyPair>;
  const pemOf = async (k: CryptoKey) => derToPem(new Uint8Array(await subtle.exportKey('spki', k)));
  const pair = await genKey();
  const publicKey = await pemOf(pair.publicKey);
  const commit = makeCommit('TextEdited', { seq: 7, prevHash: 'a'.repeat(64) });

  const witnessFor = async (c: Commit): Promise<Witness> => {
    const msg = witnessMessage(c);
    // WebCrypto ECDSA signatures are IEEE P1363 r||s, the bundle's encoding.
    const sig = await subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      msg as Uint8Array<ArrayBuffer>,
    );
    return {
      projectId: c.projectId,
      seq: c.seq,
      hash: c.hash,
      serverTime: c.serverTime,
      signature: base64Encode(new Uint8Array(sig)),
      keyId: keyIdFromPublicKeyPem(publicKey),
    };
  };

  it('signs exactly the canonical JSON of {projectId, seq, hash, serverTime}', () => {
    const msg = new TextDecoder().decode(
      witnessMessage({ ...commit, extra: 1 } as unknown as Commit),
    );
    expect(msg).toBe(
      `{"hash":"${commit.hash}","projectId":"proj1","seq":7,"serverTime":"2026-11-24T18:00:00.000Z"}`,
    );
  });

  it('verifies a P1363 signature', async () => {
    const w = await witnessFor(commit);
    expect(WitnessSchema.safeParse(w).success).toBe(true);
    expect(await verifyWitnessSignature(w, publicKey)).toBe(true);
  });

  it('fails verification when any signed field changes', async () => {
    const w = await witnessFor(commit);
    for (const tamper of [
      { seq: 8 },
      { hash: 'b'.repeat(64) },
      { serverTime: '2026-11-24T18:00:01.000Z' },
      { projectId: 'p2' },
    ]) {
      expect(await verifyWitnessSignature({ ...w, ...tamper }, publicKey)).toBe(false);
    }
    expect(await verifyWitnessSignature({ ...w, signature: 'AAAA' }, publicKey)).toBe(false);
    const other = await genKey();
    expect(await verifyWitnessSignature(w, await pemOf(other.publicKey))).toBe(false);
  });

  it('keyId is the SHA-256 of the SPKI DER; PEM helpers round-trip', () => {
    const der = pemToDer(publicKey);
    expect(keyIdFromPublicKeyPem(publicKey)).toBe(sha256Hex(der));
    expect(pemToDer(derToPem(der))).toEqual(der);
    // Same text as Node's `export({ type: 'spki', format: 'pem' })` (64-char lines).
    expect(publicKey).toMatch(
      /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=]{1,64}\n)+-----END PUBLIC KEY-----\n$/,
    );
  });

  it('base64 round-trips', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    expect(base64Encode(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
  });
});

describe('strict envelope', () => {
  it('rejects unknown envelope fields instead of stripping them', () => {
    expect(CommitSchema.safeParse({ ...makeCommit('ProjectCreated'), extra: true }).success).toBe(
      false,
    );
  });
});
