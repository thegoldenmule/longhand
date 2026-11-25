'use client';
/**
 * Replay (F6): the scrubber over the project's commits, sharing the store's
 * `Replay` (and its snapshots) with the span inspector. The timeline is taken
 * when the view opens; later edits are offered as a refresh, so the scrubber
 * never jumps under the writer's hand.
 */
import { ReplayScrubber } from '@longhand/provenance-ui';
import type { Replay } from '@longhand/ledger';
import type { Commit } from '@longhand/schema';
import { useState } from 'react';

export function ReplayView(props: {
  commits: readonly Commit[];
  replay: Replay;
  documentId: string | null;
  onDocumentChange: (id: string) => void;
}) {
  const [frozen, setFrozen] = useState(props.commits);
  const [epoch, setEpoch] = useState(0);
  const newer = props.commits.length - frozen.length;
  return (
    <div className="ws-view ws-replay" data-testid="replay-view">
      <header className="ws-view-head">
        <h2>Replay</h2>
        <p className="ws-muted">
          The document redrawn at any point in the ledger. AI sessions show as bands.
        </p>
        {newer > 0 && (
          <button
            type="button"
            className="lh-button lh-button-quiet"
            onClick={() => {
              setFrozen(props.commits);
              setEpoch((e) => e + 1);
            }}
          >
            {newer} new {newer === 1 ? 'change' : 'changes'} · refresh
          </button>
        )}
      </header>
      {frozen.length > 0 ? (
        <ReplayScrubber
          key={epoch}
          commits={frozen}
          replay={props.replay}
          {...(props.documentId ? { documentId: props.documentId } : {})}
          onDocumentChange={props.onDocumentChange}
          defaultTint
        />
      ) : (
        <p className="ws-muted">Nothing to replay yet.</p>
      )}
    </div>
  );
}
