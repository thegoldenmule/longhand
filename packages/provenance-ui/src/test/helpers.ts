/// <reference types="vite/client" />
/** Test helpers (not part of the public API). */
import { createEditorView, MemoryQueue, MockTransport, type EditorHandle } from '@longhand/editor';
import { foldCommits, type LedgerState } from '@longhand/ledger';
import type { FixtureFile } from '@longhand/ledger/fixtures';
import type { Commit, DocumentState } from '@longhand/schema';
import type { Plugin } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';

// Loaded through Vite (jsdom's import.meta.url is not a file URL, so the ledger's
// fs-based `loadFixture` does not work here).
const FILES = import.meta.glob<FixtureFile>('../../../ledger/fixtures/*.json', {
  eager: true,
  import: 'default',
});
const FIXTURES = new Map(
  Object.entries(FILES)
    .map(([path, f]) => [path.replace(/^.*\/(.+)\.json$/, '$1'), f] as const)
    .filter(([, f]) => Array.isArray(f.commits) && f.commits.length > 0),
);
export const FIXTURE_NAMES = [...FIXTURES.keys()].sort();

function loadFixture(name: string): FixtureFile {
  const f = FIXTURES.get(name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
}

const cache = new Map<string, { fixture: FixtureFile; state: LedgerState }>();

/** A golden fixture and its folded state (cached). */
export function fixture(name: string): {
  fixture: FixtureFile;
  state: LedgerState;
  commits: Commit[];
} {
  let hit = cache.get(name);
  if (!hit) {
    const f = loadFixture(name);
    hit = { fixture: f, state: foldCommits(f.commits) };
    cache.set(name, hit);
  }
  return { ...hit, commits: hit.fixture.commits };
}

/** Every (fixture, document) pair with text. */
export function fixtureDocuments(): Array<{ name: string; doc: DocumentState }> {
  const out: Array<{ name: string; doc: DocumentState }> = [];
  for (const name of FIXTURE_NAMES) {
    const f = fixture(name).fixture;
    for (const doc of Object.values(f.expected.state.documents)) out.push({ name, doc });
  }
  return out;
}

export interface MountedEditor {
  handle: EditorHandle;
  /** Types text at the selection as the browser would deliver it. */
  typeText(text: string): void;
  /** Puts the caret at `pos`. */
  at(pos: number): void;
  destroy(): void;
}

function beforeInput(inputType: string, data: string | null): Event {
  const e = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'inputType', { value: inputType });
  Object.defineProperty(e, 'data', { value: data });
  return e;
}

/** Mounts the real editor (MockTransport, memory queue) on a document at its ledger version. */
export function mountEditor(doc: DocumentState, plugins: readonly Plugin[]): MountedEditor {
  const transport = new MockTransport({
    documents: { [doc.id]: { doc: doc.content, version: doc.version } },
  });
  const mount = document.body.appendChild(document.createElement('div'));
  const handle = createEditorView({
    mount,
    projectId: 'proj',
    documentId: doc.id,
    actorId: 'writer',
    deviceId: 'dev',
    sessionId: 'sess',
    doc: doc.content,
    version: doc.version,
    transport,
    queue: new MemoryQueue('proj'),
    batch: { idleMs: 60_000 },
    trustSyntheticEvents: true,
    inputPolicy: 'refuse',
    settings: { typewriter: false },
    extraPlugins: [...plugins],
  });
  const view = handle.view;
  return {
    handle,
    at(pos) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    },
    typeText(t) {
      for (const ch of t) {
        view.dom.dispatchEvent(beforeInput('insertText', ch));
        const { from, to } = view.state.selection;
        const handled = view.someProp('handleTextInput', (f) =>
          f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
        );
        if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
      }
    },
    destroy() {
      handle.destroy();
      mount.remove();
    },
  };
}
