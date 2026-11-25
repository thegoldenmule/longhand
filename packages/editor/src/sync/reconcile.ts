/**
 * Reconciling queued `TextEdited` drafts with what the ledger actually holds, when
 * no open editor owns them (after a reload, or for another tab's drafts).
 */
import { schema, type CommitDraftOf } from '@longhand/schema';
import { Step } from 'prosemirror-transform';
import { rebaseStepsHeadless } from './rebase';
import type { RemoteUpdate } from './transport';

/** A queued draft whose steps may have been rebased. */
export interface ReconciledDraft {
  draft: CommitDraftOf<'TextEdited'>;
  /** Surviving steps, in order (rebased when foreign commits came first). */
  steps: Step[];
  /** Indexes into `draft.payload.steps` of the surviving steps. */
  kept: number[];
  /** True if anything changed (steps rebased or dropped). */
  changed: boolean;
}

/** Outcome of {@link reconcileHeadless}. */
export interface Reconciled {
  /** Drafts the ledger already holds (lost acknowledgements). */
  applied: string[];
  /** Drafts still to submit, rebased onto `version`. */
  remaining: ReconciledDraft[];
  /** Document version after `updates`. */
  version: number;
}

/**
 * Walks the ledger's updates (from the first draft's `baseVersion` on) and splits
 * the drafts into those already applied and those still pending, rebasing pending
 * ones over foreign commits by step maps.
 */
export function reconcileHeadless(
  drafts: readonly CommitDraftOf<'TextEdited'>[],
  updates: readonly RemoteUpdate[],
  startVersion: number,
): Reconciled {
  const pending: ReconciledDraft[] = drafts.map((draft) => ({
    draft,
    steps: draft.payload.steps.map((j) => Step.fromJSON(schema, j)),
    kept: draft.payload.steps.map((_j, i) => i),
    changed: false,
  }));
  const applied: string[] = [];
  let version = startVersion;
  for (const u of updates) {
    if (u.version <= version) continue;
    const ownIndex = pending.findIndex((p) => p.draft.commitId === u.commitId);
    if (ownIndex >= 0) {
      // Everything before an applied draft must have been applied too (queue order).
      applied.push(...pending.splice(0, ownIndex + 1).map((p) => p.draft.commitId));
      version = u.version;
      continue;
    }
    const remote = u.steps.slice(Math.max(0, version - u.baseVersion)).map((j) => Step.fromJSON(schema, j));
    const local = pending.flatMap((p) => p.steps);
    const result = rebaseStepsHeadless(local, remote);
    let i = 0;
    for (const p of pending) {
      const steps: Step[] = [];
      const kept: number[] = [];
      p.steps.forEach((_s, j) => {
        const r = result.steps[i++];
        if (r) {
          steps.push(r);
          kept.push(p.kept[j] as number);
        }
      });
      p.steps = steps;
      p.kept = kept;
      p.changed = true;
    }
    version = u.version;
  }
  return { applied, remaining: pending, version };
}
