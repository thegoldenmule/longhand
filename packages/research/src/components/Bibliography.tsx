import type { SourceState } from '@longhand/schema';
import { useId, useMemo, useState } from 'react';
import { STYLES, formatBibliography, resolveStyle, type StyleId } from '../bibliography/format';
import { toList, type Collection } from './shared';

/** Props of {@link Bibliography}. */
export interface BibliographyProps {
  /** `ProjectState.sources`. */
  sources: Collection<SourceState>;
  /**
   * Only these sources, e.g. `referencedSourceIds(doc)` for "works cited". Defaults
   * to every non-archived source.
   */
  sourceIds?: readonly string[];
  /** Controlled style (`ProjectSettings.citationStyle`). Uncontrolled if omitted. */
  style?: string;
  /**
   * Called when the writer picks a style. The host persists it with a
   * `ProjectSettingsChanged { patch: { citationStyle } }` commit.
   */
  onStyleChange?: (style: StyleId) => void;
  /** Heading. Defaults to "References". */
  title?: string;
}

/** The formatted bibliography with a style switcher (APA, MLA, Chicago). */
export function Bibliography(props: BibliographyProps) {
  const id = useId();
  const [ownStyle, setOwnStyle] = useState<StyleId>(resolveStyle(props.style));
  const style = props.style === undefined ? ownStyle : resolveStyle(props.style);
  const { sources, sourceIds } = props;
  const bib = useMemo(() => {
    const list = toList(sources);
    const ids = sourceIds ?? list.filter((s) => !s.archived).map((s) => s.id);
    return formatBibliography(list, style, ids);
  }, [sources, sourceIds, style]);
  const [copied, setCopied] = useState(false);

  const change = (next: StyleId) => {
    if (props.style === undefined) setOwnStyle(next);
    props.onStyleChange?.(next);
  };

  const copy = async () => {
    try {
      await globalThis.navigator?.clipboard?.writeText(bib.text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="lh-research-panel lh-research-bibliography" aria-labelledby={`${id}-title`}>
      <div className="lh-research-bib-header">
        <h2 id={`${id}-title`}>{props.title ?? 'References'}</h2>
        <label htmlFor={`${id}-style`}>Style</label>
        <select
          id={`${id}-style`}
          value={style}
          onChange={(e) => change(e.target.value as StyleId)}
        >
          {STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      {bib.entries.length === 0 ? (
        <p className="lh-research-empty">Nothing to list yet.</p>
      ) : (
        <>
          <ol
            className="lh-research-bib"
            data-style={style}
            data-hanging-indent={bib.layout.hangingIndent ? '' : undefined}
          >
            {bib.entries.map((e) => (
              // citeproc escapes item text; its HTML holds only formatting markup.
              <li key={e.id} data-source-id={e.id} dangerouslySetInnerHTML={{ __html: e.html }} />
            ))}
          </ol>
          <div className="lh-research-actions">
            <button type="button" onClick={copy}>
              {copied ? 'Copied' : 'Copy as text'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
