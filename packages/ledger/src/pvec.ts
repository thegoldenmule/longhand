/**
 * A tiny persistent (append-only) vector: chunks of 256 items. `push` copies only the
 * chunk index and the last chunk, so older states that share a vector are never
 * affected and long ledgers fold in near-linear time.
 */
const BITS = 8;
const SIZE = 1 << BITS;
const MASK = SIZE - 1;

/** An immutable vector. */
export interface PVec<T> {
  readonly chunks: ReadonlyArray<readonly T[]>;
  readonly length: number;
}

/** The empty vector. */
export function pvecEmpty<T>(): PVec<T> {
  return { chunks: [], length: 0 };
}

/** A new vector with `item` appended. */
export function pvecPush<T>(v: PVec<T>, item: T): PVec<T> {
  const ci = v.length >> BITS;
  const chunks = v.chunks.slice();
  const last = ci < chunks.length ? [...(chunks[ci] as readonly T[]), item] : [item];
  chunks[ci] = last;
  return { chunks, length: v.length + 1 };
}

/** Item at `i`, or undefined. */
export function pvecGet<T>(v: PVec<T>, i: number): T | undefined {
  if (i < 0 || i >= v.length) return undefined;
  return (v.chunks[i >> BITS] as readonly T[])[i & MASK];
}

/** All items, in order. */
export function pvecToArray<T>(v: PVec<T>): T[] {
  const out: T[] = [];
  for (const c of v.chunks) out.push(...c);
  return out;
}

/** A vector holding `items`. */
export function pvecFrom<T>(items: readonly T[]): PVec<T> {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += SIZE) chunks.push(items.slice(i, i + SIZE));
  return { chunks, length: items.length };
}
