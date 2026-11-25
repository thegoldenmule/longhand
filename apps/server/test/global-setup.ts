import type { TestProject } from 'vitest/node';
import { databaseAvailable, TEST_DATABASE_URL } from '../src/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    dbAvailable: boolean;
  }
}

/**
 * Integration tests need Postgres (`docker compose up -d`, port 5434). Without it
 * they are skipped with a warning, unless `LONGHAND_REQUIRE_DB=1` makes that fatal.
 */
export default async function setup(project: TestProject): Promise<void> {
  const ok = await databaseAvailable();
  if (!ok) {
    const msg = `Postgres is not reachable at ${TEST_DATABASE_URL}; server integration tests are skipped (docker compose up -d).`;
    if (process.env.LONGHAND_REQUIRE_DB === '1') throw new Error(msg);
    console.warn(`\n[server tests] ${msg}\n`);
  }
  project.provide('dbAvailable', ok);
}
