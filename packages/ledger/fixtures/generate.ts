/**
 * Computes golden fixture contents (everything except witness signatures, which
 * are randomized ECDSA and are re-signed only when a commit changes).
 */
import { inlineTextBetween, type Commit, type ProjectState, type Witness } from '@longhand/schema';
import { verifyChain, verifyWitnesses, type ChainProblem, type WitnessProblem } from '../src/chain';
import { foldCommits } from '../src/fold';
import type { FoldIssue } from '../src/issues';
import { documentNode, foldIssues, projectState } from '../src/project';
import {
  attributeWords,
  charactersByClass,
  projectCharactersByClass,
  projectWordsByClass,
  wordsByClass,
  type ClassCounts,
  type WordAttribution,
} from '../src/words';
import { FIXTURE_DEFINITIONS, TAMPER_DEFINITIONS } from './definitions';

/** Expected outputs for one document. */
export interface ExpectedDocument {
  /** Inline text, blocks separated by `\n`. */
  text: string;
  words: WordAttribution[];
  wordsByClass: ClassCounts;
  charactersByClass: ClassCounts;
}

/** Expected fold outputs for a ledger. */
export interface ExpectedOutputs {
  headSeq: number;
  headHash: string;
  /** The full public ProjectState (document JSON, provenance runs, annotations…). */
  state: ProjectState;
  documents: Record<string, ExpectedDocument>;
  /** Non-archived manuscript documents. */
  projectWords: ClassCounts;
  projectCharacters: ClassCounts;
  issues: FoldIssue[];
}

/** A golden fixture file. */
export interface FixtureFile {
  name: string;
  description: string;
  covers: string[];
  commits: Commit[];
  witnesses: Witness[];
  publicKeyPem: string;
  keyId: string;
  expected: ExpectedOutputs;
}

/** A tampered fixture file. */
export interface TamperedFixtureFile {
  name: string;
  description: string;
  base: string;
  /** Deliberately invalid: do not parse with CommitSchema before verifying. */
  commits: unknown[];
  witnesses: Witness[];
  publicKeyPem: string;
  keyId: string;
  /** The true head of the untampered ledger (as a witness or trusted source would give it). */
  trueHead: { seq: number; hash: string };
  expected: {
    chain: { ok: boolean; problems: Array<Pick<ChainProblem, 'code' | 'index' | 'seq'>> };
    /** With `expectedHead: trueHead`. */
    chainWithHead: { ok: boolean; problems: Array<Pick<ChainProblem, 'code' | 'index' | 'seq'>> };
    witnesses: { ok: boolean; problems: Array<Pick<WitnessProblem, 'code' | 'seq'>> } | null;
  };
}

/** JSON round-trip, so in-memory values compare equal to parsed files. */
export function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Fold outputs for a ledger. */
export function expectedOutputs(commits: readonly Commit[]): ExpectedOutputs {
  const state = foldCommits(commits);
  const ps = projectState(state);
  const documents: Record<string, ExpectedDocument> = {};
  for (const id of Object.keys(ps.documents).sort()) {
    const d = ps.documents[id]!;
    const node = documentNode(state, id)!;
    documents[id] = {
      text: inlineTextBetween(node, 0, node.content.size, '\n'),
      words: attributeWords(node, d.provenance),
      wordsByClass: wordsByClass(node, d.provenance),
      charactersByClass: charactersByClass(node, d.provenance),
    };
  }
  return plain({
    headSeq: ps.headSeq,
    headHash: ps.headHash,
    state: ps,
    documents,
    projectWords: projectWordsByClass(ps),
    projectCharacters: projectCharactersByClass(ps),
    issues: foldIssues(state),
  });
}

/** Builds a fixture's commits and expected outputs (no witnesses). */
export function buildFixture(name: string): Omit<FixtureFile, 'witnesses' | 'publicKeyPem' | 'keyId'> {
  const def = FIXTURE_DEFINITIONS[name];
  if (!def) throw new Error(`no fixture ${name}`);
  const b = def.build();
  const commits = plain(b.commits);
  return { name, description: def.description, covers: def.covers, commits, expected: expectedOutputs(commits) };
}

/** Builds a tampered fixture from its base fixture file. */
export async function buildTampered(name: string, base: FixtureFile): Promise<TamperedFixtureFile> {
  const def = TAMPER_DEFINITIONS[name];
  if (!def) throw new Error(`no tampered fixture ${name}`);
  const commits = def.apply(plain(base.commits) as unknown as Array<Record<string, unknown>>);
  const last = base.commits[base.commits.length - 1]!;
  const trueHead = { seq: last.seq, hash: last.hash };
  const pick = (r: ReturnType<typeof verifyChain>) => ({
    ok: r.ok,
    problems: r.ok ? [] : r.problems.map((p) => ({ code: p.code, index: p.index, seq: p.seq })),
  });
  let witnesses: TamperedFixtureFile['expected']['witnesses'] = null;
  const chain = verifyChain(commits);
  if (chain.ok) {
    const w = await verifyWitnesses(commits as unknown as Commit[], base.witnesses, base.publicKeyPem);
    witnesses = { ok: w.ok, problems: w.problems.map((p) => ({ code: p.code, seq: p.seq })) };
  }
  return {
    name,
    description: def.description,
    base: def.base,
    commits,
    witnesses: base.witnesses,
    publicKeyPem: base.publicKeyPem,
    keyId: base.keyId,
    trueHead,
    expected: { chain: pick(chain), chainWithHead: pick(verifyChain(commits, { expectedHead: trueHead })), witnesses },
  };
}
