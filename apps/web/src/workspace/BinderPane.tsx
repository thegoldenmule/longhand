'use client';
/** The left pane: the project title, the binder tree, and the tree/corkboard switch. */
import { BinderTree, type BinderDraft, type BinderModel } from '@longhand/binder';
import type { BinderRef } from '@longhand/schema';
import { IconBack } from '../ui/icons';

export function BinderPane(props: {
  title: string;
  model: BinderModel;
  selected: BinderRef | null;
  corkboard: boolean;
  onCorkboard: (on: boolean) => void;
  onSelect: (ref: BinderRef) => void;
  onDraft: (d: BinderDraft) => void;
  onError: (message: string) => void;
}) {
  return (
    <aside className="ws-left" aria-label="Binder" data-testid="binder-pane">
      <div className="ws-left-head">
        <a href="/" className="ws-home-link" title="All projects" aria-label="All projects">
          <IconBack />
        </a>
        <span className="ws-project-title" data-testid="project-title" title={props.title}>
          {props.title}
        </span>
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
      <div className="ws-left-body">
        <BinderTree
          model={props.model}
          selected={props.selected}
          onSelect={props.onSelect}
          onDraft={props.onDraft}
          onError={(e) => props.onError(e.message)}
          showWordCounts
          label="Binder"
        />
      </div>
    </aside>
  );
}
