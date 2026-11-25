import 'fake-indexeddb/auto';
import type { CommitDraft } from '@longhand/schema';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { makeDraft } from './drafts';
import { IndexedDbQueue, MemoryQueue, type CommitQueue } from './queue';

const ctx = { projectId: 'proj', actorId: 'u', deviceId: 'd', sessionId: 's' };

function draft(i: number): CommitDraft {
  return makeDraft(ctx, 'SuggestionDismissed', { suggestionId: `s${i}`, reason: null, note: null } as never, 1000 + i, `c${i}`) as CommitDraft;
}

function sharedBehaviour(name: string, make: () => CommitQueue): void {
  describe(name, () => {
    it('keeps enqueue order and dedupes by commitId', async () => {
      const q = make();
      expect(await q.enqueue(draft(1))).toBe(true);
      expect(await q.enqueue(draft(2))).toBe(true);
      expect(await q.enqueue(draft(1))).toBe(false);
      void q.enqueue(draft(3));
      const all = await q.list();
      expect(all.map((e) => e.commitId)).toEqual(['c1', 'c2', 'c3']);
      expect((await q.peek())?.commitId).toBe('c1');
    });

    it('removes and replaces in place', async () => {
      const q = make();
      for (const i of [1, 2, 3]) await q.enqueue(draft(i));
      await q.remove('c1');
      await q.replace('c2', { ...draft(9) });
      expect((await q.list()).map((e) => e.commitId)).toEqual(['c9', 'c3']);
      await q.replace('c9', null);
      await q.replace('missing', draft(5));
      expect((await q.list()).map((e) => e.commitId)).toEqual(['c3']);
    });

    it('notifies on change', async () => {
      const q = make();
      let n = 0;
      q.onChange(() => n++);
      await q.enqueue(draft(1));
      await q.remove('c1');
      await q.remove('c1');
      expect(n).toBe(2);
    });
  });
}

sharedBehaviour('MemoryQueue', () => new MemoryQueue('proj'));

let dbCounter = 0;
sharedBehaviour('IndexedDbQueue', () => new IndexedDbQueue('proj', { factory: new IDBFactory(), dbName: `q${++dbCounter}` }));

describe('IndexedDbQueue persistence', () => {
  it('survives a new instance (page reload) and scopes by project', async () => {
    const factory = new IDBFactory();
    const a = new IndexedDbQueue('proj', { factory, dbName: 'persist' });
    await a.enqueue(draft(1));
    await a.enqueue(draft(2));
    const other = new IndexedDbQueue('other', { factory, dbName: 'persist' });
    await other.enqueue({ ...draft(7), projectId: 'other' });
    await a.close();
    const b = new IndexedDbQueue('proj', { factory, dbName: 'persist' });
    expect((await b.list()).map((e) => e.commitId)).toEqual(['c1', 'c2']);
    expect((await other.list()).map((e) => e.commitId)).toEqual(['c7']);
    // Order continues after reload.
    await b.enqueue(draft(3));
    expect((await b.list()).map((e) => e.commitId)).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('draft documentId', () => {
  it('records the documentId of document-scoped drafts', async () => {
    const q = new MemoryQueue('proj');
    await q.enqueue(makeDraft(ctx, 'CitationInserted', { citationId: 'c', documentId: 'docA', sourceId: 's', locator: null }, 0, 'x1'));
    await q.enqueue(draft(1));
    const [a, b] = await q.list();
    expect(a?.documentId).toBe('docA');
    expect(b?.documentId).toBeNull();
    expect(a?.type).toBe('CitationInserted');
  });
});
