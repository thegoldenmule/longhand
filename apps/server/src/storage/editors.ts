/**
 * Named editors: each account's roster (migration `002_editors.sql`).
 *
 * Account settings, not ledger events: nothing here is derived from the streams,
 * and `rebuild` leaves it alone. The first read of an account's roster seeds it
 * with `STARTER_EDITORS` (once; an account that deletes every editor keeps an
 * empty roster until it resets to the starters).
 */
import { randomUUID } from 'node:crypto';
import {
  EditorProfileInputSchema,
  EditorProfileSchema,
  LENSES,
  STARTER_EDITORS,
  type EditorProfile,
  type EditorProfileInput,
} from '@longhand/schema';
import type pg from 'pg';
import { HttpError } from '../util';
import type { Db } from './db';

/** At most this many editors per account. */
export const MAX_EDITORS = 20;

/**
 * Parses and normalizes writer input: trims the text, drops blank questions and
 * puts lenses in display order. Throws a 422 `invalid-editor` HttpError.
 */
export function parseEditorInput(body: unknown): EditorProfileInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const trimmed = {
    name: typeof b.name === 'string' ? b.name.trim() : b.name,
    brief: typeof b.brief === 'string' ? b.brief.trim() : (b.brief ?? ''),
    lenses: b.lenses,
    intensity: b.intensity,
    questions: Array.isArray(b.questions)
      ? b.questions.map((q) => (typeof q === 'string' ? q.trim() : q)).filter((q) => q !== '')
      : (b.questions ?? []),
  };
  const r = EditorProfileInputSchema.safeParse(trimmed);
  if (!r.success) {
    throw new HttpError(
      422,
      'invalid-editor',
      r.error.issues.map((i) => `${i.path.join('.') || 'editor'}: ${i.message}`).join('; '),
      { issues: r.error.issues },
    );
  }
  return { ...r.data, lenses: LENSES.filter((l) => r.data.lenses.includes(l)) };
}

type Row = { editor_id: string; profile: EditorProfileInput };

function toProfile(r: Row): EditorProfile {
  return EditorProfileSchema.parse({ ...r.profile, id: r.editor_id });
}

/** Per-account editor storage. */
export class EditorStore {
  constructor(readonly db: Db) {}

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  private static async insertStarters(c: pg.PoolClient, accountId: string): Promise<void> {
    let position = 0;
    for (const s of STARTER_EDITORS) {
      await c.query(
        'INSERT INTO editors (account_id, editor_id, position, profile) VALUES ($1, $2, $3, $4)',
        [accountId, randomUUID(), position++, JSON.stringify(s)],
      );
    }
  }

  private static async rows(c: pg.PoolClient | pg.Pool, accountId: string): Promise<Row[]> {
    return (
      await c.query<Row>(
        'SELECT editor_id, profile FROM editors WHERE account_id = $1 ORDER BY position, created_at, editor_id',
        [accountId],
      )
    ).rows;
  }

  /** The account's editors in roster order, seeding the starters on first use. */
  async list(accountId: string): Promise<EditorProfile[]> {
    const seeded = await this.db.pool.query('SELECT 1 FROM editor_rosters WHERE account_id = $1', [
      accountId,
    ]);
    if (seeded.rowCount === 0) {
      await this.tx(async (c) => {
        // Only the first concurrent reader seeds.
        const won = await c.query(
          'INSERT INTO editor_rosters (account_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING account_id',
          [accountId],
        );
        if (won.rowCount) await EditorStore.insertStarters(c, accountId);
      });
    }
    return (await EditorStore.rows(this.db.pool, accountId)).map(toProfile);
  }

  /** One editor, or a 404. */
  async get(accountId: string, editorId: string): Promise<EditorProfile> {
    const r = await this.db.pool.query<Row>(
      'SELECT editor_id, profile FROM editors WHERE account_id = $1 AND editor_id = $2',
      [accountId, editorId],
    );
    const row = r.rows[0];
    if (!row) throw new HttpError(404, 'unknown-editor', `There is no editor ${editorId}.`);
    return toProfile(row);
  }

  /** Adds an editor at the end of the roster. */
  async create(accountId: string, input: EditorProfileInput): Promise<EditorProfile> {
    await this.list(accountId); // seed first, so a new account's first editor joins the starters
    return this.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `longhand-editors:${accountId}`,
      ]);
      const n = await c.query<{ count: string; next: number | null }>(
        'SELECT count(*) AS count, max(position) + 1 AS next FROM editors WHERE account_id = $1',
        [accountId],
      );
      const row = n.rows[0];
      if (Number(row?.count ?? 0) >= MAX_EDITORS) {
        throw new HttpError(
          409,
          'too-many-editors',
          `You can keep at most ${MAX_EDITORS} editors.`,
        );
      }
      const id = randomUUID();
      await c.query(
        'INSERT INTO editors (account_id, editor_id, position, profile) VALUES ($1, $2, $3, $4)',
        [accountId, id, row?.next ?? 0, JSON.stringify(input)],
      );
      return EditorProfileSchema.parse({ ...input, id });
    });
  }

  /** Replaces an editor's profile (404 if it is not the account's). */
  async update(
    accountId: string,
    editorId: string,
    input: EditorProfileInput,
  ): Promise<EditorProfile> {
    const r = await this.db.pool.query(
      'UPDATE editors SET profile = $3, updated_at = now() WHERE account_id = $1 AND editor_id = $2',
      [accountId, editorId, JSON.stringify(input)],
    );
    if (!r.rowCount) throw new HttpError(404, 'unknown-editor', `There is no editor ${editorId}.`);
    return EditorProfileSchema.parse({ ...input, id: editorId });
  }

  /** Deletes an editor (404 if it is not the account's). Past requests keep their record. */
  async delete(accountId: string, editorId: string): Promise<void> {
    const r = await this.db.pool.query(
      'DELETE FROM editors WHERE account_id = $1 AND editor_id = $2',
      [accountId, editorId],
    );
    if (!r.rowCount) throw new HttpError(404, 'unknown-editor', `There is no editor ${editorId}.`);
  }

  /** Replaces the whole roster with fresh copies of the starters. */
  async reset(accountId: string): Promise<EditorProfile[]> {
    await this.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `longhand-editors:${accountId}`,
      ]);
      await c.query('DELETE FROM editors WHERE account_id = $1', [accountId]);
      await c.query('INSERT INTO editor_rosters (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [
        accountId,
      ]);
      await EditorStore.insertStarters(c, accountId);
    });
    return (await EditorStore.rows(this.db.pool, accountId)).map(toProfile);
  }
}
