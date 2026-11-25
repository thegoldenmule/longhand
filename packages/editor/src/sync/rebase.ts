/**
 * Client-side rebase of unacknowledged local steps over steps the ledger applied
 * first (another device, or the steps the fold derived for an accepted proposal).
 *
 * The algorithm is prosemirror-collab's: undo the local steps, apply the remote
 * ones, then map each local step through `inverse(local) + remote + rebased-so-far`
 * with mirror information, dropping steps that no longer apply.
 */
import { Mapping, type Step, type Transform } from 'prosemirror-transform';

/** `Mapping#setMirror` is public at runtime (prosemirror-collab uses it) but not in the typings. */
function setMirror(mapping: Mapping, n: number, m: number): void {
  (mapping as unknown as { setMirror(n: number, m: number): void }).setMirror(n, m);
}

/** Result of a rebase: one entry per input local step (`null` = dropped). */
export interface RebaseResult {
  steps: Array<Step | null>;
  /**
   * Maps a position in the old local document *after the first `k` local steps*
   * to the new local document after the surviving rebased versions of those steps.
   */
  mapAfter(k: number, pos: number, assoc?: number): number;
  /** Number of surviving rebased steps among the first `k` local steps. */
  survivorsBefore(k: number): number;
}

function makeResult(
  mapping: Mapping,
  n: number,
  m: number,
  appendedAt: number[],
  steps: Array<Step | null>,
): RebaseResult {
  return {
    steps,
    mapAfter(k, pos, assoc = 1) {
      let end = n + m;
      for (let i = 0; i < k; i++)
        if ((appendedAt[i] as number) >= 0) end = (appendedAt[i] as number) + 1;
      return mapping.slice(n - k, end).map(pos, assoc);
    },
    survivorsBefore(k) {
      let c = 0;
      for (let i = 0; i < k; i++) if (steps[i]) c++;
      return c;
    },
  };
}

/**
 * Rebases without a document, using step maps only (for drafts whose editor is not
 * open). Steps are not validated; the ledger service re-applies them and rejects
 * any that fail.
 */
export function rebaseStepsHeadless(local: readonly Step[], remote: readonly Step[]): RebaseResult {
  const n = local.length;
  const mapping = new Mapping();
  for (let i = n - 1; i >= 0; i--) mapping.appendMap((local[i] as Step).getMap().invert());
  for (const r of remote) mapping.appendMap(r.getMap());
  const out: Array<Step | null> = [];
  const appendedAt: number[] = [];
  for (let i = 0; i < n; i++) {
    const mapped = (local[i] as Step).map(mapping.slice(n - i));
    if (mapped) {
      mapping.appendMap(mapped.getMap(), n - 1 - i);
      appendedAt.push(mapping.maps.length - 1);
      out.push(mapped);
    } else {
      appendedAt.push(-1);
      out.push(null);
    }
  }
  return makeResult(mapping, n, remote.length, appendedAt, out);
}

/** A local step with its inverse (computed against the document it applied to). */
export interface InvertibleStep {
  step: Step;
  inverted: Step;
}

/** Result of {@link rebaseOnDoc}: the transform that turns the old local doc into the new one. */
export interface DocRebaseResult extends RebaseResult {
  transform: Transform;
  /** Inverses of the surviving rebased steps, aligned with `steps`. */
  inverted: Array<Step | null>;
}

/**
 * Rebases against the current local document. `target` is a transform (usually
 * `state.tr`) whose document is the confirmed doc plus all local steps; the undo,
 * remote and rebased steps are added to it. Throws if a remote step does not apply.
 */
export function rebaseOnDoc<T extends Transform>(
  target: T,
  local: readonly InvertibleStep[],
  remote: readonly Step[],
): DocRebaseResult & { transform: T } {
  const n = local.length;
  const tr = target;
  const start = tr.steps.length;
  if (start !== 0) throw new RangeError('rebaseOnDoc needs a fresh transform');
  for (let i = n - 1; i >= 0; i--) tr.step((local[i] as InvertibleStep).inverted);
  for (const r of remote) tr.step(r);
  const out: Array<Step | null> = [];
  const inv: Array<Step | null> = [];
  const appendedAt: number[] = [];
  for (let i = 0; i < n; i++) {
    const mapped = (local[i] as InvertibleStep).step.map(tr.mapping.slice(n - i));
    const before = tr.doc;
    if (mapped && !tr.maybeStep(mapped).failed) {
      setMirror(tr.mapping, n - 1 - i, tr.steps.length - 1);
      appendedAt.push(tr.mapping.maps.length - 1);
      out.push(mapped);
      inv.push(mapped.invert(before));
    } else {
      appendedAt.push(-1);
      out.push(null);
      inv.push(null);
    }
  }
  return {
    ...makeResult(tr.mapping, n, remote.length, appendedAt, out),
    transform: tr,
    inverted: inv,
  };
}
