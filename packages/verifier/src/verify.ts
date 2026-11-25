/**
 * `verifyBundle`: checks a Longhand verification bundle from scratch.
 *
 * A bundle carries a project's whole ledger, the server's witness signatures,
 * the witness public key and an authorship report. Verifying it means:
 *
 * 1. **Bundle format.** The JSON matches the bundle schema.
 * 2. **Witness key.** The public key parses as an ECDSA P-256 key and the
 *    bundle's `keyId` is its fingerprint (SHA-256 of the SPKI DER). If you know
 *    the key Longhand publishes, pass its id as `expectedKeyId`.
 * 3. **Hash chain.** Every commit hashes to its `hash`, links to the previous
 *    one, and the chain ends at the head named by the last witness (so a
 *    truncated ledger fails).
 * 4. **Witnesses.** Every commit has a witness signed by that key over
 *    `(projectId, seq, hash, serverTime)`, and every witness embedded in the
 *    chain verifies too.
 * 5. **Re-fold.** The ledger folds into documents and provenance without errors
 *    or issues (for example, a server claiming an outcome the fold disagrees with).
 * 6. **Report.** The report recomputed from the ledger is byte-for-byte the
 *    bundled report (canonical JSON). Any difference fails, with the paths that
 *    differ.
 *
 * Isomorphic: it uses only WebCrypto and plain JavaScript, so the same code runs
 * in Node (the CLI) and in browsers (the web page). Nothing is uploaded anywhere.
 */
import { foldCommits, foldIssues, verifyChain, verifyWitnesses } from '@longhand/ledger';
import { computeReport, type Report } from '@longhand/report';
import {
  VerificationBundleSchema,
  canonicalize,
  importWitnessPublicKey,
  keyIdFromPublicKeyPem,
  type Commit,
  type ReportScope,
  type Witness,
} from '@longhand/schema';
import { describeDifference, diffJson } from './diff';

/** The checks, in the order they run. */
export type CheckId = 'schema' | 'key' | 'chain' | 'witnesses' | 'fold' | 'report';

/** The outcome of one check. `skip` means it could not run because an earlier check failed. */
export type CheckStatus = 'pass' | 'fail' | 'skip';

/** One check's outcome. */
export interface Check {
  id: CheckId;
  /** Short name, e.g. "Hash chain". */
  title: string;
  status: CheckStatus;
  /** One sentence saying what was found. */
  summary: string;
  /** Specific problems (or notes), one per line. */
  details: string[];
}

/** What {@link verifyBundle} returns. */
export interface VerificationResult {
  /** True only when every check passed. */
  ok: boolean;
  checks: Check[];
  /** The report recomputed from the ledger, when the ledger folded. */
  report: Report | null;
  /** Facts read from the bundle (null when it is not a bundle at all). */
  bundle: {
    projectId: string | null;
    commits: number;
    witnesses: number;
    keyId: string | null;
    createdAt: string | null;
  } | null;
}

/** Options for {@link verifyBundle}. */
export interface VerifyOptions {
  /** The witness key id you trust (e.g. the one Longhand publishes). Without it, the bundle's own key is used. */
  expectedKeyId?: string;
}

const TITLES: Record<CheckId, string> = {
  schema: 'Bundle format',
  key: 'Witness key',
  chain: 'Hash chain',
  witnesses: 'Witnesses',
  fold: 'Re-fold',
  report: 'Report',
};

const MAX_DETAILS = 20;

function check(id: CheckId, status: CheckStatus, summary: string, details: string[] = []): Check {
  const shown = details.slice(0, MAX_DETAILS);
  if (details.length > MAX_DETAILS) shown.push(`… and ${details.length - MAX_DETAILS} more`);
  return { id, title: TITLES[id], status, summary, details: shown };
}

function skipped(id: CheckId, because: string): Check {
  return check(id, 'skip', `Not checked: ${because}.`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function short(hash: unknown): string {
  return typeof hash === 'string' ? `${hash.slice(0, 12)}…` : String(hash);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 1. Does the JSON have the shape of a bundle? */
function checkSchema(raw: Record<string, unknown>): Check {
  const parsed = VerificationBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map(
      (i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`,
    );
    return check(
      'schema',
      'fail',
      'The bundle does not match the Longhand bundle format.',
      details,
    );
  }
  const first = parsed.data.commits[0]!;
  const others = parsed.data.commits.filter((c) => c.projectId !== parsed.data.projectId);
  if (first.projectId !== parsed.data.projectId || others.length > 0) {
    return check('schema', 'fail', 'The bundle names a different project than its ledger.', [
      `bundle projectId ${parsed.data.projectId}, ledger projectId ${first.projectId}`,
    ]);
  }
  return check(
    'schema',
    'pass',
    `The bundle matches the Longhand bundle format (version ${parsed.data.version}).`,
  );
}

/** 2. Is the public key a P-256 key whose fingerprint is the bundle's key id? */
async function checkKey(
  raw: Record<string, unknown>,
  opts: VerifyOptions,
): Promise<{ check: Check; usable: boolean }> {
  const pem = raw.publicKeyPem;
  if (typeof pem !== 'string')
    return { check: check('key', 'fail', 'The bundle has no public key.'), usable: false };
  let keyId: string;
  try {
    keyId = keyIdFromPublicKeyPem(pem);
    await importWitnessPublicKey(pem);
  } catch (e) {
    return {
      check: check('key', 'fail', 'The public key is not a valid ECDSA P-256 key.', [message(e)]),
      usable: false,
    };
  }
  const details: string[] = [];
  if (raw.keyId !== keyId)
    details.push(`the bundle says keyId ${String(raw.keyId)}, but the public key's id is ${keyId}`);
  if (opts.expectedKeyId !== undefined && opts.expectedKeyId.toLowerCase() !== keyId)
    details.push(`you expected key ${opts.expectedKeyId}, but the bundle is signed with ${keyId}`);
  if (details.length > 0)
    return {
      check: check('key', 'fail', 'The witness key is not the one claimed.', details),
      usable: true,
    };
  return {
    check: check(
      'key',
      'pass',
      opts.expectedKeyId !== undefined
        ? `The bundle is signed with the key you expected (${short(keyId)}).`
        : `Key ${short(keyId)} matches the bundle's public key.`,
      opts.expectedKeyId !== undefined
        ? []
        : [
            `This checks the bundle against its own key. To be sure the server signed it, compare key id ${keyId} with the one Longhand publishes.`,
          ],
    ),
    usable: true,
  };
}

/** The witness with the highest seq: the head the server last vouched for. */
function lastWitness(witnesses: unknown): { seq: number; hash: string } | null {
  if (!Array.isArray(witnesses)) return null;
  let best: { seq: number; hash: string } | null = null;
  for (const w of witnesses) {
    if (isRecord(w) && typeof w.seq === 'number' && typeof w.hash === 'string') {
      if (!best || w.seq > best.seq) best = { seq: w.seq, hash: w.hash };
    }
  }
  return best;
}

/** 3. Is the hash chain intact up to the last witnessed head? */
function checkChain(raw: Record<string, unknown>): Check {
  if (!Array.isArray(raw.commits)) return check('chain', 'fail', 'The bundle has no ledger.');
  const head = lastWitness(raw.witnesses);
  const v = verifyChain(raw.commits, head ? { expectedHead: head } : {});
  if (!v.ok) {
    return check(
      'chain',
      'fail',
      'The hash chain is broken: the ledger was changed after it was written.',
      v.problems.map((p) => `${p.code}: ${p.message}`),
    );
  }
  return check(
    'chain',
    'pass',
    head
      ? `${v.length} commits link from the start to the last witnessed head, seq ${v.headSeq} (${short(v.headHash)}).`
      : `${v.length} commits link from the start to seq ${v.headSeq}; there is no witness to confirm the head.`,
  );
}

/** 4. Does every commit carry a valid server signature? */
async function checkWitnesses(raw: Record<string, unknown>): Promise<Check> {
  if (!Array.isArray(raw.commits) || !Array.isArray(raw.witnesses))
    return check('witnesses', 'fail', 'The bundle has no ledger or no witnesses.');
  try {
    const v = await verifyWitnesses(
      raw.commits as Commit[],
      raw.witnesses as Witness[],
      raw.publicKeyPem as string,
    );
    if (!v.ok) {
      return check(
        'witnesses',
        'fail',
        `${v.witnessed.length} of ${raw.commits.length} commits have a valid witness; the record is not fully vouched for.`,
        v.problems.map((p) => `${p.code}: ${p.message}`),
      );
    }
    return check(
      'witnesses',
      'pass',
      `All ${v.witnessed.length} commits carry a valid server signature.`,
    );
  } catch (e) {
    return check('witnesses', 'fail', 'The witnesses could not be checked.', [message(e)]);
  }
}

/** 5. Does the ledger re-fold cleanly? */
function checkFold(commits: Commit[]): Check {
  try {
    const issues = foldIssues(foldCommits(commits));
    if (issues.length > 0) {
      return check(
        'fold',
        'fail',
        'The ledger folds, but with problems a valid ledger never has.',
        issues.map((i) => `seq ${i.seq} ${i.code}: ${i.message}`),
      );
    }
    return check(
      'fold',
      'pass',
      'The ledger re-folds into its documents and provenance with no issues.',
    );
  } catch (e) {
    return check('fold', 'fail', 'The ledger does not fold.', [message(e)]);
  }
}

/** 6. Is the bundled report exactly the recomputed one? */
function checkReport(
  raw: Record<string, unknown>,
  commits: Commit[],
): { check: Check; report: Report | null } {
  const bundled = raw.report as { scope: ReportScope };
  let report: Report;
  try {
    report = computeReport(commits, {
      scope: bundled.scope,
      witnesses: raw.witnesses as Witness[],
    });
  } catch (e) {
    return {
      check: check('report', 'fail', 'The report could not be recomputed.', [message(e)]),
      report: null,
    };
  }
  if (canonicalize(bundled) === canonicalize(report)) {
    return {
      check: check('report', 'pass', 'The recomputed report matches the bundled one exactly.'),
      report,
    };
  }
  // Round-trip through JSON so the diff compares what canonical JSON compares.
  const diffs = diffJson(JSON.parse(canonicalize(bundled)), JSON.parse(canonicalize(report)));
  return {
    check: check(
      'report',
      'fail',
      'The bundled report differs from the one recomputed from the ledger.',
      diffs.map(describeDifference),
    ),
    report,
  };
}

/**
 * Verifies a bundle (the parsed JSON). Never throws: anything wrong is a failed
 * check. Hashes are computed over the commits exactly as given.
 */
export async function verifyBundle(
  bundle: unknown,
  opts: VerifyOptions = {},
): Promise<VerificationResult> {
  if (!isRecord(bundle)) {
    return {
      ok: false,
      checks: [
        check('schema', 'fail', 'This is not a Longhand bundle: the file is not a JSON object.'),
        skipped('key', 'not a bundle'),
        skipped('chain', 'not a bundle'),
        skipped('witnesses', 'not a bundle'),
        skipped('fold', 'not a bundle'),
        skipped('report', 'not a bundle'),
      ],
      report: null,
      bundle: null,
    };
  }
  const checks: Check[] = [];
  const schema = checkSchema(bundle);
  checks.push(schema);
  const key = await checkKey(bundle, opts);
  checks.push(key.check);
  const chain = checkChain(bundle);
  checks.push(chain);
  checks.push(
    key.usable ? await checkWitnesses(bundle) : skipped('witnesses', 'the public key is unusable'),
  );

  // Only a well-formed, intact ledger is re-folded: anything else is untrusted input.
  let report: Report | null = null;
  if (schema.status !== 'pass' || chain.status !== 'pass') {
    const because =
      schema.status !== 'pass' ? 'the bundle format is invalid' : 'the hash chain is broken';
    checks.push(skipped('fold', because), skipped('report', because));
  } else {
    const commits = bundle.commits as Commit[];
    const fold = checkFold(commits);
    checks.push(fold);
    if (fold.status !== 'pass') checks.push(skipped('report', 'the ledger does not re-fold'));
    else {
      const r = checkReport(bundle, commits);
      checks.push(r.check);
      report = r.report;
    }
  }

  const commits = Array.isArray(bundle.commits) ? bundle.commits : [];
  return {
    ok: checks.every((c) => c.status === 'pass'),
    checks,
    report,
    bundle: {
      projectId: typeof bundle.projectId === 'string' ? bundle.projectId : null,
      commits: commits.length,
      witnesses: Array.isArray(bundle.witnesses) ? bundle.witnesses.length : 0,
      keyId: typeof bundle.keyId === 'string' ? bundle.keyId : null,
      createdAt: typeof bundle.createdAt === 'string' ? bundle.createdAt : null,
    },
  };
}
