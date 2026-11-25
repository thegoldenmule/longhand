import type {
  CslItem,
  SourceState,
  SourceSuggestionState,
  SurfacedCandidate,
  SurfacedSourceState,
  Target,
} from '@longhand/schema';
import { useId, useRef, useState, type FormEvent } from 'react';
import {
  researchCardDismissedDraft,
  sourceAddedDraft,
  sourceUpdatedDraft,
  surfacedSourceAddedDraft,
} from '../drafts';
import { MetadataError } from '../http';
import type { MetadataClient, MetadataResult } from '../metadata';
import { SourceForm } from './SourceForm';
import {
  AiSurfacedBadge,
  SourceSummary,
  findDuplicate,
  sortSources,
  toList,
  type Collection,
  type DraftProps,
} from './shared';

/** Props of {@link SourcesPanel}. */
export interface SourcesPanelProps extends DraftProps {
  /** The library (`ProjectState.sources`). */
  sources: Collection<SourceState>;
  /** AI-surfaced candidates (`ProjectState.annotations.surfacedSources`). */
  surfaced?: Collection<SurfacedSourceState>;
  /** The agent's "this source supports that claim" suggestions (`annotations.sourceSuggestions`). */
  sourceSuggestions?: Collection<SourceSuggestionState>;
  /** Fetches metadata. The panel makes no other network requests. */
  metadata: MetadataClient;
  /** Opens the citation picker for a source (the host wires it to the editor). */
  onCite?: (sourceId: string) => void;
  /** Shows the claim an AI card is anchored to (the host scrolls the editor). */
  onShowTarget?: (annotationId: string) => void;
  /** Show archived sources. Default false. */
  showArchived?: boolean;
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'manual' }
  | { kind: 'review'; result: MetadataResult }
  | { kind: 'edit-fetched'; result: MetadataResult }
  | { kind: 'edit'; sourceId: string }
  | { kind: 'verify'; surfacedId: string; index: number };

/**
 * The research pane's library: add sources by DOI, ISBN, URL or by hand (with a
 * fetched preview), edit metadata and notes, archive, and review AI-surfaced
 * candidates, which stay labeled *AI-surfaced — unverified* until the writer
 * checks their details and adds them.
 */
export function SourcesPanel(props: SourcesPanelProps) {
  const id = useId();
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });
  const lookupSeq = useRef(0);

  const all = toList(props.sources);
  const library = sortSources(all.filter((s) => props.showArchived || !s.archived));
  const surfaced = toList(props.surfaced).filter((s) => s.status === 'open');
  const suggestions = toList(props.sourceSuggestions).filter((s) => s.status === 'open');
  const byId = new Map(all.map((s) => [s.id, s]));
  const { draftContext: ctx, onDraft } = props;

  const lookup = async (e: FormEvent) => {
    e.preventDefault();
    if (query.trim() === '') return;
    const seq = ++lookupSeq.current;
    setStatus({ loading: true, error: null });
    try {
      const result = await props.metadata.lookup(query);
      if (seq !== lookupSeq.current) return;
      setStatus({ loading: false, error: null });
      setMode({ kind: 'review', result });
    } catch (err) {
      if (seq !== lookupSeq.current) return;
      setStatus({
        loading: false,
        error:
          err instanceof MetadataError ? err.message : 'Could not fetch details for that source.',
      });
    }
  };

  const reset = () => {
    lookupSeq.current++;
    setMode({ kind: 'idle' });
    setStatus({ loading: false, error: null });
  };

  const added = () => {
    setQuery('');
    reset();
  };

  const addFetched = (result: MetadataResult, csl: CslItem = result.csl) => {
    onDraft(sourceAddedDraft(ctx, { csl, origin: result.origin }));
    added();
  };

  const surfacedFor = (surfacedId: string) => surfaced.find((s) => s.id === surfacedId);

  const renderMode = () => {
    switch (mode.kind) {
      case 'review': {
        const dup = findDuplicate(all, mode.result.csl);
        return (
          <section className="lh-research-preview" aria-label="Fetched details">
            <h3>Is this the source?</h3>
            <SourceSummary csl={mode.result.csl} />
            <Details csl={mode.result.csl} />
            {dup ? (
              <p className="lh-research-hint" role="status">
                Already in your library as “{dup.csl.title}”.
              </p>
            ) : null}
            <div className="lh-research-actions">
              <button
                type="button"
                className="lh-research-primary"
                onClick={() => addFetched(mode.result)}
              >
                Add to library
              </button>
              <button
                type="button"
                onClick={() => setMode({ kind: 'edit-fetched', result: mode.result })}
              >
                Edit details first
              </button>
              <button type="button" onClick={reset}>
                Cancel
              </button>
            </div>
          </section>
        );
      }
      case 'edit-fetched':
        return (
          <SourceForm
            heading="Edit details"
            itemId={mode.result.csl.id}
            initial={mode.result.csl}
            submitLabel="Add to library"
            onSubmit={(csl) => addFetched(mode.result, csl)}
            onCancel={reset}
          />
        );
      case 'manual':
        return (
          <SourceForm
            heading="Add a source by hand"
            itemId="manual"
            submitLabel="Add to library"
            onSubmit={(csl) => {
              onDraft(sourceAddedDraft(ctx, { csl, origin: { kind: 'manual', value: null } }));
              added();
            }}
            onCancel={reset}
          />
        );
      case 'edit': {
        const source = byId.get(mode.sourceId);
        if (!source) return null;
        return (
          <SourceForm
            heading="Edit source"
            itemId={source.id}
            initial={source.csl}
            note={source.note}
            submitLabel="Save"
            onSubmit={(csl, note) => {
              const change: { csl?: CslItem; note?: string } = {};
              if (JSON.stringify(csl) !== JSON.stringify({ ...source.csl, id: source.id }))
                change.csl = csl;
              if (note !== undefined && note !== source.note) change.note = note;
              if (change.csl || change.note !== undefined)
                onDraft(sourceUpdatedDraft(ctx, source.id, change));
              reset();
            }}
            onCancel={reset}
          />
        );
      }
      case 'verify': {
        const s = surfacedFor(mode.surfacedId);
        const candidate = s?.candidates[mode.index];
        if (!s || !candidate) return null;
        return (
          <SourceForm
            heading="Verify before adding"
            intro={
              <>
                <AiSurfacedBadge />
                <p>
                  The AI found this candidate. Check every detail against the source itself
                  {candidate.url ? (
                    <>
                      {' '}
                      (
                      <a href={candidate.url} target="_blank" rel="noreferrer noopener">
                        open it
                      </a>
                      )
                    </>
                  ) : null}{' '}
                  before you add it. Once added it is your source.
                </p>
              </>
            }
            itemId={candidate.csl.id}
            initial={candidate.csl}
            submitLabel="I checked it — add to library"
            onSubmit={(csl) => {
              onDraft(surfacedSourceAddedDraft(ctx, s.id, mode.index, candidate, csl));
              reset();
            }}
            onCancel={reset}
          />
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="lh-research-panel lh-research-sources" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>
        Sources{' '}
        <span className="lh-research-count">{library.filter((s) => !s.archived).length}</span>
      </h2>

      {mode.kind === 'idle' ? (
        <form
          className="lh-research-lookup"
          onSubmit={lookup}
          role="search"
          aria-label="Add a source"
        >
          <label htmlFor={`${id}-lookup`}>Add by DOI, ISBN or web address</label>
          <div className="lh-research-lookup-row">
            <input
              id={`${id}-lookup`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="10.1038/nature14539 · 978-0-262-03384-8 · https://…"
              aria-describedby={status.error ? `${id}-lookup-error` : undefined}
              autoComplete="off"
            />
            <button type="submit" disabled={status.loading || query.trim() === ''}>
              {status.loading ? 'Fetching…' : 'Fetch details'}
            </button>
          </div>
          {status.error ? (
            <p id={`${id}-lookup-error`} className="lh-research-error" role="alert">
              {status.error}
            </p>
          ) : null}
          <button
            type="button"
            className="lh-research-link"
            onClick={() => setMode({ kind: 'manual' })}
          >
            Enter a source by hand
          </button>
        </form>
      ) : (
        renderMode()
      )}

      {surfaced.length > 0 ? (
        <section className="lh-research-surfaced" aria-label="AI-surfaced sources">
          <h3>Found by the AI</h3>
          {surfaced.map((s) => (
            <SurfacedCard
              key={s.id}
              surfaced={s}
              library={all}
              onVerify={(index) => setMode({ kind: 'verify', surfacedId: s.id, index })}
              onDismiss={() => onDraft(researchCardDismissedDraft(ctx, s.id))}
              onShowTarget={
                s.target && props.onShowTarget ? () => props.onShowTarget!(s.id) : undefined
              }
            />
          ))}
        </section>
      ) : null}

      {suggestions.length > 0 ? (
        <section className="lh-research-suggestions" aria-label="AI source suggestions">
          <h3>Suggested by the AI</h3>
          <ul>
            {suggestions.map((sg) => {
              const src = byId.get(sg.sourceId);
              return (
                <li key={sg.id} className="lh-research-card lh-research-ai">
                  <span className="lh-research-ai-badge">AI suggestion</span>
                  <p>
                    {targetQuote(sg.target) ? `“${targetQuote(sg.target)}” ` : 'This claim '}may be
                    supported by{' '}
                    <strong>{src?.csl.title ?? 'a source no longer in your library'}</strong>.
                  </p>
                  <p className="lh-research-rationale">{sg.rationale}</p>
                  <div className="lh-research-actions">
                    {props.onShowTarget ? (
                      <button type="button" onClick={() => props.onShowTarget!(sg.id)}>
                        Show claim
                      </button>
                    ) : null}
                    {src && props.onCite ? (
                      <button type="button" onClick={() => props.onCite!(src.id)}>
                        Cite…
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onDraft(researchCardDismissedDraft(ctx, sg.id))}
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="lh-research-library" aria-label="Library">
        {library.length === 0 ? (
          <p className="lh-research-empty">No sources yet.</p>
        ) : (
          <ul>
            {library.map((s) => (
              <li
                key={s.id}
                className="lh-research-card"
                data-archived={s.archived ? '' : undefined}
              >
                <SourceSummary csl={s.csl} />
                {s.fromSurfacedId ? (
                  <span className="lh-research-origin">Found by the AI, verified by you</span>
                ) : null}
                {s.note ? <p className="lh-research-note">{s.note}</p> : null}
                <div className="lh-research-actions">
                  {props.onCite && !s.archived ? (
                    <button type="button" onClick={() => props.onCite!(s.id)}>
                      Cite…
                    </button>
                  ) : null}
                  <button type="button" onClick={() => setMode({ kind: 'edit', sourceId: s.id })}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onDraft(sourceUpdatedDraft(ctx, s.id, { archived: !s.archived }))
                    }
                  >
                    {s.archived ? 'Restore' : 'Archive'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function targetQuote(t: Target | null): string | null {
  return t && t.kind === 'anchor' ? t.anchor.quote : null;
}

function Details({ csl }: { csl: CslItem }) {
  const rows: Array<[string, string | undefined]> = [
    ['Published in', csl['container-title']],
    ['Publisher', csl.publisher],
    ['Volume', csl.volume === undefined ? undefined : String(csl.volume)],
    ['Issue', csl.issue === undefined ? undefined : String(csl.issue)],
    ['Pages', csl.page],
    ['DOI', csl.DOI],
    ['ISBN', csl.ISBN],
    ['Web address', csl.URL],
  ];
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  if (shown.length === 0) return null;
  return (
    <dl className="lh-research-details">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function providerLabel(c: SurfacedCandidate): string {
  return c.provider === 'crossref'
    ? 'Crossref'
    : c.provider === 'openlibrary'
      ? 'Open Library'
      : 'Web';
}

function SurfacedCard(props: {
  surfaced: SurfacedSourceState;
  library: SourceState[];
  onVerify: (index: number) => void;
  onDismiss: () => void;
  onShowTarget?: () => void;
}) {
  const { surfaced } = props;
  const accepted = new Map(surfaced.accepted.map((a) => [a.candidateIndex, a.sourceId]));
  return (
    <article
      className="lh-research-card lh-research-ai"
      aria-label={`AI search: ${surfaced.query}`}
    >
      <header>
        <AiSurfacedBadge />
        <span className="lh-research-query">Search: “{surfaced.query}”</span>
      </header>
      {targetQuote(surfaced.target) ? (
        <p className="lh-research-claim">For: “{targetQuote(surfaced.target)}”</p>
      ) : null}
      {surfaced.candidates.length === 0 ? (
        <p className="lh-research-empty">No candidates found.</p>
      ) : null}
      <ol>
        {surfaced.candidates.map((c, i) => {
          const dup = accepted.has(i) ? null : findDuplicate(props.library, c.csl);
          return (
            <li
              key={i}
              className="lh-research-candidate"
              data-verified={accepted.has(i) ? '' : undefined}
            >
              <SourceSummary csl={c.csl} />
              <span className="lh-research-provider">via {providerLabel(c)}</span>
              {accepted.has(i) ? (
                <span className="lh-research-origin">Verified and added</span>
              ) : (
                <>
                  <AiSurfacedBadge />
                  {dup ? <span className="lh-research-hint">Already in your library</span> : null}
                  <div className="lh-research-actions">
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer noopener">
                        Open
                      </a>
                    ) : null}
                    <button type="button" onClick={() => props.onVerify(i)}>
                      Verify and add…
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>
      <div className="lh-research-actions">
        {props.onShowTarget ? (
          <button type="button" onClick={props.onShowTarget}>
            Show claim
          </button>
        ) : null}
        <button type="button" onClick={props.onDismiss}>
          Dismiss
        </button>
      </div>
    </article>
  );
}
