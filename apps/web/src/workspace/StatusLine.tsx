'use client';
/** Word counts and save state, in one quiet line under the page. */
import type { SaveState, WordCounts } from '@longhand/editor';

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  queued: 'Saving…',
  offline: 'Offline · changes queued',
  error: 'Not saved',
};

function n(x: number): string {
  return x.toLocaleString('en-US');
}

export function StatusLine(props: {
  counts: WordCounts | null;
  save: SaveState | null;
  queued: number;
  live: boolean;
  documentTitle: string | null;
}) {
  const c = props.counts;
  const save = props.save;
  return (
    <footer className="ws-status" aria-label="Status">
      <span className="ws-status-group">
        {c ? (
          <>
            <span data-testid="count-document">{n(c.document)} words</span>
            {c.selection > 0 && (
              <span data-testid="count-selection">{n(c.selection)} selected</span>
            )}
            <span data-testid="count-session" title="Net words this session">
              +{n(c.session)} this session
            </span>
            {c.daily && (
              <span className="ws-goal" data-testid="count-daily" title="Today’s goal">
                <span className="ws-goal-bar" aria-hidden>
                  <span
                    style={{ width: `${Math.min(100, Math.round(c.daily.progress * 100))}%` }}
                  />
                </span>
                {n(c.daily.written)} / {n(c.daily.goal)} today
              </span>
            )}
          </>
        ) : (
          <span>{props.documentTitle ?? ''}</span>
        )}
      </span>
      <span className="ws-status-group">
        {save && (
          <span
            className="ws-save"
            data-state={save}
            data-testid="save-state"
            role="status"
            aria-live="polite"
            title={
              save === 'offline'
                ? 'Your writing is kept on this device and syncs when you are back online.'
                : undefined
            }
          >
            <span className="ws-save-dot" aria-hidden />
            {SAVE_LABEL[save]}
            {(save === 'offline' || save === 'queued') && props.queued > 1
              ? ` (${props.queued})`
              : ''}
          </span>
        )}
      </span>
    </footer>
  );
}
