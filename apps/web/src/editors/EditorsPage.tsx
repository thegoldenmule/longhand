'use client';
/**
 * Your editors: the account-wide roster of named AI editors every project asks
 * for feedback. Add, edit (name, brief, lenses, intensity, canned questions),
 * delete, or reset to the starters. A feedback request records the editor as it
 * was when asked, so changing or deleting one never rewrites a past review.
 */
import {
  EDITOR_MAX_QUESTIONS,
  LENSES,
  LENS_LABELS,
  TEXT_LIMITS,
  type EditorProfile,
  type EditorProfileInput,
  type Intensity,
  type Lens,
} from '@longhand/schema';
import { INTENSITY_OPTIONS } from '@longhand/annotations';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { currentUser, signOut } from '../auth/session';
import { runtimeConfig } from '../config';
import { getClient } from '../lib/client';
import { ThemeToggle } from '../ui/ThemeToggle';

const BLANK: EditorProfileInput = {
  name: '',
  brief: '',
  lenses: ['clarity'],
  intensity: 'standard',
  questions: [],
};

function intensityLabel(i: Intensity): string {
  return INTENSITY_OPTIONS.find((o) => o.value === i)?.label ?? i;
}

/** A same-origin project path to return to, from `?back=`. */
function backHref(): string | null {
  const b = new URLSearchParams(location.search).get('back');
  return b && /^\/p\/[^/]/.test(b) ? b : null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function EditorsPage() {
  const [editors, setEditors] = useState<EditorProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The editor being edited: an id, `new`, or nothing. */
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const user = currentUser();
  const cfg = runtimeConfig();
  const back = backHref();

  useEffect(() => {
    getClient()
      .listEditors()
      .then(setEditors, (e: unknown) =>
        setError(`Can’t reach the ledger service at ${cfg.ledgerUrl}. ${message(e)}`),
      );
  }, [cfg.ledgerUrl]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (id: string | null, input: EditorProfileInput) =>
    run(async () => {
      const client = getClient();
      if (id) {
        const ed = await client.updateEditor(id, input);
        setEditors((cur) => cur?.map((e) => (e.id === id ? ed : e)) ?? [ed]);
      } else {
        const ed = await client.createEditor(input);
        setEditors((cur) => [...(cur ?? []), ed]);
      }
      setEditing(null);
    });

  const remove = (id: string) =>
    run(async () => {
      await getClient().deleteEditor(id);
      setEditors((cur) => cur?.filter((e) => e.id !== id) ?? null);
      setEditing(null);
    });

  const reset = () =>
    run(async () => {
      setEditors(await getClient().resetEditors());
      setConfirmReset(false);
      setEditing(null);
    });

  return (
    <div className="lh-home lh-editors">
      <header className="lh-home-bar">
        <a href="/" className="lh-wordmark lh-wordmark-link">
          Longhand
        </a>
        <span className="lh-home-bar-end">
          <a className="lh-link-quiet" href="/">
            Projects
          </a>
          {user && <span className="lh-muted">{user.name}</span>}
          {cfg.authMode === 'cognito' && (
            <button type="button" className="lh-link-quiet" onClick={signOut}>
              Sign out
            </button>
          )}
          <ThemeToggle />
        </span>
      </header>

      <main className="lh-home-main">
        <section className="lh-home-intro">
          {back && (
            <p className="lh-editors-back">
              <a className="lh-link-quiet" href={back}>
                ← Back to your project
              </a>
            </p>
          )}
          <h1>Your editors</h1>
          <p className="lh-muted lh-editors-lede">
            Each editor reads with its own lenses, intensity and brief. Every project can ask any of
            them. Changing one never changes a review it already gave.
          </p>
          <div className="lh-home-actions">
            <button
              type="button"
              className="lh-button lh-button-primary"
              onClick={() => setEditing(editing === 'new' ? null : 'new')}
              aria-expanded={editing === 'new'}
              disabled={editors === null}
            >
              New editor
            </button>
            {!confirmReset ? (
              <button
                type="button"
                className="lh-button lh-button-quiet"
                onClick={() => setConfirmReset(true)}
                disabled={editors === null}
              >
                Reset to starters
              </button>
            ) : (
              <span className="lh-editors-confirm" role="group" aria-label="Reset to starters">
                <span className="lh-muted">Replace all your editors with the starters?</span>
                <button
                  type="button"
                  className="lh-button"
                  onClick={() => void reset()}
                  disabled={busy}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="lh-button lh-button-quiet"
                  onClick={() => setConfirmReset(false)}
                >
                  Keep mine
                </button>
              </span>
            )}
          </div>
        </section>

        {editing === 'new' && (
          <EditorForm
            initial={BLANK}
            busy={busy}
            submitLabel="Add editor"
            onCancel={() => setEditing(null)}
            onSubmit={(input) => void save(null, input)}
          />
        )}

        {error && (
          <p className="lh-error" role="alert">
            {error}
          </p>
        )}

        <section aria-label="Editors" className="lh-editor-roster">
          {editors === null && !error && <p className="lh-muted">Loading…</p>}
          {editors?.length === 0 && (
            <p className="lh-muted lh-empty">
              No editors. Add one, or reset to the starters, to ask for feedback.
            </p>
          )}
          <ul>
            {editors?.map((ed) => (
              <li key={ed.id} data-testid="editor-row" data-editor-id={ed.id}>
                {editing === ed.id ? (
                  <EditorForm
                    initial={ed}
                    busy={busy}
                    submitLabel="Save"
                    onCancel={() => setEditing(null)}
                    onSubmit={(input) => void save(ed.id, input)}
                    onDelete={() => void remove(ed.id)}
                  />
                ) : (
                  <EditorRow editor={ed} onEdit={() => setEditing(ed.id)} />
                )}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

function EditorRow(props: { editor: EditorProfile; onEdit: () => void }) {
  const ed = props.editor;
  return (
    <article className="lh-editor-row">
      <header className="lh-editor-row-head">
        <h2 className="lh-editor-row-name">{ed.name}</h2>
        <button
          type="button"
          className="lh-link-quiet"
          onClick={props.onEdit}
          aria-label={`Edit ${ed.name}`}
        >
          Edit
        </button>
      </header>
      {ed.brief && <p className="lh-editor-row-brief">{ed.brief}</p>}
      <p className="lh-editor-row-meta lh-muted">
        {ed.lenses.map((l) => LENS_LABELS[l]).join(' · ')}
        <span aria-hidden="true"> — </span>
        {intensityLabel(ed.intensity)}
      </p>
      {ed.questions.length > 0 && (
        <ul className="lh-editor-row-questions" aria-label={`${ed.name}’s questions`}>
          {ed.questions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function EditorForm(props: {
  initial: EditorProfileInput;
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: EditorProfileInput) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const uid = useId();
  const [name, setName] = useState(props.initial.name);
  const [brief, setBrief] = useState(props.initial.brief);
  const [lenses, setLenses] = useState<Lens[]>([...props.initial.lenses]);
  const [intensity, setIntensity] = useState<Intensity>(props.initial.intensity);
  const [questions, setQuestions] = useState<string[]>([...props.initial.questions]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const filled = questions.map((q) => q.trim()).filter(Boolean);
  const valid = name.trim().length > 0 && lenses.length > 0;

  const toggle = (l: Lens) =>
    setLenses((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    props.onSubmit({
      name: name.trim(),
      brief: brief.trim(),
      lenses: LENSES.filter((l) => lenses.includes(l)),
      intensity,
      questions: [...new Set(filled)],
    });
  };

  return (
    <form
      className="lh-card-form lh-editor-form"
      aria-label={props.initial.name ? `Edit ${props.initial.name}` : 'New editor'}
      onSubmit={submit}
    >
      <label className="lh-field">
        <span>Name</span>
        <input
          name="name"
          value={name}
          required
          autoFocus
          maxLength={TEXT_LIMITS.editorNameMaxChars}
          placeholder="Margaret, Theo, The Skeptic…"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="lh-field">
        <span>
          Brief{' '}
          <em className="lh-editor-hint">
            who they are, what they look for first, how they put things
          </em>
        </span>
        <textarea
          name="brief"
          rows={3}
          value={brief}
          maxLength={TEXT_LIMITS.editorBriefMaxChars}
          placeholder="A blunt line editor who hates adverbs. Short notes, no hedging."
          onChange={(e) => setBrief(e.target.value)}
        />
      </label>
      <fieldset className="lh-editor-fieldset">
        <legend>Lenses</legend>
        <div className="lh-editor-lenses">
          {LENSES.map((l) => (
            <label key={l} className={`lh-editor-chip${lenses.includes(l) ? ' is-on' : ''}`}>
              <input
                type="checkbox"
                name={`${uid}-lens`}
                checked={lenses.includes(l)}
                onChange={() => toggle(l)}
              />
              {LENS_LABELS[l]}
            </label>
          ))}
        </div>
        {lenses.length === 0 && <p className="lh-error lh-editor-hint">Pick at least one lens.</p>}
      </fieldset>
      <fieldset className="lh-editor-fieldset">
        <legend>Intensity</legend>
        <div className="lh-editor-intensity">
          {INTENSITY_OPTIONS.map((o) => (
            <label key={o.value} className="lh-inline-choice">
              <input
                type="radio"
                name={`${uid}-intensity`}
                checked={intensity === o.value}
                onChange={() => setIntensity(o.value)}
              />
              {o.label}
              <span className="lh-editor-hint">{o.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="lh-editor-fieldset">
        <legend>
          Questions <em className="lh-editor-hint">one-tap asks, up to {EDITOR_MAX_QUESTIONS}</em>
        </legend>
        <div className="lh-editor-questions">
          {questions.map((q, i) => (
            <div key={i} className="lh-editor-question">
              <input
                aria-label={`Question ${i + 1}`}
                value={q}
                maxLength={TEXT_LIMITS.editorQuestionMaxChars}
                placeholder="Is the opening too slow?"
                onChange={(e) =>
                  setQuestions((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))
                }
              />
              <button
                type="button"
                className="lh-link-quiet"
                aria-label={`Remove question ${i + 1}`}
                onClick={() => setQuestions((cur) => cur.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          {questions.length < EDITOR_MAX_QUESTIONS && (
            <button
              type="button"
              className="lh-link-quiet lh-editor-add"
              onClick={() => setQuestions((cur) => [...cur, ''])}
            >
              + Add a question
            </button>
          )}
        </div>
      </fieldset>
      <div className="lh-form-actions lh-editor-actions">
        {props.onDelete &&
          (confirmDelete ? (
            <span className="lh-editors-confirm lh-editor-delete">
              <span className="lh-muted">Delete {props.initial.name}?</span>
              <button
                type="button"
                className="lh-button lh-button-danger"
                onClick={props.onDelete}
                disabled={props.busy}
              >
                Delete
              </button>
              <button
                type="button"
                className="lh-button lh-button-quiet"
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="lh-button lh-button-quiet lh-editor-delete"
              onClick={() => setConfirmDelete(true)}
            >
              Delete…
            </button>
          ))}
        <button type="button" className="lh-button lh-button-quiet" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="lh-button lh-button-primary"
          disabled={props.busy || !valid}
        >
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}
