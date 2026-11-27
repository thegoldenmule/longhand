// Test-only: small binder models for the workspace's title rules.
import type { BinderModel } from '@longhand/binder';
import {
  DEFAULT_PROJECT_SETTINGS,
  EMPTY_DOC_JSON,
  type BinderArea,
  type BinderRef,
  type DocumentState,
  type PMNodeJSON,
} from '@longhand/schema';

export interface NodeSpec {
  id: string;
  title?: string;
  archived?: boolean;
  /** A folder, with these children. */
  children?: NodeSpec[];
}

/** A binder model from outlines of the two areas; the project is called `title`. */
export function binderModel(
  title: string,
  outline: { manuscript?: NodeSpec[]; notes?: NodeSpec[] },
): BinderModel {
  const model: BinderModel = {
    binder: { manuscript: [], notes: [] },
    folders: {},
    documents: {},
    settings: { title, ...DEFAULT_PROJECT_SETTINGS },
  };
  const add = (area: BinderArea, nodes: NodeSpec[], parentId: string | null): BinderRef[] =>
    nodes.map((n) => {
      if (n.children) {
        model.folders[n.id] = {
          id: n.id,
          area,
          title: n.title ?? n.id,
          parentId,
          children: [],
          synopsis: '',
          archived: n.archived ?? false,
          createdSeq: 1,
          updatedSeq: 1,
        };
        model.folders[n.id]!.children = add(area, n.children, n.id);
        return { kind: 'folder', id: n.id };
      }
      const doc: DocumentState = {
        id: n.id,
        kind: area === 'notes' ? 'note' : 'manuscript',
        area,
        title: n.title ?? n.id,
        parentId,
        synopsis: '',
        content: JSON.parse(JSON.stringify(EMPTY_DOC_JSON)) as PMNodeJSON,
        version: 0,
        provenance: [],
        archived: n.archived ?? false,
        imported: null,
        createdSeq: 1,
        contentSeq: 1,
        updatedSeq: 1,
      };
      model.documents[n.id] = doc;
      return { kind: 'document', id: n.id };
    });
  model.binder.manuscript = add('manuscript', outline.manuscript ?? [], null);
  model.binder.notes = add('notes', outline.notes ?? [], null);
  return model;
}
