/**
 * Ports of the full-stack e2e run: never the dev ports (3100, 3200, 3300) and
 * never a package demo's (4317–4319, 4391), so `pnpm dev` can keep running.
 */
const webPort = Number(process.env.E2E_WEB_PORT ?? 3150);
const ledgerPort = Number(process.env.E2E_LEDGER_PORT ?? 3250);

export const E2E = {
  webPort,
  ledgerPort,
  webOrigin: `http://localhost:${webPort}`,
  ledgerUrl: `http://127.0.0.1:${ledgerPort}`,
};
