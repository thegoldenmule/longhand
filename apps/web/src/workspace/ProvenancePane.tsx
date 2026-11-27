'use client';
/**
 * The Provenance tab: the legend (with its tint switch) for the open document or the
 * manuscript, and the ways into the record (replay, report, export). In a
 * one-document project there is nothing to switch between: the legend counts the
 * manuscript.
 */
import { ProvenanceLegend, type ProvenanceTint } from '@longhand/provenance-ui';
import type { DocumentState, ProjectState } from '@longhand/schema';
import { useState } from 'react';

export function ProvenancePane(props: {
  tint: ProvenanceTint;
  document: DocumentState | null;
  state: ProjectState;
  /** The manuscript is one document. */
  single: boolean;
  /** Shortcut label for the tint toggle, e.g. "⌘⌥P". */
  tintKey: string;
  view: 'replay' | 'report' | 'other';
  onReplay: () => void;
  onReport: () => void;
  onExport: () => void;
}) {
  const [scope, setScope] = useState<'document' | 'project'>('document');
  const doc = props.document;
  return (
    <div className="ws-settings ws-provenance" data-testid="provenance-pane">
      <section className="ws-prefs" aria-label="Provenance">
        {props.single ? (
          <ProvenanceLegend
            project={{ state: props.state }}
            tint={props.tint}
            title="Words by origin"
          />
        ) : (
          <>
            <div className="ws-seg ws-seg-small" role="group" aria-label="Count">
              <button
                type="button"
                aria-pressed={scope === 'document'}
                onClick={() => setScope('document')}
                disabled={!doc}
              >
                This document
              </button>
              <button
                type="button"
                aria-pressed={scope === 'project'}
                onClick={() => setScope('project')}
              >
                Manuscript
              </button>
            </div>
            {scope === 'document' && doc ? (
              <ProvenanceLegend document={doc} tint={props.tint} title="This document" />
            ) : (
              <ProvenanceLegend
                project={{ state: props.state }}
                tint={props.tint}
                title="Whole manuscript"
              />
            )}
          </>
        )}
        <p className="ws-note">
          Who wrote what is replayed from the ledger, never stored as marks you could edit. Click
          tinted text (or press Alt-Enter) to see when it was typed and how it moved.{' '}
          {`${props.tintKey} turns the tint on or off from anywhere.`}
        </p>
      </section>

      <section className="ws-prefs" aria-label="Record">
        <h3>Record</h3>
        <div className="ws-record-actions">
          <button
            type="button"
            className="lh-button"
            aria-pressed={props.view === 'replay'}
            data-testid="open-replay"
            onClick={props.onReplay}
          >
            Replay
          </button>
          <button
            type="button"
            className="lh-button"
            aria-pressed={props.view === 'report'}
            data-testid="open-report"
            onClick={props.onReport}
          >
            Report
          </button>
          <button
            type="button"
            className="lh-button"
            data-testid="open-export"
            onClick={props.onExport}
          >
            Export…
          </button>
        </div>
      </section>
    </div>
  );
}
