/**
 * Per-document step history, kept next to the fold.
 *
 * The fold exposes only the current document. The service also needs:
 * - every step-bearing commit as an editor `RemoteUpdate` (steps included, the
 *   fold-derived ones for `ProposalAccepted`) for `fetchSince` and `subscribe`;
 * - the document at an older version and the mapping from it to the current one,
 *   to resolve an agent's anchors at `readVersion` and map them to `version`.
 *
 * ProseMirror nodes share structure, so keeping the node after every commit costs
 * little more than the steps themselves.
 */
import { schema, type PMNodeJSON, type StepJSON } from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import { Mapping, Step, type StepMap } from 'prosemirror-transform';

/** A step-bearing commit applied to a document (the editor's `RemoteUpdate`). */
export interface RemoteUpdate {
  documentId: string;
  commitId: string;
  seq: number;
  type: 'TextEdited' | 'ProposalAccepted';
  baseVersion: number;
  version: number;
  steps: StepJSON[];
}

interface Entry {
  update: RemoteUpdate;
  maps: StepMap[];
  docAfter: PMNode;
}

/** One document's history. */
export class DocHistory {
  private readonly entries: Entry[] = [];

  constructor(
    readonly documentId: string,
    /** Version the history starts at (the document's version when it was created or imported). */
    readonly initialVersion: number,
    readonly initialDoc: PMNode,
  ) {}

  get version(): number {
    return this.entries.at(-1)?.update.version ?? this.initialVersion;
  }

  get doc(): PMNode {
    return this.entries.at(-1)?.docAfter ?? this.initialDoc;
  }

  get updates(): readonly RemoteUpdate[] {
    return this.entries.map((e) => e.update);
  }

  /** Records a step-bearing commit. */
  push(update: RemoteUpdate, steps: readonly Step[], docAfter: PMNode): void {
    this.entries.push({ update, maps: steps.map((s) => s.getMap()), docAfter });
  }

  /** The update a commit produced, if it is step-bearing for this document. */
  byCommitId(commitId: string): RemoteUpdate | undefined {
    return this.entries.find((e) => e.update.commitId === commitId)?.update;
  }

  /** The document at a commit-boundary version, or null if the history has no such version. */
  docAt(version: number): PMNode | null {
    if (version === this.initialVersion) return this.initialDoc;
    const e = this.find(version);
    return e ? e.docAfter : null;
  }

  private find(version: number): Entry | undefined {
    // Versions increase; binary search on `update.version`.
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = (this.entries[mid] as Entry).update.version;
      if (v === version) {
        // Zero-step commits share a version; take the last one.
        let i = mid;
        while (
          i + 1 < this.entries.length &&
          (this.entries[i + 1] as Entry).update.version === version
        )
          i++;
        return this.entries[i];
      }
      if (v < version) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  /** Step maps from `version` to the current version, or null if `version` is unknown. */
  mapsSince(version: number): StepMap[] | null {
    if (version > this.version) return null;
    if (version !== this.initialVersion && !this.find(version)) return null;
    const out: StepMap[] = [];
    for (const e of this.entries) if (e.update.baseVersion >= version) out.push(...e.maps);
    return out;
  }

  /** A `Mapping` from `version` to the current version. */
  mappingFrom(version: number): Mapping | null {
    const maps = this.mapsSince(version);
    return maps ? new Mapping(maps) : null;
  }

  /** Step-bearing commits with `baseVersion >= version`, or null when they cannot be given. */
  since(version: number): RemoteUpdate[] | null {
    if (version > this.version || version < this.initialVersion) return null;
    if (version !== this.initialVersion && !this.find(version)) return null;
    return this.entries.filter((e) => e.update.baseVersion >= version).map((e) => e.update);
  }
}

/** Minimal envelope facts this module needs from a commit. */
interface CommitLike {
  commitId: string;
  seq: number;
  type: string;
  payload: unknown;
}

/** Histories of every document in a project. */
export class ProjectHistory {
  readonly docs = new Map<string, DocHistory>();

  get(documentId: string): DocHistory | undefined {
    return this.docs.get(documentId);
  }

  /**
   * Observes one folded commit. `prevDoc`/`nextDoc` give the fold's document
   * before and after; `derived` are the steps the fold applied.
   */
  observe(
    commit: CommitLike,
    /** The fold's derived steps for this commit (`applyCommitWithSteps` / `validateDraft`), by document. */
    derived: Readonly<Record<string, readonly StepJSON[]>>,
    lookup: {
      prevDoc(documentId: string): PMNode | undefined;
      nextDoc(documentId: string): PMNode | undefined;
      prevVersion(documentId: string): number | undefined;
      nextVersion(documentId: string): number | undefined;
    },
  ): RemoteUpdate | null {
    const payload = commit.payload as { documentId?: string };
    if (commit.type === 'DocumentCreated' || commit.type === 'DocumentImported') {
      const id = payload.documentId as string;
      const node = lookup.nextDoc(id);
      const v = lookup.nextVersion(id);
      if (node && v !== undefined) this.docs.set(id, new DocHistory(id, v, node));
      return null;
    }
    if (commit.type !== 'TextEdited' && commit.type !== 'ProposalAccepted') return null;
    const id = payload.documentId as string;
    const before = lookup.prevDoc(id);
    const after = lookup.nextDoc(id);
    const baseVersion = lookup.prevVersion(id);
    const version = lookup.nextVersion(id);
    if (!before || !after || baseVersion === undefined || version === undefined) return null;
    let h = this.docs.get(id);
    if (!h) {
      h = new DocHistory(id, baseVersion, before);
      this.docs.set(id, h);
    }
    // TextEdited: the payload's own steps; ProposalAccepted: the steps the fold derived.
    const json = derived[id] ?? [];
    if (json.length !== version - baseVersion) {
      throw new Error(
        `seq ${commit.seq}: ${json.length} derived step(s) for ${id}, but the version moved by ${version - baseVersion}`,
      );
    }
    const steps = json.map((j) => Step.fromJSON(schema, j));
    const update: RemoteUpdate = {
      documentId: id,
      commitId: commit.commitId,
      seq: commit.seq,
      type: commit.type,
      baseVersion,
      version,
      steps: [...json],
    };
    h.push(update, steps, after);
    return update;
  }
}

/** Plain JSON of a node. */
export function nodeToJSON(node: PMNode): PMNodeJSON {
  return node.toJSON() as PMNodeJSON;
}
