/**
 * Demo of the annotation layer over the real editor.
 * `pnpm --filter @longhand/annotations demo`, then open http://localhost:4319.
 *
 * The transport folds every draft with `@longhand/ledger` (`validateDraft`), so
 * trace-over resolutions and proposal acceptance run the real fold. The ledger is
 * seeded from a golden fixture, stopped after its first finished review so the
 * cards are still open.
 *
 * Query parameters:
 * - `seed=suggestions|proposals|feedback-session|discuss|research|chat|empty`
 *   (`empty`: nothing asked yet — say something in the chat to watch a reply stream in);
 * - `upto=all` to load the whole fixture instead of stopping after the first review;
 * - `theme=light|dark`; `idle=<ms>` batch idle time (default 600);
 * - `fail=1` makes the mock reviewer fail, to show the calm failure and retry;
 * - the mock leaves notes when a chat message contains "review", and replies only otherwise;
 * - `step=<ms>` the mock reviewer's pace.
 *
 * The Playwright suite drives it through `window.__ann`.
 */
import { LonghandEditor, MemoryQueue, type EditorHandle } from '@longhand/editor';
import '@longhand/editor/styles.css';
import { STARTER_EDITORS, type EditorProfile, type ProjectState } from '@longhand/schema';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AnnotationMargin,
  FeedbackChat,
  useAnnotations,
  type AnnotationsController,
  type CiteRequest,
} from '../src/index';
import '../src/styles.css';
import { fixtureCommits, isAnnotationFixture } from '../test-support/fixtureData';
import { FoldingTransport, untilFirstReview } from '../test-support/foldingTransport';
import { MockReviewer } from '../test-support/mockReviewer';
import './demo.css';

const params = new URLSearchParams(location.search);
/** The writer's editors: the starters, with fixed ids. */
const EDITORS: EditorProfile[] = STARTER_EDITORS.map((e, i) => ({ ...e, id: `editor-${i + 1}` }));
const seedName = params.get('seed') ?? 'suggestions';
const theme = params.get('theme');
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;

function seedCommits() {
  if (seedName === 'empty') {
    const all = fixtureCommits('feedback-session');
    return all.slice(
      0,
      all.findIndex((c) => c.type === 'FeedbackRequested'),
    );
  }
  const name = isAnnotationFixture(seedName) ? seedName : 'suggestions';
  const all = fixtureCommits(name);
  return params.get('upto') === 'all' ? all : untilFirstReview(all);
}

const transport = new FoldingTransport({ commits: seedCommits(), latencyMs: 25 });
const initial = transport.projectState();
const doc = Object.values(initial.documents).find((d) => d.kind === 'manuscript')!;
const queue = new MemoryQueue(initial.projectId);
const cites: CiteRequest[] = [];

declare global {
  interface Window {
    __ann: {
      transport: FoldingTransport;
      handle: EditorHandle | null;
      controller: AnnotationsController | null;
      reviewer: MockReviewer;
      cites: CiteRequest[];
      state: () => ProjectState;
    };
  }
}

let controllerRef: AnnotationsController | null = null;
const reviewer = new MockReviewer(transport, {
  stepMs: Number(params.get('step') ?? 450),
  fail: () => params.get('fail') === '1',
  onProgress: (event) => controllerRef?.pushProgress(event),
});

window.__ann = {
  transport,
  handle: null,
  controller: null,
  reviewer,
  cites,
  state: () => transport.projectState(),
};

function App(): React.JSX.Element {
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const [state, setState] = useState<ProjectState>(initial);
  const [dark, setDark] = useState(
    theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => transport.onState((s) => setState(s)), []);

  const ann = useAnnotations({
    documentId: doc.id,
    editor: handle,
    state,
    onCite: (r) => {
      // The web app opens the research lane's <CitationPicker> here.
      cites.push(r);
      console.info('cite', r);
    },
    onAddSource: (r) => console.info('check and add', r),
    // The chat is always on screen here; Discuss attaches the note to it.
    onOpenChat: () => undefined,
    onCancelSession: (id) => reviewer.cancel(id),
  });
  controllerRef = ann;
  window.__ann.controller = ann;

  const settings = useMemo(() => ({ typewriter: true, caretRatio: 0.45 }), []);
  const idle = Number(params.get('idle') ?? 600);
  const docState = state.documents[doc.id];

  return (
    <div className="demo-shell">
      <header className="demo-bar">
        <span className="demo-title">{state.settings.title}</span>
        <span className="demo-doc">{docState?.title}</span>
        <nav className="demo-seeds" aria-label="Seed ledger">
          {[
            'empty',
            'suggestions',
            'proposals',
            'feedback-session',
            'discuss',
            'research',
            'chat',
          ].map((s) => (
            <a
              key={s}
              href={`?seed=${s}${theme ? `&theme=${theme}` : ''}`}
              aria-current={s === seedName ? 'page' : undefined}
            >
              {s}
            </a>
          ))}
        </nav>
        <button
          type="button"
          className="demo-theme"
          onClick={() => {
            const next = !dark;
            setDark(next);
            document.documentElement.dataset.theme = next ? 'dark' : 'light';
          }}
        >
          {dark ? 'Light' : 'Dark'}
        </button>
      </header>
      <main className="demo-page">
        <LonghandEditor
          className="demo-editor"
          projectId={initial.projectId}
          documentId={doc.id}
          actorId="writer-1"
          doc={doc.content}
          version={doc.version}
          transport={transport}
          queue={queue}
          settings={settings}
          batch={{ idleMs: idle }}
          extraPlugins={ann.plugins}
          attributes={{ 'aria-label': 'Manuscript', 'data-testid': 'manuscript' }}
          onReady={(h) => {
            window.__ann.handle = h;
            setHandle(h);
          }}
        />
        <AnnotationMargin controller={ann} className="demo-margin" />
      </main>
      <aside className="demo-panel">
        <FeedbackChat
          controller={ann}
          editors={EDITORS}
          manageEditorsHref="#editors"
          documentTitle={docState?.title ?? null}
        />
      </aside>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
