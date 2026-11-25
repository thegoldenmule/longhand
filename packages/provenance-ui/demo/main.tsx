/**
 * Provenance demo: a golden fixture's ledger, the real editor over a
 * MockTransport, the tint, legend and span inspector, and the replay scrubber.
 * `pnpm --filter @longhand/provenance-ui demo`, then open http://localhost:4318.
 *
 * Query parameters: `fixture=<name>` (default `suggestions`), `doc=<documentId>`,
 * `view=write|replay`, `theme=light|dark`, `tint=1`. The Playwright suite drives
 * it through `window.__prov`.
 */
import { LonghandEditor, MemoryQueue, MockTransport, type EditorHandle } from '@longhand/editor';
import '@longhand/editor/styles.css';
import {
  documentNode,
  foldCommits,
  projectState,
  stateAtSeq,
  type LedgerState,
} from '@longhand/ledger';
import { EMPTY_DOC_JSON } from '@longhand/schema';
import type { FixtureFile } from '@longhand/ledger/fixtures';
import { StrictMode, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createProvenanceTint,
  ProvenanceInspector,
  ProvenanceLegend,
  ReplayScrubber,
  type ProvenanceTint,
} from '../src/index';
import '../src/styles.css';
import './demo.css';

const FILES = import.meta.glob<FixtureFile>('../../ledger/fixtures/*.json', {
  eager: true,
  import: 'default',
});
const FIXTURES = new Map(
  Object.entries(FILES)
    .map(([path, f]) => [path.replace(/^.*\/(.+)\.json$/, '$1'), f] as const)
    .filter(([, f]) => Array.isArray(f.commits) && f.commits.length > 0),
);
const FIXTURE_NAMES = [...FIXTURES.keys()].sort();

const params = new URLSearchParams(location.search);
type Theme = 'system' | 'light' | 'dark';
type View = 'write' | 'replay';

function setParam(key: string, value: string | null): void {
  const p = new URLSearchParams(location.search);
  if (value === null) p.delete(key);
  else p.set(key, value);
  history.replaceState(null, '', `${location.pathname}${p.size ? `?${p}` : ''}`);
}

function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

declare global {
  interface Window {
    __prov: {
      tint: ProvenanceTint;
      handle: EditorHandle | null;
      fixture: string;
      documentId: string;
      ready: boolean;
      /** Test hook: a document's text at a seq of the current fixture (null if absent). */
      textAt: (seq: number, documentId: string) => string | null;
    };
  }
}

const tint = createProvenanceTint({ enabled: params.get('tint') === '1' });
window.__prov = {
  tint,
  handle: null,
  fixture: '',
  documentId: '',
  ready: false,
  textAt: (seq, documentId) => {
    const f = FIXTURES.get(window.__prov.fixture);
    if (!f) return null;
    return documentNode(stateAtSeq(f.commits, seq), documentId)?.textContent ?? null;
  },
};

function Editor(props: {
  fixture: FixtureFile;
  documentId: string;
  onHandle: (h: EditorHandle) => void;
}): ReactElement {
  const doc = props.fixture.expected.state.documents[props.documentId]!;
  const transport = useMemo(
    () =>
      new MockTransport({
        documents: { [doc.id]: { doc: doc.content, version: doc.version } },
        latencyMs: 20,
      }),
    [doc],
  );
  const queue = useMemo(() => new MemoryQueue(`demo-${props.fixture.name}`), [props.fixture]);
  const settings = useMemo(() => ({ typewriter: false }), []);
  return (
    <LonghandEditor
      projectId={props.fixture.expected.state.projectId}
      documentId={doc.id}
      actorId="demo-writer"
      doc={doc.content}
      version={doc.version}
      transport={transport}
      queue={queue}
      settings={settings}
      extraPlugins={tint.plugins}
      attributes={{ 'aria-label': 'Manuscript', 'data-testid': 'manuscript' }}
      onReady={(h) => {
        tint.attach(h);
        tint.setRuns(doc.provenance, doc.version);
        props.onHandle(h);
      }}
    />
  );
}

function App(): ReactElement {
  const [fixtureName, setFixtureName] = useState(() => {
    const f = params.get('fixture');
    return f && FIXTURES.has(f) ? f : 'suggestions';
  });
  const fixture = FIXTURES.get(fixtureName)!;
  const documents = useMemo(
    () =>
      Object.values(fixture.expected.state.documents).sort(
        (a, b) =>
          (a.kind === 'manuscript' ? 0 : 1) - (b.kind === 'manuscript' ? 0 : 1) ||
          a.createdSeq - b.createdSeq,
      ),
    [fixture],
  );
  const [docParam, setDocParam] = useState(params.get('doc'));
  const documentId =
    docParam && fixture.expected.state.documents[docParam] ? docParam : documents[0]!.id;
  const docState = fixture.expected.state.documents[documentId]!;
  const [view, setView] = useState<View>(params.get('view') === 'replay' ? 'replay' : 'write');
  const [theme, setTheme] = useState<Theme>(() => {
    const t = params.get('theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  });
  const ledger = useMemo<LedgerState>(() => foldCommits(fixture.commits), [fixture]);
  const [scope, setScope] = useState<'document' | 'project'>('document');
  // The replay legend follows the scrubber: words by class at the shown seq.
  const [replayLedger, setReplayLedger] = useState<LedgerState | null>(null);
  const onSeqChange = useCallback((_seq: number, st: LedgerState) => setReplayLedger(st), []);
  const replayProject = useMemo(() => projectState(replayLedger ?? ledger), [replayLedger, ledger]);
  const replayDoc = replayProject.documents[documentId] ?? {
    content: EMPTY_DOC_JSON,
    provenance: [],
  };

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    window.__prov.fixture = fixtureName;
    window.__prov.documentId = documentId;
  }, [fixtureName, documentId]);

  return (
    <div className="demo">
      <header className="demo-bar">
        <span className="demo-brand">
          Longhand <span>· provenance</span>
        </span>
        <label>
          Ledger
          <select
            value={fixtureName}
            data-testid="fixture"
            onChange={(e) => {
              window.__prov.ready = false;
              setReplayLedger(null);
              setFixtureName(e.target.value);
              setDocParam(null);
              setParam('fixture', e.target.value);
              setParam('doc', null);
            }}
          >
            {FIXTURE_NAMES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {documents.length > 1 && view === 'write' && (
          <label>
            Document
            <select
              value={documentId}
              data-testid="document"
              onChange={(e) => {
                window.__prov.ready = false;
                setDocParam(e.target.value);
                setParam('doc', e.target.value);
              }}
            >
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="demo-tabs" role="tablist" aria-label="View">
          {(['write', 'replay'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              data-testid={`view-${v}`}
              onClick={() => {
                setView(v);
                setParam('view', v === 'write' ? null : v);
              }}
            >
              {v === 'write' ? 'Write' : 'Replay'}
            </button>
          ))}
        </div>
        <label className="demo-theme">
          Theme
          <select
            value={theme}
            data-testid="theme"
            onChange={(e) => {
              const t = e.target.value as Theme;
              setTheme(t);
              setParam('theme', t === 'system' ? null : t);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </header>

      <main className="demo-main">
        <div className="demo-page">
          {view === 'write' ? (
            <Editor
              key={`${fixtureName}/${documentId}`}
              fixture={fixture}
              documentId={documentId}
              onHandle={(h) => {
                window.__prov.handle = h;
                void h.ready.then(() => {
                  window.__prov.ready = true;
                });
              }}
            />
          ) : (
            <ReplayScrubber
              key={fixtureName}
              commits={fixture.commits}
              documentId={documentId}
              onDocumentChange={(id) => {
                setDocParam(id);
                setParam('doc', id);
              }}
              defaultScope="document"
              onSeqChange={onSeqChange}
            />
          )}
        </div>
        <aside className="demo-side">
          {view === 'write' ? (
            <>
              <ProvenanceLegend
                document={docState}
                tint={tint}
                title={docState.title}
                hint={
                  <>
                    Choose a class to highlight its words. Click any text, or put the caret in it
                    and press <kbd>Alt</kbd>+<kbd>Enter</kbd>, to see its history.
                  </>
                }
              />
            </>
          ) : (
            <>
              <div className="demo-scope" role="group" aria-label="Legend scope">
                <button
                  type="button"
                  aria-pressed={scope === 'document'}
                  onClick={() => setScope('document')}
                >
                  Document
                </button>
                <button
                  type="button"
                  aria-pressed={scope === 'project'}
                  onClick={() => setScope('project')}
                >
                  Project
                </button>
              </div>
              {scope === 'document' ? (
                <ProvenanceLegend document={replayDoc} title={docState.title} showToggle={false} />
              ) : (
                <ProvenanceLegend
                  project={{ state: replayProject }}
                  title={fixture.expected.state.settings.title}
                  showToggle={false}
                />
              )}
            </>
          )}
          <p className="demo-fixture">{fixture.description}</p>
        </aside>
      </main>

      {view === 'write' && (
        <ProvenanceInspector tint={tint} state={ledger} documentId={documentId} />
      )}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
