'use client';
/**
 * Projects: open one, start one (title, genre, audience), or bring in an
 * existing draft, which is labeled *imported (unverified)* in every report.
 */
import type { ProjectSummary } from '@longhand/client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { currentUser, signOut } from '../auth/session';
import { runtimeConfig } from '../config';
import { getClient } from '../lib/client';
import { humanDraft, postDraft } from '../lib/drafts';
import { newId } from '../lib/ids';
import { draftToDoc, formatForName, sha256Hex } from '../lib/importDraft';
import { ThemeToggle } from '../ui/ThemeToggle';

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0)
    return `Today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

type Mode = 'none' | 'new' | 'import';

async function createProject(input: {
  title: string;
  genre: string;
  audience: string;
}): Promise<{ projectId: string; actorId: string }> {
  const client = getClient();
  const me = await client.me();
  const { projectId } = await client.createProject({ title: input.title.trim() });
  const patch: Record<string, string> = {};
  if (input.genre.trim()) patch.genre = input.genre.trim();
  if (input.audience.trim()) patch.audience = input.audience.trim();
  if (Object.keys(patch).length) {
    await postDraft(client, humanDraft(projectId, me.actorId, 'ProjectSettingsChanged', { patch }));
  }
  return { projectId, actorId: me.actorId };
}

export function ProjectsHome() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('none');
  const [busy, setBusy] = useState(false);
  const user = currentUser();
  const cfg = runtimeConfig();

  useEffect(() => {
    getClient()
      .listProjects()
      .then((p) =>
        setProjects([...p].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))),
      )
      .catch((e: unknown) =>
        setError(
          `Can’t reach the ledger service at ${cfg.ledgerUrl}. ${e instanceof Error ? e.message : ''}`,
        ),
      );
  }, [cfg.ledgerUrl]);

  const open = (projectId: string) => location.assign(`/p/${encodeURIComponent(projectId)}`);

  return (
    <div className="lh-home">
      <header className="lh-home-bar">
        <span className="lh-wordmark">Longhand</span>
        <span className="lh-home-bar-end">
          <a className="lh-link-quiet" href="/editors">
            Editors
          </a>
          <a className="lh-link-quiet" href="/verify">
            Verify a bundle
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
          <h1>Your projects</h1>
          <div className="lh-home-actions">
            <button
              type="button"
              className="lh-button lh-button-primary"
              onClick={() => setMode(mode === 'new' ? 'none' : 'new')}
              aria-expanded={mode === 'new'}
            >
              New project
            </button>
            <button
              type="button"
              className="lh-button"
              onClick={() => setMode(mode === 'import' ? 'none' : 'import')}
              aria-expanded={mode === 'import'}
            >
              Import a draft
            </button>
          </div>
        </section>

        {mode === 'new' && (
          <NewProjectForm
            busy={busy}
            onCancel={() => setMode('none')}
            onSubmit={async (v) => {
              setBusy(true);
              setError(null);
              try {
                const { projectId, actorId } = await createProject(v);
                await postDraft(
                  getClient(),
                  humanDraft(projectId, actorId, 'DocumentCreated', {
                    documentId: newId(),
                    kind: 'manuscript',
                    title: 'Untitled',
                    parentId: null,
                    index: 0,
                  }),
                );
                open(projectId);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            }}
          />
        )}
        {mode === 'import' && (
          <ImportForm
            busy={busy}
            onCancel={() => setMode('none')}
            onSubmit={async (v) => {
              setBusy(true);
              setError(null);
              try {
                const content = draftToDoc(v.text, v.format);
                const { projectId, actorId } = await createProject(v);
                await postDraft(
                  getClient(),
                  humanDraft(projectId, actorId, 'DocumentImported', {
                    documentId: newId(),
                    kind: 'manuscript',
                    title: v.documentTitle.trim() || v.title.trim(),
                    parentId: null,
                    index: 0,
                    content,
                    sourceFormat: v.format,
                    sourceName: v.fileName,
                    sourceHash: await sha256Hex(new TextEncoder().encode(v.text)),
                  }),
                );
                open(projectId);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            }}
          />
        )}

        {error && (
          <p className="lh-error" role="alert">
            {error}
          </p>
        )}

        <section aria-label="Projects" className="lh-project-list">
          {projects === null && !error && <p className="lh-muted">Loading…</p>}
          {projects?.length === 0 && (
            <p className="lh-muted lh-empty">No projects yet. Start one, or bring in a draft.</p>
          )}
          <ul>
            {projects?.map((p) => (
              <li key={p.projectId}>
                <a href={`/p/${encodeURIComponent(p.projectId)}`} className="lh-project-row">
                  <span className="lh-project-title">{p.title}</span>
                  <span className="lh-muted lh-project-when">
                    {p.updatedAt ? when(p.updatedAt) : ''}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

function Field(props: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label className="lh-field">
      <span>{props.label}</span>
      <input
        name={props.name}
        value={props.value}
        required={props.required}
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        maxLength={200}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

function NewProjectForm(props: {
  busy: boolean;
  onSubmit: (v: { title: string; genre: string; audience: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [genre, setGenre] = useState('');
  const [audience, setAudience] = useState('');
  return (
    <form
      className="lh-card-form"
      aria-label="New project"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (title.trim()) props.onSubmit({ title, genre, audience });
      }}
    >
      <Field label="Title" name="title" value={title} onChange={setTitle} required autoFocus />
      <div className="lh-field-row">
        <Field
          label="Genre"
          name="genre"
          value={genre}
          onChange={setGenre}
          placeholder="Literary fiction, essay, report…"
        />
        <Field
          label="Audience"
          name="audience"
          value={audience}
          onChange={setAudience}
          placeholder="Who is it for?"
        />
      </div>
      <div className="lh-form-actions">
        <button type="button" className="lh-button lh-button-quiet" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="lh-button lh-button-primary"
          disabled={props.busy || !title.trim()}
        >
          Create project
        </button>
      </div>
    </form>
  );
}

function ImportForm(props: {
  busy: boolean;
  onSubmit: (v: {
    title: string;
    genre: string;
    audience: string;
    documentTitle: string;
    text: string;
    format: 'markdown' | 'text';
    fileName: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [genre, setGenre] = useState('');
  const [audience, setAudience] = useState('');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [format, setFormat] = useState<'markdown' | 'text'>('markdown');
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <form
      className="lh-card-form"
      aria-label="Import a draft"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (title.trim() && text.trim())
          props.onSubmit({ title, genre, audience, documentTitle: '', text, format, fileName });
      }}
    >
      <p className="lh-muted lh-form-note">
        An imported draft is labeled <em>imported (unverified)</em> in the provenance view and in
        every report: Longhand did not see it being written.
      </p>
      <Field label="Project title" name="title" value={title} onChange={setTitle} required />
      <div className="lh-field-row">
        <Field label="Genre" name="genre" value={genre} onChange={setGenre} />
        <Field label="Audience" name="audience" value={audience} onChange={setAudience} />
      </div>
      <label className="lh-field">
        <span>Draft</span>
        <textarea
          name="draft"
          rows={8}
          value={text}
          placeholder="Paste your draft here, or choose a .md or .txt file."
          onChange={(e) => {
            setText(e.target.value);
            setFileName(null);
          }}
        />
      </label>
      <div className="lh-field-row lh-import-file">
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/plain,text/markdown"
          aria-label="Choose a file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setText(await f.text());
            setFileName(f.name);
            setFormat(formatForName(f.name));
            if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ''));
          }}
        />
        <label className="lh-inline-choice">
          <input
            type="radio"
            name="format"
            checked={format === 'markdown'}
            onChange={() => setFormat('markdown')}
          />
          Markdown
        </label>
        <label className="lh-inline-choice">
          <input
            type="radio"
            name="format"
            checked={format === 'text'}
            onChange={() => setFormat('text')}
          />
          Plain text
        </label>
      </div>
      <div className="lh-form-actions">
        <button type="button" className="lh-button lh-button-quiet" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="lh-button lh-button-primary"
          disabled={props.busy || !title.trim() || !text.trim()}
        >
          Import
        </button>
      </div>
    </form>
  );
}
