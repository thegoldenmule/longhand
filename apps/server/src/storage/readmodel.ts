/**
 * The Postgres read model. Everything here is derived from the streams (except
 * `session_tokens`), so every write is an idempotent upsert and `rebuild` can
 * recreate it from scratch.
 */
import type { Commit, ProjectState, Witness } from '@longhand/schema';
import type { Db } from './db';

/** A project row. */
export interface ProjectRow {
  projectId: string;
  accountId: string;
  title: string;
  streamPath: string;
  createdAt: string;
  headSeq: number;
  headHash: string;
  updatedAt: string;
}

/** Collections of `ProjectState.annotations` stored in `annotations` (agent sessions have their own table). */
export const ANNOTATION_COLLECTIONS = [
  'feedbackRequests',
  'comments',
  'questions',
  'suggestions',
  'proposals',
  'citationFlags',
  'surfacedSources',
  'sourceSuggestions',
  'discussions',
] as const;

type AnnotationCollection = (typeof ANNOTATION_COLLECTIONS)[number];

/** Read-model tables, in dependency order (rebuild truncates them). */
export const READ_MODEL_TABLES = [
  'projects',
  'commits',
  'witnesses',
  'snapshots',
  'documents',
  'annotations',
  'agent_sessions',
  'session_tokens',
] as const;

function documentIdOf(rec: Record<string, unknown>): string | null {
  if (typeof rec.documentId === 'string') return rec.documentId;
  const scope = rec.scope as { documentId?: unknown } | undefined;
  if (scope && typeof scope.documentId === 'string') return scope.documentId;
  for (const key of ['target', 'anchor', 'span', 'range']) {
    const t = rec[key] as Record<string, unknown> | null | undefined;
    if (!t || typeof t !== 'object') continue;
    if (typeof t.documentId === 'string') return t.documentId;
    const a = (t.anchor ?? t.span) as { documentId?: unknown } | undefined;
    if (a && typeof a.documentId === 'string') return a.documentId;
  }
  return null;
}

function statusOf(rec: Record<string, unknown>): string | null {
  return typeof rec.status === 'string' ? rec.status : null;
}

/** Writes and reads the read model. */
export class ReadModel {
  constructor(readonly db: Db) {}

  private q<T extends object = Record<string, unknown>>(text: string, values: unknown[] = []) {
    return this.db.pool.query<T & Record<string, unknown>>(text, values);
  }

  // ------------------------------------------------------------------ projects

  async upsertProject(p: ProjectRow): Promise<void> {
    await this.q(
      `INSERT INTO projects (project_id, account_id, title, stream_path, created_at, head_seq, head_hash, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (project_id) DO UPDATE SET
         title = EXCLUDED.title, head_seq = EXCLUDED.head_seq, head_hash = EXCLUDED.head_hash,
         updated_at = EXCLUDED.updated_at`,
      [
        p.projectId,
        p.accountId,
        p.title,
        p.streamPath,
        p.createdAt,
        p.headSeq,
        p.headHash,
        p.updatedAt,
      ],
    );
  }

  private static project(r: Record<string, unknown>): ProjectRow {
    return {
      projectId: r.project_id as string,
      accountId: r.account_id as string,
      title: r.title as string,
      streamPath: r.stream_path as string,
      createdAt: r.created_at as string,
      headSeq: r.head_seq as number,
      headHash: r.head_hash as string,
      updatedAt: r.updated_at as string,
    };
  }

  async listProjects(accountId?: string): Promise<ProjectRow[]> {
    const r = accountId
      ? await this.q(
          'SELECT * FROM projects WHERE account_id = $1 ORDER BY created_at, project_id',
          [accountId],
        )
      : await this.q('SELECT * FROM projects ORDER BY created_at, project_id');
    return r.rows.map(ReadModel.project);
  }

  async getProject(projectId: string): Promise<ProjectRow | null> {
    const r = await this.q('SELECT * FROM projects WHERE project_id = $1', [projectId]);
    return r.rows[0] ? ReadModel.project(r.rows[0]) : null;
  }

  // ------------------------------------------------------------ commits + witnesses

  async insertCommits(commits: readonly Commit[]): Promise<void> {
    for (const c of commits) {
      const documentId =
        c.payload && typeof (c.payload as { documentId?: unknown }).documentId === 'string'
          ? ((c.payload as { documentId: string }).documentId as string)
          : null;
      await this.q(
        `INSERT INTO commits (project_id, seq, commit_id, type, actor_kind, actor_id, session_id, document_id,
                              client_time, server_time, hash, body)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (project_id, seq) DO NOTHING`,
        [
          c.projectId,
          c.seq,
          c.commitId,
          c.type,
          c.actor.kind,
          c.actor.id,
          c.sessionId,
          documentId,
          c.clientTime,
          c.serverTime,
          c.hash,
          JSON.stringify(c),
        ],
      );
    }
  }

  async insertWitnesses(witnesses: readonly Witness[]): Promise<void> {
    for (const w of witnesses) {
      await this.q(
        `INSERT INTO witnesses (project_id, seq, hash, server_time, signature, key_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (project_id, seq) DO NOTHING`,
        [w.projectId, w.seq, w.hash, w.serverTime, w.signature, w.keyId],
      );
    }
  }

  async witnesses(projectId: string): Promise<Witness[]> {
    const r = await this.q('SELECT * FROM witnesses WHERE project_id = $1 ORDER BY seq', [
      projectId,
    ]);
    return r.rows.map((x) => ({
      projectId: x.project_id as string,
      seq: x.seq as number,
      hash: x.hash as string,
      serverTime: x.server_time as string,
      signature: x.signature as string,
      keyId: x.key_id as string,
    }));
  }

  // ------------------------------------------------------------------- derived

  /** Upserts the documents, annotations and agent sessions that changed between two states. */
  async syncState(prev: ProjectState | null, next: ProjectState): Promise<void> {
    const pid = next.projectId;
    for (const [id, d] of Object.entries(next.documents)) {
      if (prev?.documents[id] === d) continue;
      await this.q(
        `INSERT INTO documents (project_id, document_id, kind, area, title, parent_id, archived, version,
                                created_seq, content_seq, updated_seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (project_id, document_id) DO UPDATE SET
           kind = EXCLUDED.kind, area = EXCLUDED.area, title = EXCLUDED.title, parent_id = EXCLUDED.parent_id,
           archived = EXCLUDED.archived, version = EXCLUDED.version, content_seq = EXCLUDED.content_seq,
           updated_seq = EXCLUDED.updated_seq`,
        [
          pid,
          id,
          d.kind,
          d.area,
          d.title,
          d.parentId,
          d.archived,
          d.version,
          d.createdSeq,
          d.contentSeq,
          d.updatedSeq,
        ],
      );
    }
    for (const collection of ANNOTATION_COLLECTIONS) {
      const recs = next.annotations[collection] as unknown as Record<
        string,
        Record<string, unknown>
      >;
      const before = prev?.annotations[collection] as Record<string, unknown> | undefined;
      for (const [id, rec] of Object.entries(recs)) {
        if (before?.[id] === rec) continue;
        await this.upsertAnnotation(pid, collection, id, rec);
      }
    }
    for (const [id, s] of Object.entries(next.annotations.agentSessions)) {
      if (prev?.annotations.agentSessions[id] === s) continue;
      await this.q(
        `INSERT INTO agent_sessions (session_id, project_id, kind, request_id, thread_id, model, status,
                                     started_seq, ended_seq, failure_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (project_id, session_id) DO UPDATE SET
           status = EXCLUDED.status, ended_seq = EXCLUDED.ended_seq, failure_reason = EXCLUDED.failure_reason`,
        [
          id,
          pid,
          s.kind,
          s.requestId,
          s.threadId,
          s.model,
          s.status,
          s.startedSeq,
          s.endedSeq,
          s.failureReason,
        ],
      );
    }
  }

  private async upsertAnnotation(
    projectId: string,
    collection: AnnotationCollection,
    id: string,
    rec: Record<string, unknown>,
  ): Promise<void> {
    await this.q(
      `INSERT INTO annotations (project_id, collection, annotation_id, seq, status, document_id, session_id, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (project_id, collection, annotation_id) DO UPDATE SET
         status = EXCLUDED.status, document_id = EXCLUDED.document_id, body = EXCLUDED.body`,
      [
        projectId,
        collection,
        id,
        typeof rec.seq === 'number' ? rec.seq : 0,
        statusOf(rec),
        documentIdOf(rec),
        typeof rec.feedbackSessionId === 'string' ? rec.feedbackSessionId : null,
        JSON.stringify(rec),
      ],
    );
  }

  // ------------------------------------------------------------------ snapshots

  async writeSnapshot(state: ProjectState): Promise<void> {
    await this.q(
      `INSERT INTO snapshots (project_id, head_seq, head_hash, state) VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id) DO UPDATE SET head_seq = EXCLUDED.head_seq, head_hash = EXCLUDED.head_hash,
         state = EXCLUDED.state
       WHERE snapshots.head_seq <= EXCLUDED.head_seq`,
      [state.projectId, state.headSeq, state.headHash, JSON.stringify(state)],
    );
  }

  async snapshot(projectId: string): Promise<ProjectState | null> {
    const r = await this.q<{ state: ProjectState }>(
      'SELECT state FROM snapshots WHERE project_id = $1',
      [projectId],
    );
    return (r.rows[0]?.state as ProjectState | undefined) ?? null;
  }

  // ------------------------------------------------------------- session tokens

  async insertSessionToken(t: {
    sessionId: string;
    projectId: string;
    accountId: string;
    kind: string;
    tokenHash: string;
  }): Promise<void> {
    await this.q(
      `INSERT INTO session_tokens (session_id, project_id, account_id, kind, token_hash) VALUES ($1,$2,$3,$4,$5)`,
      [t.sessionId, t.projectId, t.accountId, t.kind, t.tokenHash],
    );
  }

  async closeSessionToken(sessionId: string): Promise<void> {
    await this.q(
      'UPDATE session_tokens SET closed_at = now() WHERE session_id = $1 AND closed_at IS NULL',
      [sessionId],
    );
  }

  // -------------------------------------------------------------------- rebuild

  /** Empties every read-model table (rebuild). */
  async truncateAll(): Promise<void> {
    await this.q(`TRUNCATE ${[...READ_MODEL_TABLES].reverse().join(', ')}`);
  }
}
