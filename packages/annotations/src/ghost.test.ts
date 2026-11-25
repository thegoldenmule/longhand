import { afterEach, describe, expect, it } from 'vitest';
import { harness, settle, type Harness } from '../test-support/fixtures';
import { createGhostElement, installGhostClipboardGuard, scrubGhostHtml } from './ghost';
import { layoutCards } from './react/margin';
import { reduceProgress, toolActivity } from './progress';

class FakeDataTransfer {
  data = new Map<string, string>();
  getData(t: string): string {
    return this.data.get(t) ?? '';
  }
  setData(t: string, v: string): void {
    this.data.set(t, v);
  }
  clearData(): void {
    this.data.clear();
  }
  get types(): string[] {
    return [...this.data.keys()];
  }
}

function copyEvent(type: 'copy' | 'cut', data: FakeDataTransfer): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: data });
  return e;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.destroy();
  document.body.innerHTML = '';
});

describe('ghost text never reaches the clipboard', () => {
  it('strips ghost content from a native selection that spans it (cards)', () => {
    const uninstall = installGhostClipboardGuard(document);
    const box = document.body.appendChild(document.createElement('div'));
    box.innerHTML = '<p>Replace <q>old</q> with </p>';
    box.querySelector('p')!.appendChild(createGhostElement(document, 'weathered'));
    box.querySelector('p')!.append(' — your call.');
    const range = document.createRange();
    range.selectNodeContents(box);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const data = new FakeDataTransfer();
    const e = copyEvent('copy', data);
    box.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(data.getData('text/plain')).toBe('Replace old with  — your call.');
    expect(data.getData('text/plain')).not.toContain('weathered');
    expect(data.getData('text/html')).not.toContain('weathered');
    uninstall();
  });

  it('copies nothing from a selection inside ghost text', () => {
    const uninstall = installGhostClipboardGuard(document);
    const ghost = document.body.appendChild(createGhostElement(document, 'Her tea had gone cold.'));
    const range = document.createRange();
    range.selectNodeContents(ghost.firstChild!);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    const data = new FakeDataTransfer();
    ghost.dispatchEvent(copyEvent('cut', data));
    expect(data.getData('text/plain')).toBe('');
    uninstall();
  });

  it('leaves ordinary copies alone', () => {
    const uninstall = installGhostClipboardGuard(document);
    const p = document.body.appendChild(document.createElement('p'));
    p.textContent = 'Plain words.';
    const range = document.createRange();
    range.selectNodeContents(p);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    const e = copyEvent('copy', new FakeDataTransfer());
    p.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    uninstall();
  });

  it('scrubs ghost markup from clipboard HTML another handler wrote', () => {
    expect(scrubGhostHtml(document, '<p>a<span data-lh-ghost="">ghost</span>b</p>')).toBe(
      '<p>ab</p>',
    );
  });

  it('copying across a ghost in the editor yields only manuscript text', async () => {
    const h = harness('suggestions');
    harnesses.push(h);
    await settle();
    const view = h.handle.view;
    const ghost = view.dom.querySelector('.lh-ghost-insertion')!;
    expect(ghost).toBeTruthy();
    // Select the whole paragraph, ghost included, and copy through the editor.
    h.select(1, view.state.doc.content.size - 1);
    const data = new FakeDataTransfer();
    view.dom.dispatchEvent(copyEvent('copy', data));
    const text = data.getData('text/plain');
    expect(text).toBe(
      'The rain fell on the old roof. She waited by the window. Nothing moved outside. The lane was empty and the hedges were black.',
    );
    expect(data.getData('text/html')).not.toContain('Her tea');
  });
});

describe('progress', () => {
  it('folds runner events into a live view', () => {
    let p = reduceProgress({}, { kind: 'started', feedbackSessionId: 'fs', model: 'opus', seq: 4 });
    expect(p.fs).toMatchObject({
      model: 'opus',
      state: 'running',
      activity: 'Reading the document',
    });
    p = reduceProgress(
      p,
      { kind: 'model', event: { type: 'tool-call', name: 'mcp__longhand__suggest_word_choice' } },
      'fs',
    );
    expect(p.fs!.activity).toBe('Weighing a word choice');
    p = reduceProgress(p, {
      kind: 'annotation',
      seq: 9,
      draft: {
        type: 'SuggestionProposed',
        payload: { suggestionId: 's1', feedbackSessionId: 'fs', suggestion: { kind: 'insertion' } },
      },
    });
    expect(p.fs!.arrived).toEqual([
      { seq: 9, type: 'SuggestionProposed', id: 's1', label: 'Add a sentence' },
    ]);
    const same = reduceProgress(p, { kind: 'model', event: { type: 'text', text: 'hi' } }, 'fs');
    expect(same).toBe(p);
    // Agent events name their session; the fallback is only for events that do not.
    p = reduceProgress(
      p,
      {
        kind: 'model',
        feedbackSessionId: 'fs',
        event: { type: 'tool-call', name: 'mcp__longhand__comment' },
      },
      'other',
    );
    expect(p.fs!.activity).toBe('Writing a margin note');
    expect(p.other).toBeUndefined();
    p = reduceProgress(p, {
      kind: 'annotation',
      feedbackSessionId: 'fs',
      seq: 10,
      draft: { type: 'CommentAdded', payload: { commentId: 'c1' } },
    });
    expect(p.fs!.arrived.map((a) => a.id)).toEqual(['s1', 'c1']);
    // An event naming no session, with no fallback, is ignored.
    expect(reduceProgress(p, { kind: 'model', event: { type: 'tool-call', name: 'x' } })).toBe(p);
    // A failure before any session started (null) without a fallback names nothing.
    expect(reduceProgress(p, { kind: 'failed', feedbackSessionId: null, reason: 'x' })).toBe(p);
    p = reduceProgress(p, { kind: 'failed', feedbackSessionId: 'fs', reason: 'timeout' });
    expect(p.fs).toMatchObject({ state: 'failed', failureReason: 'timeout', activity: null });
    expect(toolActivity('finish_review')).toBe('Writing the summary');
    expect(toolActivity('nope')).toBeNull();
  });
});

describe('layoutCards', () => {
  it('stacks cards without overlap and pins the active card to its anchor', () => {
    const items = [
      { id: 'a', anchor: 0, height: 50 },
      { id: 'b', anchor: 10, height: 50 },
      { id: 'c', anchor: 200, height: 50 },
      { id: 'u', anchor: null, height: 20 },
    ];
    expect(layoutCards(items, 10, null)).toEqual({ a: 0, b: 60, c: 200, u: 260 });
    expect(layoutCards(items, 10, 'b')).toEqual({ a: -50, b: 10, c: 200, u: 260 });
  });
});
