/** Starting projects: a project nobody has named is Untitled, and names need not be unique. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../src/testing';
import { DB, api } from './helpers';

describe.skipIf(!DB())('creating projects', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('names a project Untitled by default, and two Untitled projects coexist', async () => {
    const a = await api<{ projectId: string }>(t, 'POST', '/v1/projects', {});
    const b = await api<{ projectId: string }>(t, 'POST', '/v1/projects', { title: 'Untitled' });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.projectId).not.toBe(b.body.projectId);
    const list = await api<{ projects: Array<{ projectId: string; title: string }> }>(
      t,
      'GET',
      '/v1/projects',
    );
    const titles = Object.fromEntries(list.body.projects.map((p) => [p.projectId, p.title]));
    expect(titles).toEqual({ [a.body.projectId]: 'Untitled', [b.body.projectId]: 'Untitled' });
  });
});
