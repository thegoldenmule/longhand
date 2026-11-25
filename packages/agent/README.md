# @longhand/agent

**Lane:** Agent. The AI editor's backend: the context builder, the system prompts, the annotation-tool MCP server with validation and caps, the annotation sinks, the model adapters (`claude -p` and a mock), and the session runner.

Nothing in this package can emit a manuscript event. It builds only agent annotation drafts plus the system `FeedbackSessionFailed`. That is enforced three times: every tool maps to one annotation event type (`TOOLS[name].emits`), the session relay refuses any other type, and drafts are checked with `CommitDraftSchema`, which enforces actor permissions.

```sh
pnpm --filter @longhand/agent test        # vitest (no live model)
pnpm --filter @longhand/agent typecheck
pnpm --filter @longhand/agent test:live   # one real sonnet review via the local claude CLI (~$0.03)
pnpm --filter @longhand/agent exec tsx scripts/record-stream-fixture.ts   # re-record src/__fixtures__/claude-stream.ndjson
```

## How a session runs

```
runFeedbackSession / runDiscussSession                  (your process)
  ├─ buildReviewContext / buildDiscussContext  → system prompt + user prompt + SessionSnapshot
  ├─ sink.append(FeedbackSessionStarted)   (with systemPromptVersion)
  ├─ SessionRelay on 127.0.0.1:<random>  (same events contract as the ledger, plus /search)
  ├─ temp dir (0700): tool-server.json (snapshot + relay token), mcp.json
  └─ adapter.run
       ClaudeCliAdapter: claude -p … --mcp-config mcp.json         (child process)
         └─ node --import tsx src/mcp/main.ts --config tool-server.json   (MCP stdio server)
              ToolExecutor validates each call → HttpAnnotationSink → relay → your AnnotationSink
       MockModelAdapter: starts the same MCP server and replays scripted calls
  └─ ReviewFinished / DiscussAnswered accepted → finished; otherwise sink.append(FeedbackSessionFailed)
```

The MCP server is a child of the CLI, so it can't call the runner's in-process sink or `SourceSearch`. It posts to the runner's loopback **relay** instead. The relay re-validates every draft (schema, actor, session, project, allowed type for the session kind, caps, closed session) and then forwards it to the injected sink. In production that sink is either an in-process appender or `HttpAnnotationSink` pointed at the ledger service.

## Public API

| Export                                                                                                                      | What                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runFeedbackSession(opts)`                                                                                                  | Runs a review for a `FeedbackRequested` payload. `opts`: `state`, `request`, `sink`, `adapter`, `search?`, `feedbackSessionId?`, `model?`, `models?`, `selection?`, `timeoutMs?`, `finishGraceMs?`, `signal?`, `onProgress?`, `now?`, `newId?`, `tmpRoot?`, `keepTempFiles?`, `context?`. Returns `SessionOutcome`. Never throws for model or sink failures. |
| `runDiscussSession(opts)`                                                                                                   | The same for a `DiscussRequested` payload. Only the read tools and `answer_discussion` are offered.                                                                                                                                                                                                                                                          |
| `SessionOutcome`                                                                                                            | `{status: 'finished' \| 'failed', feedbackSessionId, model, reason, startedSeq, failedSeq, annotations, rejectedCalls, run, context, warnings}`                                                                                                                                                                                                              |
| `SessionProgressEvent`                                                                                                      | `started` · `model` (every parsed CLI event: tool calls, results, text, usage) · `annotation` (an accepted draft and its seq, as it arrives) · `finished` · `failed`                                                                                                                                                                                         |
| `DEFAULT_MODELS`, `modelForRequest`                                                                                         | `opus` for document and project reviews, `sonnet` for selection passes and discuss replies. Override with `models` or `model`.                                                                                                                                                                                                                               |
| `DEFAULT_TIMEOUTS`                                                                                                          | Wall clock: full review 15 min, selection 5 min, discuss 3 min.                                                                                                                                                                                                                                                                                              |
| `buildReviewContext`, `buildDiscussContext` → `PromptContext`                                                               | `{systemPrompt, systemPromptVersion, prompt, sections, model, snapshot, warnings}`                                                                                                                                                                                                                                                                           |
| `REVIEW_SYSTEM_PROMPT_V1`, `DISCUSS_SYSTEM_PROMPT_V1`, `SYSTEM_PROMPT_VERSION`, `systemPrompt(kind)`                        | The versioned prompts in `src/prompts/v1.ts`.                                                                                                                                                                                                                                                                                                                |
| `ToolExecutor`                                                                                                              | Validates and executes one session's tool calls against a `SessionSnapshot`. Serializes calls. `call(name, args) → ToolCallOutcome`.                                                                                                                                                                                                                         |
| `createAnnotationMcpServer(executor)`, `MCP_SERVER_NAME` (`longhand`), `MCP_TOOL_PREFIX` (`mcp__longhand__`)                | The MCP server. It exposes exactly `toolsForSession(kind)` with the schema's descriptions and `TOOL_JSON_SCHEMAS`.                                                                                                                                                                                                                                           |
| `toolServerLaunch(configPath)`, `mcpConfigJson(launch)`, `ToolServerConfig`, `TOOL_SERVER_ENTRY`                            | How to start the stdio server and the `--mcp-config` JSON.                                                                                                                                                                                                                                                                                                   |
| `AnnotationSink`, `AppendResult`, `SinkError`                                                                               | The sink interface (contract below).                                                                                                                                                                                                                                                                                                                         |
| `HttpAnnotationSink`, `interpretResponse`, `sessionEventsPath`                                                              | The HTTP sink.                                                                                                                                                                                                                                                                                                                                               |
| `InMemoryAnnotationSink`                                                                                                    | For tests: validates, dedupes by `commitId`, assigns seqs, can `reject` chosen drafts. `ofType(type)`.                                                                                                                                                                                                                                                       |
| `SessionRelay`, `RelaySourceSearch`, `toolForDraft`                                                                         | The loopback relay and its search client.                                                                                                                                                                                                                                                                                                                    |
| `SourceSearch`, `StaticSourceSearch`, `toCandidates`                                                                        | The schema's `interface SourceSearch { search(query: string, limit: number): Promise<SurfacedCandidate[]> }` (re-exported), implemented by the research lane; candidates carry their own `provider` and `url`. `toCandidates` drops invalid candidates and caps the count.                                                                                   |
| `ClaudeCliAdapter`, `buildClaudeArgs`, `ISOLATION_ARGS`, `defaultClaudeCommand`                                             | The CLI adapter.                                                                                                                                                                                                                                                                                                                                             |
| `MockModelAdapter`, `MockStep`, `MockScript`                                                                                | Scripted model: `{tool, input}`, `{text}`, `{fail}`, `{hang: true}`, `{delayMs}`.                                                                                                                                                                                                                                                                            |
| `StreamJsonParser`, `parseStreamJson`, `eventsFromMessage`, `ModelEvent`, `ModelAdapter`, `ModelRunInput`, `ModelRunResult` | stream-json parsing and adapter types.                                                                                                                                                                                                                                                                                                                       |
| `agentDraft`, `sessionFailedDraft`, `AGENT_EVENT_TYPES`, `TOOL_EVENT_TYPES`, `SinkDraft`, `ToolEventDraft`                  | Draft builders and types.                                                                                                                                                                                                                                                                                                                                    |
| `buildSnapshot`, `resolveScope`, `binderOutline`, `manuscriptOrder`, `DocumentCache`, `SessionSnapshot`, `SnapshotScope`    | The serializable slice of `ProjectState` a session validates against.                                                                                                                                                                                                                                                                                        |
| `renderSegmented`, `renderBlock`, `renderOutline`, `renderPlain`                                                            | The text renderings the model reads. The prompt and `read_document` share them, so ids always agree.                                                                                                                                                                                                                                                         |

## The context

The prompt is ordered stable-first so the CLI's prompt cache can reuse prefixes: the system prompt, then the project, the target text, nearby documents, the feedback history and finally this request.

- **Project:** title, genre, audience, goals, style notes, and the binder outline (folders, documents with ids, word counts and synopses, then notes).
- **Target text,** segmented by the schema's segmenter, one block per line:
  ```
  <document id="ch1" title="Chapter 1" version="7" words="50">
  [p1 · heading 1] [p1.s1] The Storm
  [p2] [p2.s1] The rain fell sideways. [p2.s2] Nobody came to the door.
  [p6 · in blockquote] [p6.s1] Some quoted words stand here.
  [scene break]
  [fn1 · footnote in p2] [fn1.s1] See the archive.
  </document>
  ```
  - **Selection:** the selected blocks in full, their neighbours marked `(context)`, and `[…]` for the rest.
  - **Document:** the whole document.
  - **Project:** every manuscript document in binder order, within `maxTargetChars` (default 300k). Documents that don't fit are listed for `read_document`.
  - Hard breaks show as `↵`.
- **Nearby documents:** two before and two after in binder order, as title plus the writer's synopsis. No model call is made to summarize.
- **Feedback history:** the 40 most recent past annotations for the target documents, each with its outcome (`dismissed: not my voice`, `rejected: wrong`, `adopted`, `stale`…), plus the last two review summaries.
- **The request:** scope, lenses, intensity with the exact caps, and the writer's ask.

## Tool validation

For every call, in order:

1. The session is not finished.
2. The tool is offered for this session kind.
3. The zod input schema passes.
4. `capViolation` passes.
5. The document exists, is manuscript and is in scope, and the anchor, span, move, insertion point, split or merge resolves against the snapshot.
6. The target overlaps the selection, when the scope is a selection.
7. `rephraseGuidanceViolation` passes (rephrase hints only), the source is in the library (`suggest_source`), and the thread is the session's thread (`answer_discussion`).
8. The draft passes `CommitDraftSchema`.
9. The sink accepts it.

A rejected call returns `isError: true` with `Rejected (<code>): <message for the model>`, and the model fixes the call and retries. A success returns the new id and the remaining budget. Rejected calls don't count toward caps. `search_sources` with no results records no event, but counts as a search.

Positions in drafts are resolved at the snapshot version: `readVersion === version === snapshot document version`.

## AnnotationSink HTTP contract (for the ledger service)

`HttpAnnotationSink` implements the client side of this endpoint, and the server lane implements the server side. The runner's relay serves the same contract on loopback.

### Request

```
POST {baseUrl}/internal/sessions/{feedbackSessionId}/events
Authorization: Bearer {sessionToken}
Content-Type: application/json

<one CommitDraft as JSON>
```

- `sessionToken` is a per-session secret the ledger service issues when it decides to start a session. It authorizes drafts for that `feedbackSessionId` only. Pass the same id to the runner as `feedbackSessionId`.
- The body is a `CommitDraft` that satisfies `CommitDraftSchema` from `@longhand/schema`:
  ```
  { commitId,        // UUID chosen by the agent: the idempotency key
    projectId,
    clientTime,      // Date#toISOString()
    actor,           // {kind: 'agent', id: <model alias>}, or {kind: 'system', id: 'agent-runner'} for FeedbackSessionFailed
    deviceId,        // 'server'
    sessionId,       // = feedbackSessionId, or 'system' for FeedbackSessionFailed
    type, schemaVersion: 1, payload }
  ```
- These types are allowed: `FeedbackSessionStarted`, `CommentAdded`, `QuestionAsked`, `SuggestionProposed`, `MoveProposed`, `CutProposed`, `SplitProposed`, `MergeProposed`, `CitationNeededFlagged`, `SourceSurfaced`, `SourceSuggested`, `ReviewFinished`, `DiscussAnswered` (all agent), and `FeedbackSessionFailed` (system).
  - In a discuss session, only `FeedbackSessionStarted`, `DiscussAnswered` and `FeedbackSessionFailed` are allowed.
  - In a review session, `DiscussAnswered` is not allowed.
- Every payload `feedbackSessionId` equals the path id. The one exception is `FeedbackSessionFailed`, which may carry `null` when the session never started.

### What the service must do, in order

1. **Authenticate.** The token must match the path's session and the draft's `projectId` must be the session's project. Otherwise answer `401 unauthorized` or `403 forbidden`. Unknown session: `404 unknown-session`.
2. **Dedupe.** If `commitId` was already appended, answer `200` with the original `seq` and `duplicate: true`.
3. **Validate.** Parse with `CommitDraftSchema` (`400 invalid-draft`). Check the type is allowed for this session kind (`403 forbidden`).
4. **Order.**
   - `FeedbackSessionStarted` comes first and only once.
   - After `ReviewFinished`, `DiscussAnswered` or `FeedbackSessionFailed`, the session is closed: answer `409 session-closed`.
5. **Positions.**
   - Every anchor, span, point, split and merge in the payload carries `readVersion`, and `from`/`to`/`pos`/`joinPos` resolved at `readVersion`, with `version === readVersion`.
   - Re-resolve the anchor or span against the document at `readVersion`. If it doesn't resolve, or gives different positions, answer `422` with the anchor error code (`quote-not-found`, `unknown-sentence`, …).
   - Under the append lock, map the positions to the current version, rewrite `from`/`to`/`pos`/`joinPos` and `version`, and let the fold mark the annotation stale on arrival if its text changed.
6. **Caps (recommended).** Recount the session's accepted annotations with `countCall` and `capViolation` from `@longhand/schema`. If exceeded, answer `422 cap-reached`.
7. **Append** and witness the commit.

### Responses

```
200 {"ok": true, "seq": 123, "commitId": "<commitId>", "duplicate": false}
4xx {"ok": false, "error": {"code": "<code>", "message": "<text>"}}
```

- The client shows a 4xx `message` to the model as `The ledger did not record it (<code>): <message>`, so word it for the model.
- `409 session-closed` makes the tool server treat the session as finished.
- The client does not retry 4xx.
- The client retries 5xx, 429 and network errors up to 3 attempts with backoff (200 ms, then 400 ms), sending the same body and `commitId`. Request timeout: 15 s.

### Relay-only endpoint

`POST /internal/sessions/{id}/search` takes `{query, limit}` and returns `{ok: true, candidates: SurfacedCandidate[]}`. The ledger service does not need to implement it.

## The CLI

```
claude -p --output-format stream-json --verbose --tools "" --strict-mcp-config
  --mcp-config <session>/mcp.json --allowedTools "mcp__longhand__*" --no-session-persistence
  --system-prompt <prompt> --model <model> --setting-sources project
```

- These are the BUILD.md flags plus `--setting-sources project` (`ISOLATION_ARGS`, on by default; turn it off with `isolateSettings: false`).
  - Without it, the machine's user-level hooks run inside the headless session. The recorded `claude-stream-retry.ndjson` shows a `SessionStart` hook firing.
  - The run's cwd is a private temp dir, so there are no project settings either.
  - Authentication still works.
- The user prompt goes on **stdin**, because the variadic `--mcp-config` and `--allowedTools` flags would swallow a positional prompt.
- Verified against `claude` 2.1.331:
  - the init message lists only the 16 `mcp__longhand__*` tools;
  - `mcp__longhand__*` auto-allows them, with no permission denials.
- The adapter checks the init message and stops the run if the `longhand` server didn't connect. It enforces the wall-clock timeout with SIGTERM, then SIGKILL after 5 s. It honours an `AbortSignal`.
- Once the finish tool is accepted, the runner gives the model `finishGraceMs` (default 60 s) to end its turn before stopping it.
- The executable comes from `command`, then `$LONGHAND_CLAUDE_BIN`, then `~/.local/bin/claude`, then `claude` on PATH.

## Tests

| File               | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.test.ts`  | Prompt sections and order; segmented ids match the segmenter; selection, document and project scopes; clamping; history outcomes; discuss context                                                                                                                                                                                                                                                                                                                                                                                |
| `executor.test.ts` | Every tool's validation: unknown sentences, quotes, documents and sources; ambiguous and out-of-range occurrence; out-of-scope and note targets; over-long bodies, questions, rationales and claims; word-choice word limits; multi-sentence and over-40-word insertions; rephrase replacement text; non-contiguous, nested and self-destination moves; invalid splits and merges; caps per intensity (light 5 items, insertions, questions, the hard 15 suggestions); parallel calls; sink rejection; read tools; discuss tools |
| `mcp.test.ts`      | The real stdio server, spawned and driven by an MCP client: the tool list equals `toolsForSession` with the schema's JSON Schemas; a rejected call and its corrected retry; search through the relay; `finish_review` closes the session                                                                                                                                                                                                                                                                                         |
| `sink.test.ts`     | HTTP sink: path, bearer, status mapping, retries with the same `commitId`, unreachable server. In-memory sink. The relay refuses manuscript and foreign drafts, enforces caps, dedupes and closes.                                                                                                                                                                                                                                                                                                                               |
| `runner.test.ts`   | `MockModelAdapter` end to end: retries, caps, selection model and scope, no `finish_review`, timeout, post-finish grace, cancel, model error, unservable scope, a refused start, search, discuss                                                                                                                                                                                                                                                                                                                                 |
| `adapters.test.ts` | The stream-json parser on two recorded real CLI runs (`src/__fixtures__/*.ndjson`) and on arbitrary chunk boundaries. `ClaudeCliAdapter` against a fake `claude` (`fake-claude.mjs`): exact argv, stdin prompt, events, timeout kill, abort, crash, missing binary, failed MCP server                                                                                                                                                                                                                                            |
| `live.test.ts`     | Skipped unless `LONGHAND_LIVE_CLAUDE=1`. A real light-touch sonnet review of one paragraph. Asserts that only valid agent annotation drafts from this session reach the sink, that anchors resolve, that caps hold and that the state is untouched.                                                                                                                                                                                                                                                                              |

## Known gaps

- **Selections on a moved-on document.**
  - `FeedbackRequested.scope` positions are at `scope.version`.
  - If the document has moved on, pass `selection` already mapped to the current version. Otherwise the range is clamped and a warning is returned.
  - The fold already maps it: `state.annotations.feedbackRequests[requestId].scope` has `from`/`to`/`version` in the document's current version (documented in the schema since phase 2c), so pass its `from`/`to` as `selection`. The runner does not read it from `ProjectState` itself yet.
- **Empty searches** count toward the session's search cap in the executor but emit no event, so the fold's `counts.searches` can be lower than the executor's. That is harmless, because the executor is stricter.
- **The actor id is the model alias** (`sonnet`, `opus`), as the schema specifies. The resolved model id (e.g. `claude-sonnet-5-5`) is only visible in the `init` progress event.
- **Annotations target manuscript text in scope only.** Notes are context and can't be annotated. Rejections use the code `out-of-scope`.
- **The tool server runs under `tsx`** in a separate process per session (about 300 ms to start). It needs `node ≥ 22` and the `tsx` dependency at runtime.
- **The rephrase check is a heuristic** (`rephraseGuidanceViolation`: quoted new wording of 3 or more words). The suggestion matcher still catches retyped AI text.
- **No spend limit beyond the wall clock.** Pass `extraArgs: ['--max-budget-usd', 'N']` if needed.

## Contract changes requested

Applied in the contract revision pass (phase 2c):

- `ToolErrorCode` includes `out-of-scope`, `search-unavailable`, `sink-rejected` and `internal-error`; the agent's superset `AgentToolErrorCode` is gone.
- `SourceSearch` lives in the schema and returns `SurfacedCandidate[]` (`{csl, provider, url}`), so the agent no longer infers the provider. The relay's `/search` answers `{ok: true, candidates}`.
- `FeedbackSessionStarted.systemPromptVersion` (optional); the runner sets it to `SYSTEM_PROMPT_VERSION`, and the fold keeps it on `AgentSessionState.systemPromptVersion`.
- The schema documents that the folded `FeedbackRequestState.scope` selection is mapped to the current version.

`docs/BUILD.md` "AI runtime" already blesses `--setting-sources project` and the prompt on stdin. No requests are open.
