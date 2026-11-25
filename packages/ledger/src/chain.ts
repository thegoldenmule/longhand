/**
 * The hash chain: appending drafts, verifying a ledger, and witnesses.
 *
 * - `appendToChain` is what the ledger service does on ingest: parse the draft,
 *   assign `seq`, `prevHash`, `serverTime` and `accountId`, parse the result as a
 *   `Commit`, and hash *the parsed commit*.
 * - `verifyChain` checks a ledger exactly as given (hashes are computed over the
 *   commits as they appear, never over re-parsed output) and reports every problem
 *   with its index and seq.
 * - Witness helpers sign and verify `(projectId, seq, hash, serverTime)` with the
 *   schema's WebCrypto functions, so they run in Node and browsers.
 */
import {
  CommitDraftSchema,
  CommitSchema,
  GENESIS_PREV_HASH,
  base64Encode,
  canActorEmit,
  computeCommitHash,
  importWitnessPublicKey,
  keyIdFromPublicKeyPem,
  verifyWitnessSignature,
  witnessMessage,
  type Commit,
  type CommitDraft,
  type Witness,
  type WitnessSigner,
} from '@longhand/schema';

/** What `appendToChain` needs to know about the previous commit. */
export interface ChainHead {
  seq: number;
  hash: string;
  projectId: string;
  accountId: string;
}

/** Thrown by {@link appendToChain} for an invalid draft. */
export class ChainError extends Error {
  readonly code: 'invalid-draft' | 'actor-not-permitted' | 'project-mismatch' | 'invalid-commit';
  readonly issues: string[];
  constructor(code: ChainError['code'], message: string, issues: string[] = []) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    this.issues = issues;
  }
}

function zodIssues(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] {
  return err.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
}

/**
 * Builds the next commit from a draft: `seq = prev.seq + 1` (1 for the first),
 * `prevHash = prev.hash` (64 zeros first), the given `serverTime`, and
 * `accountId` from `prev` (or `opts.accountId`, required for the first commit).
 * The draft is parsed with `CommitDraftSchema` and the commit with `CommitSchema`;
 * the hash covers the parsed commit. Throws {@link ChainError}.
 */
export function appendToChain(
  prev: ChainHead | Commit | null,
  draft: CommitDraft | unknown,
  serverTime: string,
  opts: { accountId?: string } = {},
): Commit {
  const raw = draft as { type?: unknown; actor?: { kind?: unknown } };
  if (
    raw &&
    typeof raw.type === 'string' &&
    raw.actor &&
    typeof raw.actor.kind === 'string' &&
    !canActorEmit(raw.type, raw.actor.kind as 'human')
  ) {
    throw new ChainError('actor-not-permitted', `a ${String(raw.actor.kind)} actor may not emit ${raw.type}`);
  }
  const parsedDraft = CommitDraftSchema.safeParse(draft);
  if (!parsedDraft.success) {
    throw new ChainError('invalid-draft', 'the draft is not a valid commit draft', zodIssues(parsedDraft.error));
  }
  const d = parsedDraft.data;
  if (prev && d.projectId !== prev.projectId) {
    throw new ChainError('project-mismatch', `draft is for project ${d.projectId}, the chain is ${prev.projectId}`);
  }
  const accountId = opts.accountId ?? prev?.accountId;
  if (accountId === undefined) throw new ChainError('invalid-draft', 'accountId is required for the first commit');
  const unhashed = {
    ...d,
    seq: prev ? prev.seq + 1 : 1,
    prevHash: prev ? prev.hash : GENESIS_PREV_HASH,
    serverTime,
    accountId,
    hash: GENESIS_PREV_HASH,
  };
  const parsed = CommitSchema.safeParse(unhashed);
  if (!parsed.success) {
    throw new ChainError('invalid-commit', 'the commit does not validate', zodIssues(parsed.error));
  }
  const commit = parsed.data;
  return { ...commit, hash: computeCommitHash(commit) } as Commit;
}

/** Problems {@link verifyChain} reports. */
export type ChainProblemCode =
  | 'empty'
  | 'invalid-commit'
  | 'hash-mismatch'
  | 'prev-hash-mismatch'
  | 'genesis-mismatch'
  | 'seq-gap'
  | 'seq-out-of-order'
  | 'duplicate-seq'
  | 'project-mismatch'
  | 'account-mismatch'
  | 'duplicate-commit-id'
  | 'head-mismatch';

/** One problem found by {@link verifyChain}. */
export interface ChainProblem {
  code: ChainProblemCode;
  /** Index in the given array. */
  index: number;
  /** The commit's own `seq` (when readable). */
  seq: number | null;
  message: string;
}

/** Result of {@link verifyChain}. */
export type ChainVerification =
  | { ok: true; headSeq: number; headHash: string; length: number }
  | { ok: false; problems: ChainProblem[] };

/**
 * Verifies a ledger: every commit validates against `CommitSchema` (including
 * actor permissions), its hash matches its content, `seq` runs 1, 2, 3… with no
 * gaps, reordering or duplicates, `prevHash` links to the previous hash (64 zeros
 * first), and all commits share one project and account. `expectedHead` (from a
 * witness or a trusted source) also catches a truncated ledger. Every problem is
 * reported, in order.
 */
export function verifyChain(
  commits: readonly unknown[],
  opts: { expectedHead?: { seq: number; hash: string } } = {},
): ChainVerification {
  const problems: ChainProblem[] = [];
  if (commits.length === 0) {
    return { ok: false, problems: [{ code: 'empty', index: -1, seq: null, message: 'the ledger has no commits' }] };
  }
  const seen = new Map<number, number>();
  const ids = new Map<string, number>();
  let projectId: string | null = null;
  let accountId: string | null = null;
  let prevHash: string | null = null;
  let prevSeq = 0;
  commits.forEach((raw, index) => {
    const c = raw as Partial<Commit>;
    const seq = typeof c?.seq === 'number' ? c.seq : null;
    const add = (code: ChainProblemCode, message: string): void => {
      problems.push({ code, index, seq, message: `commit #${index} (seq ${seq ?? '?'}): ${message}` });
    };
    const parsed = CommitSchema.safeParse(raw);
    if (!parsed.success) add('invalid-commit', zodIssues(parsed.error).join('; '));
    if (typeof c?.hash === 'string') {
      let actual: string | null;
      try {
        actual = computeCommitHash(raw as Commit);
      } catch {
        actual = null;
      }
      if (actual !== c.hash) add('hash-mismatch', `hash ${c.hash} does not match its content (${actual ?? 'unhashable'})`);
    }
    if (seq !== null) {
      // prevSeq is the highest seq seen so far.
      if (seen.has(seq)) add('duplicate-seq', `seq ${seq} also appears at #${seen.get(seq)}`);
      else if (seq < prevSeq) add('seq-out-of-order', `seq ${seq} comes after seq ${prevSeq}`);
      else if (seq !== prevSeq + 1) {
        add('seq-gap', `expected seq ${prevSeq + 1}, got ${seq} (${seq - prevSeq - 1} missing)`);
      }
      if (!seen.has(seq)) seen.set(seq, index);
      prevSeq = Math.max(prevSeq, seq);
    } else {
      prevSeq += 1;
    }
    if (index === 0) {
      if (c?.prevHash !== GENESIS_PREV_HASH) add('genesis-mismatch', 'the first commit must have prevHash of 64 zeros');
    } else if (c?.prevHash !== prevHash) {
      add('prev-hash-mismatch', `prevHash ${c?.prevHash} is not the previous commit's hash ${prevHash}`);
    }
    if (typeof c?.commitId === 'string') {
      if (ids.has(c.commitId)) add('duplicate-commit-id', `commitId ${c.commitId} also used at #${ids.get(c.commitId)}`);
      ids.set(c.commitId, index);
    }
    if (projectId === null) projectId = c?.projectId ?? null;
    else if (c?.projectId !== projectId) add('project-mismatch', `project ${c?.projectId} is not ${projectId}`);
    if (accountId === null) accountId = c?.accountId ?? null;
    else if (c?.accountId !== accountId) add('account-mismatch', `account ${c?.accountId} is not ${accountId}`);
    prevHash = typeof c?.hash === 'string' ? c.hash : null;
  });
  const last = commits[commits.length - 1] as Partial<Commit>;
  if (opts.expectedHead) {
    if (last?.seq !== opts.expectedHead.seq || last?.hash !== opts.expectedHead.hash) {
      problems.push({
        code: 'head-mismatch',
        index: commits.length - 1,
        seq: typeof last?.seq === 'number' ? last.seq : null,
        message: `the ledger ends at seq ${last?.seq} (${last?.hash}), expected seq ${opts.expectedHead.seq} (${opts.expectedHead.hash})`,
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, headSeq: last.seq as number, headHash: last.hash as string, length: commits.length };
}

// ---------------------------------------------------------------------------
// Witnesses
// ---------------------------------------------------------------------------

/** Signs a commit's witness with a {@link WitnessSigner} (P1363 signature, base64). */
export async function signWitness(
  signer: WitnessSigner,
  commit: Pick<Commit, 'projectId' | 'seq' | 'hash' | 'serverTime'>,
): Promise<Witness> {
  const subject = { projectId: commit.projectId, seq: commit.seq, hash: commit.hash, serverTime: commit.serverTime };
  const sig = await signer.sign(witnessMessage(subject));
  return { ...subject, signature: base64Encode(sig), keyId: signer.keyId };
}

/** Problems found by {@link verifyWitnesses}. */
export type WitnessProblemCode =
  | 'missing-witness'
  | 'extra-witness'
  | 'subject-mismatch'
  | 'key-mismatch'
  | 'bad-signature'
  | 'embedded-mismatch'
  | 'embedded-bad-signature';

/** One witness problem. */
export interface WitnessProblem {
  code: WitnessProblemCode;
  seq: number;
  message: string;
}

/** Result of {@link verifyWitnesses}. */
export interface WitnessVerification {
  ok: boolean;
  keyId: string;
  /** Seqs with a valid witness. */
  witnessed: number[];
  problems: WitnessProblem[];
}

/**
 * Verifies witnesses against a ledger: one witness per commit whose
 * `{projectId, seq, hash, serverTime}` equal the commit's, whose `keyId` is the
 * key's, and whose signature verifies. With `requireAll: false` (offline gaps the
 * server has not witnessed yet) a missing witness is not a problem. Also checks
 * the witnesses embedded in `ChainHeadWitnessed` commits.
 */
export async function verifyWitnesses(
  commits: readonly Commit[],
  witnesses: readonly Witness[],
  publicKeyPem: string,
  opts: { requireAll?: boolean } = {},
): Promise<WitnessVerification> {
  const requireAll = opts.requireAll ?? true;
  const keyId = keyIdFromPublicKeyPem(publicKeyPem);
  const key = await importWitnessPublicKey(publicKeyPem);
  const problems: WitnessProblem[] = [];
  const witnessed: number[] = [];
  const bySeq = new Map<number, Witness>();
  for (const w of witnesses) {
    if (bySeq.has(w.seq) || w.seq < 1 || w.seq > commits.length) {
      problems.push({ code: 'extra-witness', seq: w.seq, message: `unexpected witness for seq ${w.seq}` });
      continue;
    }
    bySeq.set(w.seq, w);
  }
  for (const c of commits) {
    const w = bySeq.get(c.seq);
    if (!w) {
      if (requireAll) problems.push({ code: 'missing-witness', seq: c.seq, message: `seq ${c.seq} has no witness` });
      continue;
    }
    if (w.projectId !== c.projectId || w.hash !== c.hash || w.serverTime !== c.serverTime) {
      problems.push({ code: 'subject-mismatch', seq: c.seq, message: `the witness of seq ${c.seq} signs different fields` });
      continue;
    }
    if (w.keyId !== keyId) {
      problems.push({ code: 'key-mismatch', seq: c.seq, message: `the witness of seq ${c.seq} names key ${w.keyId}` });
      continue;
    }
    if (!(await verifyWitnessSignature(w, key))) {
      problems.push({ code: 'bad-signature', seq: c.seq, message: `the witness signature of seq ${c.seq} does not verify` });
      continue;
    }
    witnessed.push(c.seq);
  }
  for (const c of commits) {
    if (c.type !== 'ChainHeadWitnessed') continue;
    const p = c.payload;
    const target = commits[p.witnessedSeq - 1];
    if (!target || target.hash !== p.witnessedHash || target.serverTime !== p.serverTime || p.witnessedSeq >= c.seq) {
      problems.push({ code: 'embedded-mismatch', seq: c.seq, message: `ChainHeadWitnessed at seq ${c.seq} does not match seq ${p.witnessedSeq}` });
      continue;
    }
    const w: Witness = {
      projectId: c.projectId,
      seq: p.witnessedSeq,
      hash: p.witnessedHash,
      serverTime: p.serverTime,
      signature: p.signature,
      keyId: p.keyId,
    };
    if (p.keyId !== keyId || !(await verifyWitnessSignature(w, key))) {
      problems.push({ code: 'embedded-bad-signature', seq: c.seq, message: `the embedded witness at seq ${c.seq} does not verify` });
    }
  }
  return { ok: problems.length === 0, keyId, witnessed, problems };
}

/**
 * A {@link WitnessSigner} over a WebCrypto ECDSA P-256 private key (tests, local
 * development, fixtures). Production signs with KMS behind the same interface.
 */
export async function webCryptoSigner(privateKey: CryptoKey, publicKeyPem: string): Promise<WitnessSigner> {
  return {
    keyId: keyIdFromPublicKeyPem(publicKeyPem),
    publicKeyPem,
    async sign(message: Uint8Array): Promise<Uint8Array> {
      const sig = await globalThis.crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        message as Uint8Array<ArrayBuffer>,
      );
      return new Uint8Array(sig);
    },
  };
}
