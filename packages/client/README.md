# @longhand/client

**Lane:** Server. A browser and Node client for the ledger service (`apps/server`): `HttpCommitTransport`, the editor's `CommitTransport`; typed methods for every route; and an SSE helper that can send an `Authorization` header. The web app uses this package.

```sh
pnpm --filter @longhand/client test        # against a real service (needs Postgres on 5434)
pnpm --filter @longhand/client typecheck
```

## Usage

```ts
import { LonghandClient, HttpCommitTransport } from '@longhand/client';

const client = new LonghandClient({
  baseUrl: 'http://localhost:3200',
  token: async () => session?.accessToken ?? null, // omit in AUTH_MODE=dev
});
const { projectId } = await client.createProject({ title: 'Salt and Iron' });
const { state } = await client.getState(projectId);

const transport = new HttpCommitTransport({ client, projectId, onAuthError: () => refreshLogin() });
<LonghandEditor projectId={projectId} documentId={id} transport={transport} doc={state.documents[id].content} version={state.documents[id].version} … />;

// Annotation cards stream in:
const sub = client.subscribeProject(projectId, (commit) => apply(commit), { after: state.headSeq });

// Feedback:
const { sessionId } = await client.requestFeedback(projectId, feedbackRequestedDraft);
client.subscribeSession(projectId, sessionId, (e) => showProgress(e)); // started, model, annotation, finished|failed, ended

// Research pageFetch for @longhand/research:
createMetadataClient({ fetch, pageFetch: client.pageFetch, userAgent: null });
```

## `HttpCommitTransport`

| Method                                | Route                                  | Behaviour                                                                                                                                                                                                                                                                               |
| ------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit(draft)`                       | `POST /v1/projects/:pid/commits`       | 200 → `ack` / `duplicate` (with `version`); 409 → `conflict` with `currentVersion`; 401, 408, 425, 429 and 5xx → `offline` (the editor keeps the draft queued and retries; 401 also calls `onAuthError`); a network error → `offline`; other 4xx → `rejected` with the service's reason |
| `subscribe(documentId, listener)`     | `GET …/documents/:did/stream` (SSE)    | Every step-bearing commit of the document in ledger order, this client's own included. It reconnects with exponential backoff and jitter, and resumes with `since=<last delivered version>`, so a restart of the service loses nothing. Replays are dropped by seq.                     |
| `fetchSince(documentId, v)`           | `GET …/documents/:did/updates?since=v` | `{kind:'updates', updates, version}` or `{kind:'snapshot', doc, version}`. It throws on network errors and goes `offline`.                                                                                                                                                              |
| `connection()` / `onConnectionChange` |                                        | `offline` after a network failure or a dropped stream; `online` after any successful request or stream open. It also follows the browser's `online` and `offline` events.                                                                                                               |
| `dispose()`                           |                                        | Removes the browser listeners.                                                                                                                                                                                                                                                          |

The wire types (`SubmitResult`, `RemoteUpdate`, `CatchUp`, `CommitTransport`, …) mirror `packages/editor/src/sync/transport.ts` structurally, so this package does not depend on the editor (or on React). A test checks that `HttpCommitTransport` is assignable to the editor's `CommitTransport`.

## `LonghandClient`

| Method                                                                                             | Route                                                                        |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `me()`                                                                                             | `GET /v1/me`                                                                 |
| `listProjects()`, `createProject({title} \| {draft})`, `getProject(id)`                            | `/v1/projects`                                                               |
| `getState(id)`                                                                                     | `GET …/state` → `{headSeq, headHash, state}`                                 |
| `getCommits(id, after, limit)`                                                                     | `GET …/commits`                                                              |
| `fetchSince(id, documentId, version)`                                                              | `GET …/documents/:did/updates`                                               |
| `subscribeProject(id, listener, {after})`                                                          | SSE `…/events`; it resumes after the last delivered seq                      |
| `subscribeDocument(id, documentId, {since, onUpdate, onSnapshot})`                                 | SSE `…/documents/:did/stream`                                                |
| `requestFeedback(id, draft)`, `requestDiscuss(id, draft)`                                          | `POST …/feedback`, `POST …/discuss` → `{status, seq, sessionId}`             |
| `getSession`, `cancelSession`, `subscribeSession`, `waitForSession`                                | `…/sessions/:sid`                                                            |
| `searchSources(query, limit)`                                                                      | `GET /v1/research/search`                                                    |
| `pageFetch`                                                                                        | A `fetch` that goes through `GET /v1/research/page` (the SSRF-guarded proxy) |
| `exportProject(id, {format, documentIds?, style?, author?, provenance?})`, `exportUrl(id, format)` | `…/export` → `{bytes, mimeType, filename}`                                   |
| `bundle(id)`                                                                                       | `GET …/bundle`: commits, witnesses, public key and keyId                     |
| `witnessKey()`                                                                                     | `GET /.well-known/longhand-witness-key`                                      |
| `raw(method, path, body?)`, `json(method, path, body?)`                                            | Anything else. `json` throws `ApiError {status, code, message, body}`.       |

`subscribeSse({url, headers, onEvent, onOpen, onError, backoff, fatalStatuses})` is the SSE helper underneath. It sends `Last-Event-ID`, does not retry on 400, 401, 403 or 404, and takes `url` as a function so each reconnect can resume from a new point.

## Tests

`src/transport.test.ts` runs against `@longhand/server/testing` (a real service with a real Postgres schema and a real Durable Streams server):

- submit ack with version, duplicate, rejected (bad step, forged actor);
- a two-device conflict: `conflict` with `currentVersion`, a `fetchSince` catch-up, a collab-style rebase and resubmit, and the merged text;
- a snapshot for an unknown version;
- SSE ordering of five commits from two transports, own commits included, across a service restart (seq order, contiguous versions, no duplicates, `offline` then `online`);
- the project event stream;
- offline behaviour against a dead port;
- every other API method.

## Known gaps

- One SSE connection per `subscribe` call. A shared per-project stream would save connections when many documents are open.
- No retry on `fetchSince`; the editor's sync engine retries.
- `exportUrl` works as a plain link only in dev auth, or with `?access_token=`.
