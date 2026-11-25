/**
 * `LedgerBuilder`: builds realistic, valid, hashed ledgers in tests and fixtures.
 *
 * The builder behaves like the editor plus the ledger service: it turns actions
 * ("type this", "paste that", "the agent comments on p2.s1") into commit drafts
 * with real ProseMirror steps, input-method runs and keystroke timelines, checks
 * each with `validateDraft` (throws on rejection), appends it with
 * `appendToChain`, folds it, and — like the service — appends the
 * `SuggestionResolved` events the fold derives. Time is a deterministic clock;
 * typing cadence comes from a seeded generator, so a builder script always
 * produces byte-identical commits.
 */
import {
  countWords,
  inlineTextBetween,
  resolveAnchor,
  resolveInsertionPoint,
  resolveMerge,
  resolveMove,
  resolveSpan,
  resolveSplit,
  schema,
  sha256Hex,
  type Actor,
  type Anchor,
  type AnchorInput,
  type Commit,
  type CommitDraft,
  type CslItem,
  type DismissReason,
  type EventPayload,
  type EventType,
  type FeedbackEditor,
  type FeedbackScope,
  type InputRun,
  type Intensity,
  type Keystroke,
  type KeystrokeKind,
  type Lens,
  type PMNode,
  type ProjectState,
  type ResolvedAnchor,
  type Severity,
  type SourceOrigin,
  type SpanRef,
  type SurfacedCandidate,
  type Target,
} from '@longhand/schema';
import { Fragment, Slice, type Node as PMNodeClass } from 'prosemirror-model';
import { Mapping, Transform, type Step, type StepMap } from 'prosemirror-transform';
import { appendToChain } from './chain';
import { mapsBetween } from './engine';
import { applyCommit, emptyState } from './fold';
import { projectState } from './project';
import { internal, type LedgerState } from './state';
import { resolutionsBetween, validateDraft } from './validate';

/** Options for a new builder. */
export interface BuilderOptions {
  projectId?: string;
  accountId?: string;
  title?: string;
  userId?: string;
  deviceId?: string;
  /** Editor session id of the first page load. */
  editorSessionId?: string;
  /** Clock start (ISO). */
  start?: string;
  /** Seed for typing cadence. */
  seed?: number;
  /** Append `SuggestionResolved` after human commits that resolve something (default true). */
  autoResolve?: boolean;
}

/** An anchor given by quote, resolved by the builder (optionally against an older version). */
export interface AnchorSpec extends AnchorInput {
  /** Version the agent read (default: current). Must be a version the builder saw at a commit boundary. */
  readVersion?: number;
}

/** A span given by ids, resolved by the builder. */
export interface SpanSpec extends SpanRef {
  readVersion?: number;
}

/** A comment/cut target: an anchor or a span. */
export type TargetSpec = ({ kind: 'anchor' } & AnchorSpec) | ({ kind: 'span' } & SpanSpec);

/** Where to put the caret. */
export type At = number | 'end' | { after: string } | { before: string } | { endOf: string };

/** Typing options. */
export interface TypeOptions {
  at?: At;
  method?: 'typed' | 'ime' | 'autocorrect';
  traceSuggestionId?: string;
  /** Milliseconds between keystrokes, `[min, max]`. */
  cadence?: [number, number];
}

const ISO = (ms: number): string => new Date(ms).toISOString();

/** End of the last textblock's content. */
export function docEnd(doc: PMNode): number {
  let pos = doc.content.size;
  let node: PMNode | null = doc;
  while (node && !node.isTextblock) {
    const last: PMNode | null = node.lastChild;
    if (!last) break;
    pos -= 1;
    node = last;
  }
  return pos;
}

function textSlice(text: string): Slice {
  const lines = text.split('\n');
  if (lines.length === 1) return new Slice(Fragment.from(schema.text(text)), 0, 0);
  const paras = lines.map((l) => schema.nodes.paragraph!.create(null, l ? schema.text(l) : null));
  return new Slice(Fragment.from(paras), 1, 1);
}

interface UndoEntry {
  docId: string;
  steps: Step[];
  inverse: Step[];
  docsBefore: PMNode[];
  version: number;
}

/** Builds hashed, valid ledgers. */
export class LedgerBuilder {
  readonly commits: Commit[] = [];
  state: LedgerState = emptyState();
  readonly projectId: string;
  readonly accountId: string;
  readonly userId: string;
  deviceId: string;
  editorSessionId: string;
  private clock: number;
  private lastServer = 0;
  private rng: number;
  private counter = 0;
  private readonly autoResolve: boolean;
  private readonly snapshots = new Map<string, Map<number, PMNode>>();
  private readonly copies = new Map<string, Slice>();
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: UndoEntry[] = [];

  constructor(opts: BuilderOptions = {}) {
    this.projectId = opts.projectId ?? 'proj-1';
    this.accountId = opts.accountId ?? 'acct-1';
    this.userId = opts.userId ?? 'writer-1';
    this.deviceId = opts.deviceId ?? 'device-1';
    this.editorSessionId = opts.editorSessionId ?? 'editor-1';
    this.clock = Date.parse(opts.start ?? '2026-11-02T09:00:00.000Z');
    this.rng = (opts.seed ?? 1) >>> 0 || 1;
    this.autoResolve = opts.autoResolve ?? true;
    this.human('ProjectCreated', { title: opts.title ?? 'Untitled project' });
  }

  // -------------------------------------------------------------------------
  // Basics
  // -------------------------------------------------------------------------

  /** The folded public state. */
  get project(): ProjectState {
    return projectState(this.state);
  }

  /** The last commit. */
  get head(): Commit {
    return this.commits[this.commits.length - 1] as Commit;
  }

  /** Current document node. */
  doc(documentId: string): PMNode {
    const d = internal(this.state).docs[documentId];
    if (!d) throw new Error(`builder: no document ${documentId}`);
    return d.node;
  }

  /** Current document version. */
  version(documentId: string): number {
    return internal(this.state).docs[documentId]?.version ?? 0;
  }

  /** Current clock (ISO). */
  now(): string {
    return ISO(this.clock);
  }

  /** Advances the clock. */
  wait(ms: number): this {
    this.clock += ms;
    return this;
  }

  /** Starts a new editor session (a page load), optionally on another device. */
  newEditorSession(id: string, deviceId?: string): this {
    this.editorSessionId = id;
    if (deviceId) this.deviceId = deviceId;
    return this;
  }

  /** A fresh deterministic id. */
  id(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${String(this.counter).padStart(4, '0')}`;
  }

  private rand(min: number, max: number): number {
    // xorshift32
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return min + (this.rng % (max - min + 1));
  }

  /** Appends a draft (validated) and folds it. Returns the commit. */
  append(draft: CommitDraft, serverDelayMs = 250): Commit {
    const serverMs = Math.max(this.lastServer + 1, Date.parse(draft.clientTime) + serverDelayMs);
    this.lastServer = serverMs;
    const serverTime = ISO(serverMs);
    const actor = draft.actor as Actor;
    const v = validateDraft(this.state, draft, actor, { serverTime, accountId: this.accountId });
    if (!v.ok) {
      throw new Error(
        `builder: ${draft.type} rejected: ${v.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`,
      );
    }
    const prev = this.commits.length > 0 ? this.head : null;
    const commit = appendToChain(prev, draft, serverTime, { accountId: this.accountId });
    const before = this.state;
    this.state = applyCommit(this.state, commit);
    this.commits.push(commit);
    this.snapshot();
    if (this.autoResolve && actor.kind === 'human') {
      for (const r of resolutionsBetween(before, this.state, commit.seq))
        this.system('SuggestionResolved', r);
    }
    return commit;
  }

  private snapshot(): void {
    for (const [id, d] of Object.entries(internal(this.state).docs)) {
      let m = this.snapshots.get(id);
      if (!m) this.snapshots.set(id, (m = new Map()));
      if (!m.has(d.version)) m.set(d.version, d.node);
    }
  }

  private envelope(actor: Actor, sessionId: string, deviceId: string, clientTime: string) {
    return {
      commitId: this.id('c'),
      projectId: this.projectId,
      clientTime,
      actor,
      deviceId,
      sessionId,
      schemaVersion: 1,
    };
  }

  /** Appends a human event. */
  human<K extends EventType>(
    type: K,
    payload: EventPayload<K>,
    opts: { clientTime?: string } = {},
  ): Commit {
    const clientTime = opts.clientTime ?? this.now();
    const draft = {
      ...this.envelope(
        { kind: 'human', id: this.userId },
        this.editorSessionId,
        this.deviceId,
        clientTime,
      ),
      type,
      payload,
    } as unknown as CommitDraft;
    const c = this.append(draft);
    this.clock = Math.max(this.clock, Date.parse(clientTime)) + 400;
    return c;
  }

  /** Appends an agent event in a feedback session. */
  agent<K extends EventType>(
    type: K,
    payload: EventPayload<K>,
    sessionId: string,
    model = 'opus',
  ): Commit {
    this.clock += 1500;
    const draft = {
      ...this.envelope({ kind: 'agent', id: model }, sessionId, 'server', this.now()),
      type,
      payload,
    } as unknown as CommitDraft;
    return this.append(draft, 50);
  }

  /** Appends a system event. */
  system<K extends EventType>(type: K, payload: EventPayload<K>): Commit {
    const draft = {
      ...this.envelope(
        { kind: 'system', id: 'ledger' },
        'system',
        'server',
        ISO(Math.max(this.clock, this.lastServer)),
      ),
      type,
      payload,
    } as unknown as CommitDraft;
    return this.append(draft, 1);
  }

  // -------------------------------------------------------------------------
  // Binder and library
  // -------------------------------------------------------------------------

  /** Creates an empty document (or note). */
  createDocument(
    documentId: string,
    title: string,
    opts: { kind?: 'manuscript' | 'note'; parentId?: string | null; index?: number } = {},
  ): this {
    const kind = opts.kind ?? 'manuscript';
    const area = kind === 'note' ? 'notes' : 'manuscript';
    const siblings = opts.parentId
      ? (this.project.folders[opts.parentId]?.children ?? [])
      : this.project.binder[area];
    this.human('DocumentCreated', {
      documentId,
      kind,
      title,
      parentId: opts.parentId ?? null,
      index: opts.index ?? siblings.length,
    });
    return this;
  }

  /** Imports an existing draft (text paragraphs separated by blank lines, or document JSON). */
  importDocument(
    documentId: string,
    title: string,
    content: string | PMNodeClass,
    opts: {
      kind?: 'manuscript' | 'note';
      parentId?: string | null;
      index?: number;
      sourceName?: string;
    } = {},
  ): this {
    const node =
      typeof content === 'string'
        ? schema.nodes.doc!.create(
            null,
            content
              .split(/\n\n+/)
              .map((p) => schema.nodes.paragraph!.create(null, p ? schema.text(p) : null)),
          )
        : content;
    const kind = opts.kind ?? 'manuscript';
    const area = kind === 'note' ? 'notes' : 'manuscript';
    const siblings = opts.parentId
      ? (this.project.folders[opts.parentId]?.children ?? [])
      : this.project.binder[area];
    this.human('DocumentImported', {
      documentId,
      kind,
      title,
      parentId: opts.parentId ?? null,
      index: opts.index ?? siblings.length,
      content: node.toJSON(),
      sourceFormat: 'markdown',
      sourceName: opts.sourceName ?? `${documentId}.md`,
      sourceHash: sha256Hex(typeof content === 'string' ? content : JSON.stringify(node.toJSON())),
    });
    return this;
  }

  /** Creates a folder. */
  createFolder(
    folderId: string,
    title: string,
    opts: { area?: 'manuscript' | 'notes'; parentId?: string | null; index?: number } = {},
  ): this {
    const area = opts.area ?? 'manuscript';
    const siblings = opts.parentId
      ? (this.project.folders[opts.parentId]?.children ?? [])
      : this.project.binder[area];
    this.human('FolderCreated', {
      folderId,
      area,
      title,
      parentId: opts.parentId ?? null,
      index: opts.index ?? siblings.length,
    });
    return this;
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  /** Resolves a caret position. */
  pos(documentId: string, at: At = 'end'): number {
    const doc = this.doc(documentId);
    if (at === 'end') return docEnd(doc);
    if (typeof at === 'number') return at;
    const text = 'after' in at ? at.after : 'before' in at ? at.before : at.endOf;
    let found = -1;
    doc.descendants((n, p) => {
      if (found >= 0 || !n.isText) return found < 0;
      const i = (n.text as string).indexOf(text);
      if (i >= 0) found = p + i;
      return false;
    });
    if (found < 0) {
      // Fall back to inline text across text nodes.
      const all = inlineTextBetween(doc, 0, doc.content.size, '\u0000');
      if (!all.includes(text))
        throw new Error(`builder: text ${JSON.stringify(text)} not found in ${documentId}`);
      throw new Error(`builder: text ${JSON.stringify(text)} spans nodes; use a numeric position`);
    }
    if ('after' in at) return found + text.length;
    if ('before' in at) return found;
    const $p = doc.resolve(found);
    return $p.end();
  }

  /**
   * Emits one `TextEdited` built from `parts` (each a run). `build` adds steps to
   * the transform; `timeline` entries are offsets within the commit.
   */
  edit(
    documentId: string,
    parts: Array<{
      build: (tr: Transform) => void;
      run: Omit<InputRun, 'steps'>;
      keys?: Array<{ kind: KeystrokeKind; len: number; dt: number }>;
    }>,
    opts: { record?: boolean } = {},
  ): Commit {
    const doc = this.doc(documentId);
    const tr = new Transform(doc);
    const runs: InputRun[] = [];
    const timeline: Keystroke[] = [];
    let t = 0;
    let characters = 0;
    for (const part of parts) {
      const before = tr.steps.length;
      const sizeBefore = tr.doc.content.size;
      part.build(tr);
      const n = tr.steps.length - before;
      if (n === 0) continue;
      runs.push({ ...part.run, steps: n } as InputRun);
      const keys = part.keys ?? [
        {
          kind: 'insert' as KeystrokeKind,
          len: Math.max(0, tr.doc.content.size - sizeBefore),
          dt: 0,
        },
      ];
      keys.forEach((k, i) => {
        if (timeline.length > 0 || i > 0) t += k.dt;
        timeline.push({ t, kind: k.kind, len: k.len });
        if (
          k.kind === 'insert' ||
          k.kind === 'compose' ||
          k.kind === 'paste' ||
          k.kind === 'clip' ||
          k.kind === 'drop' ||
          k.kind === 'autocorrect'
        ) {
          characters += k.len;
        }
      });
    }
    if (tr.steps.length === 0) throw new Error('builder: edit produced no steps');
    const clientTime = this.now();
    const commit = this.human(
      'TextEdited',
      {
        documentId,
        baseVersion: this.version(documentId),
        steps: tr.steps.map((s) => s.toJSON() as { stepType: 'replace' }),
        runs,
        timeline,
        characters,
        durationMs: t,
      },
      { clientTime },
    );
    this.clock = Date.parse(clientTime) + t + 2000;
    if (opts.record !== false) {
      this.undoStack.push({
        docId: documentId,
        steps: tr.steps.slice(),
        inverse: tr.steps.map((s, i) => s.invert(tr.docs[i] as PMNodeClass)).reverse(),
        docsBefore: tr.docs.slice(),
        version: this.version(documentId),
      });
      this.redoStack.length = 0;
    }
    return commit;
  }

  /** Types text keystroke by keystroke (`\n` is Enter), batching ≤ 50 steps per commit. */
  type(documentId: string, text: string, opts: TypeOptions = {}): this {
    let pos = this.pos(documentId, opts.at ?? 'end');
    const chars = Array.from(text);
    const [lo, hi] = opts.cadence ?? [70, 210];
    const method = opts.method ?? 'typed';
    for (let i = 0; i < chars.length; i += 50) {
      const batch = chars.slice(i, i + 50);
      const keys: Array<{ kind: KeystrokeKind; len: number; dt: number }> = [];
      let p = pos;
      this.edit(documentId, [
        {
          run: {
            method,
            ...(opts.traceSuggestionId ? { traceSuggestionId: opts.traceSuggestionId } : {}),
          },
          build: (tr) => {
            for (const ch of batch) {
              if (ch === '\n') {
                tr.split(p);
                p += 2;
                keys.push({ kind: 'break', len: 0, dt: this.rand(lo, hi) * 2 });
              } else {
                tr.insert(p, schema.text(ch));
                p += ch.length;
                keys.push({ kind: 'insert', len: ch.length, dt: this.rand(lo, hi) });
              }
            }
          },
          keys,
        },
      ]);
      pos = p;
    }
    return this;
  }

  /** IME composition: the composing text grows in place, then commits (method `ime`). */
  compose(documentId: string, stages: string[], opts: { at?: At } = {}): this {
    const pos = this.pos(documentId, opts.at ?? 'end');
    const keys: Array<{ kind: KeystrokeKind; len: number; dt: number }> = [];
    this.edit(documentId, [
      {
        run: { method: 'ime' },
        build: (tr) => {
          let prev = 0;
          for (const s of stages) {
            tr.replaceWith(pos, pos + prev, schema.text(s));
            keys.push({ kind: 'compose', len: s.length, dt: this.rand(120, 260) });
            prev = s.length;
          }
        },
        keys,
      },
    ]);
    return this;
  }

  /** Presses Backspace `count` times at a position (deletes characters before it). */
  backspace(documentId: string, count: number, opts: { at?: At } = {}): this {
    let p = this.pos(documentId, opts.at ?? 'end');
    const keys: Array<{ kind: KeystrokeKind; len: number; dt: number }> = [];
    this.edit(documentId, [
      {
        run: { method: 'typed' },
        build: (tr) => {
          for (let i = 0; i < count; i++) {
            tr.delete(p - 1, p);
            p -= 1;
            keys.push({ kind: 'delete', len: 1, dt: this.rand(60, 140) });
          }
        },
        keys,
      },
    ]);
    return this;
  }

  /** Selects `[from, to)` and deletes it with one keystroke. */
  deleteRange(documentId: string, from: number, to: number): this {
    this.edit(documentId, [
      {
        run: { method: 'typed' },
        build: (tr) => tr.delete(from, to),
        keys: [{ kind: 'delete', len: to - from, dt: 0 }],
      },
    ]);
    return this;
  }

  /** Selects the first occurrence of `text` and deletes it. */
  deleteText(documentId: string, text: string): this {
    const from = this.pos(documentId, { before: text });
    return this.deleteRange(documentId, from, from + text.length);
  }

  /** Selects `[from, to)` and types `text` over it (the first keystroke replaces the selection). */
  typeOver(
    documentId: string,
    from: number,
    to: number,
    text: string,
    opts: Omit<TypeOptions, 'at'> = {},
  ): this {
    const chars = Array.from(text);
    const keys: Array<{ kind: KeystrokeKind; len: number; dt: number }> = [];
    let p = from;
    this.edit(documentId, [
      {
        run: {
          method: opts.method ?? 'typed',
          ...(opts.traceSuggestionId ? { traceSuggestionId: opts.traceSuggestionId } : {}),
        },
        build: (tr) => {
          chars.forEach((ch, i) => {
            if (i === 0) tr.replaceWith(from, to, schema.text(ch));
            else tr.insert(p, schema.text(ch));
            p += ch.length;
            keys.push({ kind: 'insert', len: ch.length, dt: this.rand(70, 200) });
          });
        },
        keys,
      },
    ]);
    return this;
  }

  /** Presses Enter at a position. */
  enter(documentId: string, opts: { at?: At } = {}): this {
    const p = this.pos(documentId, opts.at ?? 'end');
    this.edit(documentId, [
      {
        run: { method: 'typed' },
        build: (tr) => tr.split(p),
        keys: [{ kind: 'break', len: 0, dt: 0 }],
      },
    ]);
    return this;
  }

  /** Applies a formatting change (marks, block type) as typed input. */
  format(documentId: string, build: (tr: Transform) => void): this {
    this.edit(documentId, [
      { run: { method: 'typed' }, build, keys: [{ kind: 'format', len: 0, dt: 0 }] },
    ]);
    return this;
  }

  /** Pastes external text (`\n` separates paragraphs): `PasteOccurred` then a `pasted-external` run. */
  pasteExternal(
    documentId: string,
    text: string,
    opts: { at?: At; replace?: [number, number]; via?: 'clipboard' | 'drop' } = {},
  ): string {
    const pasteId = this.id('paste');
    const slice = textSlice(text);
    const plain = text.split('\n').join('\n');
    this.human('PasteOccurred', {
      pasteId,
      documentId,
      origin: 'external',
      via: opts.via ?? 'clipboard',
      copyId: null,
      characters: plain.replace(/\n/g, '').length,
      words: countWords(plain),
      textHash: sha256Hex(plain),
      mimeTypes: ['text/plain', 'text/html'],
    });
    const [from, to] = opts.replace ?? [
      this.pos(documentId, opts.at ?? 'end'),
      this.pos(documentId, opts.at ?? 'end'),
    ];
    this.edit(documentId, [
      {
        run: { method: 'pasted-external', pasteId },
        build: (tr) => tr.replace(from, to, slice),
        keys: [{ kind: opts.via === 'drop' ? 'drop' : 'paste', len: plain.length, dt: 0 }],
      },
    ]);
    return pasteId;
  }

  /** Copies (or cuts) `[from, to)`: emits `SliceCopied` (and the cut's deletion). Returns the copyId. */
  copy(documentId: string, from: number, to: number, opts: { cut?: boolean } = {}): string {
    const copyId = this.id('copy');
    const doc = this.doc(documentId);
    const text = inlineTextBetween(doc, from, to, '\n');
    this.copies.set(copyId, doc.slice(from, to));
    this.human('SliceCopied', {
      copyId,
      documentId,
      from,
      to,
      version: this.version(documentId),
      cut: opts.cut ?? false,
      textHash: sha256Hex(text),
      characters: text.length,
    });
    if (opts.cut) {
      this.edit(documentId, [
        {
          run: { method: 'typed' },
          build: (tr) => tr.delete(from, to),
          keys: [{ kind: 'cut', len: to - from, dt: 0 }],
        },
      ]);
    }
    return copyId;
  }

  /** Pastes a copied slice (`PasteOccurred` internal, then a `pasted-internal` run). */
  pasteInternal(documentId: string, copyId: string, opts: { at?: At; slice?: Slice } = {}): string {
    const slice = opts.slice ?? this.copies.get(copyId);
    if (!slice) throw new Error(`builder: unknown copy ${copyId}`);
    const pasteId = this.id('paste');
    const tmp = schema.nodes.doc!.create(
      null,
      slice.openStart > 0 ? slice.content : schema.nodes.paragraph!.create(null, slice.content),
    );
    const text = inlineTextBetween(tmp, 0, tmp.content.size, '\n');
    this.human('PasteOccurred', {
      pasteId,
      documentId,
      origin: 'internal',
      via: 'clipboard',
      copyId,
      characters: text.replace(/\n/g, '').length,
      words: countWords(text),
      textHash: sha256Hex(text),
      mimeTypes: ['text/plain', 'text/html'],
    });
    const at = this.pos(documentId, opts.at ?? 'end');
    this.edit(documentId, [
      {
        run: { method: 'pasted-internal', pasteId },
        build: (tr) => tr.replace(at, at, slice),
        keys: [{ kind: 'paste', len: text.length, dt: 0 }],
      },
    ]);
    return pasteId;
  }

  /** Drags `[from, to)` to `at` (a `drop-internal` run: delete, then insert the same slice). */
  drop(documentId: string, from: number, to: number, at: number): this {
    const slice = this.doc(documentId).slice(from, to);
    this.edit(documentId, [
      {
        run: { method: 'drop-internal' },
        build: (tr) => {
          tr.delete(from, to);
          const target = tr.mapping.map(at);
          tr.replace(target, target, slice);
        },
        keys: [{ kind: 'drop', len: to - from, dt: 0 }],
      },
    ]);
    return this;
  }

  /** Undoes the builder's last recorded edit (a `history` run of the inverted steps). */
  undo(): this {
    const e = this.undoStack.pop();
    if (!e) throw new Error('builder: nothing to undo');
    const maps = this.mapsSince(e.docId, e.version);
    this.edit(
      e.docId,
      [
        {
          run: { method: 'history' },
          build: (tr) => {
            for (const s of e.inverse) {
              const mapped = maps.length ? s.map(new Mapping(maps.slice())) : s;
              if (mapped) tr.step(mapped);
            }
          },
          keys: [{ kind: 'undo', len: 0, dt: 0 }],
        },
      ],
      { record: false },
    );
    this.redoStack.push({ ...e, version: this.version(e.docId) });
    return this;
  }

  /** Redoes the last undone edit (a `history` run of the original steps). */
  redo(): this {
    const e = this.redoStack.pop();
    if (!e) throw new Error('builder: nothing to redo');
    this.edit(
      e.docId,
      [
        {
          run: { method: 'history' },
          build: (tr) => e.steps.forEach((s) => tr.step(s)),
          keys: [{ kind: 'redo', len: 0, dt: 0 }],
        },
      ],
      { record: false },
    );
    this.undoStack.push({ ...e, version: this.version(e.docId) });
    return this;
  }

  private mapsSince(docId: string, version: number): StepMap[] {
    const d = internal(this.state).docs[docId]!;
    return mapsBetween(d.maps, version, d.version) ?? [];
  }

  // -------------------------------------------------------------------------
  // Research
  // -------------------------------------------------------------------------

  /** Adds a library source. */
  addSource(
    sourceId: string,
    csl: Omit<CslItem, 'id'>,
    origin: SourceOrigin = { kind: 'manual', value: null },
    from?: { surfacedId: string; candidateIndex: number },
  ): this {
    this.human('SourceAdded', {
      sourceId,
      csl: { ...csl, id: sourceId } as CslItem,
      origin: from ? { kind: 'surfaced', value: origin.value } : origin,
      fromSurfacedId: from?.surfacedId ?? null,
      candidateIndex: from?.candidateIndex ?? null,
    });
    return this;
  }

  /** Saves a clipping. */
  saveClipping(
    clippingId: string,
    sourceId: string,
    text: string,
    locator: string | null = null,
    note: string | null = null,
  ): this {
    this.human('ClippingSaved', { clippingId, sourceId, text, locator, note });
    return this;
  }

  /** Cites a source: `CitationInserted` then a `citation` run inserting the node. */
  cite(
    documentId: string,
    sourceId: string,
    locator: string | null,
    opts: { at?: At } = {},
  ): string {
    const citationId = this.id('cite');
    this.human('CitationInserted', { citationId, documentId, sourceId, locator });
    const at = this.pos(documentId, opts.at ?? 'end');
    this.edit(documentId, [
      {
        run: { method: 'citation', citationId },
        build: (tr) => tr.insert(at, schema.nodes.citation!.create({ sourceId, locator })),
        keys: [{ kind: 'cite', len: 0, dt: 0 }],
      },
    ]);
    return citationId;
  }

  /** Places a clipping as a quote block after the top-level block containing `at` (a `clipping` run). */
  placeClipping(
    documentId: string,
    clippingId: string,
    opts: { at?: At; text?: string } = {},
  ): this {
    const clip = this.project.clippings[clippingId];
    if (!clip) throw new Error(`builder: no clipping ${clippingId}`);
    const doc = this.doc(documentId);
    const $p = doc.resolve(this.pos(documentId, opts.at ?? 'end'));
    const insertAt = $p.depth > 0 ? $p.after(1) : $p.pos;
    const text = opts.text ?? clip.text;
    const qb = schema.nodes.quote_block!.create(
      { sourceId: clip.sourceId, clippingId, locator: clip.locator },
      text.split('\n').map((l) => schema.nodes.paragraph!.create(null, l ? schema.text(l) : null)),
    );
    this.edit(documentId, [
      {
        run: { method: 'clipping', clippingId },
        build: (tr) => tr.insert(insertAt, qb),
        keys: [{ kind: 'clip', len: text.replace(/\n/g, '').length, dt: 0 }],
      },
    ]);
    return this;
  }

  // -------------------------------------------------------------------------
  // Feedback and the agent
  // -------------------------------------------------------------------------

  /** The writer asks for feedback. */
  requestFeedback(
    requestId: string,
    opts: {
      scope?: FeedbackScope;
      lenses?: Lens[];
      intensity?: Intensity;
      ask?: string | null;
      editor?: FeedbackEditor;
    } = {},
  ): this {
    this.human('FeedbackRequested', {
      requestId,
      scope: opts.scope ?? { kind: 'project' },
      lenses: opts.lenses ?? ['structure', 'clarity'],
      intensity: opts.intensity ?? 'standard',
      ask: opts.ask ?? null,
      ...(opts.editor ? { editor: opts.editor } : {}),
    });
    return this;
  }

  /** The service starts a review session for a request. */
  startReview(
    sessionId: string,
    requestId: string,
    model = 'opus',
    opts: { systemPromptVersion?: string } = {},
  ): this {
    this.agent(
      'FeedbackSessionStarted',
      {
        feedbackSessionId: sessionId,
        trigger: { kind: 'feedback', requestId },
        model,
        ...(opts.systemPromptVersion ? { systemPromptVersion: opts.systemPromptVersion } : {}),
      },
      sessionId,
      model,
    );
    return this;
  }

  /** The service starts a discuss session for a thread. */
  startDiscuss(
    sessionId: string,
    threadId: string,
    model = 'sonnet',
    opts: { systemPromptVersion?: string } = {},
  ): this {
    this.agent(
      'FeedbackSessionStarted',
      {
        feedbackSessionId: sessionId,
        trigger: { kind: 'discuss', threadId },
        model,
        ...(opts.systemPromptVersion ? { systemPromptVersion: opts.systemPromptVersion } : {}),
      },
      sessionId,
      model,
    );
    return this;
  }

  private docAt(documentId: string, version: number): PMNode {
    const node = this.snapshots.get(documentId)?.get(version);
    if (!node) throw new Error(`builder: no snapshot of ${documentId} at version ${version}`);
    return node;
  }

  private forward(
    documentId: string,
    readVersion: number,
    from: number,
    to: number,
    point = false,
    assoc: 1 | -1 = 1,
  ) {
    let f = from;
    let t = to;
    for (const m of this.mapsSince(documentId, readVersion)) {
      if (point) f = t = m.map(f, assoc);
      else {
        f = m.map(f, 1);
        t = Math.max(f, m.map(t, -1));
      }
    }
    return { from: f, to: t };
  }

  /** Resolves an anchor the way the service does (at readVersion, mapped to now). */
  resolvedAnchor(spec: AnchorSpec): ResolvedAnchor {
    const version = this.version(spec.documentId);
    const readVersion = spec.readVersion ?? version;
    const r = resolveAnchor(this.docAt(spec.documentId, readVersion), spec);
    if (!r.ok) throw new Error(`builder: ${r.error.message}`);
    const { from, to } = this.forward(spec.documentId, readVersion, r.from, r.to);
    return { anchor: r.anchor as Anchor, from, to, readVersion, version };
  }

  /** Resolves an anchor or span target. */
  target(spec: TargetSpec): Target {
    if (spec.kind === 'anchor') {
      const { kind: _k, ...a } = spec;
      return { kind: 'anchor', ...this.resolvedAnchor(a) };
    }
    const version = this.version(spec.documentId);
    const readVersion = spec.readVersion ?? version;
    const span: SpanRef = { documentId: spec.documentId, unit: spec.unit, ids: spec.ids };
    const r = resolveSpan(this.docAt(spec.documentId, readVersion), span);
    if (!r.ok) throw new Error(`builder: ${r.error.message}`);
    const { from, to } = this.forward(spec.documentId, readVersion, r.from, r.to);
    return { kind: 'span', span, from, to, readVersion, version };
  }

  /** `comment`. */
  comment(
    sessionId: string,
    commentId: string,
    target: TargetSpec,
    body: string,
    opts: { category?: Lens; severity?: Severity } = {},
  ): this {
    this.agent(
      'CommentAdded',
      {
        commentId,
        feedbackSessionId: sessionId,
        target: this.target(target),
        category: opts.category ?? 'clarity',
        severity: opts.severity ?? 'moderate',
        body,
      },
      sessionId,
    );
    return this;
  }

  /** `ask_question`. */
  question(
    sessionId: string,
    questionId: string,
    question: string,
    anchor: AnchorSpec | null = null,
  ): this {
    this.agent(
      'QuestionAsked',
      {
        questionId,
        feedbackSessionId: sessionId,
        target: anchor ? { kind: 'anchor', ...this.resolvedAnchor(anchor) } : null,
        question,
      },
      sessionId,
    );
    return this;
  }

  /** `suggest_word_choice`. */
  suggestWordChoice(
    sessionId: string,
    suggestionId: string,
    anchor: AnchorSpec,
    alternatives: string[],
    rationale: string,
  ): this {
    this.agent(
      'SuggestionProposed',
      {
        suggestionId,
        feedbackSessionId: sessionId,
        suggestion: {
          kind: 'word-choice',
          target: this.resolvedAnchor(anchor),
          alternatives,
          rationale,
        },
      },
      sessionId,
    );
    return this;
  }

  /** `suggest_insertion`. */
  suggestInsertion(
    sessionId: string,
    suggestionId: string,
    where: {
      documentId: string;
      position: 'before' | 'after';
      sentenceId: string;
      readVersion?: number;
    },
    sentence: string,
    purpose: string,
  ): this {
    const version = this.version(where.documentId);
    const readVersion = where.readVersion ?? version;
    const r = resolveInsertionPoint(
      this.docAt(where.documentId, readVersion),
      where.position,
      where.sentenceId,
    );
    if (!r.ok) throw new Error(`builder: ${r.error.message}`);
    const assoc = where.position === 'before' ? 1 : -1;
    const { from } = this.forward(where.documentId, readVersion, r.pos, r.pos, true, assoc);
    this.agent(
      'SuggestionProposed',
      {
        suggestionId,
        feedbackSessionId: sessionId,
        suggestion: {
          kind: 'insertion',
          target: {
            documentId: where.documentId,
            position: where.position,
            sentenceId: where.sentenceId,
            pos: from,
            readVersion,
            version,
          },
          sentence,
          purpose,
        },
      },
      sessionId,
    );
    return this;
  }

  /** `suggest_rephrase`. */
  suggestRephrase(
    sessionId: string,
    suggestionId: string,
    anchor: AnchorSpec,
    guidance: string,
  ): this {
    this.agent(
      'SuggestionProposed',
      {
        suggestionId,
        feedbackSessionId: sessionId,
        suggestion: { kind: 'rephrase', target: this.resolvedAnchor(anchor), guidance },
      },
      sessionId,
    );
    return this;
  }

  /** `propose_move`. */
  proposeMove(
    sessionId: string,
    proposalId: string,
    span: SpanRef,
    destination: { position: 'before' | 'after'; id: string },
    rationale: string,
  ): this {
    const version = this.version(span.documentId);
    const r = resolveMove(this.doc(span.documentId), span, destination);
    if (!r.ok) throw new Error(`builder: ${r.error.message}`);
    this.agent(
      'MoveProposed',
      {
        proposalId,
        feedbackSessionId: sessionId,
        source: { span, from: r.from, to: r.to, readVersion: version, version },
        destination: { ...destination, pos: r.insertAt },
        rationale,
      },
      sessionId,
    );
    return this;
  }

  /** `propose_cut`. */
  proposeCut(sessionId: string, proposalId: string, target: TargetSpec, rationale: string): this {
    this.agent(
      'CutProposed',
      { proposalId, feedbackSessionId: sessionId, target: this.target(target), rationale },
      sessionId,
    );
    return this;
  }

  /** `propose_split`. */
  proposeSplit(
    sessionId: string,
    proposalId: string,
    documentId: string,
    paragraphId: string,
    sentenceId: string,
    rationale: string,
  ): this {
    const version = this.version(documentId);
    const r = resolveSplit(this.doc(documentId), paragraphId, sentenceId);
    if (!r.ok) throw new Error(`builder: ${r.error.message}`);
    this.agent(
      'SplitProposed',
      {
        proposalId,
        feedbackSessionId: sessionId,
        documentId,
        paragraphId,
        sentenceId,
        pos: r.pos,
        readVersion: version,
        version,
        rationale,
      },
      sessionId,
    );
    return this;
  }

  /** `propose_merge`. */
  proposeMerge(
    sessionId: string,
    proposalId: string,
    documentId: string,
    first: string,
    second: string,
    rationale: string,
  ): this {
    const version = this.version(documentId);
    const r = resolveMerge(this.doc(documentId), first, second);
    if (!r.ok) throw new Error(`builder: ${r.error.message}`);
    this.agent(
      'MergeProposed',
      {
        proposalId,
        feedbackSessionId: sessionId,
        documentId,
        firstParagraphId: first,
        secondParagraphId: second,
        joinPos: r.joinPos,
        from: r.first.pos,
        to: r.second.end,
        readVersion: version,
        version,
        rationale,
      },
      sessionId,
    );
    return this;
  }

  /** `flag_citation_needed`. */
  flagCitationNeeded(sessionId: string, flagId: string, anchor: AnchorSpec, claim: string): this {
    this.agent(
      'CitationNeededFlagged',
      { flagId, feedbackSessionId: sessionId, target: this.resolvedAnchor(anchor), claim },
      sessionId,
    );
    return this;
  }

  /** `search_sources`. */
  surfaceSources(
    sessionId: string,
    surfacedId: string,
    query: string,
    candidates: SurfacedCandidate[],
    anchor: AnchorSpec | null = null,
  ): this {
    this.agent(
      'SourceSurfaced',
      {
        surfacedId,
        feedbackSessionId: sessionId,
        query,
        target: anchor ? this.resolvedAnchor(anchor) : null,
        candidates,
      },
      sessionId,
    );
    return this;
  }

  /** `suggest_source`. */
  suggestSource(
    sessionId: string,
    sourceSuggestionId: string,
    anchor: AnchorSpec,
    sourceId: string,
    rationale: string,
  ): this {
    this.agent(
      'SourceSuggested',
      {
        sourceSuggestionId,
        feedbackSessionId: sessionId,
        target: this.resolvedAnchor(anchor),
        sourceId,
        rationale,
      },
      sessionId,
    );
    return this;
  }

  /** `finish_review`. */
  finishReview(
    sessionId: string,
    summary: string,
    strengths: string[] = [],
    topPriorities: string[] = [],
  ): this {
    this.agent(
      'ReviewFinished',
      { feedbackSessionId: sessionId, summary, strengths, topPriorities },
      sessionId,
    );
    return this;
  }

  /** `answer_discussion`. */
  answerDiscussion(sessionId: string, threadId: string, targetId: string, body: string): this {
    this.agent(
      'DiscussAnswered',
      { feedbackSessionId: sessionId, threadId, targetId, body },
      sessionId,
      'sonnet',
    );
    return this;
  }

  /** The writer sends a chat message to an editor (a new chat on its first message). */
  sendChat(
    chatId: string,
    messageId: string,
    text: string,
    opts: {
      editor?: FeedbackEditor;
      lenses?: Lens[];
      intensity?: Intensity;
      scope?: FeedbackScope;
      aboutId?: string | null;
    } = {},
  ): this {
    this.human('ChatMessageSent', {
      chatId,
      messageId,
      text,
      editor: opts.editor ?? { id: 'ed-margaret', name: 'Margaret', brief: 'Big picture first.' },
      lenses: opts.lenses ?? ['structure', 'clarity'],
      intensity: opts.intensity ?? 'standard',
      context: { scope: opts.scope ?? { kind: 'project' }, aboutId: opts.aboutId ?? null },
    });
    return this;
  }

  /** The service starts a chat session for a writer message. */
  startChat(
    sessionId: string,
    chatId: string,
    messageId: string,
    model = 'sonnet',
    opts: { systemPromptVersion?: string } = {},
  ): this {
    this.agent(
      'FeedbackSessionStarted',
      {
        feedbackSessionId: sessionId,
        trigger: { kind: 'chat', chatId, messageId },
        model,
        ...(opts.systemPromptVersion ? { systemPromptVersion: opts.systemPromptVersion } : {}),
      },
      sessionId,
      model,
    );
    return this;
  }

  /** `reply`: the editor answers in the chat, ending the session. */
  replyInChat(sessionId: string, chatId: string, replyTo: string, body: string): this {
    this.agent('ChatReplied', { feedbackSessionId: sessionId, chatId, replyTo, body }, sessionId);
    return this;
  }

  /** The writer opens or continues a Discuss thread. */
  discuss(threadId: string, targetId: string, message: string): this {
    this.human('DiscussRequested', { threadId, targetId, message });
    return this;
  }

  /** The writer dismisses a card. */
  dismiss(targetId: string, reason: DismissReason | null = null, note: string | null = null): this {
    this.human('SuggestionDismissed', { targetId, reason, note });
    return this;
  }

  /** The writer accepts a proposal. */
  acceptProposal(proposalId: string, opts: { baseVersion?: number } = {}): this {
    const p = this.project.annotations.proposals[proposalId];
    if (!p) throw new Error(`builder: no proposal ${proposalId}`);
    this.human('ProposalAccepted', {
      proposalId,
      documentId: p.documentId,
      baseVersion: opts.baseVersion ?? this.version(p.documentId),
    });
    this.undoStack.length = 0;
    return this;
  }

  /** The writer rejects a proposal. */
  rejectProposal(proposalId: string, reason: DismissReason | null = null): this {
    this.human('ProposalRejected', { proposalId, reason });
    return this;
  }
}
