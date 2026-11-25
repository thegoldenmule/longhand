/** Plain-text rendering of a {@link VerificationResult}, for the CLI. */
import type { CheckStatus, VerificationResult } from './verify';

const MARK: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };

/** A human-readable report of the checks; `name` is the file being checked. */
export function formatResult(result: VerificationResult, name: string): string {
  const lines: string[] = [`Longhand verification: ${name}`];
  const b = result.bundle;
  if (b) {
    const facts = [
      b.projectId ? `project ${b.projectId}` : null,
      `${b.commits} commits`,
      `${b.witnesses} witnesses`,
      b.keyId ? `key ${b.keyId.slice(0, 12)}…` : null,
    ].filter((s): s is string => s !== null);
    lines.push(facts.join(' · '));
  }
  lines.push('');
  const width = Math.max(...result.checks.map((c) => c.title.length));
  for (const c of result.checks) {
    lines.push(`  ${MARK[c.status]}  ${c.title.padEnd(width)}  ${c.summary}`);
    for (const d of c.details) lines.push(`${' '.repeat(width + 10)}${d}`);
  }
  lines.push('');
  if (result.ok) {
    lines.push('VERIFIED. The ledger, its signatures and its report agree.');
    if (result.report) lines.push('', 'Disclosure:', `  ${result.report.disclosure}`);
  } else {
    const failed = result.checks.filter((c) => c.status === 'fail').map((c) => c.title);
    lines.push(`NOT VERIFIED. Failed: ${failed.join(', ')}.`);
  }
  return `${lines.join('\n')}\n`;
}
