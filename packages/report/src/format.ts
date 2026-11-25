/**
 * Deterministic text helpers for the disclosure template and the report page.
 *
 * Nothing here uses `Intl`, `toLocaleString` or the host time zone: the
 * disclosure is part of the report a verifier recomputes, so it must come out
 * byte-identical in every runtime.
 */

/** `1234567` → `"1,234,567"`. */
export function formatInt(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return n < 0 ? `-${out}` : out;
}

/** `count(1, 'session')` → `"1 session"`; `count(3, 'session')` → `"3 sessions"`. */
export function count(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatInt(n)} ${n === 1 ? singular : pluralForm}`;
}

/** `["a"]` → `"a"`, `["a","b"]` → `"a and b"`, `["a","b","c"]` → `"a, b and c"`. */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Splits 100.0% into tenths of a percent across `counts` so the shares sum to
 * exactly 1000 tenths (largest-remainder rounding).
 *
 * Never overclaim: the entry at `floorIndex` (the share typed directly) is always
 * rounded *down*; the tenths left over go to the other entries, largest remainder
 * first, ties to the earlier entry (pass the least trusted classes first).
 * Returns all zeros when `total` is 0.
 */
export function allocateTenths(counts: readonly number[], floorIndex = -1): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const tenths = counts.map((c) => Math.floor((c * 1000) / total));
  const rest = counts.map((c, i) => ({ i, r: (c * 1000) % total }));
  let missing = 1000 - tenths.reduce((a, b) => a + b, 0);
  // Remainders sum to `missing * total`, so the entries other than `floorIndex`
  // always have enough non-zero remainders to absorb what is missing.
  const order = rest
    .filter((e) => e.i !== floorIndex && e.r > 0)
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const e of order) {
    if (missing <= 0) break;
    tenths[e.i] = (tenths[e.i] as number) + 1;
    missing -= 1;
  }
  return tenths;
}

/**
 * A share as printed in the disclosure: `"97.8%"`, `"100%"` only when it is all
 * of it, `"under 0.1%"` for a non-zero share that rounds to nothing, and
 * `"over 99.9%"` for a share that rounds to 100% but is not all of it.
 */
export function percentLabel(tenths: number, part: number, total: number): string {
  if (total === 0 || part === 0) return '0%';
  if (part === total) return '100%';
  if (tenths <= 0) return 'under 0.1%';
  if (tenths >= 1000) return 'over 99.9%';
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** `5_400_000` → `"1 h 30 min"`, `125_000` → `"2 min"`, `20_000` → `"under 1 min"`. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0 min';
  const minutes = Math.floor(ms / 60_000);
  if (minutes === 0) return 'under 1 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${formatInt(h)} h` : `${formatInt(h)} h ${m} min`;
}

/** An ISO time as `"2026-11-02 09:00 UTC"` (no time zone conversion). */
export function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** An ISO time's UTC calendar day, `"2026-11-02"`. */
export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}
