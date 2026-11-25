/**
 * Per-document sync engine: turns captured local steps into ledger drafts, keeps
 * track of what the ledger has acknowledged, and rebases unacknowledged steps when
 * the ledger applied someone else's steps first.
 *
 * Versions:
 * - `confirmedVersion` — the version the ledger acknowledged (all steps up to it are
 *   in the ledger, in ledger order).
 * - `localVersion` — `confirmedVersion` + every unacknowledged local step (queued
 *   drafts plus the batch still collecting). The editor shows this document.
 *
 * Batching: steps collect in `pending` and become one `TextEdited` after `idleMs`
 * without input or once `maxSteps` steps are pending (transactions are not split
 * unless they exceed `MAX_STEPS_PER_COMMIT`). Copy/cut, companion events and
 * `ProposalAccepted` flush first.
 */
import {
  MAX_STEPS_PER_COMMIT,
  docFromJSON,
  schema,
  sha256Hex,
  type CommitDraft,
  type CommitDraftOf,
  type EventPayloads,
  type EventType,
  type PMNodeJSON,
} from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { Mapping, Step, Transform, type StepMap } from 'prosemirror-transform';
import type { InputTag } from '../input/classify';
import { deletedChars, insertedChars } from '../steps';
import { Emitter, newId } from '../util';
import {
  buildTextEdited,
  emptyBatch,
  isTextEdited,
  makeDraft,
  rebuildTextEdited,
  stepTagsOf,
  type DraftContext,
  type LocalBatch,
  type LocalStep,
  type RunTag,
  type TimelineEntry,
} from './drafts';
import type { CommitFlusher, FlushParticipant } from './flusher';
import type { CommitQueue, QueueEntry } from './queue';
import { reconcileHeadless } from './reconcile';
import { rebaseOnDoc, type RebaseResult } from './rebase';
import type { CommitTransport, RemoteUpdate, SubmitResult } from './transport';

/** What the engine needs from the view. */
export interface SyncHost {
  getState(): EditorState;
  /** Dispatches a transaction carrying ledger steps (the host marks it remote). */
  applyRemote(tr: Transaction): void;
  /** Replaces the document (snapshot reload). */
  resetDoc(doc: PMNode): void;
}

/** Save state shown to the writer. */
export type SaveState = 'saved' | 'queued' | 'offline' | 'error';

/** Save status of one document. */
export interface SyncStatus {
  state: SaveState;
  /** Steps still batching (not yet a draft). */
  pendingSteps: number;
  /** Drafts of this document waiting for the ledger. */
  unacknowledged: number;
  confirmedVersion: number;
  localVersion: number;
  lastError: string | null;
}

/** A change of the document's version, for extension lanes. */
export interface VersionChange {
  documentId: string;
  confirmedVersion: number;
  localVersion: number;
  /** Ledger steps applied from elsewhere, if this change came from a remote update. */
  remote?: { update: RemoteUpdate; mapping: Mapping };
}

/** Something went wrong that the writer or host should know about. */
export interface SyncError {
  kind: 'rejected' | 'lost-steps' | 'resync' | 'transport';
  message: string;
  commitId?: string;
}

export interface DocumentSyncOptions extends DraftContext {
  documentId: string;
  /** Version of the initial document. */
  version: number;
  transport: CommitTransport;
  queue: CommitQueue;
  flusher: CommitFlusher;
  host: SyncHost;
  /** Idle time before a batch is committed (ms). Default 2000. */
  idleMs?: number;
  /** Steps that force a commit. Default 50. */
  maxSteps?: number;
  /** Clock (epoch ms). */
  now?: () => number;
  /** How many confirmed step maps to keep for `mappingFrom`. Default 5000. */
  historyLimit?: number;
}

interface PendingCopy {
  commitId: string;
  /** Local steps before the copy (relative to `confirmedVersion`). */
  k: number;
  draft: CommitDraftOf<'SliceCopied'>;
}

/** Human event types other lanes may submit through the editor's queue. */
export type SubmittableEventType = Exclude<
  EventType,
  'TextEdited' | 'PasteOccurred' | 'SliceCopied' | 'CitationInserted'
>;

export class DocumentSync implements FlushParticipant {
  readonly documentId: string;
  readonly status = new Emitter<SyncStatus>();
  readonly versions = new Emitter<VersionChange>();
  readonly drafts = new Emitter<CommitDraft>();
  readonly errors = new Emitter<SyncError>();

  confirmedVersion: number;
  private batches: LocalBatch[] = [];
  private pending: LocalBatch = emptyBatch();
  private copies: PendingCopy[] = [];
  private outstanding = new Set<string>();
  private buffered: RemoteUpdate[] = [];
  private confirmedMaps: StepMap[] = [];
  private mapsBase: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private unsubs: Array<() => void> = [];
  private readonly ctx: DraftContext;
  private readonly idleMs: number;
  private readonly maxSteps: number;
  private readonly clock: () => number;
  private readonly historyLimit: number;
  private catchingUp: Promise<void> | null = null;
  private destroyed = false;

  constructor(private readonly opts: DocumentSyncOptions) {
    this.documentId = opts.documentId;
    this.confirmedVersion = opts.version;
    this.mapsBase = opts.version;
    this.ctx = { projectId: opts.projectId, actorId: opts.actorId, deviceId: opts.deviceId, sessionId: opts.sessionId };
    this.idleMs = opts.idleMs ?? 2000;
    this.maxSteps = opts.maxSteps ?? 50;
    this.clock = opts.now ?? (() => Date.now());
    this.historyLimit = opts.historyLimit ?? 5000;
    this.unsubs.push(
      opts.flusher.register(this),
      opts.transport.subscribe(opts.documentId, (u) => this.receive(u)),
      opts.transport.onConnectionChange(() => this.emitStatus()),
      opts.flusher.status.on(() => this.emitStatus()),
    );
  }

  // ---------------------------------------------------------------- versions

  /** All unacknowledged local steps, oldest first. */
  localSteps(): LocalStep[] {
    return [...this.batches.flatMap((b) => b.steps), ...this.pending.steps];
  }

  get localVersion(): number {
    return this.confirmedVersion + this.batches.reduce((n, b) => n + b.steps.length, 0) + this.pending.steps.length;
  }

  /**
   * A mapping from document version `version` to the current local document, or
   * null if `version` is too old (or ahead of what this client knows).
   */
  mappingFrom(version: number): Mapping | null {
    const local = this.localSteps();
    if (version < this.mapsBase || version > this.confirmedVersion + local.length) return null;
    const maps: StepMap[] = [];
    if (version <= this.confirmedVersion) {
      maps.push(...this.confirmedMaps.slice(version - this.mapsBase));
      maps.push(...local.map((s) => s.step.getMap()));
    } else {
      maps.push(...local.slice(version - this.confirmedVersion).map((s) => s.step.getMap()));
    }
    return new Mapping(maps);
  }

  current(): SyncStatus {
    const unacknowledged = this.outstanding.size;
    let state: SaveState = 'saved';
    if (this.pending.steps.length > 0 || unacknowledged > 0)
      state = this.opts.transport.connection() === 'offline' ? 'offline' : 'queued';
    if (this.lastError && state !== 'saved') state = 'error';
    return {
      state,
      pendingSteps: this.pending.steps.length,
      unacknowledged,
      confirmedVersion: this.confirmedVersion,
      localVersion: this.localVersion,
      lastError: this.lastError,
    };
  }

  private emitStatus(): void {
    this.status.emit(this.current());
  }

  private emitVersion(remote?: VersionChange['remote']): void {
    this.versions.emit({
      documentId: this.documentId,
      confirmedVersion: this.confirmedVersion,
      localVersion: this.localVersion,
      ...(remote ? { remote } : {}),
    });
  }

  private pushConfirmedMaps(maps: StepMap[]): void {
    this.confirmedMaps.push(...maps);
    const extra = this.confirmedMaps.length - this.historyLimit;
    if (extra > 0) {
      this.confirmedMaps.splice(0, extra);
      this.mapsBase += extra;
    }
  }

  // ----------------------------------------------------------------- capture

  /** Records a local, guard-tagged transaction. */
  capture(tr: Transaction, tag: InputTag, at: number = this.clock()): void {
    if (this.destroyed || tr.steps.length === 0) return;
    if (tag.paste) {
      const p = tag.paste;
      this.enqueue(
        makeDraft(
          this.ctx,
          'PasteOccurred',
          {
            pasteId: p.pasteId,
            documentId: this.documentId,
            origin: p.origin,
            via: p.via,
            copyId: p.copyId,
            characters: p.characters,
            words: p.words,
            textHash: p.textHash,
            mimeTypes: p.mimeTypes,
          },
          at,
        ),
      );
    }
    if (this.pending.steps.length > 0 && this.pending.steps.length + tr.steps.length > this.maxSteps) this.flush();

    const runTag: RunTag = { method: tag.method };
    if (tag.pasteId) runTag.pasteId = tag.pasteId;
    if (tag.citationId) runTag.citationId = tag.citationId;
    if (tag.clippingId) runTag.clippingId = tag.clippingId;
    if (tag.traceSuggestionId) runTag.traceSuggestionId = tag.traceSuggestionId;

    let inserted = 0;
    let deleted = 0;
    tr.steps.forEach((step, i) => {
      const before = tr.docs[i] as PMNode;
      const chars = insertedChars(step);
      inserted += chars;
      deleted += deletedChars(step, before);
      if (this.pending.steps.length >= MAX_STEPS_PER_COMMIT) this.flush();
      if (this.pending.steps.length === 0) this.pending.firstAt = at;
      this.pending.steps.push({ step, inverted: step.invert(before), tag: runTag, chars });
    });
    this.pending.lastAt = at;
    this.pending.timeline.push(...timelineEntries(tag, inserted, deleted, at));

    if (this.pending.steps.length >= this.maxSteps) this.flush();
    else this.scheduleIdle();
    this.emitVersion();
    this.emitStatus();
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.flush();
    }, this.idleMs);
  }

  /** Commits the collecting batch now (if any). */
  flush(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.pending.steps.length === 0) return;
    const batch = this.pending;
    this.pending = emptyBatch();
    const base = this.confirmedVersion + this.batches.reduce((n, b) => n + b.steps.length, 0);
    this.batches.push(batch);
    this.enqueue(buildTextEdited(this.ctx, this.documentId, batch, base));
    this.emitStatus();
  }

  private enqueue(draft: CommitDraft): void {
    this.outstanding.add(draft.commitId);
    this.drafts.emit(draft);
    void this.opts.queue.enqueue(draft).then(
      () => this.opts.flusher.kick(),
      (err: unknown) => this.fail('transport', `could not queue ${draft.type}: ${String(err)}`, draft.commitId),
    );
  }

  /** Submits another human event through the ordered queue (flushing pending steps first). */
  submitEvent<K extends SubmittableEventType>(type: K, payload: EventPayloads[K]): CommitDraftOf<K> {
    this.flush();
    const draft = makeDraft(this.ctx, type, payload, this.clock());
    this.enqueue(draft as CommitDraft);
    return draft;
  }

  /** Emits `CitationInserted` (before the citation step is captured). */
  citationInserted(payload: EventPayloads['CitationInserted']): void {
    this.enqueue(makeDraft(this.ctx, 'CitationInserted', payload, this.clock()));
  }

  /** Accepts a proposal: flushes, then queues `ProposalAccepted` at the local version. */
  acceptProposal(proposalId: string): CommitDraftOf<'ProposalAccepted'> {
    this.flush();
    return this.submitEvent('ProposalAccepted', {
      proposalId,
      documentId: this.documentId,
      baseVersion: this.localVersion,
    });
  }

  /**
   * Records a copy or cut of `[from, to)` in the local document: flushes pending
   * steps, then queues `SliceCopied`. Returns the copy id and text hash for the
   * clipboard marker.
   */
  sliceCopied(from: number, to: number, cut: boolean, text: string): { copyId: string; textHash: string } {
    this.flush();
    const copyId = newId();
    const textHash = sha256Hex(text);
    const draft = makeDraft(
      this.ctx,
      'SliceCopied',
      { copyId, documentId: this.documentId, from, to, version: this.localVersion, cut, textHash, characters: text.length },
      this.clock(),
    );
    this.copies.push({ commitId: draft.commitId, k: this.localSteps().length, draft });
    this.enqueue(draft);
    return { copyId, textHash };
  }

  // ------------------------------------------------------------ flusher hooks

  owns(commitId: string): boolean {
    return this.outstanding.has(commitId);
  }

  onAck(entry: QueueEntry, _result: Extract<SubmitResult, { status: 'ack' | 'duplicate' }>): void {
    this.acknowledge(entry.commitId);
  }

  private acknowledge(commitId: string): void {
    if (!this.outstanding.has(commitId)) return;
    const head = this.batches[0];
    if (head && head.commitId === commitId) {
      this.batches.shift();
      this.pushConfirmedMaps(head.steps.map((s) => s.step.getMap()));
      this.confirmedVersion += head.steps.length;
      for (const c of this.copies) c.k -= head.steps.length;
    } else if (this.batches.some((b) => b.commitId === commitId)) {
      // Out-of-order ack: the queue is strictly ordered, so this should not happen.
      this.fail('resync', `out-of-order acknowledgement for ${commitId}`, commitId);
      return;
    }
    this.copies = this.copies.filter((c) => c.commitId !== commitId);
    this.outstanding.delete(commitId);
    this.lastError = null;
    this.processBuffered();
    this.emitVersion();
    this.emitStatus();
  }

  async onConflict(entry: QueueEntry, _currentVersion: number): Promise<void> {
    if (!this.outstanding.has(entry.commitId)) return;
    if (entry.type === 'ProposalAccepted') {
      // The writer accepted against a version that has since moved. The proposal
      // must be re-checked against the new text, so it is dropped, not rebased.
      this.outstanding.delete(entry.commitId);
      await this.opts.queue.remove(entry.commitId);
      this.fail('rejected', 'proposal acceptance was out of date; accept it again', entry.commitId);
      return;
    }
    await this.catchUp();
  }

  onRejected(entry: QueueEntry, reason: string): void {
    this.outstanding.delete(entry.commitId);
    this.fail('rejected', reason, entry.commitId);
    if (isTextEdited(entry.draft)) {
      // The ledger refused our steps: drop the batch and resync to the ledger's text.
      this.batches = this.batches.filter((b) => b.commitId !== entry.commitId);
      void this.catchUp(true);
    }
  }

  private fail(kind: SyncError['kind'], message: string, commitId?: string): void {
    this.lastError = message;
    this.errors.emit({ kind, message, ...(commitId ? { commitId } : {}) });
    this.emitStatus();
  }

  // ----------------------------------------------------------------- remote

  /** Handles a step-bearing commit from the ledger (subscription or catch-up). */
  receive(update: RemoteUpdate): void {
    if (this.destroyed || update.documentId !== this.documentId) return;
    if (this.outstanding.has(update.commitId) && update.type === 'TextEdited') {
      if (this.batches[0]?.commitId === update.commitId) this.acknowledge(update.commitId);
      return;
    }
    if (update.version <= this.confirmedVersion) return;
    if (update.baseVersion > this.confirmedVersion) {
      if (!this.buffered.some((b) => b.commitId === update.commitId)) this.buffered.push(update);
      this.scheduleStallCheck();
      return;
    }
    if (this.outstanding.has(update.commitId)) {
      // Our own ProposalAccepted: its derived steps arrive here.
      this.outstanding.delete(update.commitId);
    }
    const steps = update.steps.slice(this.confirmedVersion - update.baseVersion);
    this.applyRemoteSteps(update, steps);
    this.processBuffered();
  }

  private scheduleStallCheck(): void {
    if (this.stallTimer) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.buffered.some((b) => b.baseVersion > this.confirmedVersion)) void this.catchUp();
    }, 1500);
  }

  private processBuffered(): void {
    for (;;) {
      this.buffered = this.buffered.filter((b) => b.version > this.confirmedVersion);
      const next = this.buffered.find((b) => b.baseVersion <= this.confirmedVersion);
      if (!next) return;
      this.buffered = this.buffered.filter((b) => b !== next);
      this.receive(next);
    }
  }

  private applyRemoteSteps(update: RemoteUpdate, json: RemoteUpdate['steps']): void {
    if (json.length === 0) return;
    let remote: Step[];
    try {
      remote = json.map((j) => Step.fromJSON(schema, j));
    } catch (err) {
      this.fail('resync', `bad remote steps: ${String(err)}`);
      void this.catchUp(true);
      return;
    }
    const state = this.opts.host.getState();
    const local = this.localSteps();
    let result: ReturnType<typeof rebaseOnDoc<Transaction>>;
    try {
      result = rebaseOnDoc(state.tr, local, remote);
    } catch (err) {
      this.fail('resync', `remote steps do not apply: ${String(err)}`);
      void this.catchUp(true);
      return;
    }
    const tr = result.transform;
    this.opts.host.applyRemote(tr);
    this.pushConfirmedMaps(remote.map((s) => s.getMap()));
    this.confirmedVersion += remote.length;
    this.reassign(result.steps, result.inverted);
    this.regenerate(result);
    this.emitVersion({ update, mapping: tr.mapping });
    this.emitStatus();
  }

  private reassign(steps: Array<Step | null>, inverted: Array<Step | null>): void {
    let i = 0;
    for (const b of [...this.batches, this.pending]) {
      const next: LocalStep[] = [];
      for (const s of b.steps) {
        const step = steps[i];
        const inv = inverted[i];
        i++;
        if (step && inv) next.push({ ...s, step, inverted: inv, chars: insertedChars(step) });
      }
      b.steps = next;
    }
  }

  /** Rewrites the queued drafts of this document after a rebase. */
  private regenerate(result: RebaseResult | null): void {
    const queue = this.opts.queue;
    let base = this.confirmedVersion;
    const keep: LocalBatch[] = [];
    for (const b of this.batches) {
      const oldId = b.commitId;
      this.outstanding.delete(oldId);
      if (b.steps.length === 0) {
        void queue.replace(oldId, null);
        continue;
      }
      b.commitId = newId();
      this.outstanding.add(b.commitId);
      const draft = buildTextEdited(this.ctx, this.documentId, b, base);
      this.drafts.emit(draft);
      void queue.replace(oldId, draft);
      base += b.steps.length;
      keep.push(b);
    }
    this.batches = keep;
    const copies: PendingCopy[] = [];
    for (const c of this.copies) {
      const p = c.draft.payload;
      const from = result ? result.mapAfter(c.k, p.from, 1) : p.from;
      const to = result ? result.mapAfter(c.k, p.to, -1) : p.to;
      const k = result ? result.survivorsBefore(c.k) : c.k;
      if (to <= from) {
        this.outstanding.delete(c.commitId);
        void queue.replace(c.commitId, null);
        continue;
      }
      const draft: CommitDraftOf<'SliceCopied'> = {
        ...c.draft,
        payload: { ...p, from, to, version: this.confirmedVersion + k },
      };
      void queue.replace(c.commitId, draft);
      copies.push({ commitId: c.commitId, k, draft });
    }
    this.copies = copies;
    void Promise.resolve().then(() => this.opts.flusher.kick());
  }

  /**
   * Fetches everything since `confirmedVersion` and applies it. With `hard`, or
   * when the service answers with a snapshot, reloads the document.
   */
  catchUp(hard = false): Promise<void> {
    if (this.catchingUp) return this.catchingUp;
    this.catchingUp = (async () => {
      try {
        const res = await this.opts.transport.fetchSince(this.documentId, hard ? 0 : this.confirmedVersion);
        if (res.kind === 'snapshot') this.resetFromSnapshot(res.doc, res.version);
        else if (hard && res.updates.length === 0 && res.version !== this.confirmedVersion)
          this.fail('resync', 'catch-up returned no updates');
        else if (hard) this.replayFromScratch(res.updates, res.version);
        else for (const u of res.updates) this.receive(u);
      } catch (err) {
        this.fail('transport', `catch-up failed: ${String(err)}`);
        throw err;
      } finally {
        this.catchingUp = null;
      }
    })();
    return this.catchingUp;
  }

  private replayFromScratch(updates: RemoteUpdate[], version: number): void {
    // Hard resync without a snapshot: only possible if updates start at 0 on an empty doc.
    if (updates.length === 0 || updates[0]?.baseVersion !== 0) {
      this.fail('resync', `cannot rebuild document from version 0 (have ${updates.length} updates, version ${version})`);
      return;
    }
    let doc = docFromJSON({ type: 'doc', content: [{ type: 'paragraph' }] });
    for (const u of updates) {
      for (const j of u.steps) {
        const r = Step.fromJSON(schema, j).apply(doc);
        if (!r.doc) {
          this.fail('resync', `ledger step failed to apply: ${r.failed ?? ''}`);
          return;
        }
        doc = r.doc;
      }
    }
    this.resetFromDoc(doc, version);
  }

  /** Replaces the confirmed document and re-applies unacknowledged local steps on top. */
  resetFromSnapshot(json: PMNodeJSON, version: number): void {
    this.resetFromDoc(docFromJSON(json), version);
  }

  private resetFromDoc(doc: PMNode, version: number): void {
    const local = this.localSteps();
    const tr = new Transform(doc);
    const kept: Array<Step | null> = [];
    const inv: Array<Step | null> = [];
    let lost = 0;
    for (const s of local) {
      const before = tr.doc;
      if (!tr.maybeStep(s.step).failed) {
        kept.push(s.step);
        inv.push(s.step.invert(before));
      } else {
        kept.push(null);
        inv.push(null);
        lost++;
      }
    }
    this.confirmedVersion = version;
    this.confirmedMaps = [];
    this.mapsBase = version;
    this.buffered = [];
    this.opts.host.resetDoc(tr.doc);
    this.reassign(kept, inv);
    this.regenerate(null);
    if (lost > 0) this.fail('lost-steps', `${lost} unsynced step(s) no longer applied after a reload`);
    this.emitVersion();
    this.emitStatus();
  }

  // ---------------------------------------------------------------- restore

  /**
   * Restores this document's queued drafts from a previous page load: replays them
   * on top of the initial document (so the writer sees their unsynced text) and
   * takes ownership. Call once, before the writer types.
   */
  async restore(): Promise<number> {
    const entries = (await this.opts.queue.list()).filter((e) => e.documentId === this.documentId);
    if (entries.length === 0) return 0;
    let texts = entries.filter((e) => isTextEdited(e.draft)).map((e) => e.draft as CommitDraftOf<'TextEdited'>);
    for (const e of entries) if (!isTextEdited(e.draft) && e.type !== 'SliceCopied') this.outstanding.add(e.commitId);
    if (texts.length === 0) {
      this.emitStatus();
      return 0;
    }
    const first = texts[0] as CommitDraftOf<'TextEdited'>;
    if (first.payload.baseVersion !== this.confirmedVersion) {
      let res;
      try {
        res = await this.opts.transport.fetchSince(this.documentId, Math.min(first.payload.baseVersion, this.confirmedVersion));
      } catch {
        // Offline: leave the drafts to the flusher; they will come back as ledger updates.
        return 0;
      }
      if (res.kind === 'snapshot') return 0;
      const r = reconcileHeadless(texts, res.updates.filter((u) => u.baseVersion >= first.payload.baseVersion), first.payload.baseVersion);
      for (const id of r.applied) await this.opts.queue.remove(id);
      // Bring the view up to the ledger's version first.
      for (const u of res.updates) this.receive(u);
      if (this.confirmedVersion !== r.version) return 0;
      const rebuilt: CommitDraftOf<'TextEdited'>[] = [];
      let v = r.version;
      for (const p of r.remaining) {
        const d = p.changed ? rebuildTextEdited(p.draft, p.steps, p.kept, v) : p.draft;
        await this.opts.queue.replace(p.draft.commitId, d);
        if (d) {
          rebuilt.push(d);
          v += d.payload.steps.length;
        }
      }
      texts = rebuilt;
    }
    return this.replay(texts);
  }

  private replay(texts: CommitDraftOf<'TextEdited'>[]): number {
    const state = this.opts.host.getState();
    const tr = state.tr;
    let expected = this.confirmedVersion;
    let count = 0;
    for (const d of texts) {
      if (d.payload.baseVersion !== expected) break;
      const tags = stepTagsOf(d.payload.runs);
      const clientMs = Date.parse(d.clientTime);
      const batch: LocalBatch = {
        commitId: d.commitId,
        steps: [],
        timeline: d.payload.timeline.map((k): TimelineEntry => ({ at: clientMs + k.t, kind: k.kind, len: k.len })),
        firstAt: clientMs,
        lastAt: clientMs + d.payload.durationMs,
      };
      let ok = true;
      d.payload.steps.forEach((j, i) => {
        if (!ok) return;
        const step = Step.fromJSON(schema, j);
        const before = tr.doc;
        if (tr.maybeStep(step).failed) {
          ok = false;
          return;
        }
        batch.steps.push({ step, inverted: step.invert(before), tag: tags[i] ?? { method: 'pasted-external' }, chars: insertedChars(step) });
      });
      if (!ok) {
        this.fail('lost-steps', `queued draft ${d.commitId} no longer applies`);
        break;
      }
      this.batches.push(batch);
      this.outstanding.add(d.commitId);
      expected += batch.steps.length;
      count += batch.steps.length;
    }
    if (tr.docChanged) this.opts.host.applyRemote(tr as Transaction);
    this.emitVersion();
    this.emitStatus();
    this.opts.flusher.kick();
    return count;
  }

  /** Stops listening. Pending steps are flushed to the queue first. */
  destroy(): void {
    this.flush();
    this.destroyed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    for (const u of this.unsubs) u();
  }
}

function timelineEntries(tag: InputTag, inserted: number, deleted: number, at: number): TimelineEntry[] {
  switch (tag.kind) {
    case 'insert':
    case 'compose':
    case 'autocorrect':
      return deleted > 0 && tag.kind === 'insert'
        ? [
            { at, kind: 'delete', len: deleted },
            { at, kind: 'insert', len: inserted },
          ]
        : [{ at, kind: tag.kind, len: inserted }];
    case 'paste':
    case 'drop':
      return [{ at, kind: tag.kind, len: inserted }];
    case 'delete':
    case 'cut':
      return [{ at, kind: tag.kind, len: deleted }];
    case 'undo':
    case 'redo':
      return [{ at, kind: tag.kind, len: Math.max(inserted, deleted) }];
    case 'break':
    case 'format':
      return [{ at, kind: tag.kind, len: inserted }];
  }
}
