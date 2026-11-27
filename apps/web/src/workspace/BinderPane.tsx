'use client';
/**
 * The left pane: the way back to all projects, the binder tree, and (with
 * several documents) the project title and the tree/corkboard switch.
 *
 * In a one-document project the title lives in the page header alone, so the
 * head says only "All projects", there is no corkboard to switch to, and the
 * sole document has no row (`hide`).
 */
import {
  BinderTree,
  changeProjectSettings,
  type BinderDraft,
  type BinderModel,
} from '@longhand/binder';
import type { BinderRef } from '@longhand/schema';
import { IconBack } from '../ui/icons';
import { TitleField } from './TitleField';

export function BinderPane(props: {
  model: BinderModel;
  /** One document (or none): no project title, no corkboard switch. */
  single: boolean;
  /** Rows to leave out of the tree (the sole document). */
  hide?: readonly BinderRef[];
  selected: BinderRef | null;
  corkboard: boolean;
  onCorkboard: (on: boolean) => void;
  onSelect: (ref: BinderRef) => void;
  onDraft: (d: BinderDraft) => void;
  onError: (message: string) => void;
}) {
  const { model, onDraft, onError } = props;
  const renameProject = (title: string) => {
    const res = changeProjectSettings(model, { title });
    if (res.ok) onDraft(res.draft);
    else if (res.error.code !== 'no-op') onError(res.error.message);
  };
  return (
    <aside className="ws-left" aria-label="Binder" data-testid="binder-pane">
      {props.single ? (
        <div className="ws-left-head">
          <a href="/" className="ws-home-link ws-home-link-text">
            <IconBack />
            All projects
          </a>
        </div>
      ) : (
        <>
          <div className="ws-left-head">
            <a href="/" className="ws-home-link" title="All projects" aria-label="All projects">
              <IconBack />
            </a>
            <TitleField
              value={model.settings.title}
              label="Project title"
              testId="project-title"
              className="ws-project-title"
              onCommit={renameProject}
            />
          </div>
          <div className="ws-seg" role="group" aria-label="Binder view">
            <button
              type="button"
              aria-pressed={!props.corkboard}
              onClick={() => props.onCorkboard(false)}
            >
              Write
            </button>
            <button
              type="button"
              aria-pressed={props.corkboard}
              data-testid="corkboard-toggle"
              onClick={() => props.onCorkboard(true)}
            >
              Corkboard
            </button>
          </div>
        </>
      )}
      <div className="ws-left-body">
        <BinderTree
          model={model}
          selected={props.selected}
          onSelect={props.onSelect}
          onDraft={onDraft}
          onError={(e) => onError(e.message)}
          {...(props.hide ? { hide: props.hide } : {})}
          showWordCounts
          label="Binder"
        />
      </div>
    </aside>
  );
}
