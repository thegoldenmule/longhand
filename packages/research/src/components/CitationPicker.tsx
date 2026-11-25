import { TEXT_LIMITS, type SourceState } from '@longhand/schema';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { DEFAULT_STYLE, formatCitation } from '../bibliography/format';
import { sourceLabel } from '../csl';
import { SourceSummary, sortSources, toList, type Collection } from './shared';

/** Props of {@link CitationPicker}. */
export interface CitationPickerProps {
  /** `ProjectState.sources`. Archived sources are not offered. */
  sources: Collection<SourceState>;
  /** Preselected source. */
  initialSourceId?: string;
  /** Style for the preview (`ProjectSettings.citationStyle`). */
  style?: string;
  /**
   * Called with the chosen source and locator (null if none). The host runs
   * `insertCitation(sourceId, locator, { documentId })` against the editor.
   */
  onInsert: (sourceId: string, locator: string | null) => void;
  onCancel?: () => void;
}

/** Pick a library source and a locator, preview the citation, and insert it. */
export function CitationPicker(props: CitationPickerProps) {
  const id = useId();
  const sources = useMemo(
    () => sortSources(toList(props.sources).filter((s) => !s.archived)),
    [props.sources],
  );
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(props.initialSourceId ?? '');
  const [locator, setLocator] = useState('');

  const q = filter.trim().toLowerCase();
  const shown = q
    ? sources.filter((s) => {
        const { title, byline } = sourceLabel(s.csl);
        return `${title} ${byline}`.toLowerCase().includes(q);
      })
    : sources;
  const chosen = sources.find((s) => s.id === selected) ?? null;
  const locatorTooLong = locator.trim().length > TEXT_LIMITS.locatorMaxChars;
  const preview = chosen
    ? formatCitation(sources, chosen.id, locator, props.style ?? DEFAULT_STYLE).text
    : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!chosen || locatorTooLong) return;
    props.onInsert(chosen.id, locator.trim() === '' ? null : locator.trim());
  };

  return (
    <form
      className="lh-research-panel lh-research-picker"
      onSubmit={submit}
      aria-label="Cite a source"
    >
      <h2>Cite</h2>
      {sources.length === 0 ? (
        <p className="lh-research-empty">Add a source to your library first.</p>
      ) : (
        <>
          <div className="lh-research-field">
            <label htmlFor={`${id}-filter`}>Find a source</label>
            <input
              id={`${id}-filter`}
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoComplete="off"
            />
          </div>
          <fieldset className="lh-research-choices">
            <legend>Source</legend>
            {shown.length === 0 ? <p className="lh-research-empty">No matching sources.</p> : null}
            {shown.map((s) => (
              <label key={s.id} className="lh-research-choice">
                <input
                  type="radio"
                  name={`${id}-source`}
                  value={s.id}
                  checked={selected === s.id}
                  onChange={() => setSelected(s.id)}
                />
                <SourceSummary csl={s.csl} />
              </label>
            ))}
          </fieldset>
          <div className="lh-research-field">
            <label htmlFor={`${id}-locator`}>Page or location</label>
            <input
              id={`${id}-locator`}
              value={locator}
              onChange={(e) => setLocator(e.target.value)}
              placeholder="p. 12"
              aria-invalid={locatorTooLong ? true : undefined}
            />
            {locatorTooLong ? (
              <span className="lh-research-error" role="alert">
                Keep the location under {TEXT_LIMITS.locatorMaxChars} characters.
              </span>
            ) : null}
          </div>
          {preview ? (
            <p className="lh-research-preview-line" aria-live="polite">
              <span className="lh-research-hint">Preview </span>
              <output>{preview}</output>
            </p>
          ) : null}
        </>
      )}
      <div className="lh-research-actions">
        <button type="submit" className="lh-research-primary" disabled={!chosen || locatorTooLong}>
          Insert citation
        </button>
        {props.onCancel ? (
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
