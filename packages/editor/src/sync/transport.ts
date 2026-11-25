/**
 * The contract between the editor and the ledger service. The editor never talks
 * HTTP or SSE itself; the host (apps/web) supplies a `CommitTransport`. The package
 * ships {@link MockTransport} for tests and the demo.
 */
import type { CommitDraft, PMNodeJSON, StepJSON } from '@longhand/schema';

/** Result of submitting one draft. */
export type SubmitResult =
  /** Appended. `version` is the document version after the commit (step-bearing commits). */
  | { status: 'ack'; seq: number; version?: number }
  /** Already appended earlier (same `commitId`); treated exactly like `ack`. */
  | { status: 'duplicate'; seq: number; version?: number }
  /** `baseVersion` did not match; the document is at `currentVersion`. Catch up and rebase. */
  | { status: 'conflict'; currentVersion: number }
  /** Permanently invalid (schema, steps do not apply, …). Dropped from the queue. */
  | { status: 'rejected'; reason: string }
  /** Network unavailable; the draft stays queued and is retried. */
  | { status: 'offline' };

/**
 * A step-bearing commit applied to a document, in ledger order. For `TextEdited`
 * the steps are the commit's own; for `ProposalAccepted` they are the steps the
 * fold derived. `version === baseVersion + steps.length`.
 */
export interface RemoteUpdate {
  documentId: string;
  commitId: string;
  seq: number;
  type: 'TextEdited' | 'ProposalAccepted';
  baseVersion: number;
  version: number;
  steps: StepJSON[];
}

/** Catch-up answer: the step-bearing commits since a version, or a snapshot when the service no longer has them. */
export type CatchUp =
  | { kind: 'updates'; updates: RemoteUpdate[]; version: number }
  | { kind: 'snapshot'; doc: PMNodeJSON; version: number };

/** Online state of a transport. */
export type ConnectionState = 'online' | 'offline';

/**
 * What the editor needs from the ledger service.
 *
 * Ordering rules the editor relies on:
 * - `submit` is called with one draft at a time per queue, in queue order.
 * - `subscribe` delivers every step-bearing commit of the document in ledger
 *   order, **including this client's own** (matched by `commitId`, which then also
 *   counts as an acknowledgement).
 * - `fetchSince(documentId, v)` returns the step-bearing commits with
 *   `baseVersion >= v` in order, or a snapshot.
 */
export interface CommitTransport {
  submit(draft: CommitDraft): Promise<SubmitResult>;
  subscribe(documentId: string, listener: (update: RemoteUpdate) => void): () => void;
  fetchSince(documentId: string, version: number): Promise<CatchUp>;
  connection(): ConnectionState;
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;
}
