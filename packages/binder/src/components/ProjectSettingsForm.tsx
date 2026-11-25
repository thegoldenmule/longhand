import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { TEXT_LIMITS, type ProjectSettings } from '@longhand/schema';
import { changeProjectSettings, type BinderDraft, type BinderError } from '../drafts';
import { LiveRegion, cx, useAnnouncer } from './shared';

/** A citation style the form offers. */
export interface CitationStyleOption {
  /** CSL style id, e.g. `apa`. */
  id: string;
  label: string;
}

/** Citation styles offered by default. */
export const DEFAULT_CITATION_STYLES: readonly CitationStyleOption[] = [
  { id: 'apa', label: 'APA' },
  { id: 'modern-language-association', label: 'MLA' },
  { id: 'chicago-author-date', label: 'Chicago (author-date)' },
  { id: 'chicago-note-bibliography', label: 'Chicago (notes and bibliography)' },
];

/** Props of {@link ProjectSettingsForm}. */
export interface ProjectSettingsFormProps {
  settings: ProjectSettings;
  /** Called with a `ProjectSettingsChanged` draft whenever a field is committed with a new value. */
  onDraft: (draft: BinderDraft) => void;
  /** Citation styles to offer; the current style is always listed. */
  citationStyles?: readonly CitationStyleOption[];
  /** Called when a value is refused (the message is also shown by the field). */
  onError?: (error: BinderError) => void;
  /** Heading text; pass null to render no heading. */
  heading?: string | null;
  className?: string;
}

type TextField = 'title' | 'genre' | 'audience' | 'goals' | 'styleNotes' | 'dailyWordGoal';

interface FieldSpec {
  field: TextField;
  label: string;
  hint?: string;
  multiline?: boolean;
  maxLength?: number;
}

const FIELDS: readonly FieldSpec[] = [
  { field: 'title', label: 'Project title', maxLength: TEXT_LIMITS.titleMaxChars },
  {
    field: 'genre',
    label: 'Genre',
    hint: 'For example: literary fiction, personal essay, history.',
    maxLength: TEXT_LIMITS.genreMaxChars,
  },
  {
    field: 'audience',
    label: 'Audience',
    hint: 'Who you are writing for.',
    maxLength: TEXT_LIMITS.audienceMaxChars,
  },
  {
    field: 'goals',
    label: 'Goals',
    hint: 'What you want this piece to do.',
    multiline: true,
    maxLength: TEXT_LIMITS.goalsMaxChars,
  },
  {
    field: 'styleNotes',
    label: 'Style notes',
    hint: 'Voice, tense, rules you keep. The editor calibrates to these.',
    multiline: true,
    maxLength: TEXT_LIMITS.styleNotesMaxChars,
  },
  {
    field: 'dailyWordGoal',
    label: 'Daily word goal',
    hint: 'Optional. Leave empty for no goal.',
  },
];

const display = (settings: ProjectSettings, field: TextField): string => {
  const v = settings[field];
  return v === null || v === undefined ? '' : String(v);
};

/**
 * The project context the AI editor reads (title, genre, audience, goals, style
 * notes) plus the daily word goal and citation style. There is no save button: each
 * field commits when it loses focus (or on Enter in one-line fields) and emits one
 * `ProjectSettingsChanged` draft holding only what changed.
 */
export function ProjectSettingsForm(props: ProjectSettingsFormProps) {
  const {
    settings,
    onDraft,
    citationStyles = DEFAULT_CITATION_STYLES,
    onError,
    heading = 'Project',
    className,
  } = props;
  const baseId = useId();
  // Values being edited (or committed but not yet reflected in `settings`).
  const [drafts, setDrafts] = useState<Partial<Record<TextField, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<TextField | 'citationStyle', string>>>({});
  const [focused, setFocused] = useState<TextField | null>(null);
  const [message, announce] = useAnnouncer();

  // When settings change (the ledger or the optimistic reducer caught up), drop local
  // copies of fields that are not being edited.
  useEffect(() => {
    setDrafts((prev) => {
      const next: Partial<Record<TextField, string>> = {};
      let changed = false;
      for (const [k, v] of Object.entries(prev) as Array<[TextField, string]>) {
        if (k === focused) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
    // `focused` is read, not watched: only a settings change should clear copies.
  }, [settings]);

  const valueOf = (field: TextField) => drafts[field] ?? display(settings, field);

  const commit = (field: TextField) => {
    const raw = valueOf(field);
    let value: string | number | null = raw;
    if (field === 'dailyWordGoal') {
      const t = raw.trim();
      if (t === '') value = null;
      else if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 100000) {
        setErrors((e) => ({
          ...e,
          [field]: 'Enter a whole number from 1 to 100,000, or leave it empty.',
        }));
        return;
      } else value = Number(t);
    }
    const res = changeProjectSettings({ settings }, { [field]: value } as Partial<ProjectSettings>);
    if (res.ok) {
      setErrors((e) => ({ ...e, [field]: undefined }));
      onDraft(res.draft);
      announce(`${FIELDS.find((f) => f.field === field)?.label ?? field} saved.`);
    } else if (res.error.code === 'no-op') {
      setErrors((e) => ({ ...e, [field]: undefined }));
      setDrafts((d) => {
        const { [field]: _drop, ...rest } = d;
        return rest;
      });
    } else {
      setErrors((e) => ({ ...e, [field]: res.error.message }));
      onError?.(res.error);
    }
  };

  const onKeyDown = (field: TextField, multiline: boolean) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit(field);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setErrors((er) => ({ ...er, [field]: undefined }));
      setDrafts((d) => {
        const { [field]: _drop, ...rest } = d;
        return rest;
      });
    }
  };

  const styles = citationStyles.some((s) => s.id === settings.citationStyle)
    ? citationStyles
    : [...citationStyles, { id: settings.citationStyle, label: settings.citationStyle }];

  const onStyleChange = (id: string) => {
    const res = changeProjectSettings({ settings }, { citationStyle: id });
    if (res.ok) {
      setErrors((e) => ({ ...e, citationStyle: undefined }));
      onDraft(res.draft);
      announce('Citation style saved.');
    } else if (res.error.code !== 'no-op') {
      setErrors((e) => ({ ...e, citationStyle: res.error.message }));
      onError?.(res.error);
    }
  };

  const headingId = `${baseId}-heading`;
  const styleId = `${baseId}-citationStyle`;

  return (
    <form
      className={cx('lh-settings', className)}
      aria-labelledby={heading ? headingId : undefined}
      aria-label={heading ? undefined : 'Project settings'}
      onSubmit={(e: FormEvent) => e.preventDefault()}
      noValidate
    >
      {heading && (
        <h2 id={headingId} className="lh-settings-heading">
          {heading}
        </h2>
      )}
      <p className="lh-settings-intro">
        The editor reads this context to calibrate its feedback. None of it enters your manuscript.
      </p>
      {FIELDS.map(({ field, label, hint, multiline = false, maxLength }) => {
        const id = `${baseId}-${field}`;
        const hintId = `${id}-hint`;
        const errorId = `${id}-error`;
        const error = errors[field];
        const describedBy = cx(hint && hintId, error && errorId) || undefined;
        const common = {
          id,
          className: 'lh-settings-input',
          value: valueOf(field),
          maxLength,
          'aria-describedby': describedBy,
          'aria-invalid': error ? true : undefined,
          onFocus: () => setFocused(field),
          onBlur: () => {
            setFocused(null);
            commit(field);
          },
          onKeyDown: onKeyDown(field, multiline),
        };
        return (
          <div key={field} className={cx('lh-settings-field', error && 'is-invalid')}>
            <label htmlFor={id} className="lh-settings-label">
              {label}
            </label>
            {multiline ? (
              <textarea
                {...common}
                rows={field === 'styleNotes' ? 6 : 4}
                onChange={(e) => setDrafts((d) => ({ ...d, [field]: e.target.value }))}
              />
            ) : (
              <input
                {...common}
                type="text"
                inputMode={field === 'dailyWordGoal' ? 'numeric' : undefined}
                onChange={(e) => setDrafts((d) => ({ ...d, [field]: e.target.value }))}
              />
            )}
            {hint && (
              <p id={hintId} className="lh-settings-hint">
                {hint}
              </p>
            )}
            {error && (
              <p id={errorId} className="lh-settings-error" role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}
      <div className="lh-settings-field">
        <label htmlFor={styleId} className="lh-settings-label">
          Citation style
        </label>
        <select
          id={styleId}
          className="lh-settings-input"
          value={settings.citationStyle}
          onChange={(e) => onStyleChange(e.target.value)}
        >
          {styles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {errors.citationStyle && (
          <p className="lh-settings-error" role="alert">
            {errors.citationStyle}
          </p>
        )}
      </div>
      <LiveRegion message={message} />
    </form>
  );
}
