/** Test helpers (not part of the public API). */
import {
  CommitDraftSchema,
  docFromJSON,
  schema,
  type CommitDraft,
  type PMNodeJSON,
} from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { expect } from 'vitest';
import type { InputTag } from '../input/classify';
import type { SyncHost } from '../sync/engine';

/** A doc with one paragraph per string. */
export function docOf(...paragraphs: string[]): PMNode {
  return docFromJSON(docJSON(...paragraphs));
}

export function docJSON(...paragraphs: string[]): PMNodeJSON {
  return {
    type: 'doc',
    content: paragraphs.map((t) =>
      t ? { type: 'paragraph', content: [{ type: 'text', text: t }] } : { type: 'paragraph' },
    ),
  };
}

/** A minimal SyncHost over a plain EditorState. */
export class StateHost implements SyncHost {
  state: EditorState;
  remote: Transaction[] = [];
  constructor(doc: PMNode) {
    this.state = EditorState.create({ doc, schema });
  }
  getState(): EditorState {
    return this.state;
  }
  applyRemote(tr: Transaction): void {
    this.remote.push(tr);
    this.state = this.state.apply(tr);
  }
  resetDoc(doc: PMNode): void {
    this.state = EditorState.create({ doc, schema });
  }
  /** Applies a local transaction built by `build` and returns it. */
  local(build: (s: EditorState) => Transaction): Transaction {
    const tr = build(this.state);
    this.state = this.state.apply(tr);
    return tr;
  }
  /** Types `text` at `pos` as one transaction. */
  type(text: string, pos?: number): Transaction {
    return this.local((s) => {
      const tr = s.tr;
      if (pos !== undefined) tr.setSelection(TextSelection.create(s.doc, pos));
      return tr.insertText(text);
    });
  }
  text(): string {
    return this.state.doc.textBetween(0, this.state.doc.content.size, '\n');
  }
}

export const TYPED: InputTag = { method: 'typed', kind: 'insert' };

/** Asserts a draft passes the schema's `CommitDraftSchema`. */
export function expectValidDraft(draft: CommitDraft): void {
  const r = CommitDraftSchema.safeParse(draft);
  if (!r.success) throw new Error(`invalid draft ${draft.type}: ${r.error.message}`);
  expect(r.success).toBe(true);
}

/** A DataTransfer stand-in for jsdom. */
export class FakeDataTransfer {
  private data = new Map<string, string>();
  get types(): string[] {
    return [...this.data.keys()];
  }
  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  clearData(): void {
    this.data.clear();
  }
  get files(): FileList {
    return [] as unknown as FileList;
  }
}

/** A clipboard event for jsdom. */
export function clipboardEvent(type: 'copy' | 'cut' | 'paste', data: FakeDataTransfer): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: data });
  return e;
}

/** A beforeinput event for jsdom. */
export function beforeInput(inputType: string, data: string | null): Event {
  const e = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'inputType', { value: inputType });
  Object.defineProperty(e, 'data', { value: data });
  return e;
}

/** Flushes pending microtasks and zero-delay timers. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}
