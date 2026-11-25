import { TEXT_LIMITS, type ClippingState, type SourceState } from '@longhand/schema';
import { useId, useState, type FormEvent } from 'react';
import { sourceLabel } from '../csl';
import { clippingRemovedDraft, clippingSavedDraft } from '../drafts';
import { sortSources, toList, type Collection, type DraftProps } from './shared';

/** Props of {@link ClippingsList}. */
export interface ClippingsListProps extends DraftProps {
  /** `ProjectState.clippings`. Removed clippings are hidden. */
  clippings: Collection<ClippingState>;
  /** `ProjectState.sources`, for labels and the source picker. */
  sources: Collection<SourceState>;
  /** Only show (and save to) this source. */
  sourceId?: string;
  /**
   * Places a clipping in the manuscript. The host runs `placeClipping(clipping)`
   * against the editor; omit to hide the button (e.g. no document open).
   */
  onPlace?: (clipping: ClippingState) => void;
}

/**
 * Saved quotes with their location. Save a new quote from a source, place one in
 * the manuscript as a quote block (quoted, never counted as typed), or remove it.
 */
export function ClippingsList(props: ClippingsListProps) {
  const id = useId();
  const sources = sortSources(toList(props.sources).filter((s) => !s.archived));
  const byId = new Map(toList(props.sources).map((s) => [s.id, s]));
  const clippings = toList(props.clippings)
    .filter((c) => !c.removed && (props.sourceId === undefined || c.sourceId === props.sourceId))
    .sort((a, b) => b.savedSeq - a.savedSeq);

  const [adding, setAdding] = useState(false);
  const [sourceId, setSourceId] = useState(props.sourceId ?? sources[0]?.id ?? '');
  const [text, setText] = useState('');
  const [locator, setLocator] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = (e: FormEvent) => {
    e.preventDefault();
    const target = props.sourceId ?? sourceId;
    if (!target || !byId.has(target)) return setError('Choose the source this quote is from.');
    if (text.trim() === '') return setError('Paste or type the quote.');
    if (text.length > TEXT_LIMITS.clippingMaxChars)
      return setError(`Quotes are limited to ${TEXT_LIMITS.clippingMaxChars} characters.`);
    if (locator.trim().length > TEXT_LIMITS.locatorMaxChars)
      return setError(`Keep the location under ${TEXT_LIMITS.locatorMaxChars} characters.`);
    if (note.length > TEXT_LIMITS.clippingNoteMaxChars) return setError('That note is too long.');
    props.onDraft(
      clippingSavedDraft(props.draftContext, { sourceId: target, text, locator, note }),
    );
    setText('');
    setLocator('');
    setNote('');
    setError(null);
    setAdding(false);
  };

  return (
    <div className="lh-research-panel lh-research-clippings" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>
        Clippings <span className="lh-research-count">{clippings.length}</span>
      </h2>

      {adding ? (
        <form className="lh-research-form" onSubmit={save} aria-label="Save a quote" noValidate>
          {props.sourceId === undefined ? (
            <div className="lh-research-field">
              <label htmlFor={`${id}-source`}>Source</label>
              <select
                id={`${id}-source`}
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
              >
                {sources.length === 0 ? <option value="">Add a source first</option> : null}
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {sourceLabel(s.csl).title}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="lh-research-field">
            <label htmlFor={`${id}-text`}>Quote</label>
            <textarea
              id={`${id}-text`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
            />
          </div>
          <div className="lh-research-field">
            <label htmlFor={`${id}-locator`}>Location</label>
            <input
              id={`${id}-locator`}
              value={locator}
              onChange={(e) => setLocator(e.target.value)}
              placeholder="p. 12"
            />
          </div>
          <div className="lh-research-field">
            <label htmlFor={`${id}-note`}>Note (optional)</label>
            <input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error ? (
            <p className="lh-research-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="lh-research-actions">
            <button type="submit" className="lh-research-primary">
              Save quote
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={sources.length === 0 && props.sourceId === undefined}
        >
          Save a quote…
        </button>
      )}

      {clippings.length === 0 ? (
        <p className="lh-research-empty">No clippings yet.</p>
      ) : (
        <ul>
          {clippings.map((c) => {
            const src = byId.get(c.sourceId);
            return (
              <li key={c.id} className="lh-research-card lh-research-clipping">
                <blockquote>
                  {c.text.split('\n').map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </blockquote>
                <p className="lh-research-cite-line">
                  {src ? sourceLabel(src.csl).title : 'Unknown source'}
                  {c.locator ? `, ${c.locator}` : ''}
                </p>
                {c.note ? <p className="lh-research-note">{c.note}</p> : null}
                <div className="lh-research-actions">
                  {props.onPlace ? (
                    <button type="button" onClick={() => props.onPlace!(c)}>
                      Place in manuscript
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => props.onDraft(clippingRemovedDraft(props.draftContext, c.id))}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
