import { schema, sha256Hex, type CommitDraft } from '@longhand/schema';
import { Transform } from 'prosemirror-transform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputTag } from '../input/classify';
import { docJSON, docOf, expectValidDraft, StateHost, TYPED } from '../test/helpers';
import { DocumentSync } from './engine';
import { CommitFlusher } from './flusher';
import { MockTransport, type MockTransportOptions } from './mockTransport';
import { MemoryQueue } from './queue';

const DOC = 'doc1';

function setup(
  opts: {
    text?: string;
    transport?: MockTransportOptions;
    queue?: MemoryQueue;
    transportInstance?: MockTransport;
  } = {},
) {
  const text = opts.text ?? 'Hello world';
  const transport =
    opts.transportInstance ??
    new MockTransport({ documents: { [DOC]: { doc: docJSON(text) } }, ...opts.transport });
  const snap = transport.snapshot(DOC);
  const host = new StateHost(docOf(text));
  host.resetDoc(schema.nodeFromJSON(snap.doc));
  const queue = opts.queue ?? new MemoryQueue('proj');
  const flusher = new CommitFlusher(queue, transport, { retryBaseMs: 50 });
  const sync = new DocumentSync({
    projectId: 'proj',
    actorId: 'user1',
    deviceId: 'dev1',
    sessionId: 'sess1',
    documentId: DOC,
    version: snap.version,
    transport,
    queue,
    flusher,
    host,
  });
  const type = (t: string, pos?: number, tag: InputTag = TYPED): void => {
    const tr = host.type(t, pos);
    sync.capture(tr, tag);
  };
  return { transport, host, queue, flusher, sync, type };
}

const types = (drafts: CommitDraft[]): string[] => drafts.map((d) => d.type);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('DocumentSync batching', () => {
  it('commits one TextEdited after 2 s idle', async () => {
    const { transport, sync, type } = setup();
    type('a', 12);
    await vi.advanceTimersByTimeAsync(500);
    type('b');
    await vi.advanceTimersByTimeAsync(500);
    type('c');
    await vi.advanceTimersByTimeAsync(1999);
    expect(transport.log).toHaveLength(0);
    expect(sync.current().state).toBe('queued');
    await vi.advanceTimersByTimeAsync(10);
    expect(types(transport.commits())).toEqual(['TextEdited']);
    const te = transport.commits('TextEdited')[0]!;
    expectValidDraft(te);
    expect(te.payload.steps).toHaveLength(3);
    expect(te.payload.baseVersion).toBe(0);
    expect(te.payload.timeline.map((k) => k.t)).toEqual([0, 500, 1000]);
    expect(te.payload.durationMs).toBe(1000);
    expect(te.payload.characters).toBe(3);
    expect(sync.confirmedVersion).toBe(3);
    expect(sync.current().state).toBe('saved');
    expect(transport.snapshot(DOC).doc).toEqual(docJSON('Hello worldabc'));
  });

  it('commits at 50 steps without waiting', async () => {
    const { transport, type } = setup({ text: '' });
    for (let i = 0; i < 50; i++) type('x');
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.commits('TextEdited')).toHaveLength(1);
    expect(transport.commits('TextEdited')[0]!.payload.steps).toHaveLength(50);
    type('y');
    await vi.advanceTimersByTimeAsync(2001);
    expect(transport.commits('TextEdited').map((c) => c.payload.baseVersion)).toEqual([0, 50]);
  });

  it('emits PasteOccurred before the TextEdited that references it', async () => {
    const { transport, type } = setup();
    type('a', 12);
    const paste = {
      pasteId: 'paste-1',
      origin: 'external' as const,
      via: 'clipboard' as const,
      copyId: null,
      mimeTypes: ['text/plain'],
      characters: 6,
      words: 1,
      textHash: sha256Hex('pasted'),
    };
    type('pasted', undefined, {
      method: 'pasted-external',
      kind: 'paste',
      pasteId: 'paste-1',
      paste,
    });
    await vi.advanceTimersByTimeAsync(2001);
    expect(types(transport.commits())).toEqual(['PasteOccurred', 'TextEdited']);
    for (const d of transport.commits()) expectValidDraft(d);
    const te = transport.commits('TextEdited')[0]!;
    expect(te.payload.runs).toEqual([
      { steps: 1, method: 'typed' },
      { steps: 1, method: 'pasted-external', pasteId: 'paste-1' },
    ]);
    expect(te.payload.timeline.map((k) => k.kind)).toEqual(['insert', 'paste']);
  });

  it('emits declared companions (CitationInserted) before the steps', async () => {
    const { transport, host, sync } = setup();
    const tr = host.local((s) =>
      s.tr.insert(12, schema.nodes.citation!.create({ sourceId: 'src1', locator: 'p. 4' })),
    );
    sync.capture(tr, {
      method: 'citation',
      citationId: 'cit-1',
      kind: 'paste',
      timelineLen: 0,
      companions: [
        {
          type: 'CitationInserted',
          payload: { citationId: 'cit-1', documentId: DOC, sourceId: 'src1', locator: 'p. 4' },
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(2001);
    expect(types(transport.commits())).toEqual(['CitationInserted', 'TextEdited']);
    expect(transport.commits('TextEdited')[0]!.payload.runs).toEqual([
      { steps: 1, method: 'citation', citationId: 'cit-1' },
    ]);
  });

  it('flushes pending steps before SliceCopied, whose positions refer to the flushed version', async () => {
    const { transport, sync, type } = setup();
    type('!', 12);
    const { copyId, textHash } = sync.sliceCopied(1, 6, false, 'Hello');
    expect(textHash).toBe(sha256Hex('Hello'));
    await vi.advanceTimersByTimeAsync(1);
    expect(types(transport.commits())).toEqual(['TextEdited', 'SliceCopied']);
    const sc = transport.commits('SliceCopied')[0]!;
    expectValidDraft(sc);
    expect(sc.payload).toMatchObject({
      copyId,
      from: 1,
      to: 6,
      version: 1,
      cut: false,
      characters: 5,
    });
  });
});

describe('DocumentSync offline queue', () => {
  it('holds drafts while offline and flushes on reconnect', async () => {
    const { transport, sync, queue, type } = setup({ transport: { online: false } });
    const statuses: string[] = [];
    sync.status.on((s) => statuses.push(s.state));
    type('a', 12);
    await vi.advanceTimersByTimeAsync(2001);
    expect(transport.log).toHaveLength(0);
    expect(await queue.list()).toHaveLength(1);
    expect(sync.current().state).toBe('offline');
    const queued = (await queue.list())[0]!.draft;
    expect(Date.parse(queued.clientTime)).toBeGreaterThan(0);
    transport.setOnline(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.commits('TextEdited')).toHaveLength(1);
    expect(await queue.list()).toHaveLength(0);
    expect(sync.current().state).toBe('saved');
    expect(statuses).toContain('offline');
  });

  it('dedupes resends by commitId', async () => {
    const { transport, queue, type } = setup();
    type('a', 12);
    await vi.advanceTimersByTimeAsync(2001);
    const draft = transport.commits('TextEdited')[0]!;
    await queue.enqueue(draft);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.commits('TextEdited')).toHaveLength(1);
    expect(transport.submissions.at(-1)?.result.status).toBe('duplicate');
    expect(await queue.list()).toHaveLength(0);
  });

  it('restores queued drafts after a reload and flushes them', async () => {
    const transport = new MockTransport({
      documents: { [DOC]: { doc: docJSON('Hello world') } },
      online: false,
    });
    const queue = new MemoryQueue('proj');
    const first = setup({ transportInstance: transport, queue });
    first.type(' again', 12);
    first.sync.flush();
    first.sync.destroy();
    await vi.advanceTimersByTimeAsync(1);
    expect(await queue.list()).toHaveLength(1);

    // "Reload": a new editor over the ledger's (old) document and the same queue.
    const second = setup({ transportInstance: transport, queue });
    expect(second.host.text()).toBe('Hello world');
    await second.sync.restore();
    expect(second.host.text()).toBe('Hello world again');
    expect(second.sync.localVersion).toBe(1);
    expect(second.sync.current().state).toBe('offline');
    transport.setOnline(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.snapshot(DOC).doc).toEqual(docJSON('Hello world again'));
    expect(second.sync.confirmedVersion).toBe(1);
    expect(second.sync.current().state).toBe('saved');
  });
});

describe('DocumentSync rebase', () => {
  it('rebases pending steps over a remote update', async () => {
    const { transport, host, sync, type } = setup();
    type('Oh, ', 1);
    transport.remoteEdit(DOC, (doc) => new Transform(doc).insert(12, schema.text('!')).steps);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.text()).toBe('Oh, Hello world!');
    expect(sync.confirmedVersion).toBe(1);
    await vi.advanceTimersByTimeAsync(2001);
    const te = transport.commits('TextEdited').at(-1)!;
    expect(te.payload.baseVersion).toBe(1);
    expect(transport.snapshot(DOC).doc).toEqual(docJSON('Oh, Hello world!'));
  });

  it('handles a version conflict on submit by catching up and resubmitting', async () => {
    const { transport, host, sync, type } = setup();
    type('Oh, ', 1);
    sync.flush();
    // The ledger takes another device's edit before ours arrives.
    transport.remoteEdit(DOC, (doc) => new Transform(doc).insert(12, schema.text('?')).steps);
    await vi.advanceTimersByTimeAsync(5);
    const results = transport.submissions
      .filter((s) => s.draft.type === 'TextEdited')
      .map((s) => s.result.status);
    expect(results).toContain('conflict');
    expect(results.at(-1)).toBe('ack');
    expect(host.text()).toBe('Oh, Hello world?');
    expect(transport.snapshot(DOC).doc).toEqual(docJSON('Oh, Hello world?'));
    expect(sync.current().state).toBe('saved');
    expect(sync.confirmedVersion).toBe(2);
  });

  it('maps queued SliceCopied positions through a rebase', async () => {
    const { transport, sync, type } = setup({ transport: { online: false } });
    type('Oh, ', 1);
    sync.sliceCopied(5, 10, false, 'Hello');
    transport.setOnline(true);
    transport.setOnline(false);
    // Remote edit lands first (inserted at the start).
    transport.setOnline(true);
    transport.remoteEdit(DOC, (doc) => new Transform(doc).insert(1, schema.text('>> ')).steps);
    await vi.advanceTimersByTimeAsync(10);
    const sc = transport.commits('SliceCopied')[0]!;
    expect(sc.payload).toMatchObject({ version: 2 });
    const snap = transport.snapshot(DOC);
    const doc = schema.nodeFromJSON(snap.doc);
    expect(doc.textBetween(sc.payload.from, sc.payload.to)).toBe('Hello');
  });

  it('applies the steps the fold derived for an accepted proposal', async () => {
    const { host, sync, transport } = setup({
      transport: { deriveProposal: (_id, doc) => new Transform(doc).delete(6, 12).steps },
    });
    const draft = sync.acceptProposal('prop-1');
    expectValidDraft(draft);
    expect(draft.payload.baseVersion).toBe(0);
    await vi.advanceTimersByTimeAsync(5);
    expect(host.text()).toBe('Hello');
    expect(sync.confirmedVersion).toBe(1);
    expect(transport.commits('ProposalAccepted')).toHaveLength(1);
  });

  it('maps positions from an older version onto the local document', async () => {
    const { sync, type } = setup();
    type('Oh, ', 1);
    await vi.advanceTimersByTimeAsync(2001);
    type('!', 16);
    const m = sync.mappingFrom(0)!;
    expect(m.map(7)).toBe(11); // "Hello |world" at v0 → after "Oh, "
    expect(sync.mappingFrom(-1)).toBeNull();
    expect(sync.mappingFrom(99)).toBeNull();
  });
});
