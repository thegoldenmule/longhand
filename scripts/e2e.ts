/**
 * `pnpm e2e` — every Playwright suite, one after another (each starts its own
 * servers on its own ports, so they must not overlap):
 *
 *   editor (4317) · provenance-ui (4318) · annotations (4319) · verifier (4391)
 *   web, full stack (3150 web, 3250 ledger, random Durable Streams; needs Postgres)
 *
 * A suite whose port is already taken fails instead of reusing a stale server
 * (LONGHAND_E2E_STRICT=1 also turns off reuse in the package configs).
 * `pnpm e2e editor web` runs a subset. Extra Playwright flags go after `--`.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exited, portInUse, run } from './proc';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const SUITES = [
  { name: 'editor', filter: '@longhand/editor', ports: [4317] },
  { name: 'provenance-ui', filter: '@longhand/provenance-ui', ports: [4318] },
  { name: 'annotations', filter: '@longhand/annotations', ports: [4319] },
  { name: 'verifier', filter: '@longhand/verifier', ports: [4391] },
  { name: 'web', filter: '@longhand/web', ports: [3150, 3250] },
] as const;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf('--');
  const names = dash >= 0 ? argv.slice(0, dash) : argv;
  const extra = dash >= 0 ? argv.slice(dash + 1) : [];
  const chosen = names.length ? SUITES.filter((s) => names.includes(s.name)) : SUITES;
  const results: Array<{ name: string; ok: boolean; seconds: number }> = [];
  let interrupted = false;
  let current: ReturnType<typeof run> | null = null;
  process.on('SIGINT', () => {
    interrupted = true;
    if (current?.pid) process.kill(-current.pid, 'SIGINT');
  });

  for (const suite of chosen) {
    if (interrupted) break;
    for (const port of suite.ports) {
      if (await portInUse(port)) {
        console.error(
          `[e2e] ${suite.name}: port ${port} is already in use; stop whatever is running there (no stale servers are reused).`,
        );
        results.push({ name: suite.name, ok: false, seconds: 0 });
        continue;
      }
    }
    if (results.at(-1)?.name === suite.name) continue;
    const started = Date.now();
    current = run(suite.name, 'pnpm', ['--filter', suite.filter, 'e2e', ...extra], {
      cwd: root,
      env: { LONGHAND_E2E_STRICT: '1' },
    });
    const code = await exited(current);
    results.push({
      name: suite.name,
      ok: code === 0,
      seconds: Math.round((Date.now() - started) / 1000),
    });
  }

  console.log('\n[e2e] summary');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.seconds}s)`);
  process.exit(results.every((r) => r.ok) && !interrupted ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
