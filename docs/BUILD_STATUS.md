# Build status

The coordinator updates this file after every phase. A resumed session reads it first.

| Phase | Work | State | Commit |
| --- | --- | --- | --- |
| 0 | Preflight, spec export, build brief | done | — |
| 1 | Scaffold + contracts (`packages/schema`) | done (270 tests) | dec3bd6 |
| 2a | Ledger core + golden fixtures (`packages/ledger`) | done (136 tests, 13 fixtures + 6 tampered) | merged |
| 2b | Lanes needing contracts: editor, agent, binder, export, research | done | merged |
| 2c | Contract revision pass (applied list below) | done (schema 273 tests, ledger 137, 13 fixtures + 6 tampered regenerated; SCHEMA_VERSION stays 1) | 2dd23fa |
| 3 | Lanes needing ledger core: server (+ packages/client), provenance-ui, report + verifier | done | merged |
| 4 | Annotations lane | done | merged |
| 5 | Integration: `apps/web`, dev orchestration, end-to-end in Chrome | done (web 18 e2e + live; `pnpm e2e` all suites green) | see git log |

## Lane results

| Lane | State | Merge |
| --- | --- | --- |
| binder | merged (91 tests) | see git log |
| export | merged (60 tests) | see git log |
| research | merged (88 tests) | see git log |
| agent | merged (92 tests + live smoke passing) | see git log |
| editor | merged (77 unit + 13 Playwright in Chrome) | see git log |

## Applied contract changes (phase 2c)

Each applied in `packages/schema` first, then in its consumers; fixtures regenerated. `SCHEMA_VERSION` stays 1: every payload change is optional or additive, and the one tightening (clipping text) changes no shape and predates any stored ledger.

- Folder synopses: `SynopsisEdited` is `{documentId, synopsis} | {folderId, synopsis}`; `FolderState.synopsis`. Ledger fold, binder `editSynopsis(model, ref, text)`, optimistic reducer and Corkboard folder cards; `binder` fixture covers it. (5d0d906)
- Ledger fold confirms: folder `updatedSeq` bumps on child create/move; moves into archived folders accepted (builders refuse); duplicate ids rejected per collection. Already true at the ledger merge (`binder` fixture); binder README updated.
- Shared input-method meta: `INPUT_METHOD_META = 'longhand/input-method'`, `DeclaredInput`, `DECLARABLE_INPUT_METHODS` in schema `input`. Editor and research use it; the editor still reads `longhand/editor-input` and `longhand/research-input` for one version. Keystroke kinds `cite` and `clip`, used by the editor, research and the ledger builder. (14e9b12)
- Clipping text: `ClippingSavedSchema` rejects empty lines and leading/trailing newlines; the fold still collapses blank lines as defense (`research` fixture places a quote block with an empty paragraph). (14e9b12)
- `SourceSearch` in schema (`tools`): `search(query, limit): Promise<SurfacedCandidate[]>`, reusing the existing `SurfacedCandidate` (`url` is `string | null`). Research implements it (`searchItems` keeps bare CSL); the agent consumes it and no longer infers the provider; the relay's `/search` answers `{ok, candidates}`. (d57b46c)
- `ToolErrorCode` adds `out-of-scope`, `search-unavailable`, `sink-rejected`, `internal-error`; the agent's `AgentToolErrorCode` is gone. (d57b46c)
- `FeedbackSessionStarted.systemPromptVersion` (optional); the agent runner sets it; the fold keeps `AgentSessionState.systemPromptVersion` (null when absent). (2edfc4b)
- Documented: folded `FeedbackRequestState.scope` selection `from`/`to`/`version` are in the document's current version (the fold already mapped them). (2edfc4b)
- `ProvenanceRun.matchedKind`, present exactly when `suggestionId` is: `suggestion | insertion | comment | question | proposal | citation-flag | surfaced-source | source-suggestion | discuss | review` (the three research kinds were added because the four-word matcher also matches those cards). `suggestionId` is documented as naming any annotation. Ledger fills it; `spanHistory().matched.group` derives from it; `suggestions` fixture regenerated. (b9c7302)
- `ProvenanceSummary` and `provenanceSummaryFromReport` moved to schema `bundle`; export imports and re-exports them. (2dd23fa)

| provenance-ui | merged (139 unit + 9 Playwright) | see git log |
| report + verifier | merged (7 Playwright; verifier fails every tamper case) | see git log |
| annotations | merged (56 unit + 19 Playwright) | see git log |

Integration note (provenance-ui): the span inspector needs the folded `LedgerState`, so the web app keeps the project's commit array client-side and folds it (shared `Replay` for scrubber + inspector).

## Applied contract changes (core fixes, after phase 4)

- Ledger exports the steps the fold applies per commit: `validateDraft` success adds `derivedSteps: DerivedSteps` (`Record<documentId, StepJSON[]>`; a `TextEdited`'s own steps, the fold-derived move/cut/split/merge steps incl. joining whitespace for `ProposalAccepted`, `{}` otherwise), plus `derivedStepsFor(stateBefore, commit)` and `applyCommitWithSteps(state, commit)` for replay and `fetchSince` from history. Applying them gives exactly the fold's document, and their count is exactly the version delta (tested on every fixture commit, every `proposals` accept, and random proposals). Annotations' `FoldingTransport` sends them (the padded diff step is gone); the editor's sync needed no change. Server: `RemoteUpdate.steps = v.derivedSteps[documentId]`. (annotations → ledger, server)
- `@longhand/ledger/fixtures` loads under jsdom: paths come from `node:url` (`fileURLToPath`/`pathToFileURL`), never the global `URL`; new `fixturePath(name)`. Annotations keeps importing the JSON in `fixtureData.ts` (its browser demo shares the module) and a jsdom test checks it equals `loadFixture`. (annotations)
- Agent `SessionProgressEvent`: `model` and `annotation` events now carry `feedbackSessionId` too, so every event names the runner's session from `started` on (only a `failed` before `FeedbackSessionStarted` was appended has `null`, as in that `FeedbackSessionFailed`). Annotations' `pushProgress(event, sessionId?)` uses the event's id; `sessionId` is only a fallback, and the controller no longer guesses from the last `started`. Server: relay events as-is. (annotations → agent)

## Pending contract changes

- ~~Research lane should ship `formatCitation`/`formatBibliographyEntry` adapters for export's injected formatters (CSL). (export → research)~~ Done by the server's `cslFormatters` (phase 3).
- Optional: a CSL `source` convention or a `provider` field on library sources, so the origin provider survives `SourceAdded`. (research)
- ~~Server lane implements the AnnotationSink HTTP contract in `packages/agent/README.md`.~~ Done (phase 3).
- ~~Server/web must implement the editor's `CommitTransport` (`packages/editor/src/sync/transport.ts`): submit → ack/duplicate/conflict/rejected/offline; subscribe in ledger order incl. own commits; `fetchSince` with fold-derived steps for ProposalAccepted (now from ledger `validateDraft().derivedSteps` / `derivedStepsFor`). (editor → server)~~ Done: `HttpCommitTransport` (phase 3), used by the web app (phase 5).

- ~~Repo license~~ — resolved: MIT for the whole repo (LICENSE).

- ~~Research: citeproc wrapper crashes on numeric CSL fields (e.g. `volume: 12`); export works around by stringifying. (server)~~ Fixed in phase 5: the wrapper stringifies numeric fields on the copy it hands citeproc; the server's workaround is gone.
- ~~Agent: `MockModelAdapter` ignores a signal aborted before run start. (server)~~ Fixed in phase 5: it returns `aborted` without starting the tool server; the server's cancel no longer defers the abort.
- Optional: ledger fold-state serialize/restore for fast startup from Postgres snapshots. (server)

## Phase 5: integration

- `apps/web`: Next 16 App Router app composing every package (projects home with import, the workspace with binder/corkboard, editor, margin, feedback, research, provenance, replay, report, bundle, export, settings, shortcuts; `/verify`; dev and Cognito PKCE auth). See `apps/web/README.md`.
- Root `pnpm dev` (Postgres check or compose, `dev:setup` when needed, server and web, clean Ctrl-C) and `pnpm e2e` (editor, provenance-ui, annotations, verifier, web, sequentially, never reusing a stale server).
- Full-stack e2e (`apps/web/e2e`): fresh database per run, real Durable Streams and ledger service (lens-driven mock reviewer), production web build, Chrome. 16 numbered tests, light/dark screenshots, and the invariant checked from the API after every test. Live test (real `opus` review from the UI) passes.
- Server mock reviewer: `word-choice` adds a word-choice suggestion and `structure` adds a paragraph move and a sentence move.
- `README.md`, `docs/DEPLOY.md`, `amplify.yml`, `apps/server/Dockerfile`, `deploy/ec2/*`.

## Known gaps after phase 5 (prioritized)

1. **Not deployed.** Amplify (with Next 16), the EC2 image, KMS signing and Cognito sign-in are documented and unit-tested (KMS mocked, PKCE with a mocked token endpoint) but never run against AWS. The `apps/server/Dockerfile` has not been built yet (the Docker registry was unreachable from the build machine), and the new CI e2e job has not run (nothing was pushed).
2. **Single ledger instance, in-memory sessions** (server). No failover; a crash between appending a `FeedbackRequested` and starting its session leaves it pending. Each loaded project keeps its commits and step history in memory.
3. **Client folds the whole ledger** on open (no fold-state snapshot API in `@longhand/ledger`). Fine for one book; slow for very long histories.
4. **One annotation controller per open document.** A project-wide review shows items in other documents as labels until you open them.
5. **Binder/research events with no document open** are retried in memory rather than queued in IndexedDB; with a document open they use the editor's durable queue.
6. **The in-app report recolours the classes** to match the provenance tint; the downloadable/verifier report keeps the report lane's colour-blind-validated palette.
7. **Footnote text is not tinted**, and the replay view is not inspectable (provenance-ui gaps).
8. **Browser coverage:** every Playwright suite ran in Chrome only.
9. **No root LICENSE**; the verifier declares MIT. Needs the owner's decision.

## Polish after hand testing

- Agent prompt v2 (`SYSTEM_PROMPT_VERSION = 'v2'`, v1 kept): ids such as `p1.s2`, `s3` and `fn1.s1` never appear in text the writer reads; the tool executor rejects them in every writer-facing field. Live sonnet check passed with no ids in the prose. (2a094d9)
- An empty document shows a faint "Begin here." (an `aria-hidden` widget, never text), and opening a document puts the caret in it. (26b5132)
- The provenance tint leaves typed text plain, so pasted, imported, quoted and from-a-suggestion text stand out; touching runs that look the same draw as one span, so run boundaries inside a word leave no seam.

## Notes

- Commits go straight to `main` and are pushed after each phase.
