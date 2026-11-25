/**
 * `<ProvenanceLegend>`: the share of words in each provenance class, with the
 * tint toggle. Clicking a class highlights its spans (and turns the tint on).
 */
import type { CountScope } from '@longhand/ledger';
import type { ProjectState } from '@longhand/schema';
import { useId, useMemo, type ReactElement, type ReactNode } from 'react';
import { CLASS_META, type TintClass } from '../classes';
import { formatCount, plural } from '../format';
import { documentLegend, projectLegend, type LegendData, type LegendDocument } from '../legendData';
import type { ProvenanceTint } from '../tint';
import { useProvenanceTint } from './useTint';

export interface ProvenanceLegendProps {
  /** Count one document (`DocumentState` has `content` and `provenance`). */
  document?: LegendDocument;
  /** Or count a project (default scope: non-archived manuscript documents). */
  project?: { state: ProjectState; scope?: CountScope };
  /** Or pass precomputed data (`documentLegend`, `projectLegend`, `legendFromCounts`). */
  data?: LegendData;
  /** Binds the toggle and highlight to a tint controller. */
  tint?: ProvenanceTint;
  /** Without `tint`: whether the tint is on, and its change handler. */
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  /** Without `tint`: the highlighted class, and its change handler. */
  highlight?: TintClass | null;
  onHighlightChange?: (cls: TintClass | null) => void;
  /** Heading text (default "Provenance"). */
  title?: string;
  /** Hide the toggle (for a legend next to a view that is always tinted). */
  showToggle?: boolean;
  /**
   * Text under the rows. Default: how to highlight and inspect (with the toggle),
   * nothing without it. Pass null to hide it.
   */
  hint?: ReactNode | null;
  className?: string;
}

const NOOP_TINT_SNAPSHOT = { enabled: false, highlight: null } as const;

function useTintState(tint: ProvenanceTint | undefined) {
  // Hooks must run unconditionally; a dummy store keeps the call order stable.
  const dummy = useMemo(
    () => ({
      subscribe: () => () => undefined,
      getSnapshot: () => NOOP_TINT_SNAPSHOT,
    }),
    [],
  );
  const snap = useProvenanceTint((tint ?? dummy) as ProvenanceTint);
  return tint ? snap : null;
}

/** The provenance legend. */
export function ProvenanceLegend(props: ProvenanceLegendProps): ReactElement {
  const { document: doc, project, data: given, tint } = props;
  const headingId = useId();
  const tintState = useTintState(tint);
  const enabled = tintState ? tintState.enabled : (props.enabled ?? false);
  const highlight = tintState ? tintState.highlight : (props.highlight ?? null);

  const data = useMemo<LegendData | null>(() => {
    if (given) return given;
    if (doc) return documentLegend(doc);
    if (project) return projectLegend(project.state, project.scope);
    return null;
  }, [given, doc, project]);

  const setEnabled = (on: boolean): void => {
    if (tint) tint.setEnabled(on);
    else props.onEnabledChange?.(on);
  };
  const setHighlight = (cls: TintClass | null): void => {
    if (tint) tint.setHighlight(cls);
    else props.onHighlightChange?.(cls);
  };
  const choose = (cls: TintClass): void => {
    if (!enabled) setEnabled(true);
    setHighlight(highlight === cls && enabled ? null : cls);
  };

  const total = data?.total ?? 0;
  const showToggle = props.showToggle ?? true;
  const hint =
    props.hint !== undefined
      ? props.hint
      : !showToggle
        ? null
        : enabled
          ? 'Choose a class to highlight its words. Click any text, or press Alt+Enter at the caret, to see its history.'
          : 'Turn on the tint to see who wrote what.';

  return (
    <section
      className={`lh-prov-legend${props.className ? ` ${props.className}` : ''}`}
      aria-labelledby={headingId}
      data-enabled={enabled ? 'true' : 'false'}
    >
      <header className="lh-prov-legend__head">
        <h2 id={headingId} className="lh-prov-legend__title">
          {props.title ?? 'Provenance'}
        </h2>
        {showToggle && (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            className="lh-prov-switch"
            onClick={() => setEnabled(!enabled)}
          >
            <span className="lh-prov-switch__track" aria-hidden="true">
              <span className="lh-prov-switch__thumb" />
            </span>
            <span className="lh-prov-switch__label">Tint</span>
          </button>
        )}
      </header>

      <p className="lh-prov-legend__total" data-testid="legend-total">
        {plural(total, 'word')}
      </p>

      {data && total > 0 && (
        <div className="lh-prov-legend__bar" aria-hidden="true">
          {data.rows
            .filter((r) => r.count > 0)
            .map((r) => (
              <span
                key={r.cls}
                className={`lh-prov-legend__seg lh-prov-swatch--${r.cls}`}
                style={{ flexGrow: r.count }}
              />
            ))}
        </div>
      )}

      <ul className="lh-prov-legend__rows">
        {(data?.rows ?? []).map((r) => {
          const active = enabled && highlight === r.cls;
          return (
            <li key={r.cls} className="lh-prov-legend__item">
              <button
                type="button"
                className="lh-prov-legend__row"
                data-class={r.cls}
                data-testid={`legend-${r.cls}`}
                aria-pressed={active}
                disabled={r.count === 0}
                title={CLASS_META[r.cls].description}
                onClick={() => choose(r.cls)}
              >
                <span className={`lh-prov-sample lh-prov--${r.cls}`} aria-hidden="true">
                  Aa
                </span>
                <span className="lh-prov-legend__label">{r.label}</span>
                <span className="lh-prov-legend__count" data-testid={`legend-count-${r.cls}`}>
                  {formatCount(r.count)}
                </span>
                <span className="lh-prov-legend__share">{r.share}</span>
              </button>
              {r.cls === 'typed-from-suggestion' && data && data.matched.length > 0 && (
                <ul className="lh-prov-legend__matched" aria-label="Matched AI text">
                  {data.matched.map((m) => (
                    <li key={m.kind} data-testid={`legend-matched-${m.kind}`}>
                      <span>{m.label}</span>
                      <span className="lh-prov-legend__count">{formatCount(m.count)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {hint !== null && <p className="lh-prov-legend__hint">{hint}</p>}
    </section>
  );
}
