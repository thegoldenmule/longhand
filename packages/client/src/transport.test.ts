/**
 * `HttpCommitTransport` and `LonghandClient` against a running ledger service
 * (real Postgres, real Durable Streams): submit, duplicate, conflict, rebase via
 * fetchSince, SSE ordering (own commits included) across a service restart, and
 * offline behaviour.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { CommitTransport as EditorCommitTransport } from '@longhand/editor';
import {
  STARTER_EDITORS,
  docFromJSON,
  schema,
  type CommitDraft,
  type PMNodeJSON,
  type StepJSON,
} from '@longhand/schema';
import { startTestServer, type TestServer } from '@longhand/server/testing';
import { Mapping, Step } from 'prosemirror-transform';
import { LonghandClient } from './api';
import { HttpCommitTransport } from './transport';
import type { RemoteUpdate } from './types';

declare module 'vitest' {
  export interface ProvidedContext {
    dbAvailable: boolean;
  }
}

// Compile-time: the transport satisfies the editor's interface.
const _typecheck = (t: HttpCommitTransport): EditorCommitTransport => t;
void _typecheck;

const DOC = 'doc-1';

function textDraft(
  projectId: string,
  baseVersion: number,
  pos: number,
  text: string,
  actorId = 'writer-1',
): CommitDraft {
  return {
    commitId: randomUUID(),
    projectId,
    clientTime: new Date().toISOString(),
    actor: { kind: 'human', id: actorId },
    deviceId: 'device-test',
    sessionId: 'editor-test',
    schemaVersion: 1,
    type: 'TextEdited',
    payload: {
      documentId: DOC,
      baseVersion,
      steps: [
        { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
      ],
      runs: [{ steps: 1, method: 'typed' }],
      timeline: [{ t: 0, kind: 'insert', len: text.length }],
      characters: text.length,
      durationMs: 0,
    },
  } as CommitDraft;
}

function humanDraft(projectId: string, type: string, payload: unknown): CommitDraft {
  return {
    commitId: randomUUID(),
    projectId,
    clientTime: new Date().toISOString(),
    actor: { kind: 'human', id: 'writer-1' },
    deviceId: 'device-test',
    sessionId: 'editor-test',
    schemaVersion: 1,
    type,
    payload,
  } as CommitDraft;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!inject('dbAvailable'))('HttpCommitTransport against the ledger service', () => {
  let t: TestServer;
  let client: LonghandClient;
  let projectId: string;
  let a: HttpCommitTransport;
  let b: HttpCommitTransport;

  beforeAll(async () => {
    t = await startTestServer();
    // The base URL is read per request, so a restart on a new port is followed.
    client = new LonghandClient({ baseUrl: t.url, backoff: { initialMs: 50, maxMs: 500 } });
    Object.defineProperty(client, 'baseUrl', { get: () => t.url });
    projectId = (await client.createProject({ title: 'Transport' })).projectId;
    a = new HttpCommitTransport({ client, projectId });
    b = new HttpCommitTransport({ client, projectId });
    const r = await a.submit(
      humanDraft(projectId, 'DocumentCreated', {
        documentId: DOC,
        kind: 'manuscript',
        title: 'One',
        parentId: null,
        index: 0,
      }),
    );
    expect(r.status).toBe('ack');
  });
  afterAll(async () => {
    a?.dispose();
    b?.dispose();
    await t?.close();
  });

  it('submits (ack with version), dedupes (duplicate) and rejects invalid drafts', async () => {
    const d = textDraft(projectId, 0, 1, 'Hello');
    const r1 = await a.submit(d);
    expect(r1).toMatchObject({ status: 'ack', version: 1 });
    const r2 = await a.submit(d);
    expect(r2).toEqual({ ...r1, status: 'duplicate' });
    const bad = await a.submit({ ...textDraft(projectId, 1, 999, 'x') });
    expect(bad.status).toBe('rejected');
    const forged = await a.submit(textDraft(projectId, 1, 6, '!', 'someone-else'));
    expect(forged).toMatchObject({ status: 'rejected' });
    expect((forged as { reason: string }).reason).toMatch(/actor-mismatch/);
    expect(a.connection()).toBe('online');
  });

  it('answers a conflict with the current version; the client rebases via fetchSince and resubmits', async () => {
    const s = await client.getState(projectId);
    const v = s.state.documents[DOC]!.version;
    // Device A and device B both type at version v.
    const ra = await a.submit(textDraft(projectId, v, 6, ' world'));
    expect(ra).toMatchObject({ status: 'ack', version: v + 1 });
    const mine = textDraft(projectId, v, 1, '> ') as CommitDraft & {
      payload: { steps: StepJSON[]; baseVersion: number };
    };
    const rb = await b.submit(mine);
    expect(rb).toEqual({ status: 'conflict', currentVersion: v + 1 });
    // Rebase (prosemirror-collab style): map B's steps over the steps it has not seen.
    const catchUp = await b.fetchSince(DOC, v);
    expect(catchUp.kind).toBe('updates');
    if (catchUp.kind !== 'updates') return;
    expect(catchUp.updates.map((u) => u.version)).toEqual([v + 1]);
    const mapping = new Mapping(
      catchUp.updates.flatMap((u) => u.steps.map((j) => Step.fromJSON(schema, j).getMap())),
    );
    const rebased = mine.payload.steps.map(
      (j) => Step.fromJSON(schema, j).map(mapping)!.toJSON() as StepJSON,
    );
    const retry = await b.submit({
      ...mine,
      commitId: randomUUID(),
      payload: { ...mine.payload, baseVersion: catchUp.version, steps: rebased },
    } as CommitDraft);
    expect(retry).toMatchObject({ status: 'ack', version: v + 2 });
    const after = await client.getState(projectId);
    expect(docFromJSON(after.state.documents[DOC]!.content as PMNodeJSON).textContent).toBe(
      '> Hello world',
    );
    // A snapshot when the version is unknown (mid-commit or ahead).
    expect((await b.fetchSince(DOC, 999)).kind).toBe('snapshot');
  });

  it('streams every step-bearing commit in ledger order, own commits included, across a service restart', async () => {
    const seen: RemoteUpdate[] = [];
    const states: string[] = [];
    a.onConnectionChange((st) => states.push(st));
    const unsubscribe = a.subscribe(DOC, (u) => seen.push(u));
    // Give the stream a moment to connect (subscribe is live-only until the first update).
    await new Promise((r) => setTimeout(r, 200));
    let v = (await client.getState(projectId)).state.documents[DOC]!.version;
    let text = docFromJSON(
      (await client.getState(projectId)).state.documents[DOC]!.content as PMNodeJSON,
    ).textContent;
    const type = async (via: HttpCommitTransport, ch: string) => {
      const r = await via.submit(textDraft(projectId, v, 1 + text.length, ch));
      expect(r.status, JSON.stringify(r)).toBe('ack');
      text += ch;
      v += 1;
    };
    await type(a, '1');
    await type(b, '2');
    await type(a, '3');
    await until(() => seen.length === 3);

    // Restart the service: the stream reconnects and resumes after the last version it delivered.
    await t.restart();
    await type(b, '4');
    await type(a, '5');
    await until(() => seen.length === 5, 20_000);
    unsubscribe();

    expect(seen.map((u) => u.seq)).toEqual([...seen.map((u) => u.seq)].sort((x, y) => x - y));
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.baseVersion).toBe(seen[i - 1]!.version);
    expect(new Set(seen.map((u) => u.commitId)).size).toBe(5);
    expect(seen.every((u) => u.type === 'TextEdited' && u.steps.length === 1)).toBe(true);
    expect(states).toContain('offline');
    expect(a.connection()).toBe('online');
  });

  it('streams project commits and reports offline when the service is unreachable', async () => {
    const commits: number[] = [];
    const head = (await client.getState(projectId)).headSeq;
    const sub = client.subscribeProject(projectId, (c) => commits.push(c.seq), { after: head - 2 });
    await until(() => commits.length >= 2);
    sub.close();
    expect(commits.slice(0, 2)).toEqual([head - 1, head]);

    const dead = new HttpCommitTransport({
      client: new LonghandClient({ baseUrl: 'http://127.0.0.1:1' }),
      projectId,
    });
    const changes: string[] = [];
    dead.onConnectionChange((s) => changes.push(s));
    expect(await dead.submit(textDraft(projectId, 0, 1, 'x'))).toEqual({ status: 'offline' });
    expect(dead.connection()).toBe('offline');
    expect(changes).toEqual(['offline']);
    await expect(dead.fetchSince(DOC, 0)).rejects.toThrow();
    dead.dispose();
  });

  it('exposes the other API methods', async () => {
    expect(await client.me()).toMatchObject({
      accountId: 'acct-1',
      actorId: 'writer-1',
      authMode: 'dev',
    });
    expect((await client.listProjects()).map((p) => p.projectId)).toContain(projectId);
    const key = await client.witnessKey();
    const bundle = await client.bundle(projectId);
    expect(bundle.keyId).toBe(key.keyId);
    expect(bundle.witnesses).toHaveLength(bundle.commits.length);
    const md = await client.exportProject(projectId, { format: 'md' });
    expect(new TextDecoder().decode(md.bytes)).toContain('# Transport');
    expect(md.filename).toMatch(/\.md$/);
    expect((await client.pageFetch('http://127.0.0.1:1/')).status).toBe(400);
    expect(await client.searchSources('ledgers')).toEqual([]);
    await expect(client.getState('no-such-project')).rejects.toMatchObject({
      status: 404,
      code: 'unknown-project',
    });
  });

  it('manages the account editors', async () => {
    const starters = await client.listEditors();
    expect(starters.map((e) => e.name)).toEqual(STARTER_EDITORS.map((s) => s.name));
    const ed = await client.createEditor({
      name: 'Theo',
      brief: 'A blunt line editor who hates adverbs.',
      lenses: ['word-choice'],
      intensity: 'light',
      questions: ['Which adverbs would you cut?'],
    });
    expect(await client.getEditor(ed.id)).toEqual(ed);
    const up = await client.updateEditor(ed.id, { ...ed, name: 'Theodora' });
    expect(up).toMatchObject({ id: ed.id, name: 'Theodora' });
    await expect(client.createEditor({ ...ed, lenses: [] })).rejects.toMatchObject({
      status: 422,
      code: 'invalid-editor',
    });
    await client.deleteEditor(ed.id);
    await expect(client.getEditor(ed.id)).rejects.toMatchObject({
      status: 404,
      code: 'unknown-editor',
    });
    expect((await client.resetEditors()).map((e) => e.name)).toEqual(
      STARTER_EDITORS.map((s) => s.name),
    );
  });
});
