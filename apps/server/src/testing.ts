/**
 * Test support (`@longhand/server/testing`): a real service on a random port,
 * with its own Postgres schema and a real Durable Streams server on a random
 * port. Used by this package's integration tests and by `@longhand/client`.
 */
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { DurableStreamTestServer } from '@durable-streams/server';
import { StaticSourceSearch } from '@longhand/agent';
import type { SourceSearch } from '@longhand/schema';
import pg from 'pg';
import { DevAuthenticator, type Authenticator } from './auth';
import { adapterFactory, type AdapterFactory } from './agent/sessions';
import type { ClockHooks } from './ledger/project';
import type { PageFetchOptions } from './research/ssrf';
import { startServer, type ServerHandle } from './server';
import type { CadenceConfig } from './service';
import { DevFileSigner, type Signer } from './signer';
import { dropSchema, openDb, type Db } from './storage/db';
import { DurableStreamsStore } from './storage/streams';

/** Postgres for tests (the docker compose one by default). */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://longhand:longhand@localhost:5434/longhand';

/** True if Postgres answers. */
export async function databaseAvailable(url = TEST_DATABASE_URL): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** A fresh P-256 signer (tests). */
export function generateSigner(): DevFileSigner {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return new DevFileSigner(privateKey);
}

/** Options for {@link startTestServer}. */
export interface TestServerOptions {
  accountId?: string;
  actorId?: string;
  auth?: Authenticator;
  signer?: Signer;
  hooks?: ClockHooks;
  adapters?: AdapterFactory;
  search?: SourceSearch | null;
  cadence?: Partial<CadenceConfig>;
  autoStartSessions?: boolean;
  finishGraceMs?: number;
  sessionTimeoutMs?: number;
  pageFetch?: PageFetchOptions;
  /** Use this Durable Streams server instead of starting one. */
  streamsUrl?: string;
  log?: (msg: string) => void;
}

/** A running test server. */
export interface TestServer {
  url: string;
  handle: ServerHandle;
  db: Db;
  schema: string;
  streamsUrl: string;
  prefix: string;
  signer: Signer;
  /**
   * Stops the service and starts a new instance on the same streams and schema.
   * `crash: true` drops the old instance without flushing anything.
   */
  restart(opts?: { crash?: boolean }): Promise<TestServer>;
  /** Stops everything and drops the schema. */
  close(): Promise<void>;
}

/** Starts a service for a test. */
export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const ds = opts.streamsUrl ? null : new DurableStreamTestServer({ port: 0, host: '127.0.0.1' });
  if (ds) await ds.start();
  const streamsUrl = opts.streamsUrl ?? (ds as unknown as { url: string }).url;
  const id = randomBytes(6).toString('hex');
  const schema = `t_${id}`;
  const prefix = `test-${id}`;
  const db = openDb(TEST_DATABASE_URL, schema);
  const signer = opts.signer ?? generateSigner();
  const auth =
    opts.auth ??
    new DevAuthenticator({
      accountId: opts.accountId ?? 'acct-1',
      actorId: opts.actorId ?? 'writer-1',
    });
  const quiet = opts.log ?? (() => undefined);

  const boot = async (): Promise<ServerHandle> =>
    startServer({
      port: 0,
      db,
      store: new DurableStreamsStore(streamsUrl, { prefix }),
      signer,
      auth,
      adapters: opts.adapters ?? adapterFactory('mock'),
      search: opts.search === undefined ? new StaticSourceSearch([]) : opts.search,
      cadence: { everyCommits: 0, intervalMs: 0, ...opts.cadence },
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.autoStartSessions !== undefined
        ? { autoStartSessions: opts.autoStartSessions }
        : {}),
      ...(opts.finishGraceMs !== undefined
        ? { finishGraceMs: opts.finishGraceMs }
        : { finishGraceMs: 2000 }),
      ...(opts.sessionTimeoutMs ? { sessionTimeoutMs: opts.sessionTimeoutMs } : {}),
      ...(opts.pageFetch ? { pageFetch: opts.pageFetch } : {}),
      corsOrigins: ['http://localhost:3100'],
      log: quiet,
    });

  const make = (handle: ServerHandle): TestServer => {
    const t: TestServer = {
      url: handle.url,
      handle,
      db,
      schema,
      streamsUrl,
      prefix,
      signer,
      restart: async ({ crash } = {}) => {
        if (crash) await handle.closeHttpOnly();
        else await handle.close();
        const next = make(await boot());
        Object.assign(t, next);
        return t;
      },
      close: async () => {
        await t.handle.close();
        await db.close();
        await dropSchema(TEST_DATABASE_URL, schema).catch(() => undefined);
        await ds?.stop();
      },
    };
    return t;
  };
  return make(await boot());
}
