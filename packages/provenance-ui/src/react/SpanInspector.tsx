/**
 * The span inspector popover (`<SpanInspector>`, presentational) and
 * `<ProvenanceInspector>`, which wires it to a tint: a click on tinted text, or
 * Alt-Enter at the caret, opens it for that character.
 */
import type { LedgerState } from '@longhand/ledger';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  formatDuration,
  formatTime as defaultFormatTime,
  plural,
  sameDay,
  type TimeFormatter,
} from '../format';
import { inspectSpan, type InspectorModel, type InspectorPaste } from '../inspector';
import type { InspectRect, InspectRequest, ProvenanceTint } from '../tint';
import { useProvenanceTint } from './useTint';

export interface SpanInspectorProps {
  /** The model, or null for text the ledger does not have yet. */
  model: InspectorModel | null;
  /** Where the inspected character is on screen (viewport coordinates). */
  rect: InspectRect | null;
  onClose: () => void;
  /** Move focus into the popover when it opens (keyboard opening). */
  autoFocus?: boolean;
  formatTime?: TimeFormatter;
  /** Render inline instead of as a positioned popover (tests, side panels). */
  inline?: boolean;
}

function pasteText(p: InspectorPaste): string {
  const where =
    p.origin === 'internal'
      ? p.verifiedInternal
        ? 'from inside the project'
        : 'from inside the project (not verified)'
      : p.via === 'drop'
        ? 'dropped from outside'
        : 'from outside the project';
  return `${plural(p.characters, 'character')}, ${plural(p.words, 'word')} ${where}`;
}

function Row(props: { label: string; children: ReactNode; testId?: string }): ReactElement {
  return (
    <div className="lh-prov-pop__row" data-testid={props.testId}>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

const POPOVER_GAP = 8;
const EDGE = 8;

/** Places the popover under (or above) the character, inside the viewport. */
function usePlacement(
  ref: RefObject<HTMLElement | null>,
  rect: InspectRect | null,
  inline: boolean,
): CSSProperties {
  // Unplaced, it stays transparent but focusable (keyboard opening focuses it at once).
  const [style, setStyle] = useState<CSSProperties>({ top: 0, left: 0, opacity: 0 });
  useLayoutEffect(() => {
    if (inline) return;
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth || 360;
    const h = el.offsetHeight || 200;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    if (!rect) {
      setStyle({ top: EDGE * 4, left: Math.max(EDGE, (vw - w) / 2) });
      return;
    }
    let top = rect.bottom + POPOVER_GAP;
    if (top + h > vh - EDGE && rect.top - POPOVER_GAP - h >= EDGE) top = rect.top - POPOVER_GAP - h;
    const left = Math.min(Math.max(EDGE, rect.left - 24), Math.max(EDGE, vw - w - EDGE));
    setStyle({ top: Math.max(EDGE, top), left });
  }, [ref, rect, inline]);
  return inline ? {} : style;
}

/** The inspector popover for one character. */
export function SpanInspector(props: SpanInspectorProps): ReactElement {
  const { model, onClose } = props;
  const fmt = props.formatTime ?? defaultFormatTime;
  const ref = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const style = usePlacement(ref, props.rect, props.inline ?? false);

  useEffect(() => {
    if (props.autoFocus) ref.current?.focus({ preventScroll: true });
  }, [props.autoFocus, model]);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const cls = model?.class;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      tabIndex={-1}
      className={`lh-prov-pop${props.inline ? ' lh-prov-pop--inline' : ''}`}
      data-class={cls}
      data-testid="span-inspector"
      style={style}
      onKeyDown={onKeyDown}
    >
      <header className="lh-prov-pop__head">
        {cls && (
          <span className={`lh-prov-sample lh-prov--${cls}`} aria-hidden="true">
            Aa
          </span>
        )}
        <h2 id={headingId} className="lh-prov-pop__title">
          {model ? model.classLabel : 'Not in the ledger yet'}
        </h2>
        <button type="button" className="lh-prov-pop__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      {!model ? (
        <p className="lh-prov-pop__note">
          This text was written since the provenance was last computed. Its history appears once it
          is saved and the ledger has folded it.
        </p>
      ) : (
        <>
          {model.spanText && (
            <blockquote className="lh-prov-pop__span" data-testid="inspector-span">
              {model.spanText}
            </blockquote>
          )}
          <dl className="lh-prov-pop__facts">
            <Row label={model.action} testId="inspector-when">
              <time dateTime={model.origin.clientTime}>
                {fmt(model.origin.clientTime, { seconds: true })}
              </time>
            </Row>
            <Row label="Session" testId="inspector-session">
              {model.session ? (
                <>
                  Writing session {model.session.number} of {model.session.total} ·{' '}
                  {fmt(model.session.startTime)}–
                  {fmt(model.session.endTime, {
                    date: !sameDay(model.session.startTime, model.session.endTime),
                  })}{' '}
                  · {formatDuration(model.session.activeMs)} active
                </>
              ) : (
                'Not part of a writing session'
              )}
            </Row>
            {model.methodText && (
              <Row label="Input" testId="inspector-input">
                {model.methodText.charAt(0).toUpperCase() + model.methodText.slice(1)}
              </Row>
            )}
            <Row label="AI text" testId="inspector-suggestion">
              {model.matched ? (
                <>
                  Matched {model.matched.kindLabel}
                  {model.matched.text && (
                    <>
                      : <q className="lh-prov-pop__ai">{model.matched.text}</q>
                    </>
                  )}
                  {model.matched.status && (
                    <span className="lh-prov-pop__muted"> ({model.matched.status})</span>
                  )}
                </>
              ) : (
                'Did not match any AI text'
              )}
              <div className="lh-prov-pop__sub" data-testid="inspector-visible">
                {model.visibleSuggestions.length === 0 ? (
                  'No AI suggestions were open in this document when it was typed.'
                ) : (
                  <>
                    {model.visibleSuggestions.length === 1
                      ? 'One suggestion was open when it was typed:'
                      : `${model.visibleSuggestions.length} suggestions were open when it was typed:`}
                    <ul>
                      {model.visibleSuggestions.map((s) => (
                        <li
                          key={s.id}
                          data-matched={model.matched?.id === s.id ? 'true' : undefined}
                        >
                          {s.kindLabel}
                          {s.text && (
                            <>
                              {' '}
                              <q className="lh-prov-pop__ai">{s.text}</q>
                            </>
                          )}{' '}
                          <span className="lh-prov-pop__muted">({s.status})</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </Row>
            <Row label="Moves" testId="inspector-moves">
              {model.moves.length === 0 ? (
                'Not moved'
              ) : (
                <ul>
                  {model.moves.map((m) => (
                    <li key={m.seq}>
                      {m.label} ·{' '}
                      <time dateTime={m.clientTime}>{fmt(m.clientTime, { seconds: true })}</time>
                      {m.paste && (
                        <span className="lh-prov-pop__muted"> · {pasteText(m.paste)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Row>
            {model.pastes.length > 0 && (
              <Row label="Paste size" testId="inspector-paste">
                {model.pastes.length === 1 ? (
                  pasteText(model.pastes[0] as InspectorPaste)
                ) : (
                  <ul>
                    {model.pastes.map((p) => (
                      <li key={p.id}>{pasteText(p)}</li>
                    ))}
                  </ul>
                )}
              </Row>
            )}
            {model.imported && (
              <Row label="Draft" testId="inspector-import">
                {model.imported.sourceName ?? 'Unnamed draft'} ({model.imported.sourceFormat})
              </Row>
            )}
            {model.source && (
              <Row label="Source" testId="inspector-source">
                {model.source.title ?? model.source.id}
                {model.source.locator && `, ${model.source.locator}`}
              </Row>
            )}
          </dl>
          {model.note && <p className="lh-prov-pop__note">{model.note}</p>}
          <p className="lh-prov-pop__ledger" data-testid="inspector-ledger">
            Ledger seq {model.origin.seq} · witnessed{' '}
            {fmt(model.origin.serverTime, {
              seconds: true,
              date: !sameDay(model.origin.serverTime, model.origin.clientTime),
            })}{' '}
            · device {model.origin.deviceId}
          </p>
        </>
      )}
    </div>
  );
}

export interface ProvenanceInspectorProps {
  tint: ProvenanceTint;
  /**
   * The ledger state the tint's runs come from (for example `foldCommits(commits)`
   * or `replay.head()`); its document must be at the version passed to `setRuns`.
   */
  state: LedgerState | null;
  documentId: string;
  formatTime?: TimeFormatter;
  /** Called with each opened model (null for unsynced text). */
  onOpen?: (model: InspectorModel | null, request: InspectRequest) => void;
}

interface OpenState {
  req: InspectRequest;
  model: InspectorModel | null;
  rect: InspectRect | null;
}

/** Opens `<SpanInspector>` for clicks and Alt-Enter on tinted text. */
export function ProvenanceInspector(props: ProvenanceInspectorProps): ReactElement | null {
  const { tint, state, documentId, onOpen } = props;
  const snap = useProvenanceTint(tint);
  const [open, setOpen] = useState<OpenState | null>(null);
  const openRef = useRef<OpenState | null>(null);
  openRef.current = open;

  const close = useCallback(
    (restoreFocus: boolean) => {
      const was = openRef.current;
      setOpen(null);
      tint.markSpan(null);
      if (restoreFocus && was?.req.via === 'keyboard') tint.host()?.view.focus();
    },
    [tint],
  );

  useEffect(
    () =>
      tint.onInspect((req) => {
        const model =
          req.ledgerPos !== null && state ? inspectSpan(state, documentId, req.ledgerPos) : null;
        if (model) tint.markSpan({ from: model.run.from, to: model.run.to });
        else tint.markSpan(null);
        setOpen({ req, model, rect: req.rect });
        onOpen?.(model, req);
      }),
    [tint, state, documentId, onOpen],
  );

  useEffect(() => tint.onDismiss(() => openRef.current && close(false)), [tint, close]);

  // Close when the tint goes off or the document changes.
  useEffect(() => {
    if (!snap.enabled && openRef.current) close(false);
  }, [snap.enabled, close]);
  useEffect(() => () => setOpen(null), [documentId]);

  // Follow the text when the page scrolls.
  useEffect(() => {
    if (!open) return;
    const onScroll = (): void => {
      const cur = openRef.current;
      const view = tint.host()?.view;
      if (!cur || !view) return;
      try {
        const a = view.coordsAtPos(cur.req.localPos, 1);
        setOpen({ ...cur, rect: { left: a.left, right: a.right, top: a.top, bottom: a.bottom } });
      } catch {
        // The position is gone; keep the last placement.
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, tint]);

  // A pointer press outside the popover closes it (a click on other text reopens it).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      const pop = document.querySelector('[data-testid="span-inspector"]');
      if (pop && target && pop.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <SpanInspector
      model={open.model}
      rect={open.rect}
      onClose={() => close(true)}
      autoFocus={open.req.via === 'keyboard'}
      {...(props.formatTime ? { formatTime: props.formatTime } : {})}
    />,
    document.body,
  );
}
