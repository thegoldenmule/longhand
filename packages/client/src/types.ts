/**
 * Wire types of the ledger service API.
 *
 * The `CommitTransport` family mirrors `packages/editor/src/sync/transport.ts`
 * structurally (this package does not depend on the editor, which needs React);
 * `transport.test.ts` checks that `HttpCommitTransport` is assignable to the
 * editor's interface.
 */
import type {
  Commit,
  CommitDraft,
  PMNodeJSON,
  ProjectState,
  StepJSON,
  SurfacedCandidate,
  Witness,
} from '@longhand/schema';

/** Result of submitting one draft (the editor's `SubmitResult`). */
export type SubmitResult =
  | { status: 'ack'; seq: number; version?: number }
  | { status: 'duplicate'; seq: number; version?: number }
  | { status: 'conflict'; currentVersion: number }
  | { status: 'rejected'; reason: string }
  | { status: 'offline' };

/** A step-bearing commit applied to a document (the editor's `RemoteUpdate`). */
export interface RemoteUpdate {
  documentId: string;
  commitId: string;
  seq: number;
  type: 'TextEdited' | 'ProposalAccepted';
  baseVersion: number;
  version: number;
  steps: StepJSON[];
}

/** Catch-up answer (the editor's `CatchUp`). */
export type CatchUp =
  | { kind: 'updates'; updates: RemoteUpdate[]; version: number }
  | { kind: 'snapshot'; doc: PMNodeJSON; version: number };

/** Online state of a transport. */
export type ConnectionState = 'online' | 'offline';

/** The editor's `CommitTransport`. */
export interface CommitTransport {
  submit(draft: CommitDraft): Promise<SubmitResult>;
  subscribe(documentId: string, listener: (update: RemoteUpdate) => void): () => void;
  fetchSince(documentId: string, version: number): Promise<CatchUp>;
  connection(): ConnectionState;
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;
}

/** A project row. */
export interface ProjectSummary {
  projectId: string;
  accountId: string;
  title: string;
  createdAt: string;
  headSeq: number;
  headHash: string;
  updatedAt: string;
}

/** `GET /v1/projects/:id/state`. */
export interface StateSnapshot {
  headSeq: number;
  headHash: string;
  state: ProjectState;
}

/** `GET /v1/projects/:id/bundle`: raw verification pieces. */
export interface BundleData {
  projectId: string;
  accountId: string;
  headSeq: number;
  headHash: string;
  commits: Commit[];
  witnesses: Witness[];
  publicKeyPem: string;
  keyId: string;
  unwitnessedSeqs: number[];
  lateArrivals: Array<{ seq: number; clientTime: string; serverTime: string; lagMs: number }>;
}

/** `GET /.well-known/longhand-witness-key`. */
export interface WitnessKey {
  keyId: string;
  publicKeyPem: string;
  algorithm: string;
  signatureEncoding: string;
  message: string;
}

/** Progress of an agent session (`/sessions/:id/events`). */
export type SessionEvent =
  | { kind: 'started'; feedbackSessionId: string; model: string; seq: number }
  | { kind: 'model'; event: { type: string; [k: string]: unknown } }
  | {
      kind: 'annotation';
      seq: number;
      draft: { type: string; payload: unknown; [k: string]: unknown };
    }
  | { kind: 'finished'; feedbackSessionId: string }
  | { kind: 'failed'; feedbackSessionId: string | null; reason: string }
  | { kind: 'ended'; status: 'finished' | 'failed'; reason: string | null };

/** `POST /feedback` and `/discuss`. */
export interface SessionStart {
  status: 'ack' | 'duplicate';
  seq: number | null;
  sessionId: string;
}

/** `GET /sessions/:id`. */
export interface SessionInfo {
  id: string;
  kind: 'review' | 'discuss';
  requestId: string | null;
  threadId: string | null;
  phase: 'open' | 'cancelling' | 'closed';
  ended: boolean;
  folded: ProjectState['annotations']['agentSessions'][string] | null;
}

export type { SurfacedCandidate };
