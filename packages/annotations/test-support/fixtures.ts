/**
 * Fixture helpers for the jsdom tests (Node only: reads the golden fixtures from
 * disk) and a harness that mounts a real editor over a {@link FoldingTransport}.
 */
import { createEditorView, MemoryQueue, type EditorHandle } from '@longhand/editor';
import type { CommitDraft } from '@longhand/schema';
import { TextSelection } from 'prosemirror-state';
import { AnnotationsController, type AnnotationsControllerOptions } from '../src/controller';
import { fixtureCommits, type AnnotationFixture } from './fixtureData';
import { FoldingTransport, untilFirstReview } from './foldingTransport';

export { ANNOTATION_FIXTURES, fixtureCommits, fixtureState } from './fixtureData';

/** Flushes microtasks and zero-delay timers. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A beforeinput event for jsdom. */
export function beforeInput(inputType: string, data: string | null): Event {
  const e = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'inputType', { value: inputType });
  Object.defineProperty(e, 'data', { value: data });
  return e;
}

/** A real editor + controller over a folding transport seeded from a fixture prefix. */
export interface Harness {
  transport: FoldingTransport;
  handle: EditorHandle;
  controller: AnnotationsController;
  documentId: string;
  drafts: CommitDraft[];
  /** Simulates the browser typing `text` at the current selection. */
  typeText(text: string): void;
  /** Puts the caret (or a selection) somewhere. */
  select(from: number, to?: number): void;
  /** Commits pending typing and waits for the fold to publish. */
  commit(): Promise<void>;
  text(): string;
  destroy(): void;
}

/** Builds a {@link Harness}. `prefix: 'review'` stops at the fixture's first finished review. */
export function harness(
  fixture: AnnotationFixture,
  opts: { prefix?: 'review' | 'all'; controller?: Partial<AnnotationsControllerOptions> } = {},
): Harness {
  const all = fixtureCommits(fixture);
  const commits = opts.prefix === 'all' ? all : untilFirstReview(all);
  const transport = new FoldingTransport({ commits });
  const ps = transport.projectState();
  const doc = Object.values(ps.documents)[0]!;
  const mount = document.body.appendChild(document.createElement('div'));
  const drafts: CommitDraft[] = [];
  const handle = createEditorView({
    mount,
    projectId: ps.projectId,
    documentId: doc.id,
    actorId: 'writer-1',
    deviceId: 'device-test',
    sessionId: 'editor-test',
    doc: doc.content,
    version: doc.version,
    transport,
    queue: new MemoryQueue(ps.projectId),
    batch: { idleMs: 10 },
    trustSyntheticEvents: true,
    inputPolicy: 'refuse',
    onDraft: (d) => drafts.push(d),
  });
  const controller = new AnnotationsController({
    documentId: doc.id,
    state: ps,
    ...opts.controller,
  });
  handle.setExtraPlugins(controller.plugins);
  controller.attach(handle);
  controller.connect();
  const unsub = transport.onState((s) => controller.setState(s));
  const view = handle.view;
  return {
    transport,
    handle,
    controller,
    documentId: doc.id,
    drafts,
    typeText(text) {
      for (const ch of text) {
        view.dom.dispatchEvent(beforeInput('insertText', ch));
        const { from, to } = view.state.selection;
        const handled = view.someProp('handleTextInput', (f) =>
          f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
        );
        if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
      }
    },
    select(from, to) {
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to ?? from)),
      );
    },
    async commit() {
      handle.flush();
      await settle(10);
    },
    text: () => view.state.doc.textBetween(0, view.state.doc.content.size, '\n'),
    destroy() {
      unsub();
      controller.destroy();
      handle.destroy();
      mount.remove();
    },
  };
}
