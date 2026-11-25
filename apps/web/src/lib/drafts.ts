/**
 * Human events outside the editor's own capture (binder, research, settings,
 * imports). With a document open they go through `editor.submitEvent`, so they
 * share the editor's ordered IndexedDB queue (offline-safe, in order with the
 * text). With no editor (an empty project, the projects page) they are posted
 * directly and retried while offline.
 */
import type { HttpCommitTransport, LonghandClient } from '@longhand/client';
import type { EditorHandle, SubmittableEventType } from '@longhand/editor';
import {
  CommitDraftSchema,
  SCHEMA_VERSION,
  type CommitDraft,
  type EventPayloads,
} from '@longhand/schema';
import { deviceId, editorSessionId, newId } from './ids';

/** A human commit draft. */
export function humanDraft<K extends keyof EventPayloads>(
  projectId: string,
  actorId: string,
  type: K,
  payload: EventPayloads[K],
): CommitDraft {
  return CommitDraftSchema.parse({
    commitId: newId(),
    projectId,
    clientTime: new Date().toISOString(),
    actor: { kind: 'human', id: actorId },
    deviceId: deviceId(),
    sessionId: editorSessionId(),
    schemaVersion: SCHEMA_VERSION,
    type,
    payload,
  }) as CommitDraft;
}

/** Posts a draft; throws unless the ledger acknowledged it. */
export async function postDraft(client: LonghandClient, draft: CommitDraft): Promise<number> {
  const r = await client.json<{ status: string; seq: number }>(
    'POST',
    `/v1/projects/${encodeURIComponent(draft.projectId)}/commits`,
    draft,
  );
  return r.seq;
}

/** Routes the workspace's human events (see the module comment). */
export class HumanEvents {
  editor: EditorHandle | null = null;
  private backlog: CommitDraft[] = [];
  private draining = false;

  constructor(
    private readonly transport: HttpCommitTransport,
    private readonly projectId: string,
    private readonly actorId: string,
    private readonly onError: (message: string) => void = () => undefined,
  ) {}

  /** Queues a human event; returns its commit id. */
  submit<K extends SubmittableEventType>(type: K, payload: EventPayloads[K]): string {
    if (this.editor) return this.editor.submitEvent(type, payload).commitId;
    const draft = humanDraft(this.projectId, this.actorId, type, payload);
    this.backlog.push(draft);
    void this.drain();
    return draft.commitId;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    let delay = 1000;
    try {
      while (this.backlog.length) {
        const draft = this.backlog[0] as CommitDraft;
        const r = await this.transport.submit(draft);
        if (r.status === 'offline') {
          await new Promise((res) => setTimeout(res, delay));
          delay = Math.min(delay * 2, 30_000);
          continue;
        }
        if (r.status === 'rejected') this.onError(`The ledger refused a change: ${r.reason}`);
        this.backlog.shift();
        delay = 1000;
      }
    } finally {
      this.draining = false;
    }
  }
}
