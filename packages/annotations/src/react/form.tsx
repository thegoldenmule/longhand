/**
 * `<FeedbackRequestForm>`: scope, lenses, intensity and a free-text ask (F3). It
 * emits a validated `FeedbackRequested` event through `onRequest`; the host (or
 * the controller) submits it with `editor.submitEvent`.
 */
import {
  LENSES,
  LENS_LABELS,
  TEXT_LIMITS,
  type FeedbackScope,
  type Intensity,
  type Lens,
} from '@longhand/schema';
import { useId, useState, type FormEvent } from 'react';
import type { SelectionScope } from '../controller';
import { feedbackRequested, newId, type AnnotationEventOf } from '../drafts';

/** Intensity labels and hints. */
export const INTENSITY_OPTIONS: ReadonlyArray<{ value: Intensity; label: string; hint: string }> = [
  { value: 'light', label: 'Light touch', hint: 'At most 5 items' },
  { value: 'standard', label: 'Standard', hint: 'A full pass' },
  { value: 'thorough', label: 'Thorough', hint: 'Everything worth raising' },
];

/** Props of {@link FeedbackRequestForm}. */
export interface FeedbackRequestFormProps {
  /** The current document. */
  documentId: string;
  documentTitle?: string;
  /** The writer's selection, if any (enables the selection scope). */
  selection?: SelectionScope | null;
  /** Called with the `FeedbackRequested` event when the writer submits. */
  onRequest: (event: AnnotationEventOf<'FeedbackRequested'>) => void;
  onCancel?: () => void;
  defaultScope?: FeedbackScope['kind'];
  defaultLenses?: readonly Lens[];
  defaultIntensity?: Intensity;
  newId?: () => string;
  className?: string;
}

/** The feedback request form. */
export function FeedbackRequestForm(props: FeedbackRequestFormProps): React.JSX.Element {
  const {
    documentId,
    documentTitle,
    selection = null,
    onRequest,
    onCancel,
    defaultLenses = ['clarity'],
    defaultIntensity = 'standard',
  } = props;
  const uid = useId();
  const [scopeKind, setScopeKind] = useState<FeedbackScope['kind']>(
    props.defaultScope ?? (selection ? 'selection' : 'document'),
  );
  const [lenses, setLenses] = useState<Lens[]>([...defaultLenses]);
  const [intensity, setIntensity] = useState<Intensity>(defaultIntensity);
  const [ask, setAsk] = useState('');
  const [error, setError] = useState<string | null>(null);
  const effectiveScope = scopeKind === 'selection' && !selection ? 'document' : scopeKind;

  const toggleLens = (lens: Lens): void =>
    setLenses((cur) => (cur.includes(lens) ? cur.filter((l) => l !== lens) : [...cur, lens]));

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (lenses.length === 0) {
      setError('Pick at least one lens.');
      return;
    }
    let scope: FeedbackScope;
    if (effectiveScope === 'selection' && selection)
      scope = {
        kind: 'selection',
        documentId: selection.documentId,
        from: selection.from,
        to: selection.to,
        version: selection.version,
      };
    else if (effectiveScope === 'project') scope = { kind: 'project' };
    else scope = { kind: 'document', documentId };
    try {
      const ordered = LENSES.filter((l) => lenses.includes(l));
      onRequest(
        feedbackRequested({ scope, lenses: ordered, intensity, ask }, props.newId ?? newId),
      );
      setError(null);
      setAsk('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <form
      className={`lh-ann lh-request${props.className ? ` ${props.className}` : ''}`}
      onSubmit={submit}
      aria-label="Ask for feedback"
      data-testid="feedback-form"
    >
      <fieldset className="lh-request-group">
        <legend>Scope</legend>
        <div className="lh-segmented" role="presentation">
          <label
            className={effectiveScope === 'selection' ? 'is-on' : ''}
            aria-disabled={!selection}
          >
            <input
              type="radio"
              name={`${uid}-scope`}
              value="selection"
              checked={effectiveScope === 'selection'}
              disabled={!selection}
              onChange={() => setScopeKind('selection')}
            />
            Selection
          </label>
          <label className={effectiveScope === 'document' ? 'is-on' : ''}>
            <input
              type="radio"
              name={`${uid}-scope`}
              value="document"
              checked={effectiveScope === 'document'}
              onChange={() => setScopeKind('document')}
            />
            {documentTitle ? `“${documentTitle}”` : 'This document'}
          </label>
          <label className={effectiveScope === 'project' ? 'is-on' : ''}>
            <input
              type="radio"
              name={`${uid}-scope`}
              value="project"
              checked={effectiveScope === 'project'}
              onChange={() => setScopeKind('project')}
            />
            Whole project
          </label>
        </div>
      </fieldset>

      <fieldset className="lh-request-group">
        <legend>Lenses</legend>
        <div className="lh-lenses">
          {LENSES.map((lens) => (
            <label key={lens} className={`lh-chip${lenses.includes(lens) ? ' is-on' : ''}`}>
              <input
                type="checkbox"
                name={`${uid}-lens`}
                value={lens}
                checked={lenses.includes(lens)}
                onChange={() => toggleLens(lens)}
              />
              {LENS_LABELS[lens]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="lh-request-group">
        <legend>Intensity</legend>
        <div className="lh-segmented">
          {INTENSITY_OPTIONS.map((o) => (
            <label key={o.value} className={intensity === o.value ? 'is-on' : ''} title={o.hint}>
              <input
                type="radio"
                name={`${uid}-intensity`}
                value={o.value}
                checked={intensity === o.value}
                onChange={() => setIntensity(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
        <p className="lh-hint">{INTENSITY_OPTIONS.find((o) => o.value === intensity)?.hint}</p>
      </fieldset>

      <label className="lh-request-group lh-request-ask">
        <span className="lh-legend">Anything in particular?</span>
        <textarea
          value={ask}
          maxLength={TEXT_LIMITS.feedbackAskMaxChars}
          rows={2}
          placeholder="Is the opening too slow?"
          onChange={(e) => setAsk(e.target.value)}
        />
        <span className="lh-hint">This goes to the editor only. It never enters your text.</span>
      </label>

      {error && (
        <p className="lh-request-error" role="alert">
          {error}
        </p>
      )}
      <div className="lh-request-actions">
        {onCancel && (
          <button type="button" className="lh-btn lh-btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="lh-btn lh-btn-primary" disabled={lenses.length === 0}>
          Ask the editor
        </button>
      </div>
    </form>
  );
}
