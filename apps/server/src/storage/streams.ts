/**
 * Durable Streams storage. The ledger service is the only writer.
 *
 * - One JSON stream per project at `{base}/longhand/projects/{accountId}/{projectId}`.
 *   Its messages are {@link StreamRecord}s: every commit, followed by its witness.
 *   Witnesses travel in the stream so the Postgres read model (witnesses included)
 *   can be rebuilt from the streams alone.
 * - One registry stream at `{base}/longhand/registry` listing every project stream,
 *   so `rebuild` can find them (the protocol has no "list streams").
 *
 * Every append carries `Stream-Seq` = the record's zero-padded index in its stream.
 * The Durable Streams server refuses a seq that is not greater than the last one,
 * so two service instances can never interleave writes to one project.
 */
import { DurableStream, stream as readStream } from '@durable-streams/client';
import type { Commit, Witness } from '@longhand/schema';

/** One message in a project stream. */
export type StreamRecord =
  { kind: 'commit'; commit: Commit } | { kind: 'witness'; witness: Witness };

/** One message in the registry stream. */
export interface RegistryRecord {
  kind: 'project';
  projectId: string;
  accountId: string;
  /** Path of the project stream, relative to the Durable Streams base URL. */
  path: string;
  createdAt: string;
}

/** What the service needs from stream storage. */
export interface LedgerStore {
  /** Path of a project's stream. */
  projectPath(accountId: string, projectId: string): string;
  /** Creates the stream if it does not exist yet. */
  ensure(path: string): Promise<void>;
  /** True if the stream exists. */
  exists(path: string): Promise<boolean>;
  /** Every record in the stream, in order (empty if the stream does not exist). */
  readAll<T>(path: string): Promise<T[]>;
  /** Appends one record; `index` is its 0-based position in the stream. */
  append(path: string, record: unknown, index: number): Promise<void>;
  /** Path of the registry stream. */
  readonly registryPath: string;
}

/** Writer seq for record `index`: lexicographic order equals numeric order. */
export function writerSeq(index: number): string {
  return String(index).padStart(12, '0');
}

/** A {@link LedgerStore} over a Durable Streams server. */
export class DurableStreamsStore implements LedgerStore {
  readonly registryPath: string;
  private readonly base: string;
  private readonly handles = new Map<string, DurableStream>();

  constructor(
    baseUrl: string,
    private readonly opts: { prefix?: string; headers?: Record<string, string> } = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
    const prefix = (opts.prefix ?? 'longhand').replace(/^\/+|\/+$/g, '');
    this.registryPath = `/${prefix}/registry`;
    this.prefix = prefix;
  }

  private readonly prefix: string;

  projectPath(accountId: string, projectId: string): string {
    return `/${this.prefix}/projects/${encodeURIComponent(accountId)}/${encodeURIComponent(projectId)}`;
  }

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  private handle(path: string): DurableStream {
    let h = this.handles.get(path);
    if (!h) {
      h = new DurableStream({
        url: this.url(path),
        contentType: 'application/json',
        batching: false,
        ...(this.opts.headers ? { headers: this.opts.headers } : {}),
      });
      this.handles.set(path, h);
    }
    return h;
  }

  async exists(path: string): Promise<boolean> {
    try {
      const h = await this.handle(path).head();
      return h.exists !== false;
    } catch (e) {
      if (statusOf(e) === 404) return false;
      throw e;
    }
  }

  async ensure(path: string): Promise<void> {
    if (await this.exists(path)) return;
    try {
      await this.handle(path).create({ contentType: 'application/json' });
    } catch (e) {
      // Created concurrently with the same config: fine.
      if (statusOf(e) !== 409 || !(await this.exists(path))) throw e;
    }
  }

  async readAll<T>(path: string): Promise<T[]> {
    if (!(await this.exists(path))) return [];
    const res = await readStream<T>({
      url: this.url(path),
      live: false,
      json: true,
      ...(this.opts.headers ? { headers: this.opts.headers } : {}),
    });
    return (await res.json()) as T[];
  }

  async append(path: string, record: unknown, index: number): Promise<void> {
    await this.handle(path).append(JSON.stringify(record), { seq: writerSeq(index) });
  }
}

function statusOf(e: unknown): number | undefined {
  if (e && typeof e === 'object' && 'status' in e && typeof e.status === 'number') return e.status;
  return undefined;
}
