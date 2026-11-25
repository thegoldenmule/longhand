'use client';
/**
 * The research sidebar (F8): the sources library, clippings, the citation picker
 * and the bibliography. Page lookups go through the ledger service's
 * SSRF-guarded proxy (`client.pageFetch`); Crossref and Open Library are called
 * directly (they allow CORS).
 */
import type { LonghandClient } from '@longhand/client';
import type { EditorHandle } from '@longhand/editor';
import {
  Bibliography,
  CitationPicker,
  ClippingsList,
  SourcesPanel,
  createMetadataClient,
  referencedSourceIds,
  type DraftContext,
  type ResearchDraft,
} from '@longhand/research';
import type { ProjectState } from '@longhand/schema';
import { TextSelection } from 'prosemirror-state';
import { useMemo, useState } from 'react';

export type ResearchTab = 'library' | 'clippings' | 'bibliography';

/** A pending "cite": from a citation-needed flag, a source suggestion or the library. */
export interface CiteIntent {
  sourceId?: string;
  /** Local editor position to cite at (the end of the flagged claim). */
  at?: number;
}

export function ResearchPane(props: {
  state: ProjectState;
  client: LonghandClient;
  draftContext: DraftContext;
  onDraft: (d: ResearchDraft) => void;
  editor: EditorHandle | null;
  documentId: string | null;
  cite: CiteIntent | null;
  onCite: (c: CiteIntent | null) => void;
  onStyleChange: (style: string) => void;
  onShowTarget: (annotationId: string) => void;
}) {
  const { state, editor } = props;
  const [tab, setTab] = useState<ResearchTab>('library');
  const metadata = useMemo(
    () =>
      createMetadataClient({
        fetch: (input, init) => fetch(input, init),
        pageFetch: props.client.pageFetch,
        userAgent: null,
      }),
    [props.client],
  );
  const cited = useMemo(() => {
    const ids = new Set<string>();
    for (const d of Object.values(state.documents)) {
      if (d.archived || d.kind === 'note') continue;
      for (const id of referencedSourceIds(d.content)) ids.add(id);
    }
    return [...ids];
  }, [state.documents]);
  const style = state.settings.citationStyle;

  return (
    <div className="ws-research" data-testid="research-pane">
      {props.cite && (
        <div className="ws-cite" data-testid="citation-picker">
          <CitationPicker
            sources={state.sources}
            {...(props.cite.sourceId ? { initialSourceId: props.cite.sourceId } : {})}
            style={style}
            onInsert={(sourceId, locator) => {
              if (!editor) return;
              const at = props.cite?.at;
              if (at !== undefined) {
                const view = editor.view;
                const pos = Math.max(0, Math.min(at, view.state.doc.content.size));
                view.dispatch(
                  view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)),
                );
              }
              editor.insertCitation({ sourceId, locator });
              props.onCite(null);
              editor.focus();
            }}
            onCancel={() => props.onCite(null)}
          />
        </div>
      )}
      <div className="ws-tabs ws-tabs-sub" role="tablist" aria-label="Research">
        {(
          [
            ['library', 'Sources'],
            ['clippings', 'Clippings'],
            ['bibliography', 'Bibliography'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`research-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        {!props.cite && Object.keys(state.sources).length > 0 && editor && (
          <button
            type="button"
            className="ws-tabs-action"
            data-testid="cite-button"
            onClick={() => props.onCite({})}
          >
            Cite…
          </button>
        )}
      </div>
      {tab === 'library' && (
        <SourcesPanel
          sources={state.sources}
          surfaced={state.annotations.surfacedSources}
          sourceSuggestions={state.annotations.sourceSuggestions}
          metadata={metadata}
          draftContext={props.draftContext}
          onDraft={props.onDraft}
          onCite={(sourceId) => props.onCite({ sourceId })}
          onShowTarget={props.onShowTarget}
        />
      )}
      {tab === 'clippings' && (
        <ClippingsList
          clippings={state.clippings}
          sources={state.sources}
          draftContext={props.draftContext}
          onDraft={props.onDraft}
          {...(editor && props.documentId
            ? {
                onPlace: (c) => {
                  editor.insertClipping({
                    clippingId: c.id,
                    sourceId: c.sourceId,
                    locator: c.locator,
                    text: c.text,
                  });
                  editor.focus();
                },
              }
            : {})}
        />
      )}
      {tab === 'bibliography' && (
        <div data-testid="bibliography">
          <Bibliography
            sources={state.sources}
            {...(cited.length ? { sourceIds: cited } : {})}
            style={style}
            onStyleChange={(s) => props.onStyleChange(s)}
            title={cited.length ? 'Works cited' : 'All sources'}
          />
        </div>
      )}
    </div>
  );
}
