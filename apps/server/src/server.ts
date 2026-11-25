/**
 * Wiring: builds the service from a config and serves it over HTTP.
 */
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { KMSClient } from '@aws-sdk/client-kms';
import { createSourceSearch } from '@longhand/research';
import type { SourceSearch } from '@longhand/schema';
import { CognitoAuthenticator, DevAuthenticator, type Authenticator } from './auth';
import { adapterFactory, type AdapterFactory } from './agent/sessions';
import type { Config } from './config';
import { createApp } from './http/app';
import type { ClockHooks } from './ledger/project';
import type { PageFetchOptions } from './research/ssrf';
import { LedgerService, type CadenceConfig } from './service';
import { DevFileSigner, KmsSigner, type Signer } from './signer';
import { migrate, openDb, type Db } from './storage/db';
import { ReadModel } from './storage/readmodel';
import { DurableStreamsStore, type LedgerStore } from './storage/streams';

/** Everything {@link startServer} needs; tests build it directly. */
export interface ServerOptions {
  port: number;
  host?: string;
  /** Origin sessions post back to; default `http://{host}:{port}`. */
  internalUrl?: string | null;
  db: Db;
  store: LedgerStore;
  signer: Signer;
  auth: Authenticator;
  adapters: AdapterFactory;
  search: SourceSearch | null;
  cadence?: Partial<CadenceConfig>;
  hooks?: ClockHooks;
  autoStartSessions?: boolean;
  preload?: boolean;
  models?: { full?: string; quick?: string };
  corsOrigins?: string[];
  pageFetch?: PageFetchOptions;
  sessionTimeoutMs?: number;
  finishGraceMs?: number;
  /** Run migrations before starting (default true). */
  migrate?: boolean;
  log?: (msg: string) => void;
}

/** A running server. */
export interface ServerHandle {
  url: string;
  port: number;
  service: LedgerService;
  /** Cancels sessions (recording their end), flushes the read model, stops HTTP. Does not close `db`. */
  close(): Promise<void>;
  /**
   * Simulates a crash for tests: stops HTTP and timers without cancelling sessions
   * or writing snapshots (queued read-model writes are awaited so they cannot race
   * a new instance).
   */
  closeHttpOnly(): Promise<void>;
}

/** Starts the service and its HTTP server. */
export async function startServer(o: ServerOptions): Promise<ServerHandle> {
  if (o.migrate !== false) await migrate(o.db);
  const service = new LedgerService({
    store: o.store,
    readModel: new ReadModel(o.db),
    signer: o.signer,
    adapters: o.adapters,
    search: o.search,
    ...(o.cadence ? { cadence: o.cadence } : {}),
    ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.autoStartSessions !== undefined ? { autoStartSessions: o.autoStartSessions } : {}),
    ...(o.preload !== undefined ? { preload: o.preload } : {}),
    ...(o.models ? { models: o.models } : {}),
    ...(o.sessionTimeoutMs ? { sessionTimeoutMs: o.sessionTimeoutMs } : {}),
    ...(o.finishGraceMs !== undefined ? { finishGraceMs: o.finishGraceMs } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  await service.start();
  const app = createApp({
    service,
    auth: o.auth,
    ...(o.corsOrigins ? { corsOrigins: o.corsOrigins } : {}),
    ...(o.pageFetch ? { pageFetch: o.pageFetch } : {}),
  });
  const host = o.host ?? '127.0.0.1';
  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: o.port, hostname: host }, () => resolve(s));
    s.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  service.setBaseUrl(o.internalUrl ?? url);
  let closing: Promise<void> | null = null;
  const stopHttp = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  return {
    url,
    port,
    service,
    close: () =>
      (closing ??= (async () => {
        await service.close();
        await stopHttp();
      })()),
    closeHttpOnly: () =>
      (closing ??= (async () => {
        service.abandon();
        await stopHttp();
        await service.flush();
      })()),
  };
}

/** Builds the signer a config asks for. */
export async function signerFromConfig(cfg: Config): Promise<Signer> {
  if (cfg.witnessSigner === 'kms') {
    const client = new KMSClient(cfg.awsRegion ? { region: cfg.awsRegion } : {});
    return KmsSigner.create(client, cfg.kmsKeyId);
  }
  return DevFileSigner.fromFile(cfg.witnessKeyPath);
}

/** Builds the authenticator a config asks for. */
export function authFromConfig(cfg: Config): Authenticator {
  if (cfg.authMode === 'cognito') {
    return CognitoAuthenticator.create({
      userPoolId: cfg.cognito.userPoolId,
      clientId: cfg.cognito.clientId,
      tokenUse: cfg.cognito.tokenUse,
    }).auth;
  }
  return new DevAuthenticator({ accountId: cfg.devAccountId, actorId: cfg.devUserId });
}

/** Starts everything from a config (the `start` and `dev` entry points). */
export async function startFromConfig(cfg: Config): Promise<ServerHandle & { db: Db }> {
  const db = openDb(cfg.databaseUrl, cfg.databaseSchema);
  const handle = await startServer({
    port: cfg.port,
    host: cfg.host,
    internalUrl: cfg.internalUrl,
    db,
    store: new DurableStreamsStore(cfg.durableStreamsUrl, { prefix: cfg.streamPrefix }),
    signer: await signerFromConfig(cfg),
    auth: authFromConfig(cfg),
    adapters: adapterFactory(cfg.modelAdapter, {
      ...(cfg.claudeBin ? { claudeBin: cfg.claudeBin } : {}),
      mockStepDelayMs: cfg.mockStepDelayMs,
    }),
    search: createSourceSearch({}),
    cadence: cfg.cadence,
    autoStartSessions: cfg.autoStartSessions,
    preload: cfg.preload,
    models: cfg.models,
    corsOrigins: cfg.corsOrigins,
  });
  return { ...handle, db };
}
