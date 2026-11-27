/**
 * One document, one name: while the manuscript is a single document, that
 * document goes by the project's name. The link is a UI rule kept by ordinary
 * events (`ProjectSettingsChanged` and `DocumentRenamed`); the fold stores both
 * titles as it always has.
 *
 * These helpers live apart from `drafts` because they apply drafts with the
 * optimistic reducer, which itself imports `drafts`.
 */
import {
  changeProjectSettings,
  renameNode,
  titleOrUntitled,
  type BinderDraft,
  type BinderError,
} from './drafts';
import { soleManuscriptDocument, type BinderModel } from './model';
import { applyBinderDraft } from './reducer';

/**
 * Renames the project and its sole document together: 0, 1 or 2 drafts, the
 * project first. The title goes through {@link titleOrUntitled}. Refuses invalid
 * titles, and returns `no-op` when nothing changes.
 */
export function renameProjectAndDocument(
  model: BinderModel,
  documentId: string,
  raw: string,
): { ok: true; drafts: BinderDraft[] } | { ok: false; error: BinderError } {
  const title = titleOrUntitled(raw);
  const drafts: BinderDraft[] = [];
  const project = changeProjectSettings(model, { title });
  if (project.ok) drafts.push(project.draft);
  else if (project.error.code !== 'no-op') return project;
  const document = renameNode(model, { kind: 'document', id: documentId }, title);
  if (document.ok) drafts.push(document.draft);
  else if (document.error.code !== 'no-op') return document;
  if (drafts.length === 0) {
    return { ok: false, error: { code: 'no-op', message: 'The title is unchanged.' } };
  }
  return { ok: true, drafts };
}

/**
 * The drafts to emit for `draft`: just `draft`, unless it ends single-document
 * mode while the sole document's stored title differs from the project's. Then
 * that document is renamed to the project's name first, so it keeps the name the
 * writer has been seeing.
 */
export function withTitleLink(model: BinderModel, draft: BinderDraft): BinderDraft[] {
  const sole = soleManuscriptDocument(model);
  if (sole === null) return [draft];
  const after = applyBinderDraft(model, draft);
  if (!after.ok || soleManuscriptDocument(after.model) === sole) return [draft];
  const rename = renameNode(model, { kind: 'document', id: sole }, model.settings.title);
  return rename.ok ? [rename.draft, draft] : [draft];
}
