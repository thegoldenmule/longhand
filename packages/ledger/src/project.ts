/**
 * Read accessors over the opaque fold state, including the public
 * `ProjectState` projection (memoized per state, document and node).
 */
import type {
  DocumentState,
  PMNode,
  PMNodeJSON,
  ProjectState,
  ProvenanceRun,
} from '@longhand/schema';
import type { FoldIssue } from './issues';
import { toPublicRuns } from './prov';
import { pvecGet, pvecToArray } from './pvec';
import { internal, type CommitInfo, type DocInternal, type LedgerState } from './state';

const jsonCache = new WeakMap<PMNode, PMNodeJSON>();
const docCache = new WeakMap<DocInternal, DocumentState>();
const stateCache = new WeakMap<object, ProjectState>();

/** `node.toJSON()`, memoized per node. */
export function nodeJSON(node: PMNode): PMNodeJSON {
  let j = jsonCache.get(node);
  if (!j) {
    j = node.toJSON() as PMNodeJSON;
    jsonCache.set(node, j);
  }
  return j;
}

function publicDoc(d: DocInternal): DocumentState {
  let out = docCache.get(d);
  if (!out) {
    out = {
      id: d.id,
      kind: d.kind,
      area: d.area,
      title: d.title,
      parentId: d.parentId,
      synopsis: d.synopsis,
      content: nodeJSON(d.node),
      version: d.version,
      provenance: toPublicRuns(d.runs),
      archived: d.archived,
      imported: d.imported,
      createdSeq: d.createdSeq,
      contentSeq: d.contentSeq,
      updatedSeq: d.updatedSeq,
    };
    docCache.set(d, out);
  }
  return out;
}

/**
 * The public `ProjectState` (see `@longhand/schema` `state.ts`). Memoized: the same
 * state returns the same object, and unchanged documents keep their objects across
 * states. Treat it as read-only.
 */
export function projectState(state: LedgerState): ProjectState {
  const s = internal(state);
  const hit = stateCache.get(s);
  if (hit) return hit;
  const documents: Record<string, DocumentState> = {};
  for (const id of Object.keys(s.docs)) documents[id] = publicDoc(s.docs[id] as DocInternal);
  const out: ProjectState = {
    projectId: s.projectId,
    accountId: s.accountId,
    headSeq: s.headSeq,
    headHash: s.headHash,
    settings: s.settings,
    createdSeq: s.createdSeq,
    binder: s.binder,
    folders: s.folders as ProjectState['folders'],
    documents,
    annotations: s.ann,
    sources: s.sources as ProjectState['sources'],
    clippings: s.clippings as ProjectState['clippings'],
    pastes: s.pastes as ProjectState['pastes'],
    writingSessions: s.sessions as ProjectState['writingSessions'],
  };
  stateCache.set(s, out);
  return out;
}

/** The ProseMirror node of a document (avoids re-parsing `content`), or undefined. */
export function documentNode(state: LedgerState, documentId: string): PMNode | undefined {
  return internal(state).docs[documentId]?.node;
}

/** A document's current version, or undefined. */
export function documentVersion(state: LedgerState, documentId: string): number | undefined {
  return internal(state).docs[documentId]?.version;
}

/** A document's canonical provenance runs, or undefined. */
export function documentProvenance(
  state: LedgerState,
  documentId: string,
): ProvenanceRun[] | undefined {
  const d = internal(state).docs[documentId];
  return d ? publicDoc(d).provenance : undefined;
}

/** Every issue the fold recorded (a valid ledger has none). */
export function foldIssues(state: LedgerState): FoldIssue[] {
  return pvecToArray(internal(state).issues);
}

/** Seq of the last folded commit. */
export function headSeq(state: LedgerState): number {
  return internal(state).headSeq;
}

/** Hash of the last folded commit (64 zeros before any). */
export function headHash(state: LedgerState): string {
  return internal(state).headHash;
}

/** Envelope facts of a folded commit (for the span inspector and reports), or undefined. */
export function commitInfo(state: LedgerState, seq: number): Readonly<CommitInfo> | undefined {
  return pvecGet(internal(state).commits, seq - 1);
}
