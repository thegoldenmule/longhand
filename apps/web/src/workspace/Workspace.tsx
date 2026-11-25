'use client';
/**
 * The project workspace: binder on the left, the page in the middle (editor and
 * annotation margin in one scrolling column), and a side panel on the right
 * (feedback, research, provenance, settings). Replay, the report and the
 * corkboard take the middle when chosen. Everything collapses to the page alone.
 *
 * State: the project's commits are kept and folded client-side (`ProjectStore`).
 * The editor syncs its document through `HttpCommitTransport`; every other part
 * reads the fold.
 */
import {
  FeedbackPanel,
  useAnnotations,
  useAnnotationsSnapshot,
  type AnnotationsController,
} from '@longhand/annotations';
import {
  Corkboard,
  applyBinderDrafts,
  getNode,
  type BinderDraft,
  type BinderModel,
} from '@longhand/binder';
import { HttpCommitTransport, type LonghandClient } from '@longhand/client';
import {
  DEFAULT_SETTINGS,
  type EditorHandle,
  type EditorSettings,
  type SaveState,
  type WordCounts,
} from '@longhand/editor';
import {
  ProvenanceInspector,
  createProvenanceTint,
  useProvenanceTint,
} from '@longhand/provenance-ui';
import type { ResearchDraft } from '@longhand/research';
import type { BinderRef, DocumentState, ProjectState } from '@longhand/schema';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { onAuthError } from '../auth/session';
import { getClient } from '../lib/client';
import { HumanEvents } from '../lib/drafts';
import { deviceId, editorSessionId, newId } from '../lib/ids';
import { ProjectStore, type ProjectSnapshot } from '../store/projectStore';
import { IconClose, IconSidebarLeft, IconSidebarRight } from '../ui/icons';
import { ThemeToggle } from '../ui/ThemeToggle';
import { BinderPane } from './BinderPane';
import { createCitationLabels } from './citationLabels';
import { EditorSurface } from './EditorSurface';
import { ExportDialog } from './ExportDialog';
import { ProvenancePane } from './ProvenancePane';
import { ReplayView } from './ReplayView';
import { ReportView } from './ReportView';
import { ResearchPane, type CiteIntent } from './ResearchPane';
import { SettingsPane } from './SettingsPane';
import { keyLabel, useShortcuts, type Shortcut } from './shortcuts';
import { StatusLine } from './StatusLine';

type View = 'write' | 'corkboard' | 'replay' | 'report';
type Tab = 'feedback' | 'research' | 'provenance' | 'settings';

const PREFS_KEY = 'longhand:editor-prefs';
const LAYOUT_KEY = 'longhand:layout';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...(JSON.parse(v) as T) } : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // per-page only
  }
}

/** The first manuscript document in binder order (or the first note). */
function firstDocument(state: ProjectState): string | null {
  const walk = (refs: readonly BinderRef[]): string | null => {
    for (const r of refs) {
      if (r.kind === 'document') {
        const d = state.documents[r.id];
        if (d && !d.archived) return r.id;
      } else {
        const f = state.folders[r.id];
        if (f && !f.archived) {
          const hit = walk(f.children);
          if (hit) return hit;
        }
      }
    }
    return null;
  };
  return walk(state.binder.manuscript) ?? walk(state.binder.notes);
}

const noSubscribe = () => () => undefined;
const noSnapshot = () => null;

export function Workspace({ projectId }: { projectId: string }) {
  const client = getClient();
  const [actorId, setActorId] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [store, setStore] = useState<ProjectStore | null>(null);

  useEffect(() => {
    client.me().then(
      (m) => setActorId(m.actorId),
      (e: unknown) => setFatal(e instanceof Error ? e.message : String(e)),
    );
  }, [client]);
  useEffect(() => {
    const s = new ProjectStore(client, projectId);
    setStore(s);
    void s.start();
    return () => s.dispose();
  }, [client, projectId]);

  const snap = useSyncExternalStore<ProjectSnapshot | null>(
    store?.subscribe ?? noSubscribe,
    store?.getSnapshot ?? noSnapshot,
    noSnapshot,
  );

  const error = fatal ?? (snap?.status === 'error' ? snap.error : null);
  if (error) {
    return (
      <main className="lh-center-page">
        <div className="lh-signin">
          <p className="lh-wordmark">Longhand</p>
          <p className="lh-error" role="alert">
            This project could not be opened. {error}
          </p>
          <a className="lh-button" href="/">
            All projects
          </a>
        </div>
      </main>
    );
  }
  if (!store || !snap || snap.status !== 'ready' || !snap.state || !actorId) {
    return (
      <main className="lh-center-page" aria-busy="true">
        <p className="lh-muted lh-loading">Opening…</p>
      </main>
    );
  }
  return (
    <WorkspaceReady
      key={projectId}
      client={client}
      store={store}
      snap={snap}
      state={snap.state}
      actorId={actorId}
      projectId={projectId}
    />
  );
}

function readUrl(): { doc: string | null; view: View | null } {
  const q = new URLSearchParams(location.search);
  const v = q.get('view');
  return {
    doc: q.get('doc'),
    view: v === 'replay' || v === 'report' || v === 'corkboard' || v === 'write' ? v : null,
  };
}

function WorkspaceReady(props: {
  client: LonghandClient;
  store: ProjectStore;
  snap: ProjectSnapshot;
  state: ProjectState;
  actorId: string;
  projectId: string;
}) {
  const { client, store, snap, state, actorId, projectId } = props;

  // ---------------------------------------------------------------- plumbing
  const [transport] = useState(
    () => new HttpCommitTransport({ client, projectId, onAuthError: () => onAuthError() }),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [events] = useState(() => new HumanEvents(transport, projectId, actorId, setToast));
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  events.editor = handle;
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // ------------------------------------------------------------ navigation
  const initial = useMemo(readUrl, []);
  const [docId, setDocId] = useState<string | null>(() =>
    initial.doc && state.documents[initial.doc] ? initial.doc : firstDocument(state),
  );
  const [view, setView] = useState<View>(initial.view ?? 'write');
  const [corkFolder, setCorkFolder] = useState<string | null>(null);
  const doc: DocumentState | null = (docId && state.documents[docId]) || null;

  useEffect(() => {
    if (!docId || !state.documents[docId] || state.documents[docId]?.archived) {
      const next = firstDocument(state);
      if (next !== docId) setDocId(next);
    }
  }, [docId, state]);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (docId) q.set('doc', docId);
    else q.delete('doc');
    if (view !== 'write') q.set('view', view);
    else q.delete('view');
    const qs = q.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
  }, [docId, view]);

  // ---------------------------------------------------------------- layout
  const [layout, setLayout] = useState(() =>
    loadJson(LAYOUT_KEY, { left: true, quiet: false as boolean }),
  );
  const [tab, setTab] = useState<Tab | null>(null);
  const [askNonce, setAskNonce] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [cite, setCite] = useState<CiteIntent | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  useEffect(() => saveJson(LAYOUT_KEY, layout), [layout]);
  const leftOpen = layout.left && !layout.quiet;
  const rightOpen = tab !== null && !layout.quiet;

  // ----------------------------------------------------------- preferences
  const [prefs, setPrefs] = useState<Omit<EditorSettings, 'dailyGoal'>>(() => {
    const { dailyGoal: _d, ...rest } = DEFAULT_SETTINGS;
    return loadJson(PREFS_KEY, rest);
  });
  useEffect(() => saveJson(PREFS_KEY, prefs), [prefs]);
  const settings: EditorSettings = useMemo(
    () => ({ ...prefs, dailyGoal: state.settings.dailyWordGoal }),
    [prefs, state.settings.dailyWordGoal],
  );

  // ------------------------------------------------------------ status line
  const [counts, setCounts] = useState<WordCounts | null>(null);
  const [save, setSave] = useState<{ state: SaveState; queued: number } | null>(null);
  useEffect(() => {
    setCounts(null);
    setSave(null);
  }, [docId]);

  // ---------------------------------------------------------- provenance
  const [tint] = useState(() => createProvenanceTint());
  const tintSnap = useProvenanceTint(tint);
  useEffect(() => (handle ? tint.attach(handle) : undefined), [handle, tint]);
  useEffect(() => {
    if (!handle || !doc) return;
    const apply = () => {
      if (tint.getSnapshot().version !== doc.version || tint.getSnapshot().stale)
        tint.setRuns(doc.provenance, doc.version);
    };
    tint.setRuns(doc.provenance, doc.version);
    // The fold can be a step ahead of the editor (a proposal's derived steps):
    // retry once the editor catches up.
    return handle.on('version', apply);
  }, [handle, doc, tint]);

  // ---------------------------------------------------------- annotations
  const ann = useAnnotations({
    documentId: docId ?? '',
    editor: handle,
    state,
    onCite: (r) => {
      setTab('research');
      setCite({
        ...(r.sourceId ? { sourceId: r.sourceId } : {}),
        ...(r.range ? { at: r.range.to } : {}),
      });
    },
    onAddSource: () => setTab('research'),
    onError: (e) => setToast(e instanceof Error ? e.message : String(e)),
  });
  useEffect(
    () =>
      store.onProgress((e) => {
        if (e.kind !== 'ended') ann.pushProgress(e);
      }),
    [store, ann],
  );
  const annSnap = useAnnotationsSnapshot(ann);
  const [citeLabels] = useState(createCitationLabels);
  const plugins = useMemo(
    () => [...ann.plugins, ...tint.plugins, citeLabels.plugin],
    [ann, tint, citeLabels],
  );
  useEffect(() => {
    if (handle) citeLabels.refresh(handle.view, state.sources, state.settings.citationStyle);
  }, [handle, citeLabels, state.sources, state.settings.citationStyle]);

  // --------------------------------------------------------------- binder
  const [pending, setPending] = useState<Array<{ commitId: string; draft: BinderDraft }>>([]);
  useEffect(() => {
    setPending((p) =>
      p.some((x) => store.has(x.commitId)) ? p.filter((x) => !store.has(x.commitId)) : p,
    );
  }, [snap.headSeq, store]);
  const binderModel: BinderModel = useMemo(
    () =>
      applyBinderDrafts(
        state,
        pending.map((p) => p.draft),
      ).model,
    [state, pending],
  );
  const onBinderDraft = useCallback(
    (d: BinderDraft) => {
      const commitId = events.submit(d.type, d.payload as never);
      setPending((p) => [...p, { commitId, draft: d }]);
    },
    [events],
  );
  const onResearchDraft = useCallback(
    (d: ResearchDraft) => {
      // Citations go in through the editor's own Cite command (with their companion).
      if (d.type === 'CitationInserted') return;
      events.submit(d.type, d.payload as never);
    },
    [events],
  );
  const draftContext = useMemo(
    () => ({
      projectId,
      actor: { kind: 'human' as const, id: actorId },
      deviceId: deviceId(),
      sessionId: editorSessionId(),
    }),
    [projectId, actorId],
  );

  const select = (ref: BinderRef) => {
    if (ref.kind === 'document') {
      setDocId(ref.id);
      if (view !== 'corkboard') setView('write');
      else setCorkFolder(state.documents[ref.id]?.parentId ?? null);
    } else {
      setCorkFolder(ref.id);
    }
  };
  const corkArea =
    (corkFolder && state.folders[corkFolder]?.area) ||
    (doc?.kind === 'note' ? 'notes' : 'manuscript');
  const corkParent = corkFolder ?? doc?.parentId ?? null;
  const corkShown =
    corkParent && getNode(binderModel, { kind: 'folder', id: corkParent }) ? corkParent : null;

  // ------------------------------------------------------------- actions
  const askForFeedback = () => {
    setLayout((l) => ({ ...l, quiet: false }));
    setTab('feedback');
    setAskNonce((n) => n + 1);
    setView('write');
  };
  const toggleTint = () => tint.toggle();
  const togglePanel = (t: Tab) => {
    setLayout((l) => ({ ...l, quiet: false }));
    setTab((cur) => (cur === t ? null : t));
  };
  const cycleFocus = () =>
    setPrefs((p) => ({
      ...p,
      focusMode:
        p.focusMode === 'off' ? 'sentence' : p.focusMode === 'sentence' ? 'paragraph' : 'off',
    }));

  const shortcuts: Shortcut[] = useMemo(() => {
    const list: Shortcut[] = [
      {
        keys: 'Mod-Backslash',
        label: 'Show or hide the binder',
        run: () => setLayout((l) => ({ ...l, left: !l.left, quiet: false })),
      },
      {
        keys: 'Mod-Shift-Backslash',
        label: 'Show or hide the side panel',
        run: () => setTab((t) => (t ? null : 'feedback')),
      },
      {
        keys: 'Mod-Alt-Backslash',
        label: 'Just the page (hide everything)',
        run: () => setLayout((l) => ({ ...l, quiet: !l.quiet })),
      },
      { keys: 'Mod-Alt-KeyP', label: 'Provenance tint', run: () => tint.toggle() },
      { keys: 'Mod-Alt-Period', label: 'Focus mode (off, sentence, paragraph)', run: cycleFocus },
      { keys: 'Mod-Slash', label: 'Keyboard shortcuts', run: () => setShowKeys((s) => !s) },
    ];
    if (view === 'replay' || view === 'report' || view === 'corkboard')
      list.push({ keys: 'Escape', label: 'Back to writing', run: () => setView('write') });
    return list;
    // `cycleFocus` and the setters are stable in effect.
  }, [view, tint]);
  useShortcuts(shortcuts);

  const newDocument = () => {
    const documentId = newId();
    onBinderDraft({
      type: 'DocumentCreated',
      payload: {
        documentId,
        kind: 'manuscript',
        title: 'Untitled',
        parentId: null,
        index: state.binder.manuscript.length,
      },
    });
    setDocId(documentId);
  };

  const hasCards = annSnap.marginCards.length > 0;
  const title = state.settings.title;

  return (
    <div
      className="ws"
      data-left={leftOpen ? 'open' : 'closed'}
      data-right={rightOpen ? 'open' : 'closed'}
      data-quiet={layout.quiet ? 'true' : 'false'}
      data-tint={tintSnap.enabled ? 'on' : 'off'}
    >
      {leftOpen && (
        <BinderPane
          title={title}
          model={binderModel}
          selected={
            view === 'corkboard' && corkFolder
              ? { kind: 'folder', id: corkFolder }
              : docId
                ? { kind: 'document', id: docId }
                : null
          }
          corkboard={view === 'corkboard'}
          onCorkboard={(on) => setView(on ? 'corkboard' : 'write')}
          onSelect={select}
          onDraft={onBinderDraft}
          onError={setToast}
        />
      )}

      <div className="ws-center">
        <header className="ws-bar" aria-label="Workspace">
          <span className="ws-bar-start">
            <button
              type="button"
              className="lh-icon-button"
              aria-label={leftOpen ? 'Hide binder' : 'Show binder'}
              title={`${leftOpen ? 'Hide' : 'Show'} binder (${keyLabel('Mod-Backslash')})`}
              aria-pressed={leftOpen}
              data-testid="toggle-binder"
              onClick={() => setLayout((l) => ({ ...l, left: !leftOpen, quiet: false }))}
            >
              <IconSidebarLeft />
            </button>
            {!leftOpen && (
              <a href="/" className="ws-crumb" title="All projects">
                {title}
              </a>
            )}
            {doc && (
              <span className="ws-doc-title" data-testid="document-title">
                {doc.title}
                {doc.imported && (
                  <span
                    className="ws-badge"
                    title="Brought in from an existing draft; Longhand did not see it being written."
                  >
                    imported (unverified)
                  </span>
                )}
              </span>
            )}
          </span>
          <nav className="ws-tools" aria-label="Tools">
            <button
              type="button"
              className="ws-tool"
              data-testid="ask-feedback"
              onClick={askForFeedback}
              disabled={!doc || doc.kind === 'note'}
            >
              Ask for feedback
            </button>
            <button
              type="button"
              className="ws-tool"
              aria-pressed={tintSnap.enabled}
              data-testid="toggle-tint"
              title={`Tint text by origin (${keyLabel('Mod-Alt-KeyP')})`}
              onClick={toggleTint}
            >
              Provenance
            </button>
            <button
              type="button"
              className="ws-tool"
              aria-pressed={view === 'replay'}
              data-testid="open-replay"
              onClick={() => setView(view === 'replay' ? 'write' : 'replay')}
            >
              Replay
            </button>
            <button
              type="button"
              className="ws-tool"
              aria-pressed={view === 'report'}
              data-testid="open-report"
              onClick={() => setView(view === 'report' ? 'write' : 'report')}
            >
              Report
            </button>
            <button
              type="button"
              className="ws-tool"
              data-testid="open-export"
              onClick={() => setExporting(true)}
            >
              Export
            </button>
            <span className="ws-tools-sep" aria-hidden />
            <ThemeToggle />
            <button
              type="button"
              className="lh-icon-button"
              aria-label={rightOpen ? 'Hide side panel' : 'Show side panel'}
              title={`Side panel (${keyLabel('Mod-Shift-Backslash')})`}
              aria-pressed={rightOpen}
              data-testid="toggle-panel"
              onClick={() => (rightOpen ? setTab(null) : togglePanel('research'))}
            >
              <IconSidebarRight />
            </button>
          </nav>
        </header>

        <main className="ws-main" data-view={view}>
          {doc ? (
            <EditorSurface
              projectId={projectId}
              actorId={actorId}
              document={doc}
              transport={transport}
              settings={settings}
              plugins={plugins}
              controller={ann}
              showMargin={hasCards}
              hidden={view !== 'write'}
              onReady={setHandle}
              onStatus={(s) => setSave({ state: s.state, queued: s.unacknowledged })}
              onWordCount={setCounts}
            />
          ) : (
            view === 'write' && (
              <div className="ws-empty">
                <p>This project has no documents yet.</p>
                <button type="button" className="lh-button lh-button-primary" onClick={newDocument}>
                  New document
                </button>
              </div>
            )
          )}
          {view === 'corkboard' && (
            <div className="ws-view ws-cork" data-testid="corkboard-view">
              <CorkboardHead
                model={binderModel}
                area={corkArea}
                folderId={corkShown}
                onUp={(id) => setCorkFolder(id)}
              />
              <Corkboard
                model={binderModel}
                area={corkArea}
                folderId={corkShown}
                onDraft={onBinderDraft}
                onOpen={(ref) => {
                  if (ref.kind === 'document') {
                    setDocId(ref.id);
                    setView('write');
                  } else setCorkFolder(ref.id);
                }}
                selected={docId ? { kind: 'document', id: docId } : null}
                showWordCounts
              />
            </div>
          )}
          {view === 'replay' && (
            <ReplayView
              commits={snap.commits}
              replay={snap.replay}
              documentId={docId}
              onDocumentChange={setDocId}
            />
          )}
          {view === 'report' && (
            <ReportView
              client={client}
              projectId={projectId}
              title={title}
              headSeq={snap.headSeq}
              documentId={docId}
              documentTitle={doc?.title ?? null}
              onExport={() => setExporting(true)}
            />
          )}
        </main>

        <StatusLine
          counts={view === 'write' ? counts : null}
          save={save?.state ?? null}
          queued={save?.queued ?? 0}
          live={snap.live}
          documentTitle={doc?.title ?? null}
        />
      </div>

      {rightOpen && (
        <aside className="ws-right" aria-label="Side panel" data-testid="side-panel">
          <div className="ws-tabs" role="tablist" aria-label="Side panel">
            {(
              [
                ['feedback', 'Feedback'],
                ['research', 'Research'],
                ['provenance', 'Provenance'],
                ['settings', 'Settings'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                data-testid={`tab-${id}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className="lh-icon-button ws-tabs-close"
              aria-label="Close side panel"
              onClick={() => setTab(null)}
            >
              <IconClose />
            </button>
          </div>
          <div className="ws-right-body">
            {tab === 'feedback' && <FeedbackTab controller={ann} doc={doc} nonce={askNonce} />}
            {tab === 'research' && (
              <ResearchPane
                state={state}
                client={client}
                draftContext={draftContext}
                onDraft={onResearchDraft}
                editor={handle}
                documentId={docId}
                cite={cite}
                onCite={setCite}
                onStyleChange={(citationStyle) =>
                  state.settings.citationStyle !== citationStyle &&
                  events.submit('ProjectSettingsChanged', { patch: { citationStyle } })
                }
                onShowTarget={(id) => {
                  setView('write');
                  ann.focus(id);
                }}
              />
            )}
            {tab === 'provenance' && <ProvenancePane tint={tint} document={doc} state={state} />}
            {tab === 'settings' && (
              <SettingsPane
                settings={state.settings}
                onDraft={onBinderDraft}
                prefs={settings}
                onPrefs={(p) => setPrefs((cur) => ({ ...cur, ...p }))}
              />
            )}
          </div>
        </aside>
      )}

      {docId && <ProvenanceInspector tint={tint} state={snap.ledger} documentId={docId} />}

      {exporting && (
        <ExportDialog
          client={client}
          projectId={projectId}
          commits={snap.commits}
          headHash={state.headHash}
          documentId={docId}
          documentTitle={doc?.title ?? null}
          onClose={() => setExporting(false)}
        />
      )}
      {showKeys && <ShortcutSheet shortcuts={shortcuts} onClose={() => setShowKeys(false)} />}
      {toast && (
        <div className="ws-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function CorkboardHead(props: {
  model: BinderModel;
  area: 'manuscript' | 'notes';
  folderId: string | null;
  onUp: (folderId: string | null) => void;
}) {
  const folder = props.folderId ? props.model.folders[props.folderId] : null;
  return (
    <header className="ws-cork-head">
      <h2>{folder ? folder.title : props.area === 'notes' ? 'Notes' : 'Manuscript'}</h2>
      {folder && (
        <button type="button" className="ws-cork-up" onClick={() => props.onUp(folder.parentId)}>
          ↑{' '}
          {folder.parentId
            ? (props.model.folders[folder.parentId]?.title ?? 'Up')
            : props.area === 'notes'
              ? 'Notes'
              : 'Manuscript'}
        </button>
      )}
    </header>
  );
}

function FeedbackTab(props: {
  controller: AnnotationsController;
  doc: DocumentState | null;
  nonce: number;
}) {
  if (!props.doc || props.doc.kind === 'note')
    return <p className="ws-note">Open a manuscript document to ask the editor about it.</p>;
  return (
    <FeedbackPanel
      key={props.nonce}
      controller={props.controller}
      documentTitle={props.doc.title}
      {...(props.nonce > 0 ? { formOpen: true } : {})}
    />
  );
}

function ShortcutSheet(props: { shortcuts: readonly Shortcut[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="ws-dialog" aria-labelledby="keys-title" onClose={props.onClose}>
      <h2 id="keys-title">Keyboard</h2>
      <dl className="ws-keys">
        {props.shortcuts.map((s) => (
          <div key={s.keys}>
            <dt>
              <kbd>{keyLabel(s.keys)}</kbd>
            </dt>
            <dd>{s.label}</dd>
          </div>
        ))}
        <div>
          <dt>
            <kbd>Alt-Enter</kbd>
          </dt>
          <dd>Inspect the text at the caret (with the tint on)</dd>
        </div>
      </dl>
      <p className="ws-note">
        Formatting: Markdown shortcuts as you type (#, &gt;, -, *em*, **strong**).
      </p>
      <div className="lh-form-actions">
        <button type="button" className="lh-button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
