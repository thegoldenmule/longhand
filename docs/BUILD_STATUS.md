# Build status

The coordinator updates this file after every phase. A resumed session reads it first.

| Phase | Work | State | Commit |
| --- | --- | --- | --- |
| 0 | Preflight, spec export, build brief | done | — |
| 1 | Scaffold + contracts (`packages/schema`) | done (270 tests) | dec3bd6 |
| 2a | Ledger core + golden fixtures (`packages/ledger`) | done (136 tests, 13 fixtures + 6 tampered) | merged |
| 2b | Lanes needing contracts: editor, agent, binder, export, research | done | merged |
| 2c | Contract revision pass (pending list below) | running | |
| 3 | Lanes needing ledger core: server, provenance-ui, report + verifier | pending | |
| 4 | Annotations lane | pending | |
| 5 | Integration: `apps/web`, dev orchestration, end-to-end in Chrome | pending | |

## Lane results

| Lane | State | Merge |
| --- | --- | --- |
| binder | merged (91 tests) | see git log |
| export | merged (60 tests) | see git log |
| research | merged (88 tests) | see git log |
| agent | merged (92 tests + live smoke passing) | see git log |
| editor | merged (77 unit + 13 Playwright in Chrome) | see git log |

## Pending contract changes (apply serially after ledger core merges)

- Folder synopses: `SynopsisEdited` accepts `{documentId} | {folderId}`; `FolderState.synopsis`. (binder)
- Ledger fold must confirm: folder `updatedSeq` bumps on child create/move; moves into archived folders accepted by fold (builders refuse); duplicate ids rejected per collection. (binder)

- Research lane should ship `formatCitation`/`formatBibliographyEntry` adapters for export's injected formatters (CSL). Move `ProvenanceSummary` into schema or have report import it from export. (export)

- Shared input-method transaction meta key in schema (research uses `RESEARCH_INPUT_META = 'longhand/research-input'`); keystroke kinds `cite`/`clip`. (research)
- Clipping blank lines: `ClippingSavedSchema` rejects empty lines, or fold collapses them before comparing. (research)
- Move `SourceSearch` interface into schema. (research)

- `ToolErrorCode` add `out-of-scope`, `search-unavailable`, `sink-rejected`, `internal-error`. (agent)
- `SourceSearch` returns `SurfacedCandidate[]` (csl, provider, url) — merge with research's request to move it into schema. (agent, research)
- Fold maps `FeedbackRequestState.scope` selection positions to current version. (agent → ledger)
- Optional: `systemPromptVersion` on `FeedbackSessionStarted`. (agent)
- Server lane implements the AnnotationSink HTTP contract in `packages/agent/README.md`.

- Move `EDITOR_INPUT_META` / `DeclaredInput` into schema as `INPUT_METHOD_META`; keystroke kinds `cite`/`clip`. (editor, research)
- Server/web must implement the editor's `CommitTransport` (`packages/editor/src/sync/transport.ts`): submit → ack/duplicate/conflict/rejected/offline; subscribe in ledger order incl. own commits; `fetchSince` with fold-derived steps for ProposalAccepted. (editor → server)

- `ProvenanceRun.suggestionId` can name any annotation under the 4-word rule: add `matchedKind` (or reword). Document that folded `FeedbackScope` selection from/to/version are mapped. (ledger)

## Notes

- Commits go straight to `main` and are pushed after each phase.
