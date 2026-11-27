'use client';
/**
 * The project workspace: binder on the left, the page in the middle (editor and
 * annotation margin in one scrolling column), and a side panel on the right
 * (feedback, research, provenance, settings). The header keeps only "Ask for
 * feedback"; the tint, replay, report and export live in the Provenance tab.
 * Replay, the report and the corkboard take the middle when chosen. Everything
 * collapses to the page alone.
 *
 * One document, one name: when the manuscript is a single document it goes by
 * the project's name, shown once (in the header) and edited there. Renaming it
 * renames the project too. A one-document project opens with the binder closed.
 * With several documents the project and each document keep their own names.
 *
 * State: the project's commits are kept and folded client-side (`ProjectStore`).
 * The editor syncs its document through `HttpCommitTransport`; every other part
 * reads the fold.
 */
import {
  FeedbackChat,
  useAnnotations,
  useAnnotationsSnapshot,
  type AnnotationsController,
} from '@longhand/annotations';
import {
  Corkboard,
  UNTITLED,
  applyBinderDraft,
  applyBinderDrafts,
  changeProjectSettings,
  getNode,
  renameNode,
  renameProjectAndDocument,
  soleManuscriptDocument,
  withTitleLink,
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
import { editorsHref, useEditors, type EditorsState } from '../lib/editors';
import { HumanEvents } from '../lib/drafts';
import { deviceId, editorSessionId, newId } from '../lib/ids';
import { ProjectStore, type ProjectSnapshot } from '../store/projectStore';
import { IconBack, IconClose, IconSidebarLeft, IconSidebarRight } from '../ui/icons';
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
import { TitleField } from './TitleField';
import { workspaceTitles } from './titles';

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
  const editors = useEditors();

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
  // A one-document project opens with the binder closed. Otherwise it opens the way
  // you left it, and `layout.left` remembers only multi-document projects.
  const [openedSingle] = useState(() => soleManuscriptDocument(state) !== null);
  const [binderOpen, setBinderOpen] = useState<boolean | null>(null);
  const leftPref = binderOpen ?? (openedSingle ? false : layout.left);
  const [tab, setTab] = useState<Tab | null>(null);
  const [exporting, setExporting] = useState(false);
  const [cite, setCite] = useState<CiteIntent | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  useEffect(() => saveJson(LAYOUT_KEY, layout), [layout]);
  const leftOpen = leftPref && !layout.quiet;
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
    // The feedback chat: Discuss and Ask for feedback open it in the side panel.
    onOpenChat: () => {
      setLayout((l) => ({ ...l, quiet: false }));
      setTab('feedback');
    },
    onCancelSession: (id) => {
      client.cancelSession(projectId, id).catch((e: unknown) => {
        setToast(`Could not stop the editor. ${e instanceof Error ? e.message : String(e)}`);
      });
    },
    // With no document open there is no editor queue: post directly.
    submitWithoutEditor: (e) => {
      events.submit(e.type, e.payload as never);
    },
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
  // The model as of the drafts emitted so far, even between renders.
  const latestModel = useRef(binderModel);
  latestModel.current = binderModel;
  const onBinderDraft = useCallback(
    (d: BinderDraft) => {
      // Ending single-document mode first renames the sole document to the name it was shown with.
      for (const draft of withTitleLink(latestModel.current, d)) {
        const commitId = events.submit(draft.type, draft.payload as never);
        setPending((p) => [...p, { commitId, draft }]);
        const next = applyBinderDraft(latestModel.current, draft);
        if (next.ok) latestModel.current = next.model;
      }
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

  // ---------------------------------------------------------------- titles
  const titles = workspaceTitles(binderModel, docId);
  const { mode, soleId, projectTitle } = titles;
  const isSingle = mode === 'single';
  useEffect(() => {
    document.title = `${projectTitle} · Longhand`;
  }, [projectTitle]);
  useEffect(() => {
    if (isSingle && view === 'corkboard') setView('write');
  }, [isSingle, view]);
  // Archiving down to one document: it goes by the project's name from now on.
  const prevMode = useRef(mode);
  useEffect(() => {
    const was = prevMode.current;
    prevMode.current = mode;
    if (was !== 'multi' || mode !== 'single' || !soleId) return;
    if (binderModel.documents[soleId]?.title !== projectTitle)
      setToast('One document left. It goes by the project’s name now.');
  }, [mode, soleId, binderModel, projectTitle]);

  const showRefusal = (
    res: { ok: true } | { ok: false; error: { code: string; message: string } },
  ) => {
    if (!res.ok && res.error.code !== 'no-op') setToast(res.error.message);
  };
  /** Renames from the header: the project and its sole document, a document or note, or (empty) the project. */
  const renameFromHeader = (title: string) => {
    const m = latestModel.current;
    if (soleId && docId === soleId) {
      const res = renameProjectAndDocument(m, soleId, title);
      if (res.ok) res.drafts.forEach(onBinderDraft);
      else showRefusal(res);
    } else if (docId && m.documents[docId]) {
      const res = renameNode(m, { kind: 'document', id: docId }, title);
      if (res.ok) onBinderDraft(res.draft);
      else showRefusal(res);
    } else renameProject(title);
  };
  const renameProject = (title: string) => {
    const res = changeProjectSettings(latestModel.current, { title });
    if (res.ok) onBinderDraft(res.draft);
    else showRefusal(res);
  };
  const backToPage = () => handle?.focus();

  /** Shows or hides the binder; only multi-document projects remember it. */
  const setLeft = (open: boolean) => {
    setBinderOpen(open);
    setLayout((l) => ({ ...l, ...(isSingle ? {} : { left: open }), quiet: false }));
  };
  const toggleBinder = useRef<() => void>(() => undefined);
  toggleBinder.current = () => setLeft(!leftOpen);

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
    setView('write');
    // Focuses the chat's composer; a selection is attached automatically.
    ann.openChat();
  };
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
        run: () => toggleBinder.current(),
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
        title: UNTITLED,
        parentId: null,
        index: state.binder.manuscript.length,
      },
    });
    setDocId(documentId);
  };

  const hasCards = annSnap.marginCards.length > 0;
  // The open document as the binder sees it (optimistic), for the header.
  const shownDoc = docId ? binderModel.documents[docId] : undefined;
  const docLabel = shownDoc?.kind === 'note' ? 'Note title' : 'Document title';
  const badge = shownDoc?.imported && (
    <span
      className="ws-badge"
      data-testid="imported-badge"
      title="Brought in from an existing draft. Longhand did not see it being written."
    >
      imported (unverified)
    </span>
  );

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
          model={binderModel}
          single={mode !== 'multi'}
          {...(soleId ? { hide: [{ kind: 'document', id: soleId }] } : {})}
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
              onClick={() => setLeft(!leftOpen)}
            >
              <IconSidebarLeft />
            </button>
            {!leftOpen && (
              <a href="/" className="ws-home-link" title="All projects" aria-label="All projects">
                <IconBack />
              </a>
            )}
            {mode === 'multi' && !leftOpen && <span className="ws-crumb">{projectTitle}</span>}
            {mode === 'empty' && (
              <span className={shownDoc ? 'ws-crumb' : 'ws-doc-title'}>
                <TitleField
                  value={projectTitle}
                  label="Project title"
                  testId="project-title"
                  onCommit={renameProject}
                  onDone={backToPage}
                />
              </span>
            )}
            {titles.crumb && (
              <button
                type="button"
                className="ws-crumb ws-crumb-button"
                aria-label={`Open ‘${titles.crumb.title}’`}
                onClick={() => {
                  setDocId(titles.crumb?.documentId ?? null);
                  setView('write');
                }}
              >
                {titles.crumb.title}
              </button>
            )}
            {titles.docTitle !== null && (
              <span className="ws-doc-title">
                <TitleField
                  value={titles.docTitle}
                  label={isSingle && docId === soleId ? 'Title' : docLabel}
                  testId="document-title"
                  onCommit={renameFromHeader}
                  onDone={backToPage}
                />
                {badge}
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
              title={projectTitle}
              single={isSingle}
              headSeq={snap.headSeq}
              documentId={docId}
              documentTitle={titles.docTitle}
              onExport={() => setExporting(true)}
            />
          )}
        </main>

        <StatusLine
          counts={view === 'write' ? counts : null}
          save={save?.state ?? null}
          queued={save?.queued ?? 0}
          live={snap.live}
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
          <div className={`ws-right-body${tab === 'feedback' ? ' is-chat' : ''}`}>
            {tab === 'feedback' && (
              <FeedbackTab
                controller={ann}
                doc={doc}
                docTitle={titles.docTitle}
                editors={editors}
                projectId={projectId}
              />
            )}
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
            {tab === 'provenance' && (
              <ProvenancePane
                tint={tint}
                document={doc}
                state={state}
                single={isSingle}
                tintKey={keyLabel('Mod-Alt-KeyP')}
                view={view === 'replay' || view === 'report' ? view : 'other'}
                onReplay={() => setView(view === 'replay' ? 'write' : 'replay')}
                onReport={() => setView(view === 'report' ? 'write' : 'report')}
                onExport={() => setExporting(true)}
              />
            )}
            {tab === 'settings' && (
              <SettingsPane
                editorsHref={editorsHref(projectId)}
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
          single={isSingle}
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
  /** The open document's title as shown. */
  docTitle: string | null;
  editors: EditorsState;
  projectId: string;
}) {
  // A manuscript document is the default context; with none (or a note) open, the project.
  const title = props.doc && props.doc.kind === 'manuscript' ? props.docTitle : null;
  return (
    <>
      {props.editors.error && !props.editors.editors && (
        <p className="lh-error" role="alert">
          Couldn’t load your editors. {props.editors.error}{' '}
          <button type="button" className="lh-link-quiet" onClick={props.editors.reload}>
            Try again
          </button>
        </p>
      )}
      <FeedbackChat
        controller={props.controller}
        documentTitle={title}
        editors={props.editors.editors}
        manageEditorsHref={editorsHref(props.projectId)}
      />
    </>
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
        Formatting: Markdown shortcuts as you type (#, &gt;, -, *em*, **strong**, `code`,
        [text](url)). Select text for the toolbar. <kbd>{keyLabel('Mod-KeyK')}</kbd> adds a link and{' '}
        <kbd>{keyLabel('Alt-F10')}</kbd> moves into the toolbar.
      </p>
      <div className="lh-form-actions">
        <button type="button" className="lh-button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
