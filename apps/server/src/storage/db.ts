/**
 * Postgres access and the migration runner.
 *
 * Migrations are the numbered SQL files in `apps/server/migrations`
 * (`NNN_name.sql`), applied in order, each in its own transaction, and recorded in
 * `schema_migrations`. A schema name may be given (tests use one per test); the
 * runner creates it and every connection of the pool uses it as `search_path`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Default migrations directory. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** A pool bound to one schema. */
export interface Db {
  pool: pg.Pool;
  schema: string;
  close(): Promise<void>;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** Opens a pool. `schema` defaults to `public`. */
export function openDb(databaseUrl: string, schema = 'public'): Db {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name ${schema}`);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    options: `-c search_path=${schema}`,
  });
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  return { pool, schema, close: () => pool.end() };
}

/** One migration file. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Reads `NNN_name.sql` files in version order. */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = /^(\d+)_([\w-]+)\.sql$/.exec(file);
    if (!m) continue;
    out.push({
      version: Number(m[1]),
      name: m[2] as string,
      sql: readFileSync(join(dir, file), 'utf8'),
    });
  }
  for (let i = 1; i < out.length; i++) {
    if ((out[i] as Migration).version === (out[i - 1] as Migration).version) {
      throw new Error(`duplicate migration version ${(out[i] as Migration).version}`);
    }
  }
  return out;
}

/** Applies pending migrations. Returns the versions applied. Safe to run concurrently (advisory lock). */
export async function migrate(db: Db, migrations = loadMigrations()): Promise<number[]> {
  const client = await db.pool.connect();
  const applied: number[] = [];
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${db.schema}`);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`longhand-migrate:${db.schema}`]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version integer PRIMARY KEY,
           name text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const done = new Set(
        (await client.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map(
          (r) => r.version,
        ),
      );
      for (const m of migrations) {
        if (done.has(m.version)) continue;
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
            m.version,
            m.name,
          ]);
          await client.query('COMMIT');
          applied.push(m.version);
        } catch (e) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${m.version}_${m.name} failed: ${(e as Error).message}`, {
            cause: e,
          });
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
        `longhand-migrate:${db.schema}`,
      ]);
    }
  } finally {
    client.release();
  }
  return applied;
}

/** Drops a schema (tests). */
export async function dropSchema(databaseUrl: string, schema: string): Promise<void> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name ${schema}`);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await client.end();
  }
}
