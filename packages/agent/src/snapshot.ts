/**
 * The session snapshot: the serializable slice of a `ProjectState` that one agent
 * session reads and validates against. The runner builds it, writes it to a
 * private temp file, and the MCP tool server (a child of the `claude` CLI) loads
 * it. Every anchor is resolved against these document versions (`readVersion`).
 */
import {
  docFromJSON,
  segmentDoc,
  type AgentSessionKind,
  type BinderArea,
  type BinderRef,
  type CslItem,
  type DocumentKind,
  type FeedbackScope,
  type Intensity,
  type PMNode,
  type PMNodeJSON,
  type ProjectSettings,
  type ProjectState,
  type Segmentation,
  type SessionCounts,
} from '@longhand/schema';

/** Snapshot format version. */
export const SNAPSHOT_VERSION = 1;

/** One document as the session sees it. */
export interface SnapshotDocument {
  id: string;
  kind: DocumentKind;
  area: BinderArea;
  title: string;
  synopsis: string;
  content: PMNodeJSON;
  version: number;
}

/** One library source. */
export interface SnapshotSource {
  id: string;
  csl: CslItem;
}

/** One binder outline entry, in binder order (depth-first). */
export interface OutlineEntry {
  kind: 'folder' | 'document';
  id: string;
  area: BinderArea;
  title: string;
  depth: number;
  /** Documents only. */
  synopsis?: string;
}

/**
 * Which text annotation tools may target.
 * - `selection`: one document, overlapping `[from, to]` (positions at that document's snapshot version).
 * - `document`: one document.
 * - `project`: every manuscript document in the snapshot.
 * - `none`: no annotations (discuss sessions).
 */
export type SnapshotScope =
  | { kind: 'selection'; documentId: string; from: number; to: number }
  | { kind: 'document'; documentId: string }
  | { kind: 'project' }
  | { kind: 'none' };

/** Everything the tool server needs, as JSON. */
export interface SessionSnapshot {
  snapshotVersion: typeof SNAPSHOT_VERSION;
  sessionKind: AgentSessionKind;
  projectId: string;
  feedbackSessionId: string;
  model: string;
  intensity: Intensity;
  settings: ProjectSettings;
  outline: OutlineEntry[];
  /** Non-archived documents (manuscript and notes), keyed by id. */
  documents: Record<string, SnapshotDocument>;
  /** Non-archived library sources, keyed by id. */
  sources: Record<string, SnapshotSource>;
  scope: SnapshotScope;
  /** Discuss sessions: the one thread the session may answer. */
  discussion: { threadId: string; targetId: string } | null;
  /** Counts already recorded for this session (normally zero). */
  counts: SessionCounts;
}

/** Binder outline of an area, depth-first, skipping archived nodes. */
export function binderOutline(state: ProjectState, area: BinderArea): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const visit = (refs: readonly BinderRef[], depth: number) => {
    for (const ref of refs) {
      if (ref.kind === 'folder') {
        const f = state.folders[ref.id];
        if (!f || f.archived) continue;
        out.push({ kind: 'folder', id: f.id, area, title: f.title, depth });
        visit(f.children, depth + 1);
      } else {
        const d = state.documents[ref.id];
        if (!d || d.archived) continue;
        out.push({
          kind: 'document',
          id: d.id,
          area,
          title: d.title,
          depth,
          synopsis: d.synopsis,
        });
      }
    }
  };
  visit(state.binder[area], 0);
  return out;
}

/** Manuscript document ids in binder order (non-archived). */
export function manuscriptOrder(state: ProjectState): string[] {
  return binderOutline(state, 'manuscript')
    .filter((e) => e.kind === 'document')
    .map((e) => e.id);
}

/** Inputs for {@link buildSnapshot}. */
export interface BuildSnapshotInput {
  state: ProjectState;
  sessionKind: AgentSessionKind;
  feedbackSessionId: string;
  model: string;
  intensity: Intensity;
  scope: SnapshotScope;
  discussion?: { threadId: string; targetId: string } | null;
  counts?: SessionCounts;
}

/** Builds the session snapshot from a folded project. */
export function buildSnapshot(input: BuildSnapshotInput): SessionSnapshot {
  const { state } = input;
  const documents: Record<string, SnapshotDocument> = {};
  for (const d of Object.values(state.documents)) {
    if (d.archived) continue;
    documents[d.id] = {
      id: d.id,
      kind: d.kind,
      area: d.area,
      title: d.title,
      synopsis: d.synopsis,
      content: d.content,
      version: d.version,
    };
  }
  const sources: Record<string, SnapshotSource> = {};
  for (const s of Object.values(state.sources)) {
    if (!s.archived) sources[s.id] = { id: s.id, csl: s.csl };
  }
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    sessionKind: input.sessionKind,
    projectId: state.projectId,
    feedbackSessionId: input.feedbackSessionId,
    model: input.model,
    intensity: input.intensity,
    settings: state.settings,
    outline: [...binderOutline(state, 'manuscript'), ...binderOutline(state, 'notes')],
    documents,
    sources,
    scope: input.scope,
    discussion: input.discussion ?? null,
    counts: input.counts ?? {
      items: 0,
      suggestions: 0,
      insertions: 0,
      proposals: 0,
      questions: 0,
      searches: 0,
    },
  };
}

/**
 * Resolves a feedback request's scope to a snapshot scope. Selection positions are
 * at `scope.version`; when the document has moved on, pass `selection` already
 * mapped to the current version (otherwise the range is clamped and a warning is
 * returned).
 */
export function resolveScope(
  state: ProjectState,
  scope: FeedbackScope,
  selection?: { from: number; to: number },
): { scope: SnapshotScope; warnings: string[] } {
  const warnings: string[] = [];
  if (scope.kind === 'project') return { scope: { kind: 'project' }, warnings };
  const doc = state.documents[scope.documentId];
  if (!doc) throw new ScopeError(`unknown document ${scope.documentId}`);
  if (doc.archived) throw new ScopeError(`document ${scope.documentId} is archived`);
  if (doc.area !== 'manuscript')
    throw new ScopeError(`document ${scope.documentId} is a note, not manuscript`);
  if (scope.kind === 'document')
    return { scope: { kind: 'document', documentId: doc.id }, warnings };
  let { from, to } = selection ?? scope;
  if (!selection && scope.version !== doc.version) {
    warnings.push(
      `selection positions are for version ${scope.version} but the document is at ${doc.version}; clamped`,
    );
  }
  const size = docFromJSON(doc.content).content.size;
  from = Math.max(0, Math.min(from, size));
  to = Math.max(from, Math.min(to, size));
  return { scope: { kind: 'selection', documentId: doc.id, from, to }, warnings };
}

/** A scope that cannot be served (unknown, archived or note document). */
export class ScopeError extends Error {}

/** A snapshot document parsed and segmented once. */
export interface LoadedDocument extends SnapshotDocument {
  node: PMNode;
  seg: Segmentation;
}

/** Parses and segments snapshot documents lazily, once each. */
export class DocumentCache {
  private readonly loaded = new Map<string, LoadedDocument>();
  constructor(private readonly docs: Record<string, SnapshotDocument>) {}

  get(id: string): LoadedDocument | null {
    const hit = this.loaded.get(id);
    if (hit) return hit;
    const d = this.docs[id];
    if (!d) return null;
    const node = docFromJSON(d.content);
    const doc: LoadedDocument = { ...d, node, seg: segmentDoc(node) };
    this.loaded.set(id, doc);
    return doc;
  }
}
