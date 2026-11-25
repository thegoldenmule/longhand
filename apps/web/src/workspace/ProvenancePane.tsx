'use client';
/** The provenance legend for the open document and the project, bound to the tint. */
import { ProvenanceLegend, type ProvenanceTint } from '@longhand/provenance-ui';
import type { DocumentState, ProjectState } from '@longhand/schema';
import { useState } from 'react';

export function ProvenancePane(props: {
  tint: ProvenanceTint;
  document: DocumentState | null;
  state: ProjectState;
}) {
  const [scope, setScope] = useState<'document' | 'project'>('document');
  const doc = props.document;
  return (
    <div className="ws-provenance" data-testid="provenance-pane">
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
        <ProvenanceLegend document={doc} tint={props.tint} title={doc.title} />
      ) : (
        <ProvenanceLegend
          project={{ state: props.state }}
          tint={props.tint}
          title="Whole manuscript"
        />
      )}
      <p className="ws-note">
        Who wrote what is replayed from the ledger, never stored as marks you could edit. Click
        tinted text (or press Alt-Enter) to see when it was typed and how it moved.
      </p>
    </div>
  );
}
