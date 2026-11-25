import type { CslItem } from '@longhand/schema';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  SOURCE_TYPES,
  cslToManualEntry,
  emptyManualEntry,
  validateManualEntry,
  type ManualEntry,
  type ManualField,
} from '../manual';

/** Props of {@link SourceForm}. */
export interface SourceFormProps {
  /** Prefill from existing metadata (fetched preview, AI candidate, or a library source). */
  initial?: CslItem;
  /** The id the resulting CSL item gets (the source id, or a placeholder for new sources). */
  itemId: string;
  /** Heading above the form. */
  heading: string;
  /** Explanatory text under the heading. */
  intro?: ReactNode;
  submitLabel: string;
  /** Show a note field with this initial value. */
  note?: string;
  onSubmit: (csl: CslItem, note: string | undefined) => void;
  onCancel: () => void;
}

const CONTAINER_LABEL: Record<string, string> = {
  'article-journal': 'Journal',
  'article-magazine': 'Magazine',
  'article-newspaper': 'Newspaper',
  'paper-conference': 'Proceedings or conference',
  chapter: 'Book title',
  'entry-encyclopedia': 'Encyclopedia',
  webpage: 'Website',
  'post-weblog': 'Blog',
};

/** The manual entry / edit metadata form. Validates with {@link validateManualEntry}. */
export function SourceForm(props: SourceFormProps) {
  const id = useId();
  const [form, setForm] = useState<ManualEntry>(() =>
    props.initial ? cslToManualEntry(props.initial) : emptyManualEntry(),
  );
  const [note, setNote] = useState(props.note ?? '');
  const [errors, setErrors] = useState<Partial<Record<ManualField, string>>>({});
  const [warnings, setWarnings] = useState<Partial<Record<ManualField, string>>>({});

  const set = (k: ManualField) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = validateManualEntry(form, props.itemId, props.initial);
    if (!result.ok) {
      setErrors(result.errors);
      setWarnings({});
      return;
    }
    setErrors({});
    setWarnings(result.warnings);
    props.onSubmit(result.csl, props.note === undefined ? undefined : note);
  };

  const field = (
    k: ManualField,
    label: string,
    opts: { multiline?: boolean; hint?: string } = {},
  ) => {
    const fid = `${id}-${k}`;
    const err = errors[k];
    const warn = warnings[k];
    const describedBy = err || warn || opts.hint ? `${fid}-msg` : undefined;
    return (
      <div className="lh-research-field" data-field={k}>
        <label htmlFor={fid}>{label}</label>
        {opts.multiline ? (
          <textarea
            id={fid}
            value={form[k]}
            onChange={set(k)}
            rows={2}
            aria-invalid={err ? true : undefined}
            aria-describedby={describedBy}
          />
        ) : (
          <input
            id={fid}
            value={form[k]}
            onChange={set(k)}
            aria-invalid={err ? true : undefined}
            aria-describedby={describedBy}
          />
        )}
        {err || warn || opts.hint ? (
          <span
            id={`${fid}-msg`}
            className={err ? 'lh-research-error' : 'lh-research-hint'}
            role={err ? 'alert' : undefined}
          >
            {err ?? warn ?? opts.hint}
          </span>
        ) : null}
      </div>
    );
  };

  const typeKnown = SOURCE_TYPES.some(([t]) => t === form.type);

  return (
    <form
      className="lh-research-form"
      onSubmit={submit}
      aria-labelledby={`${id}-heading`}
      noValidate
    >
      <h3 id={`${id}-heading`}>{props.heading}</h3>
      {props.intro ? <div className="lh-research-intro">{props.intro}</div> : null}
      <div className="lh-research-field" data-field="type">
        <label htmlFor={`${id}-type`}>Type</label>
        <select id={`${id}-type`} value={form.type} onChange={set('type')}>
          {typeKnown ? null : <option value={form.type}>{form.type}</option>}
          {SOURCE_TYPES.map(([t, label]) => (
            <option key={t} value={t}>
              {label}
            </option>
          ))}
        </select>
        {errors.type ? (
          <span className="lh-research-error" role="alert">
            {errors.type}
          </span>
        ) : null}
      </div>
      {field('title', 'Title')}
      {field('authors', 'Authors', {
        multiline: true,
        hint: 'One per line or separated by “;”, as Family, Given.',
      })}
      {field('editors', 'Editors', { multiline: true })}
      {field('issued', 'Date', { hint: 'YYYY, YYYY-MM or YYYY-MM-DD.' })}
      {field('containerTitle', CONTAINER_LABEL[form.type] ?? 'Published in')}
      {field('publisher', 'Publisher')}
      {field('publisherPlace', 'Place')}
      <div className="lh-research-row">
        {field('volume', 'Volume')}
        {field('issue', 'Issue')}
        {field('page', 'Pages')}
        {field('edition', 'Edition')}
      </div>
      {field('doi', 'DOI')}
      {field('isbn', 'ISBN')}
      {field('url', 'Web address')}
      {field('accessed', 'Accessed')}
      {props.note !== undefined ? (
        <div className="lh-research-field" data-field="note">
          <label htmlFor={`${id}-note`}>Your note</label>
          <textarea
            id={`${id}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
          />
        </div>
      ) : null}
      <div className="lh-research-actions">
        <button type="submit" className="lh-research-primary">
          {props.submitLabel}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
