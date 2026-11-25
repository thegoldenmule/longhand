/**
 * The full-stack e2e backend: a fresh Postgres database per run, a real Durable
 * Streams server, and the real ledger service started from configuration (the
 * same `loadConfig` → `startFromConfig` path as `pnpm dev:server`), with
 * `MODEL_ADAPTER=mock` (or `claude` for the live test). Playwright starts it as
 * a web server and stops it with SIGTERM, which drops the database.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStreamTestServer } from '@durable-streams/server';
import { loadConfig, startFromConfig } from '@longhand/server';
import pg from 'pg';
import { E2E } from './ports';

const ADMIN_URL =
  process.env.E2E_DATABASE_ADMIN_URL ?? 'postgres://longhand:longhand@localhost:5434/longhand';

function log(msg: string): void {
  console.log(`[e2e-stack] ${msg}`);
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  const dbName = `longhand_e2e_${Date.now().toString(36)}_${process.pid}`;
  await admin(async (c) => {
    // Leftovers of runs that were killed hard.
    const old = await c.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'longhand_e2e_%'",
    );
    for (const { datname } of old.rows) {
      await c.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => undefined);
    }
    await c.query(`CREATE DATABASE "${dbName}"`);
  });
  const databaseUrl = new URL(ADMIN_URL);
  databaseUrl.pathname = `/${dbName}`;

  const dir = mkdtempSync(join(tmpdir(), 'longhand-e2e-'));
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const keyPath = join(dir, 'witness-key.pem');
  writeFileSync(keyPath, privateKey, { mode: 0o600 });

  const ds = new DurableStreamTestServer({ port: 0, host: '127.0.0.1' });
  await ds.start();
  const streamsUrl = (ds as unknown as { url: string }).url;

  const live = process.env.LONGHAND_LIVE_CLAUDE === '1';
  const cfg = loadConfig({
    ...process.env,
    LEDGER_PORT: String(E2E.ledgerPort),
    LEDGER_HOST: '127.0.0.1',
    DATABASE_URL: databaseUrl.toString(),
    DATABASE_SCHEMA: 'public',
    DURABLE_STREAMS_URL: streamsUrl,
    DURABLE_STREAMS_PREFIX: 'e2e',
    AUTH_MODE: 'dev',
    DEV_ACCOUNT_ID: 'e2e-account',
    DEV_USER_ID: 'e2e-writer',
    WITNESS_SIGNER: 'file',
    WITNESS_KEY_PATH: keyPath,
    MODEL_ADAPTER: live ? 'claude' : 'mock',
    MOCK_STEP_DELAY_MS: process.env.MOCK_STEP_DELAY_MS ?? '120',
    AGENT_AUTOSTART: '1',
    CORS_ORIGINS: [E2E.webOrigin, `http://127.0.0.1:${E2E.webPort}`].join(','),
    WEB_PORT: String(E2E.webPort),
  });
  const handle = await startFromConfig(cfg);
  log(
    `ledger service ${handle.url} · database ${dbName} · streams ${streamsUrl} · model ${cfg.modelAdapter}`,
  );

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping`);
    await handle.close().catch(() => undefined);
    await handle.db.close().catch(() => undefined);
    await ds.stop().catch(() => undefined);
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)).catch(
      (e: unknown) => log(`could not drop ${dbName}: ${String(e)}`),
    );
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
