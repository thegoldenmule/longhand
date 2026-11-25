/**
 * Standalone demo of the Longhand editor over the in-memory mock ledger.
 * `pnpm --filter @longhand/editor demo`, then open http://localhost:4317.
 *
 * Query parameters: `offline=1` start offline, `ratio=0.4` caret height,
 * `focus=sentence|paragraph`, `idle=<ms>` batch idle time, `reset=1` clear the
 * persisted ledger and queue. The Playwright suite drives it through
 * `window.__longhand`.
 */
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  IndexedDbQueue,
  LonghandEditor,
  MockTransport,
  sharedFlusher,
  type EditorHandle,
  type FocusMode,
  type SyncStatus,
  type WordCounts,
} from '../src/index';
import '../src/styles.css';
import './demo.css';

const params = new URLSearchParams(location.search);
const PROJECT = 'demo-project';
const DOC = 'demo-doc';
const LEDGER_KEY = 'longhand-demo-ledger';

const SAMPLE = [
  'The rain had been falling sideways since noon, and by evening the whole street seemed to lean with it. Mara kept the lamp low. She had a letter to finish and no particular wish to finish it.',
  'Somewhere below, a door banged twice and was still. She wrote a sentence, crossed it out in her head, and wrote it again exactly the same way. That was how it went on nights like this: the words came back around like dogs that had been sent away.',
  'Her brother would read it in the morning. He would read it standing up, the way he read everything, as if sitting down would commit him to an opinion. She did not mind. She only wanted him to read it to the end.',
  'Outside, the gutters ran loud and bright under the streetlights. A car went by slowly, its wipers keeping a patient time. She thought of the harbour, of the boats knocking against each other in the dark, of how the sound carried all the way up the hill when the wind was right.',
  'There was a way of telling it that would make him laugh, and a way that would make him angry, and she suspected there was a third way, harder than either, that would simply make him understand. She did not know yet which one she was writing.',
  'The lamp flickered. She waited for it to steady and then went on.',
];

if (params.get('reset') === '1') {
  localStorage.removeItem(LEDGER_KEY);
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase('longhand-editor');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
  params.delete('reset');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
}

const transport = new MockTransport({
  persistKey: LEDGER_KEY,
  online: params.get('offline') !== '1',
  latencyMs: 30,
  documents: {
    [DOC]: {
      doc: {
        type: 'doc',
        content: SAMPLE.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
      },
    },
  },
});
const queue = new IndexedDbQueue(PROJECT);
const flusher = sharedFlusher(queue, transport);
const initial = transport.snapshot(DOC);

declare global {
  interface Window {
    __longhand: {
      transport: MockTransport;
      queue: IndexedDbQueue;
      handle: EditorHandle | null;
      ready: Promise<void>;
    };
  }
}
let resolveReady: () => void = () => undefined;
window.__longhand = {
  transport,
  queue,
  handle: null,
  ready: new Promise<void>((r) => (resolveReady = r)),
};

function App(): React.JSX.Element {
  const [ratio, setRatio] = useState(Number(params.get('ratio') ?? 0.5));
  const [focus, setFocus] = useState<FocusMode>((params.get('focus') as FocusMode | null) ?? 'off');
  const [online, setOnline] = useState(transport.connection() === 'online');
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [counts, setCounts] = useState<WordCounts | null>(null);
  const [chrome, setChrome] = useState(true);
  const settings = useMemo(
    () => ({ caretRatio: ratio, focusMode: focus, dailyGoal: 500 }),
    [ratio, focus],
  );
  const idle = params.get('idle');

  return (
    <>
      <LonghandEditor
        projectId={PROJECT}
        documentId={DOC}
        actorId="demo-writer"
        doc={initial.doc}
        version={initial.version}
        transport={transport}
        queue={queue}
        flusher={flusher}
        settings={settings}
        {...(idle ? { batch: { idleMs: Number(idle) } } : {})}
        attributes={{ 'aria-label': 'Manuscript', 'data-testid': 'manuscript' }}
        onStatus={setStatus}
        onWordCount={setCounts}
        onReady={(h) => {
          window.__longhand.handle = h;
          void h.ready.then(resolveReady);
          h.focus();
        }}
      />
      {chrome && (
        <aside className="demo-controls" aria-label="Editor settings">
          <label>
            Caret <output>{Math.round(ratio * 100)}%</output>
            <input
              type="range"
              min={0.33}
              max={0.6}
              step={0.01}
              value={ratio}
              onChange={(e) => setRatio(Number(e.target.value))}
              data-testid="ratio"
            />
          </label>
          <label>
            Focus
            <select
              value={focus}
              onChange={(e) => setFocus(e.target.value as FocusMode)}
              data-testid="focus"
            >
              <option value="off">off</option>
              <option value="sentence">sentence</option>
              <option value="paragraph">paragraph</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={online}
              data-testid="online"
              onChange={(e) => {
                transport.setOnline(e.target.checked);
                setOnline(e.target.checked);
              }}
            />
            Online
          </label>
        </aside>
      )}
      <footer className="demo-status" data-testid="status">
        <button
          type="button"
          className="demo-hide"
          onClick={() => setChrome((c) => !c)}
          aria-pressed={!chrome}
        >
          {chrome ? 'Hide' : 'Show'}
        </button>
        <span data-testid="save-state" data-state={status?.state ?? 'saved'}>
          {status?.state === 'offline'
            ? 'Offline · changes queued'
            : status?.state === 'queued'
              ? 'Saving…'
              : status?.state === 'error'
                ? 'Sync problem'
                : 'Saved'}
        </span>
        {counts && (
          <span data-testid="counts">
            {counts.document.toLocaleString()} words
            {counts.selection > 0 && ` · ${counts.selection} selected`} · {counts.session} this
            session
            {counts.daily &&
              ` · ${Math.round(counts.daily.progress * 100)}% of ${counts.daily.goal} today`}
          </span>
        )}
      </footer>
    </>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
