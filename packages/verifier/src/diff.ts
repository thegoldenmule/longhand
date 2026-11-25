/**
 * A small structural diff of two JSON values, for explaining why a bundled
 * report differs from the recomputed one. Paths look like
 * `words.byClass.typed` or `sessions.list[2].activeMs`.
 */

/** One difference between two JSON values. */
export interface JsonDifference {
  path: string;
  /** The value in the bundle (`undefined` when the bundle lacks it). */
  bundled: unknown;
  /** The recomputed value (`undefined` when only the bundle has it). */
  recomputed: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function join(path: string, key: string): string {
  return /^[A-Za-z_$][\w$-]*$/.test(key)
    ? path
      ? `${path}.${key}`
      : key
    : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Every place where `bundled` and `recomputed` differ, depth first, in sorted key
 * order (the order canonical JSON uses), up to `limit` differences.
 */
export function diffJson(bundled: unknown, recomputed: unknown, limit = 50): JsonDifference[] {
  const out: JsonDifference[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (out.length >= limit) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const p = `${path}[${i}]`;
        if (i >= a.length) out.push({ path: p, bundled: undefined, recomputed: b[i] });
        else if (i >= b.length) out.push({ path: p, bundled: a[i], recomputed: undefined });
        else walk(a[i], b[i], p);
        if (out.length >= limit) return;
      }
      return;
    }
    if (isObject(a) && isObject(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const k of keys) {
        // Canonical JSON omits undefined properties, so an absent key equals undefined.
        if (a[k] === undefined && b[k] === undefined) continue;
        walk(a[k], b[k], join(path, k));
        if (out.length >= limit) return;
      }
      return;
    }
    if (a !== b) out.push({ path: path || '(root)', bundled: a, recomputed: b });
  };
  walk(bundled, recomputed, '');
  return out;
}

/**
 * One line describing a difference. Two long strings are shown around the
 * first character where they differ, so the change is visible.
 */
export function describeDifference(d: JsonDifference): string {
  const { bundled: a, recomputed: b } = d;
  if (typeof a === 'string' && typeof b === 'string') {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const from = Math.max(0, i - 24);
    const clip = (s: string) =>
      `${from > 0 ? '…' : ''}${s.slice(from, i + 32)}${s.length > i + 32 ? '…' : ''}`;
    return `${d.path}: bundled "${clip(a)}", recomputed "${clip(b)}"`;
  }
  return `${d.path}: bundled ${preview(a)}, recomputed ${preview(b)}`;
}

/** A value as short, readable JSON (`undefined` reads "missing"). */
export function preview(value: unknown, max = 72): string {
  if (value === undefined) return 'missing';
  const s = JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
