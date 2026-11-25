/**
 * The outbound commit queue: every draft the editor produces is written here
 * first (write-ahead), then drained to the transport in order by the
 * {@link CommitFlusher}. Entries are removed only when the ledger acknowledges
 * them, so drafts survive dropped connections and page reloads.
 *
 * - Order is the enqueue order; companion events (`PasteOccurred`, `SliceCopied`,
 *   `CitationInserted`) therefore always precede the `TextEdited` that needs them.
 * - `commitId` is unique: enqueueing a known id is a no-op (dedupe).
 * - `replace` keeps an entry's position (used when unacknowledged drafts are rebased).
 * - One queue per project. Several tabs share the IndexedDB store.
 */
import type { CommitDraft } from '@longhand/schema';
import { Emitter } from '../util';

/** One queued draft. */
export interface QueueEntry {
  order: number;
  commitId: string;
  projectId: string;
  documentId: string | null;
  type: CommitDraft['type'];
  draft: CommitDraft;
  /** Epoch ms when the draft was enqueued. */
  enqueuedAt: number;
}

/** Persistent, ordered outbound queue for one project. */
export interface CommitQueue {
  readonly projectId: string;
  /** Appends a draft. Resolves false if its `commitId` is already queued. */
  enqueue(draft: CommitDraft): Promise<boolean>;
  /** The oldest entry. */
  peek(): Promise<QueueEntry | undefined>;
  /** All entries, oldest first. */
  list(): Promise<QueueEntry[]>;
  /** Removes an entry (acknowledged or permanently rejected). */
  remove(commitId: string): Promise<void>;
  /** Replaces an entry in place (`null` removes it). Missing ids are ignored. */
  replace(commitId: string, draft: CommitDraft | null): Promise<void>;
  /** Called after every change. */
  onChange(listener: () => void): () => void;
}

/** The document a draft belongs to, if any. */
export function draftDocumentId(draft: CommitDraft): string | null {
  const p = draft.payload as { documentId?: unknown };
  return typeof p.documentId === 'string' ? p.documentId : null;
}

function entryOf(draft: CommitDraft, order: number, projectId: string, enqueuedAt: number): QueueEntry {
  return {
    order,
    commitId: draft.commitId,
    projectId,
    documentId: draftDocumentId(draft),
    type: draft.type,
    draft,
    enqueuedAt,
  };
}

/** In-memory queue (tests, demo, or browsers without IndexedDB). */
export class MemoryQueue implements CommitQueue {
  private entries: QueueEntry[] = [];
  private next = 1;
  private changes = new Emitter<void>();
  constructor(readonly projectId: string) {}

  async enqueue(draft: CommitDraft): Promise<boolean> {
    if (this.entries.some((e) => e.commitId === draft.commitId)) return false;
    this.entries.push(entryOf(draft, this.next++, this.projectId, Date.now()));
    this.changes.emit();
    return true;
  }
  async peek(): Promise<QueueEntry | undefined> {
    return this.entries[0];
  }
  async list(): Promise<QueueEntry[]> {
    return [...this.entries];
  }
  async remove(commitId: string): Promise<void> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.commitId !== commitId);
    if (this.entries.length !== before) this.changes.emit();
  }
  async replace(commitId: string, draft: CommitDraft | null): Promise<void> {
    const i = this.entries.findIndex((e) => e.commitId === commitId);
    if (i < 0) return;
    const old = this.entries[i] as QueueEntry;
    if (draft === null) this.entries.splice(i, 1);
    else this.entries[i] = { ...entryOf(draft, old.order, this.projectId, old.enqueuedAt) };
    this.changes.emit();
  }
  onChange(listener: () => void): () => void {
    return this.changes.on(listener);
  }
}

const DB_NAME = 'longhand-editor';
const STORE = 'queue';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

/** Opens (and creates) the editor's IndexedDB database. */
export function openQueueDatabase(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'order', autoIncrement: true });
        store.createIndex('commitId', 'commitId', { unique: true });
        store.createIndex('projectId', 'projectId', { unique: false });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/**
 * IndexedDB-backed queue. Operations are serialized, so order and dedupe hold even
 * when callers do not await. Other tabs' changes are picked up on the next read.
 */
export class IndexedDbQueue implements CommitQueue {
  private db: Promise<IDBDatabase>;
  private chain: Promise<unknown> = Promise.resolve();
  private changes = new Emitter<void>();

  constructor(
    readonly projectId: string,
    opts: { factory?: IDBFactory; dbName?: string } = {},
  ) {
    this.db = openQueueDatabase(opts.factory ?? indexedDB, opts.dbName ?? DB_NAME);
  }

  private run<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const p = this.chain.then(async () => fn(await this.db));
    this.chain = p.catch(() => undefined);
    return p;
  }

  enqueue(draft: CommitDraft): Promise<boolean> {
    return this.run(async (db) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const existing = await req(store.index('commitId').getKey(draft.commitId));
      if (existing !== undefined) {
        await done(tx);
        return false;
      }
      const { order: _order, ...entry } = entryOf(draft, 0, this.projectId, Date.now());
      store.add(entry);
      await done(tx);
      this.changes.emit();
      return true;
    });
  }

  list(): Promise<QueueEntry[]> {
    return this.run(async (db) => {
      const tx = db.transaction(STORE, 'readonly');
      const all = (await req(tx.objectStore(STORE).index('projectId').getAll(this.projectId))) as QueueEntry[];
      return all.sort((a, b) => a.order - b.order);
    });
  }

  peek(): Promise<QueueEntry | undefined> {
    return this.run(async (db) => {
      const tx = db.transaction(STORE, 'readonly');
      const cursor = await req(tx.objectStore(STORE).index('projectId').openCursor(IDBKeyRange.only(this.projectId)));
      return cursor ? (cursor.value as QueueEntry) : undefined;
    });
  }

  remove(commitId: string): Promise<void> {
    return this.run(async (db) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const key = await req(store.index('commitId').getKey(commitId));
      if (key !== undefined) store.delete(key);
      await done(tx);
      if (key !== undefined) this.changes.emit();
    });
  }

  replace(commitId: string, draft: CommitDraft | null): Promise<void> {
    return this.run(async (db) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const old = (await req(store.index('commitId').get(commitId))) as QueueEntry | undefined;
      if (old) {
        store.delete(old.order);
        if (draft) store.put(entryOf(draft, old.order, this.projectId, old.enqueuedAt));
      }
      await done(tx);
      if (old) this.changes.emit();
    });
  }

  onChange(listener: () => void): () => void {
    return this.changes.on(listener);
  }

  /** Closes the database connection. */
  async close(): Promise<void> {
    (await this.db).close();
  }
}

/** An IndexedDB queue when IndexedDB exists, else an in-memory one. */
export function createCommitQueue(projectId: string): CommitQueue {
  return typeof indexedDB !== 'undefined' ? new IndexedDbQueue(projectId) : new MemoryQueue(projectId);
}
