/**
 * An in-memory ledger service for tests and the demo page. It behaves like the
 * real one where the editor can tell: it validates drafts with `CommitDraftSchema`,
 * assigns `seq`, dedupes by `commitId`, re-applies `TextEdited` steps and rejects
 * version mismatches, fans updates out to subscribers (including the sender), and
 * answers `fetchSince`. It can go offline, add latency, simulate edits from another
 * device and persist itself to `localStorage`.
 */
import {
  CommitDraftSchema,
  docFromJSON,
  schema,
  type CommitDraft,
  type PMNodeJSON,
  type StepJSON,
} from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import { Emitter, newId } from '../util';
import type {
  CatchUp,
  CommitTransport,
  ConnectionState,
  RemoteUpdate,
  SubmitResult,
} from './transport';

/** One appended commit. */
export interface MockCommit {
  seq: number;
  serverTime: string;
  draft: CommitDraft;
}

interface MockDoc {
  doc: PMNode;
  version: number;
  updates: RemoteUpdate[];
}

export interface MockTransportOptions {
  /** Simulated round-trip latency (ms). Default 0. */
  latencyMs?: number;
  online?: boolean;
  /** Documents the ledger already holds. */
  documents?: Record<string, { doc: PMNodeJSON; version?: number }>;
  /** Persist the ledger to storage under this key (the demo uses it to survive reloads). */
  persistKey?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** Steps the "fold" derives for an accepted proposal. Default: none (rejected). */
  deriveProposal?: (proposalId: string, doc: PMNode) => Step[] | null;
  /** Validate drafts with `CommitDraftSchema`. Default true. */
  validate?: boolean;
  /** Called with every submit result (for test assertions). */
  onSubmit?: (draft: CommitDraft, result: SubmitResult) => void;
}

interface Persisted {
  log: MockCommit[];
  docs: Record<string, { doc: PMNodeJSON; version: number; updates: RemoteUpdate[] }>;
}

export class MockTransport implements CommitTransport {
  readonly log: MockCommit[] = [];
  readonly submissions: Array<{ draft: CommitDraft; result: SubmitResult }> = [];
  private docs = new Map<string, MockDoc>();
  private subs = new Map<string, Set<(u: RemoteUpdate) => void>>();
  private conn = new Emitter<ConnectionState>();
  private online: boolean;
  latencyMs: number;

  constructor(private readonly opts: MockTransportOptions = {}) {
    this.online = opts.online ?? true;
    this.latencyMs = opts.latencyMs ?? 0;
    if (!this.load()) {
      for (const [id, d] of Object.entries(opts.documents ?? {}))
        this.docs.set(id, { doc: docFromJSON(d.doc), version: d.version ?? 0, updates: [] });
    }
  }

  // ------------------------------------------------------------ persistence

  private storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
    if (!this.opts.persistKey) return null;
    if (this.opts.storage) return this.opts.storage;
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      return null;
    }
  }

  private load(): boolean {
    const s = this.storage();
    const raw = s?.getItem(this.opts.persistKey as string);
    if (!raw) return false;
    try {
      const p = JSON.parse(raw) as Persisted;
      this.log.push(...p.log);
      for (const [id, d] of Object.entries(p.docs))
        this.docs.set(id, { doc: docFromJSON(d.doc), version: d.version, updates: d.updates });
      return true;
    } catch {
      return false;
    }
  }

  private save(): void {
    const s = this.storage();
    if (!s) return;
    const docs: Persisted['docs'] = {};
    for (const [id, d] of this.docs)
      docs[id] = { doc: d.doc.toJSON() as PMNodeJSON, version: d.version, updates: d.updates };
    s.setItem(
      this.opts.persistKey as string,
      JSON.stringify({ log: this.log, docs } satisfies Persisted),
    );
  }

  // ------------------------------------------------------------- inspection

  /** The ledger's current document and version. */
  snapshot(documentId: string): { doc: PMNodeJSON; version: number } {
    const d = this.ensure(documentId);
    return { doc: d.doc.toJSON() as PMNodeJSON, version: d.version };
  }

  /** Appended commits, optionally of one type. */
  commits<T extends CommitDraft['type']>(type?: T): Array<Extract<CommitDraft, { type: T }>> {
    return this.log
      .filter((c) => !type || c.draft.type === type)
      .map((c) => c.draft as Extract<CommitDraft, { type: T }>);
  }

  private ensure(documentId: string): MockDoc {
    let d = this.docs.get(documentId);
    if (!d)
      this.docs.set(
        documentId,
        (d = {
          doc: docFromJSON({ type: 'doc', content: [{ type: 'paragraph' }] }),
          version: 0,
          updates: [],
        }),
      );
    return d;
  }

  // -------------------------------------------------------------- connection

  connection(): ConnectionState {
    return this.online ? 'online' : 'offline';
  }

  onConnectionChange(listener: (state: ConnectionState) => void): () => void {
    return this.conn.on(listener);
  }

  setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    this.conn.emit(this.connection());
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    else await Promise.resolve();
  }

  // ----------------------------------------------------------------- ledger

  async submit(draft: CommitDraft): Promise<SubmitResult> {
    await this.delay();
    const result = this.append(draft);
    this.submissions.push({ draft, result });
    this.opts.onSubmit?.(draft, result);
    return result;
  }

  private append(draft: CommitDraft): SubmitResult {
    if (!this.online) return { status: 'offline' };
    const existing = this.log.find((c) => c.draft.commitId === draft.commitId);
    if (existing) {
      const u = this.findUpdate(draft.commitId);
      return { status: 'duplicate', seq: existing.seq, ...(u ? { version: u.version } : {}) };
    }
    if (this.opts.validate !== false) {
      const parsed = CommitDraftSchema.safeParse(draft);
      if (!parsed.success) return { status: 'rejected', reason: parsed.error.message };
    }
    let update: RemoteUpdate | null = null;
    if (draft.type === 'TextEdited' || draft.type === 'ProposalAccepted') {
      const p = draft.payload;
      const d = this.ensure(p.documentId);
      if (p.baseVersion !== d.version) return { status: 'conflict', currentVersion: d.version };
      let steps: Step[];
      if (draft.type === 'TextEdited') {
        try {
          steps = draft.payload.steps.map((j) => Step.fromJSON(schema, j));
        } catch (err) {
          return { status: 'rejected', reason: `bad step: ${String(err)}` };
        }
      } else {
        const derived = this.opts.deriveProposal?.(draft.payload.proposalId, d.doc);
        if (!derived) return { status: 'rejected', reason: 'unknown proposal' };
        steps = derived;
      }
      let doc = d.doc;
      for (const s of steps) {
        const r = s.apply(doc);
        if (!r.doc) return { status: 'rejected', reason: `step failed: ${r.failed ?? ''}` };
        doc = r.doc;
      }
      const seq = this.log.length + 1;
      update = {
        documentId: p.documentId,
        commitId: draft.commitId,
        seq,
        type: draft.type,
        baseVersion: d.version,
        version: d.version + steps.length,
        steps: steps.map((s) => s.toJSON() as StepJSON),
      };
      d.doc = doc;
      d.version = update.version;
      d.updates.push(update);
    }
    const seq = this.log.length + 1;
    this.log.push({ seq, serverTime: new Date().toISOString(), draft });
    this.save();
    if (update) this.publish(update);
    return { status: 'ack', seq, ...(update ? { version: update.version } : {}) };
  }

  private findUpdate(commitId: string): RemoteUpdate | undefined {
    for (const d of this.docs.values()) {
      const u = d.updates.find((x) => x.commitId === commitId);
      if (u) return u;
    }
    return undefined;
  }

  private publish(update: RemoteUpdate): void {
    const listeners = this.subs.get(update.documentId);
    if (!listeners) return;
    // Deliver asynchronously, like a stream would.
    setTimeout(() => {
      for (const l of [...listeners]) l(update);
    }, 0);
  }

  subscribe(documentId: string, listener: (update: RemoteUpdate) => void): () => void {
    let set = this.subs.get(documentId);
    if (!set) this.subs.set(documentId, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  async fetchSince(documentId: string, version: number): Promise<CatchUp> {
    await this.delay();
    if (!this.online) throw new Error('offline');
    const d = this.ensure(documentId);
    const first = d.updates[0];
    if (version > 0 && first && first.baseVersion > version)
      return { kind: 'snapshot', doc: d.doc.toJSON() as PMNodeJSON, version: d.version };
    if (version === 0 && first && first.baseVersion > 0)
      return { kind: 'snapshot', doc: d.doc.toJSON() as PMNodeJSON, version: d.version };
    if (!first && d.version > version)
      return { kind: 'snapshot', doc: d.doc.toJSON() as PMNodeJSON, version: d.version };
    return {
      kind: 'updates',
      updates: d.updates.filter((u) => u.version > version),
      version: d.version,
    };
  }

  /**
   * Simulates a `TextEdited` from another device: `build` returns the steps to
   * apply to the ledger's current document.
   */
  remoteEdit(documentId: string, build: (doc: PMNode) => Step[]): RemoteUpdate {
    const d = this.ensure(documentId);
    const steps = build(d.doc);
    const draft = {
      commitId: newId(),
      projectId: 'mock',
      clientTime: new Date().toISOString(),
      actor: { kind: 'human', id: 'other-device' },
      deviceId: 'other-device',
      sessionId: 'other-session',
      schemaVersion: 1,
      type: 'TextEdited',
      payload: {
        documentId,
        baseVersion: d.version,
        steps: steps.map((s) => s.toJSON() as StepJSON),
        runs: [{ steps: steps.length, method: 'typed' }],
        timeline: [],
        characters: 0,
        durationMs: 0,
      },
    } as CommitDraft;
    const res = this.append(draft);
    if (res.status !== 'ack') throw new Error(`remote edit failed: ${JSON.stringify(res)}`);
    return this.findUpdate(draft.commitId) as RemoteUpdate;
  }
}
