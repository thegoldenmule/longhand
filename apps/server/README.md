# @longhand/server

**Lane:** Server. The ledger service: the single enforcement point for "no word enters the manuscript unless a human input event put it there". Auth, ingest and validation, witnessing, Durable Streams storage, the Postgres read model and its migrations, SSE fan-out, the agent session runner, research and export endpoints.

```sh
docker compose up -d                       # Postgres on 5434
pnpm dev:setup                             # .dev/witness-key.pem
pnpm dev:server                            # = pnpm --filter @longhand/server dev
pnpm --filter @longhand/server test        # Vitest (integration tests need Postgres)
pnpm --filter @longhand/server test:live   # one real review with the claude CLI (LONGHAND_LIVE_CLAUDE=1)
pnpm --filter @longhand/server typecheck
pnpm --filter @longhand/server rebuild     # empty the Postgres read model and rebuild it from the streams
pnpm --filter @longhand/server migrate     # apply pending migrations
```

`dev` starts the Durable Streams reference server in-process (file-backed in `.dev/streams`, port 3300), runs the migrations and starts the service on port 3200. `start` does the same against an external `DURABLE_STREAMS_URL`; `streams` runs only the Durable Streams server. All of them read `.env` at the repo root; every variable is documented in `.env.example`. `MODEL_ADAPTER=mock` swaps the `claude` CLI for a canned script (comment, question, `finish_review`; a discuss answer), still through the real MCP tool server and relay.

## Architecture

```
browser ──HTTP/SSE──► Hono app (src/http) ──► LedgerService (src/service.ts)
                                                ├─ ProjectLedger per project (src/ledger/project.ts)
                                                │    fold state, chain, witnesses, step history, append lock
                                                │    └─► Durable Stream /longhand/projects/{account}/{project}
                                                ├─ ReadModel (Postgres, src/storage) — rebuildable
                                                └─ SessionManager (src/agent/sessions.ts)
                                                     runFeedbackSession / runDiscussSession (@longhand/agent)
                                                     └─ HttpAnnotationSink ──► POST /internal/sessions/:id/events
```

### Storage

- **One Durable Stream per project**, JSON mode. Its messages are `{kind:'commit', commit}` followed by `{kind:'witness', witness}`. Witnesses travel in the stream so the whole read model, witnesses included, is rebuildable from the streams.
- **A registry stream** (`/longhand/registry`) lists every project stream, since the protocol has no "list streams"; `rebuild` reads it.
- Every append carries `Stream-Seq` = the record's index, zero-padded, so a second writer can never interleave (the Durable Streams server answers 409). The service is the only writer.
- **On startup** the service reads the registry. Each project is folded from its stream on first use (`PRELOAD_PROJECTS=1` folds all at startup). The stream is verified with `verifyChain` before folding. A commit without a stored witness (a crash between the two appends) is witnessed on load.
- **Postgres** (`migrations/NNN_*.sql`, applied by `src/storage/db.ts` under an advisory lock) holds `projects` (keyed by `account_id`), `commits`, `witnesses`, `snapshots` (the folded `ProjectState` at head, every 50 commits and on shutdown), `documents`, `annotations` (one row per annotation-layer record), `agent_sessions`, and `session_tokens`. Everything except `session_tokens` is derived from the streams. Writes are queued per project and are idempotent upserts. `session_tokens` holds SHA-256 hashes of per-session secrets; secrets never enter the streams, so `rebuild` empties it (sessions do not survive a restart anyway).
- The snapshot is a read cache only. The fold's internal state is not serializable through `@longhand/ledger`'s public API, so writes always go through a fold of the stream.

### Ingest (per project, under one append lock)

1. **Dedupe** by `commitId`: a resend answers `duplicate` with the original seq (and version).
2. `validateDraft(state, draft, actor, { serverTime, accountId })`. The actor is the authenticated human on the public route; on the internal route it is the draft's agent (or system, for `FeedbackSessionFailed`) actor after the session checks below.
3. `appendToChain(head, draft, serverTime)` with the same `serverTime`; its hash must equal the validated commit's.
4. **Invariant before the append**: unless the commit is a human manuscript event, no existing document's node may change and a new document must start empty; a human manuscript event may change only its own document.
5. Store the commit in the stream.
6. **Invariant after the append**: the commit exactly as stored (a JSON round trip) is re-hashed, re-folded with `applyCommitWithSteps`, and checked again. A violation here **halts the project**: it is logged loudly as `INVARIANT VIOLATION`, every later write answers `503 project-halted`, and it is never reported as a client error.
7. Witness it (`signWitness`) and store the witness.
8. Fan out: listeners get `{commit, witness, update, state}`. `update` is the editor's `RemoteUpdate` for `TextEdited` and `ProposalAccepted`, whose steps are `validateDraft(...).derivedSteps[documentId]` (the fold's own steps, never the client payload for proposals). Per-document histories keep them for `fetchSince`. After a restart they are recovered by folding with `applyCommitWithSteps`.
9. After a **human** commit, append each `v.resolutions` entry as a system `SuggestionResolved` (BUILD.md: written after the triggering human commit). An annotation that is stale on arrival is already stale in the fold, so none is written after agent commits, matching the golden fixtures.

Clients send drafts with old `clientTime`s after an offline period. They are accepted, and `serverTime` is always assigned at ingest. `GET /bundle` lists `lateArrivals` (`serverTime − clientTime` > 2 min) for the report lane's unwitnessed intervals.

### Witnessing

- `Signer` is the schema's `WitnessSigner`. `DevFileSigner` reads a PKCS#8 PEM (`WITNESS_KEY_PATH`, default `.dev/witness-key.pem`). `KmsSigner` uses `@aws-sdk/client-kms` with an `ECC_NIST_P256` / `SIGN_VERIFY` key, signs `ECDSA_SHA_256` over the raw message, and converts KMS's DER signature to P1363 (`derToP1363`). `keyId` is the SHA-256 of the SPKI DER.
- One witness per commit, stored in the stream and in `witnesses`.
- **`ChainHeadWitnessed` cadence: after every 256 commits since the last embedded witness, and every 10 minutes when commits arrived since then** (`WITNESS_EMBED_EVERY_COMMITS`, `WITNESS_EMBED_INTERVAL_MS`). The embedded witness is a fresh signature over the head commit's subject. Rationale: dropping out-of-band witnesses becomes detectable within one window, at the cost of at most one extra commit per 256 commits or per active 10 minutes. A head that is already a `ChainHeadWitnessed` is not re-embedded, so an idle project gets no new commits.

### Agent sessions

- `POST /feedback` (or any `FeedbackRequested` appended through `POST /commits`, since the editor's `submitEvent` sends it there) appends the writer's draft, mints a session id and a 256-bit token, and runs `runFeedbackSession` with `ClaudeCliAdapter` (or the mock) and an `HttpAnnotationSink` pointed at this service's own `/internal/sessions/:id/events`. A selection scope is passed as `selection` from `state.annotations.feedbackRequests[id].scope`, already mapped to the current version by the fold. `DiscussRequested` works the same way with `runDiscussSession`. One session per request id (per `DiscussRequested` commit for discuss).
- Progress streams over `GET /sessions/:id/events` (the agent's `SessionProgressEvent`s as they are, replayed from the start, then `ended`).
- **Cancel** (`POST /sessions/:id/cancel`) marks the session `cancelling`, so only `FeedbackSessionFailed` is accepted, then aborts the run at once (both model adapters honour a signal that is already aborted when their run starts). If the runner could not record the end, the supervisor appends `FeedbackSessionFailed` itself.
- **Shutdown** cancels every running session and waits up to 15 s while the internal route stays up, so the runners' `FeedbackSessionFailed` lands. Public routes answer 503 meanwhile. A session left `running` by a crash is failed with a system `FeedbackSessionFailed` when its project is next loaded.
- Models: `AGENT_MODEL_FULL` (default `opus`) for document and project reviews, `AGENT_MODEL_QUICK` (default `sonnet`) for selections and discuss.

## API reference

All `/v1` routes need auth and are scoped by `accountId`. A project of another account answers 404. Errors are `{"ok": false, "error": {"code", "message"}}`.

| Route                                                                       | What                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                                              | `{ok: true}`                                                                                                                                                                                                                                                                                                                           |
| `GET /.well-known/longhand-witness-key`                                     | `{keyId, publicKeyPem, algorithm, signatureEncoding, message}` (no auth)                                                                                                                                                                                                                                                               |
| `GET /v1/me`                                                                | `{accountId, actorId, authMode}`                                                                                                                                                                                                                                                                                                       |
| `GET /v1/projects`                                                          | `{projects: [{projectId, accountId, title, createdAt, headSeq, headHash, updatedAt}]}`                                                                                                                                                                                                                                                 |
| `POST /v1/projects`                                                         | `{title, projectId?, deviceId?, sessionId?}` or `{draft}` (the client's own `ProjectCreated`) → 201 `{projectId, seq: 1, duplicate}`. 409 `project-exists` for an id already taken.                                                                                                                                                    |
| `GET /v1/projects/:pid`                                                     | `{project: {projectId, accountId, title, headSeq, headHash, halted}}`                                                                                                                                                                                                                                                                  |
| `GET /v1/projects/:pid/state`                                               | `{headSeq, headHash, state: ProjectState}`                                                                                                                                                                                                                                                                                             |
| `GET /v1/projects/:pid/commits?after=&limit=`                               | `{headSeq, commits}` (limit ≤ 5000)                                                                                                                                                                                                                                                                                                    |
| `POST /v1/projects/:pid/commits`                                            | CommitTransport `submit`. Body: a `CommitDraft`. 200 `{status:'ack'\|'duplicate', seq, version?}` · 409 `{status:'conflict', currentVersion, code}` (`stale-base-version` / `future-base-version`) · 403 `{status:'rejected', code:'actor-mismatch'\|'actor-not-permitted', reason}` · 422 `{status:'rejected', code, reason, errors}` |
| `GET /v1/projects/:pid/documents/:did/updates?since=v`                      | CommitTransport `fetchSince`: `{kind:'updates', updates: RemoteUpdate[], version}` (every step-bearing commit with `baseVersion >= v`, fold-derived steps for `ProposalAccepted`), or `{kind:'snapshot', doc, version}` when `v` is not a commit boundary or is ahead                                                                  |
| `GET /v1/projects/:pid/documents/:did/stream?since=v`                       | CommitTransport `subscribe` (SSE): `update` events (`RemoteUpdate`, id = seq) in ledger order, own commits included. With `since`, the backlog first (or a `snapshot` event).                                                                                                                                                          |
| `GET /v1/projects/:pid/events?after=seq`                                    | SSE of every commit (`commit` events, id = seq) in ledger order; default live only; honours `Last-Event-ID`                                                                                                                                                                                                                            |
| `POST /v1/projects/:pid/feedback`                                           | `{draft: FeedbackRequested}` → 201 `{status, seq, sessionId}` (200 for a duplicate request, with the same session)                                                                                                                                                                                                                     |
| `POST /v1/projects/:pid/discuss`                                            | `{draft: DiscussRequested}` → 201 `{status, seq, sessionId}`                                                                                                                                                                                                                                                                           |
| `GET /v1/projects/:pid/sessions/:sid`                                       | `{session: {id, kind, requestId, threadId, phase, ended, folded}}`                                                                                                                                                                                                                                                                     |
| `GET /v1/projects/:pid/sessions/:sid/events`                                | SSE: `started`, `model`, `annotation`, `finished` / `failed`, then `ended` `{status, reason}`                                                                                                                                                                                                                                          |
| `POST /v1/projects/:pid/sessions/:sid/cancel`                               | Cancels; returns once the end is recorded                                                                                                                                                                                                                                                                                              |
| `GET /v1/research/search?q=&limit=`                                         | `{candidates: SurfacedCandidate[]}` from `createSourceSearch` (the same `SourceSearch` the sessions get)                                                                                                                                                                                                                               |
| `GET /v1/research/page?url=`                                                | Page-metadata proxy for the browser's `pageFetch`: the page's HTML with its status, or 400 `blocked-url` (SSRF guard below)                                                                                                                                                                                                            |
| `GET /v1/projects/:pid/export?format=md\|docx\|pdf&documents=a,b&style=apa` | Download via `exportFile`, with the research lane's CSL renderer injected                                                                                                                                                                                                                                                              |
| `POST /v1/projects/:pid/export`                                             | `{format, documentIds?, style?, author?, provenance?: ProvenanceSummary}` (the provenance appendix comes from the report lane)                                                                                                                                                                                                         |
| `GET /v1/projects/:pid/bundle`                                              | `{projectId, accountId, headSeq, headHash, commits, witnesses, publicKeyPem, keyId, unwitnessedSeqs, lateArrivals}`: the raw pieces the report lane builds the bundle on                                                                                                                                                               |
| `POST /internal/sessions/:id/events`                                        | The AnnotationSink HTTP contract (`packages/agent/README.md`), below                                                                                                                                                                                                                                                                   |

`EventSource` cannot send headers, so SSE routes also accept `?access_token=`. `@longhand/client` uses fetch-based SSE with the header.

### `POST /internal/sessions/:id/events`

In order, exactly as the agent README specifies:

1. **Authenticate.** Unknown session: 404 `unknown-session`. A missing or wrong bearer token, compared in constant time against the SHA-256 the service keeps: 401 `unauthorized`. A draft for another project: 403 `forbidden`.
2. **Dedupe.** A known `commitId` answers 200 `{seq, duplicate: true}`.
3. **Validate.** `CommitDraftSchema`: 400 `invalid-draft`. A type not allowed for the session kind (review: annotation types plus `ReviewFinished`; discuss: `DiscussAnswered`), the wrong actor kind, an envelope `sessionId` other than the session (or `system` for `FeedbackSessionFailed`), or a payload `feedbackSessionId` other than the path id: 403 `forbidden`.
4. **Order.** Annotations before `FeedbackSessionStarted` get 409 `session-not-started`. A second `FeedbackSessionStarted` gets 409. After `ReviewFinished`, `DiscussAnswered` or `FeedbackSessionFailed`, or once cancelled, the answer is 409 `session-closed`. `FeedbackSessionStarted` must name the session's request or thread.
5. **Positions** (`src/ledger/positions.ts`). Anchors, spans, insertion points, moves, splits and merges are re-resolved against the document at `readVersion` with the schema's resolvers; an unresolvable one is 422 with the resolver code (`quote-not-found`, `unknown-sentence`, …). Positions that differ from the resolution are 422 `target-mismatch`, and an unknown or future `readVersion` is 422 `invalid-version`. They are then mapped through every step since `readVersion` (ranges: `from` right, `to` left, clamped; points by side), and `version` is rewritten to the current version, under the lock. A draft already at the current version is accepted only if its positions equal that mapping.
6. **Caps.** `capViolation(toolForDraft(draft), folded counts, intensity)`: 422 `cap-reached`.
7. **Append** and witness. Fold-level refusals are 422 with the ledger's code.

200 `{"ok": true, "seq", "commitId", "duplicate"}`.

### SSRF guard (`src/research/ssrf.ts`)

`http:`/`https:` only; no credentials; ports 80, 443, 8080 and 8443 only. `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa` and dotless hosts are refused. Every resolved address must be public: loopback, RFC 1918, CGNAT, link-local (cloud metadata), multicast, documentation, benchmarking, reserved, ULA, and IPv4-mapped/NAT64 forms are refused. The check runs inside the socket `lookup`, so the connection goes to the checked address (no DNS-rebinding window). Redirects are followed by hand (at most 5), and every hop is re-checked. Responses are limited to 2 MB, 10 s and HTML/XHTML.

### Auth

- `AUTH_MODE=dev` gives a fixed principal (`DEV_ACCOUNT_ID`, `DEV_USER_ID`) and makes no external calls.
- `AUTH_MODE=cognito` verifies `Authorization: Bearer` JWTs with `aws-jwt-verify` (`COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_TOKEN_USE`). `accountId` is `custom:accountId` when present, else `sub`; the human actor id is `sub`.

## Exports

`startServer(options)` / `startFromConfig(config)` → `ServerHandle {url, port, service, close(), closeHttpOnly()}`; `LedgerService`; `ProjectLedger`; `ProjectHistory` / `DocHistory`; `remapAgentDraft`; `SessionManager`, `adapterFactory`, `mockScript`; `DevFileSigner`, `KmsSigner`, `derToP1363`; `DevAuthenticator`, `CognitoAuthenticator`; `DurableStreamsStore`; `openDb`, `migrate`, `ReadModel`; `fetchPublicPage`, `validatePublicUrl`, `isPrivateAddress`; `cslFormatters`, `exportInputFor`, `renderExport`; `createApp`; `loadConfig`.

`@longhand/server/testing` exports `startTestServer(opts)`: a real service on a random port with its own Postgres schema and its own Durable Streams server on a random port, with `restart({crash?})` and `close()`. Integration tests, the client package and later e2e suites use it.

## Tests

Integration tests use the real Postgres on 5434 (one schema per test) and a real Durable Streams server per test on a random port. Without Postgres they are skipped with a warning; set `LONGHAND_REQUIRE_DB=1` to make that fatal.

| File                 | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures.test.ts`   | Every golden fixture replayed through HTTP: human drafts through `POST /commits`, agent drafts through the internal endpoint in the agent's form (positions at `readVersion`, which the service maps), `SuggestionResolved` produced by the service. Checks that the folded state equals `expected.state`, the stored chain is byte-identical, the witnesses verify (stream and Postgres), and `fetchSince` replays every document to its content with exact step counts.                                                                             |
| `rejections.test.ts` | Agent `TextEdited` on both routes; forged actor; stale and future `baseVersion` (409 with `currentVersion`); session auth (unknown, wrong token, another session's token, another project); ordering; unresolvable anchors (`quote-not-found`, `unknown-sentence`, `target-mismatch`, `invalid-version`); mapping across a concurrent edit; caps; closed session; discuss types. A fast-check property fires random agent drafts (manuscript types, bad anchors, forged actors, garbage) and checks that manuscript text and provenance never change. |
| `restart.test.ts`    | Crash and restart give identical state and bundle; writes continue at the right writer seq; `rebuild` reproduces every read-model table; the `ChainHeadWitnessed` cadence and interval tick.                                                                                                                                                                                                                                                                                                                                                          |
| `feedback.test.ts`   | Mock e2e: request in, annotations over project SSE in seq order, `ReviewFinished`, finished session; duplicate request; selection mapped by the fold; Discuss; cancel; shutdown; crash-orphaned sessions.                                                                                                                                                                                                                                                                                                                                             |
| `live.test.ts`       | Skipped unless `LONGHAND_LIVE_CLAUDE=1`: a real light sonnet selection review through the whole service.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `signer.test.ts`     | `DevFileSigner`; `derToP1363` against 200 Node signatures plus edge cases; `KmsSigner` with a mocked KMS client, verified with WebCrypto.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `auth.test.ts`       | Cognito with a locally signed JWKS (valid, `custom:accountId`, expired, wrong issuer, client, token use or key); account scoping of every route over HTTP.                                                                                                                                                                                                                                                                                                                                                                                            |
| `ssrf.test.ts`       | Address classification, URL rules, private resolution, redirects to private hosts, size and type limits, the proxy route, search.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `export.test.ts`     | The CSL adapter (citeproc text and italic spans); Markdown, DOCX and PDF downloads of the research fixture.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Contract changes needed

- **`pnpm-workspace.yaml`** (outside this lane): `@durable-streams/server` depends on `lmdb`, which pulls in `msgpackr-extract`. pnpm 11 turns their ignored build scripts into a failing `pnpm install`, and its deps check before every `pnpm run` fails too. Add the following (prebuilt binaries load without the scripts; verified locally):
  ```yaml
  allowBuilds:
    esbuild: true
    lmdb: false
    msgpackr-extract: false
  ```
  Until then, run scripts with `pnpm --config.verify-deps-before-run=false <script>`.
- **CI**: the server and client integration tests need Postgres. Add a `postgres:16` service on 5434 (user, password and database `longhand`) and `LONGHAND_REQUIRE_DB=1`; without it they are skipped.
- Optional (`@longhand/ledger`): a serializable fold state (`serializeState` / `deserializeState`). It would let Postgres snapshots skip the full re-fold at startup.

## Known gaps

- Per-document step history (nodes after every commit, with structural sharing) and every commit stay in memory for each loaded project. There is no eviction yet.
- `fetchSince` for a version that is not a commit boundary answers a snapshot.
- If the service crashes between appending a `FeedbackRequested` and starting its session, the request stays `pending`. It is not retried.
- `ChainHeadWitnessed` re-signs the head subject; it does not reuse the stored witness signature.
- The SSRF guard allows ports 80, 443, 8080 and 8443 only.
- Sessions are in-process. Running several service instances against one stream is prevented by `Stream-Seq`, but there is no failover.
