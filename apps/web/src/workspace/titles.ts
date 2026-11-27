/**
 * Which titles the workspace shows, and where. When the manuscript is a single
 * document, that document goes by the project's name and the title appears once,
 * in the header. Otherwise the project and each document keep their own names.
 */
import { soleManuscriptDocument, visibleChildren, type BinderModel } from '@longhand/binder';

export interface WorkspaceTitles {
  /**
   * `single`: the manuscript is one document. `empty`: the manuscript has nothing
   * in it. `multi`: anything else (several documents, or a folder).
   */
  mode: 'single' | 'multi' | 'empty';
  /** The manuscript's only document, in single mode. */
  soleId: string | null;
  /** Title of the open document as shown (the project's name for the sole document). */
  docTitle: string | null;
  projectTitle: string;
  /** Set when single mode has a note open: the manuscript crumb. */
  crumb: { title: string; documentId: string } | null;
}

export function workspaceTitles(model: BinderModel, docId: string | null): WorkspaceTitles {
  const projectTitle = model.settings.title;
  const soleId = soleManuscriptDocument(model);
  const mode = soleId
    ? 'single'
    : visibleChildren(model, 'manuscript', null).length === 0
      ? 'empty'
      : 'multi';
  const doc = docId ? model.documents[docId] : undefined;
  const docTitle = !doc ? null : docId === soleId ? projectTitle : doc.title;
  const crumb = soleId && doc?.kind === 'note' ? { title: projectTitle, documentId: soleId } : null;
  return { mode, soleId, docTitle, projectTitle, crumb };
}
