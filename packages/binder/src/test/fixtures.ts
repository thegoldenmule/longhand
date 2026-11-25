// Test-only: hand-built binder models from a compact outline, following the schema types.
import {
  DEFAULT_PROJECT_SETTINGS,
  EMPTY_DOC_JSON,
  type BinderArea,
  type BinderRef,
  type DocumentState,
  type FolderState,
  type PMNodeJSON,
} from '@longhand/schema';
import type { BinderModel } from '../model';

/** An outline node: a folder (`children` given) or a document. */
export interface OutlineNode {
  id: string;
  title?: string;
  children?: OutlineNode[];
  archived?: boolean;
  synopsis?: string;
  /** Plain text: one paragraph per line. */
  text?: string;
}

function contentFor(text: string | undefined): PMNodeJSON {
  if (!text) return JSON.parse(JSON.stringify(EMPTY_DOC_JSON)) as PMNodeJSON;
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}

/** Builds a `BinderModel` from outlines of the two areas. */
export function makeModel(outline: {
  manuscript?: OutlineNode[];
  notes?: OutlineNode[];
}): BinderModel {
  const model: BinderModel = {
    binder: { manuscript: [], notes: [] },
    folders: {},
    documents: {},
    settings: { title: 'Test Project', ...DEFAULT_PROJECT_SETTINGS },
  };
  let seq = 1;
  const add = (area: BinderArea, nodes: OutlineNode[], parentId: string | null): BinderRef[] =>
    nodes.map((n) => {
      seq += 1;
      if (n.children) {
        const folder: FolderState = {
          id: n.id,
          area,
          title: n.title ?? n.id,
          parentId,
          children: [],
          synopsis: n.synopsis ?? '',
          archived: n.archived ?? false,
          createdSeq: seq,
          updatedSeq: seq,
        };
        model.folders[n.id] = folder;
        folder.children = add(area, n.children, n.id);
        return { kind: 'folder', id: n.id };
      }
      const doc: DocumentState = {
        id: n.id,
        kind: area === 'notes' ? 'note' : 'manuscript',
        area,
        title: n.title ?? n.id,
        parentId,
        synopsis: n.synopsis ?? '',
        content: contentFor(n.text),
        version: 0,
        provenance: [],
        archived: n.archived ?? false,
        imported: null,
        createdSeq: seq,
        contentSeq: seq,
        updatedSeq: seq,
      };
      model.documents[n.id] = doc;
      return { kind: 'document', id: n.id };
    });
  model.binder.manuscript = add('manuscript', outline.manuscript ?? [], null);
  model.binder.notes = add('notes', outline.notes ?? [], null);
  return model;
}

/** The novel used across tests: Part › Chapter › Scene, plus notes. */
export function novel(): BinderModel {
  return makeModel({
    manuscript: [
      {
        id: 'part1',
        title: 'Part One',
        children: [
          {
            id: 'ch1',
            title: 'Chapter 1',
            synopsis: 'Arrival.',
            children: [
              {
                id: 's1',
                title: 'Rain',
                synopsis: 'A stranger arrives.',
                text: 'The rain fell sideways.',
              },
              { id: 's2', title: 'The Inn', text: 'She knocked twice.\nNobody answered.' },
            ],
          },
          { id: 'ch2', title: 'Chapter 2', children: [{ id: 's3', title: 'Morning' }] },
        ],
      },
      { id: 'part2', title: 'Part Two', children: [] },
      { id: 'epilogue', title: 'Epilogue' },
    ],
    notes: [
      { id: 'chars', title: 'Characters', children: [{ id: 'n1', title: 'Mara' }] },
      { id: 'n2', title: 'Style guide' },
    ],
  });
}

/** The outline of an area as nested `[id, children?]` arrays, for compact assertions. */
export function shape(model: BinderModel, area: BinderArea): unknown[] {
  const walk = (refs: readonly BinderRef[]): unknown[] =>
    refs.map((r) =>
      r.kind === 'folder' ? { [r.id]: walk(model.folders[r.id]?.children ?? []) } : r.id,
    );
  return walk(model.binder[area]);
}

/**
 * Checks the tree invariants every fold output satisfies: each node is listed exactly
 * once, in a list of its own area, under the parent its `parentId` names.
 */
export function checkInvariants(model: BinderModel): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const visit = (area: BinderArea, parentId: string | null, refs: readonly BinderRef[]) => {
    for (const r of refs) {
      const key = `${r.kind}:${r.id}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      const node = r.kind === 'folder' ? model.folders[r.id] : model.documents[r.id];
      if (!node) {
        problems.push(`${key} listed but missing`);
        continue;
      }
      if (node.area !== area) problems.push(`${key} in wrong area`);
      if (node.parentId !== parentId)
        problems.push(`${key} parentId ${node.parentId} != ${parentId}`);
      if (r.kind === 'folder' && (seen.get(key) ?? 0) === 1) {
        visit(area, r.id, model.folders[r.id]?.children ?? []);
      }
    }
  };
  visit('manuscript', null, model.binder.manuscript);
  visit('notes', null, model.binder.notes);
  for (const id of Object.keys(model.folders)) {
    const n = seen.get(`folder:${id}`) ?? 0;
    if (n !== 1) problems.push(`folder:${id} listed ${n} times`);
  }
  for (const id of Object.keys(model.documents)) {
    const n = seen.get(`document:${id}`) ?? 0;
    if (n !== 1) problems.push(`document:${id} listed ${n} times`);
  }
  return problems;
}
