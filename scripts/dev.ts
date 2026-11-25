/**
 * `pnpm dev` — everything for local development:
 *
 * 1. Postgres on 5434: used if it answers, otherwise `docker compose up -d`.
 * 2. `pnpm dev:setup` when the witness key is missing.
 * 3. The ledger service (`pnpm dev:server`: Durable Streams on 3300, API on 3200)
 *    and the web app (http://localhost:3100), with prefixed output.
 *
 * Ctrl-C stops both cleanly (the service cancels running reviews first); a second
 * Ctrl-C forces it. Reads the repo-root `.env` (see `.env.example`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exited, portInUse, run, signalGroup, sleep } from './proc';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const envFile = join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const say = (msg: string) => console.log(`\x1b[2m[dev]\x1b[0m ${msg}`);

function pgPort(): number {
  try {
    return Number(new URL(process.env.DATABASE_URL ?? '').port || 5434);
  } catch {
    return 5434;
  }
}

async function ensurePostgres(): Promise<void> {
  const port = pgPort();
  if (await portInUse(port)) {
    say(`Postgres answers on ${port}`);
    return;
  }
  say(`Postgres is not on ${port}: docker compose up -d`);
  const up = spawnSync('docker', ['compose', 'up', '-d'], { cwd: root, stdio: 'inherit' });
  if (up.status !== 0) throw new Error('docker compose up failed (is Docker running?)');
  for (let i = 0; i < 60; i++) {
    const ready = spawnSync(
      'docker',
      ['compose', 'exec', '-T', 'postgres', 'pg_isready', '-U', 'longhand', '-d', 'longhand'],
      { cwd: root, stdio: 'ignore' },
    );
    if (ready.status === 0 && (await portInUse(port))) {
      say('Postgres is ready');
      return;
    }
    await sleep(1000);
  }
  throw new Error(`Postgres did not become ready on ${port}`);
}

async function main(): Promise<void> {
  await ensurePostgres();
  const key = resolve(root, process.env.WITNESS_KEY_PATH ?? '.dev/witness-key.pem');
  if ((process.env.WITNESS_SIGNER ?? 'file') === 'file' && !existsSync(key)) {
    say('no witness key yet: pnpm dev:setup');
    const setup = spawnSync('pnpm', ['dev:setup'], { cwd: root, stdio: 'inherit' });
    if (setup.status !== 0) throw new Error('pnpm dev:setup failed');
  }
  const webPort = Number(process.env.WEB_PORT ?? 3100);
  const ledgerPort = Number(process.env.LEDGER_PORT ?? 3200);
  for (const [name, port] of [
    ['web app', webPort],
    ['ledger service', ledgerPort],
    ['Durable Streams', 3300],
  ] as const) {
    if (await portInUse(port)) throw new Error(`port ${port} (${name}) is already in use`);
  }

  const children = [
    run('server', 'pnpm', ['--filter', '@longhand/server', 'dev'], { cwd: root }),
    run('web', 'pnpm', ['--filter', '@longhand/web', 'dev'], {
      cwd: root,
      env: { WEB_PORT: String(webPort) },
    }),
  ];
  say(`web app on http://localhost:${webPort} · ledger service on http://127.0.0.1:${ledgerPort}`);
  say(
    `model adapter: ${process.env.MODEL_ADAPTER ?? 'claude'} (MODEL_ADAPTER=mock for a canned reviewer)`,
  );

  let stopping = 0;
  const stop = async (code: number) => {
    if (stopping) {
      // A terminal Ctrl-C reaches this process twice (directly and relayed by
      // pnpm/tsx); only a later, deliberate second Ctrl-C forces the stop.
      if (Date.now() - stopping < 1500) return;
      say('forcing stop');
      for (const c of children) signalGroup(c, 'SIGKILL');
      process.exit(code || 1);
    }
    stopping = Date.now();
    say('stopping…');
    for (const c of children) signalGroup(c, 'SIGINT');
    const timer = setTimeout(() => {
      for (const c of children) signalGroup(c, 'SIGKILL');
    }, 20_000);
    await Promise.all(children.map(exited));
    clearTimeout(timer);
    say('stopped');
    process.exit(code);
  };
  process.on('SIGINT', () => void stop(0));
  process.on('SIGTERM', () => void stop(0));
  // If either exits on its own, stop the other.
  for (const c of children) void exited(c).then((code) => !stopping && void stop(code));
}

main().catch((e: unknown) => {
  console.error(`[dev] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
