/**
 * `tsx src/cli.ts <command>`:
 *
 * - `dev`      start the Durable Streams server (file-backed, `.dev/streams`, port 3300)
 *              in-process, run migrations, start the service (port 3200)
 * - `start`    run migrations and start the service against `DURABLE_STREAMS_URL`
 * - `streams`  run only the Durable Streams server
 * - `migrate`  apply pending migrations
 * - `rebuild`  empty the Postgres read model and rebuild it from the streams
 *
 * Reads `.env` at the repo root when present.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DurableStreamTestServer } from '@durable-streams/server';
import { loadConfig, REPO_ROOT, type Config } from './config';
import { signerFromConfig, startFromConfig } from './server';
import { LedgerService } from './service';
import { adapterFactory } from './agent/sessions';
import { migrate, openDb } from './storage/db';
import { ReadModel } from './storage/readmodel';
import { DurableStreamsStore } from './storage/streams';

const envFile = join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function startStreams(cfg: Config): Promise<DurableStreamTestServer> {
  const url = new URL(cfg.durableStreamsUrl);
  const dataDir = process.env.DURABLE_STREAMS_DATA_DIR ?? join(REPO_ROOT, '.dev', 'streams');
  mkdirSync(dataDir, { recursive: true });
  const ds = new DurableStreamTestServer({
    port: Number(url.port || 3300),
    host: url.hostname,
    dataDir,
  });
  await ds.start();
  console.log(`[streams] Durable Streams on ${cfg.durableStreamsUrl} (data in ${dataDir})`);
  return ds;
}

function onSignal(stop: () => Promise<void>): void {
  let stopping = false;
  const handler = (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n[server] ${sig}: shutting down…`);
    stop().then(
      () => process.exit(0),
      (e) => {
        console.error(e);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

async function main(cmd: string): Promise<void> {
  const cfg = loadConfig();
  switch (cmd) {
    case 'migrate': {
      const db = openDb(cfg.databaseUrl, cfg.databaseSchema);
      const applied = await migrate(db);
      console.log(
        applied.length ? `applied migrations ${applied.join(', ')}` : 'migrations up to date',
      );
      await db.close();
      return;
    }
    case 'rebuild': {
      const db = openDb(cfg.databaseUrl, cfg.databaseSchema);
      await migrate(db);
      const service = new LedgerService({
        store: new DurableStreamsStore(cfg.durableStreamsUrl, { prefix: cfg.streamPrefix }),
        readModel: new ReadModel(db),
        signer: await signerFromConfig(cfg),
        adapters: adapterFactory('mock'),
        search: null,
        cadence: { everyCommits: 0, intervalMs: 0 },
        autoStartSessions: false,
      });
      await service.start();
      const r = await service.rebuild();
      await service.close();
      await db.close();
      console.log(`rebuilt the read model: ${r.projects} project(s), ${r.commits} commit(s)`);
      return;
    }
    case 'streams': {
      const ds = await startStreams(cfg);
      onSignal(() => ds.stop());
      return;
    }
    case 'dev':
    case 'start': {
      const ds = cmd === 'dev' ? await startStreams(cfg) : null;
      const handle = await startFromConfig(cfg);
      console.log(
        `[server] ledger service on ${handle.url} (auth ${cfg.authMode}, model ${cfg.modelAdapter}, witness key ${handle.service.signer.keyId.slice(0, 12)}…)`,
      );
      onSignal(async () => {
        await handle.close();
        await handle.db.close();
        await ds?.stop();
      });
      return;
    }
    default:
      console.error('usage: tsx src/cli.ts dev|start|streams|migrate|rebuild');
      process.exit(2);
  }
}

main(process.argv[2] ?? 'start').catch((e) => {
  console.error(e);
  process.exit(1);
});
