/**
 * The input guard: a ProseMirror plugin that classifies every doc-changing
 * transaction by input method and refuses the ones no real user input explains.
 *
 * - Classification happens in `filterTransaction`, so it covers transactions from
 *   `view.dispatch`, `state.apply` and other plugins' `appendTransaction` alike.
 * - Tags live in a module-private `WeakMap`, so nothing outside this module can
 *   forge one. Read them with {@link inputTagOf}.
 * - Remote steps (acknowledged ledger state from the sync engine) are marked with
 *   the guard's privileged {@link InputGuard.markRemote}; they are never captured.
 * - State integrity: a doc that reaches the view without passing the filter (for
 *   example `view.updateState` with a hand-built state) is reverted.
 *
 * Policy `refuse` (default in development) drops violating transactions. Policy
 * `flag` (default in production) lets a violating *insertion* through as
 * `pasted-external`, so the writer never loses text and nothing is overclaimed.
 */
import { inlineTextBetween } from '@longhand/schema';
import { EditorState, Plugin, PluginKey, type EditorStateConfig, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { changedRange, isSplitStep, transformTotals } from '../steps';
import { Emitter, isProduction, newId } from '../util';
import {
  classifyTransaction,
  type InputGrant,
  type InputTag,
  type TransactionFacts,
} from './classify';
import { InputTracker, type InputTrackerOptions } from './tracker';

const TAGS = new WeakMap<Transaction, InputTag>();
const REMOTE = new WeakSet<Transaction>();
const VERIFIED_DOCS = new WeakSet<object>();

/** The input tag the guard assigned to a transaction, if it changed the document. */
export function inputTagOf(tr: Transaction): InputTag | undefined {
  return TAGS.get(tr);
}

/** True if the transaction carries remote (ledger) steps rather than local input. */
export function isRemoteTransaction(tr: Transaction): boolean {
  return REMOTE.has(tr);
}

/** A refused (or, under `flag`, downgraded) transaction. */
export interface GuardViolation {
  reason: string;
  flagged: boolean;
  steps: number;
}

export interface InputGuardOptions extends InputTrackerOptions {
  /** Project id, used to validate internal clipboard markers. */
  projectId: string;
  /** `refuse` drops violations; `flag` lets insertions through as `pasted-external`. */
  policy?: 'refuse' | 'flag';
  /** Called for every violation. */
  onViolation?: (v: GuardViolation) => void;
}

/** A guard instance. One per editor view. The methods marked privileged belong to the editor core. */
export interface InputGuard {
  readonly plugin: Plugin;
  readonly tracker: InputTracker;
  readonly policy: 'refuse' | 'flag';
  readonly violations: Emitter<GuardViolation>;
  /** Privileged: marks a transaction as remote ledger state (not captured, always allowed). */
  markRemote(tr: Transaction): Transaction;
  /** Privileged: grants a Longhand command or input rule input units / a method. */
  grant(tr: Transaction, grant: InputGrant): Transaction;
  /** Sets (or clears) the suggestion the writer is tracing over (adds `traceSuggestionId`). */
  setTraceSuggestion(id: string | null): void;
  /** Creates a state whose document the guard treats as verified. */
  createState(config: EditorStateConfig): EditorState;
}

const guardKey = new PluginKey<{ doc: object | null }>('longhand-input-guard');

function factsOf(tr: Transaction, grant: InputGrant | undefined): TransactionFacts {
  const totals = transformTotals(tr);
  let text: string | null = null;
  return {
    docChanged: tr.docChanged,
    uiEvent: tr.getMeta('uiEvent') as string | undefined,
    history: tr.getMeta('history$') as { redo: boolean } | undefined,
    composition: !!tr.getMeta('composition'),
    insertedUnits: totals.insertedUnits,
    insertedChars: totals.insertedChars,
    deletedChars: totals.deletedChars,
    split: tr.steps.some(isSplitStep),
    structural: totals.structural,
    hintKind: grant?.kind,
    grant,
    insertedText: () => {
      if (text === null) {
        const r = changedRange(tr);
        text = r ? inlineTextBetween(tr.doc, r.from, r.to, '\n') : '';
      }
      return text;
    },
  };
}

/** Creates an input guard. */
export function createInputGuard(opts: InputGuardOptions): InputGuard {
  let viewRef: EditorView | null = null;
  const tracker = new InputTracker({
    ...opts,
    isDraggingInternally: opts.isDraggingInternally ?? (() => !!viewRef?.dragging),
  });
  const policy = opts.policy ?? (isProduction() ? 'flag' : 'refuse');
  const violations = new Emitter<GuardViolation>();
  const grants = new WeakMap<Transaction, InputGrant>();
  let traceSuggestionId: string | null = null;

  const report = (v: GuardViolation): void => {
    if (!v.flagged) console.error(`[longhand/editor] refused a transaction: ${v.reason}`);
    else console.warn(`[longhand/editor] flagged an unverifiable insertion as pasted-external: ${v.reason}`);
    opts.onViolation?.(v);
    violations.emit(v);
  };

  const plugin: Plugin = new Plugin({
    key: guardKey,
    state: {
      init: (config, instance) => ({
        doc: VERIFIED_DOCS.has(config as object) ? instance.doc : null,
      }),
      apply: (_tr, _value, _old, newState) => ({ doc: newState.doc }),
    },
    filterTransaction(tr) {
      if (!tr.docChanged || REMOTE.has(tr) || TAGS.has(tr)) return true;
      const facts = factsOf(tr, grants.get(tr));
      const result = classifyTransaction(facts, tracker.state(), {
        projectId: opts.projectId,
        policy,
        newId,
        traceSuggestionId,
      });
      if (!result.ok) {
        report({ reason: result.reason, flagged: false, steps: tr.steps.length });
        return false;
      }
      const { tag, consume } = result;
      if (consume.text) tracker.consumeText(consume.text);
      if (consume.paste) tracker.consumePaste();
      if (consume.drop) tracker.consumeDrop();
      if (consume.autocorrect) tracker.consumeAutocorrect();
      if (tag) {
        if (tag.flagged) report({ reason: 'insertion without matching input', flagged: true, steps: tr.steps.length });
        TAGS.set(tr, tag);
      }
      return true;
    },
    view(view) {
      viewRef = view;
      const detach = tracker.attach(view.dom as HTMLElement);
      return {
        update(v, prevState) {
          const st = guardKey.getState(v.state);
          if (v.state.doc !== prevState.doc && st?.doc !== v.state.doc) {
            report({ reason: 'document replaced outside the transaction pipeline', flagged: false, steps: 0 });
            queueMicrotask(() => {
              if (v.isDestroyed) return;
              const current = guardKey.getState(v.state);
              if (current?.doc !== v.state.doc) v.updateState(prevState);
            });
          }
        },
        destroy() {
          detach();
          viewRef = null;
        },
      };
    },
  });

  return {
    plugin,
    tracker,
    policy,
    violations,
    markRemote(tr) {
      REMOTE.add(tr);
      tr.setMeta('addToHistory', false);
      return tr;
    },
    grant(tr, grant) {
      grants.set(tr, grant);
      return tr;
    },
    setTraceSuggestion(id) {
      traceSuggestionId = id;
    },
    createState(config) {
      const cfg = { ...config };
      VERIFIED_DOCS.add(cfg);
      return EditorState.create(cfg);
    },
  };
}
