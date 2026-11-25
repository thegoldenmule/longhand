/**
 * `<FeedbackRequestForm>`: ask one of the writer's named editors (F3). The writer
 * picks an editor, a scope (the selection, this document or the whole project)
 * and, optionally, one of the editor's canned questions and/or their own
 * question. Lenses and intensity come from the editor. It emits a validated
 * `FeedbackRequested` event (with `editor`) through `onRequest`; the host (or
 * the controller) submits it with `editor.submitEvent`.
 */
import {
  TEXT_LIMITS,
  editorSummary,
  type EditorProfile,
  type FeedbackScope,
  type Intensity,
} from '@longhand/schema';
import { useId, useState, type FormEvent } from 'react';
import type { SelectionScope } from '../controller';
import { feedbackRequestFor, newId, type AnnotationEventOf } from '../drafts';

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
  /** The writer's selection, if any (enables the selection scope, and is the default). */
  selection?: SelectionScope | null;
  /** The writer's editors, in roster order. `null` while they load. */
  editors: readonly EditorProfile[] | null;
  /** The editor chosen at first (default: the first). */
  defaultEditorId?: string | null;
  /** Where the writer manages their editors (a link under the list). */
  manageEditorsHref?: string;
  /** Called with the `FeedbackRequested` event when the writer submits. */
  onRequest: (event: AnnotationEventOf<'FeedbackRequested'>) => void;
  onCancel?: () => void;
  defaultScope?: FeedbackScope['kind'];
  newId?: () => string;
  className?: string;
}

/** The ask the form sends: the canned question, then the writer's own, one per line. */
export function composeAsk(canned: string | null, typed: string): string {
  return [canned?.trim(), typed.trim()].filter((s) => !!s).join('\n');
}

/** The feedback request form. */
export function FeedbackRequestForm(props: FeedbackRequestFormProps): React.JSX.Element {
  const { documentId, documentTitle, selection = null, onRequest, onCancel, editors } = props;
  const uid = useId();
  const [scopeKind, setScopeKind] = useState<FeedbackScope['kind']>(
    props.defaultScope ?? (selection ? 'selection' : 'document'),
  );
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [canned, setCanned] = useState<string | null>(null);
  const [ask, setAsk] = useState('');
  const [error, setError] = useState<string | null>(null);
  const effectiveScope = scopeKind === 'selection' && !selection ? 'document' : scopeKind;
  const wanted = chosenId ?? props.defaultEditorId ?? null;
  const editor = editors?.find((e) => e.id === wanted) ?? editors?.[0] ?? null;
  const askRoom = TEXT_LIMITS.feedbackAskMaxChars - (canned ? canned.length + 1 : 0);

  const choose = (id: string): void => {
    setChosenId(id);
    setCanned(null);
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!editor) {
      setError('Choose an editor.');
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
      onRequest(
        feedbackRequestFor(editor, { scope, ask: composeAsk(canned, ask) }, props.newId ?? newId),
      );
      setError(null);
      setAsk('');
      setCanned(null);
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
        <legend>Editor</legend>
        {editors === null ? (
          <p className="lh-hint" role="status">
            Loading your editors…
          </p>
        ) : editors.length === 0 ? (
          <p className="lh-hint lh-editor-none">
            You have no editors yet.
            {props.manageEditorsHref && (
              <>
                {' '}
                <a className="lh-btn-link" href={props.manageEditorsHref}>
                  Set one up
                </a>
              </>
            )}
          </p>
        ) : (
          <div className="lh-editor-list" role="radiogroup" aria-label="Editor">
            {editors.map((ed) => {
              const on = ed.id === editor?.id;
              return (
                <label
                  key={ed.id}
                  className={`lh-editor-option${on ? ' is-on' : ''}`}
                  data-editor-id={ed.id}
                >
                  <input
                    type="radio"
                    name={`${uid}-editor`}
                    value={ed.id}
                    checked={on}
                    onChange={() => choose(ed.id)}
                  />
                  <span className="lh-editor-name">{ed.name}</span>
                  <span className="lh-editor-summary">{editorSummary(ed.brief) || 'No brief'}</span>
                </label>
              );
            })}
          </div>
        )}
        {props.manageEditorsHref && editors && editors.length > 0 && (
          <a className="lh-hint lh-editor-manage" href={props.manageEditorsHref}>
            Manage editors
          </a>
        )}
      </fieldset>

      <fieldset className="lh-request-group">
        <legend>Look at</legend>
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

      <div className="lh-request-group lh-request-ask">
        <span className="lh-legend" id={`${uid}-ask`}>
          Anything in particular?
        </span>
        {editor && editor.questions.length > 0 && (
          <div className="lh-questions" role="group" aria-labelledby={`${uid}-ask`}>
            {editor.questions.map((q) => (
              <button
                key={q}
                type="button"
                className={`lh-chip lh-question-chip${canned === q ? ' is-on' : ''}`}
                aria-pressed={canned === q}
                onClick={() => setCanned(canned === q ? null : q)}
              >
                {q}
              </button>
            ))}
          </div>
        )}
        <textarea
          value={ask}
          aria-labelledby={`${uid}-ask`}
          maxLength={askRoom}
          rows={2}
          placeholder={canned ? 'Add to that, if you like' : 'Your own question (optional)'}
          onChange={(e) => setAsk(e.target.value.slice(0, askRoom))}
        />
        <span className="lh-hint">This goes to the editor only. It never enters your text.</span>
      </div>

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
        <button type="submit" className="lh-btn lh-btn-primary" disabled={!editor}>
          {editor ? `Ask ${editor.name}` : 'Ask'}
        </button>
      </div>
    </form>
  );
}
