# Build status

The coordinator updates this file after every phase. A resumed session reads it first.

| Phase | Work | State | Commit |
| --- | --- | --- | --- |
| 0 | Preflight, spec export, build brief | done | — |
| 1 | Scaffold + contracts (`packages/schema`) | done (270 tests) | dec3bd6 |
| 2a | Ledger core + golden fixtures (`packages/ledger`) | done (136 tests, 13 fixtures + 6 tampered) | merged |
| 2b | Lanes needing contracts: editor, agent, binder, export, research | done | merged |
| 2c | Contract revision pass (applied list below) | done (schema 273 tests, ledger 137, 13 fixtures + 6 tampered regenerated; SCHEMA_VERSION stays 1) | 2dd23fa |
| 3 | Lanes needing ledger core: server (+ packages/client), provenance-ui, report + verifier | running | |
| 4 | Annotations lane | running (started alongside phase 3) | |
| 5 | Integration: `apps/web`, dev orchestration, end-to-end in Chrome | pending | |

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

Integration note (provenance-ui): the span inspector needs the folded `LedgerState`, so the web app keeps the project's commit array client-side and folds it (shared `Replay` for scrubber + inspector).

## Pending contract changes

- Research lane should ship `formatCitation`/`formatBibliographyEntry` adapters for export's injected formatters (CSL). (export → research)
- Optional: a CSL `source` convention or a `provider` field on library sources, so the origin provider survives `SourceAdded`. (research)
- Server lane implements the AnnotationSink HTTP contract in `packages/agent/README.md`.
- Server/web must implement the editor's `CommitTransport` (`packages/editor/src/sync/transport.ts`): submit → ack/duplicate/conflict/rejected/offline; subscribe in ledger order incl. own commits; `fetchSince` with fold-derived steps for ProposalAccepted. (editor → server)

- Repo has no root LICENSE; verifier package declares MIT. Needs the owner's decision. (report/verifier)

## Notes

- Commits go straight to `main` and are pushed after each phase.
