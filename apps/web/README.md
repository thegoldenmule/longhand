# @longhand/web

**Lane:** Serial (integration). The Next.js app (App Router, React 19) that composes every package into the writing app. Port 3100 locally.

```sh
pnpm dev                                   # from the repo root: Postgres, ledger service and this app
pnpm --filter @longhand/web dev            # just this app (expects the ledger service on LEDGER_URL)
pnpm --filter @longhand/web typecheck
pnpm --filter @longhand/web test           # Vitest (jsdom): auth/PKCE, config, draft import, ProjectStore
pnpm --filter @longhand/web e2e            # the full-stack Playwright suite (needs Postgres on 5434)
LONGHAND_LIVE_CLAUDE=1 pnpm --filter @longhand/web e2e   # one real review with the claude CLI
node apps/web/scripts/smoke.mjs <outDir>   # a quick walkthrough with screenshots against a running `pnpm dev`
```

## Routes

| Route                      | What                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                        | Projects: open one, create one (title, genre, audience), or import a draft (paste or `.md`/`.txt`) as `DocumentImported`, labeled _imported (unverified)_ |
| `/p/:projectId?doc=&view=` | The workspace (`view` = `write`, `corkboard`, `replay` or `report`)                                                                                       |
| `/auth/callback`           | Cognito Hosted UI redirect: exchanges the code with the PKCE verifier                                                                                     |
| `/verify`                  | The standalone verifier page (`packages/verifier/web`), built into `public/verify` by `scripts/build-verifier.mjs`; fully client-side                     |

Everything under `/` and `/p` renders client-side only (`next/dynamic` with `ssr: false`): the packages use IndexedDB, WebCrypto and the DOM.

## How it is wired

- **Runtime config** (`src/config.ts`). The root layout reads the environment per request and inlines `{ledgerUrl, authMode, cognito}` as `window.__LONGHAND__`, so one build runs against any ledger service.
- **Auth** (`src/auth`). `AUTH_MODE=dev`: no token; the ledger service signs in its dev user. `AUTH_MODE=cognito`: Hosted UI, authorization code with PKCE (S256), tokens in `localStorage`, refreshed a minute before expiry; `@longhand/client` sends `Authorization: Bearer`. A 401 from the service (`HttpCommitTransport.onAuthError`) starts the sign-in again. Variables: `.env.example` and `docs/DEPLOY.md`.
- **The ledger, client side** (`src/store/projectStore.ts`). Loads `/commits`, follows the project event stream (fetching any gap), and folds every commit with `@longhand/ledger` through **one shared `Replay`**: its head is the `LedgerState` the span inspector needs and the `ProjectState` the binder, cards, tint and report read; the replay scrubber gets the same `Replay`. It also follows the progress stream of every running agent session and relays it to `ann.pushProgress`.
- **The editor** (`src/workspace/EditorSurface.tsx`). `<LonghandEditor>` over `HttpCommitTransport`, with its scroll container for typewriter scrolling. Opening a document puts the caret in it, unless the writer is typing in another field (a binder rename, say); an empty document shows the editor's "Begin here." hint. The editor syncs its own document (submit, document SSE, `fetchSince`, rebase); the rest of the UI reads the fold, which includes the editor's commits once the ledger has them. Annotation and tint ranges are mapped from the fold's version onto the editor's local document (`mappingFrom`), and the tint re-applies when the editor catches up with a proposal's derived steps.
- **Human events** (`src/lib/drafts.ts`). Binder, research and settings drafts go through `editor.submitEvent`, so they share the editor's ordered, IndexedDB-backed queue with the text; with no document open they are posted directly and retried while offline.
- **Annotations.** `useAnnotations` with the editor handle and the folded state; `<AnnotationMargin>` in the page's scroll container, `<FeedbackPanel>` in the side panel. **Ask for feedback** opens its `<FeedbackRequestForm>` (the selection scope uses the editor selection).
- **Provenance.** One `createProvenanceTint()` per workspace; `setRuns(doc.provenance, doc.version)` on every fold; `<ProvenanceLegend>` in the side panel; `<ProvenanceInspector>` with the shared replay's head.
- **Report and bundle** (`src/workspace/ReportView.tsx`). `computeReport` over `/bundle`'s commits and witnesses; **Download verification bundle** builds it client-side with `buildBundle` from the same pieces. It verifies with `@longhand/verifier` and on `/verify` (e2e test 13).
- **Export** (`src/workspace/ExportDialog.tsx`). The server's export route; the provenance appendix is `provenanceSummaryForExport(computeReport(…))`.
- **Research** (`src/workspace/ResearchPane.tsx`). Sources, clippings, the citation picker and the bibliography. Crossref and Open Library are called from the browser; page metadata goes through the service's SSRF-guarded proxy (`client.pageFetch`). Citations draw as their formatted in-text citation (`citationLabels.ts`, a node decoration).
- **Design** (`app/globals.css`). One token set (`--app-*`, light and dark on `<html data-theme>`) mapped onto every package's `--lh-*` variables. Nothing from the AI appears until asked; panels collapse to the page alone.

Keyboard: ⌘\ binder · ⇧⌘\ side panel · ⌥⌘\ just the page · ⌥⌘P tint · ⌥⌘. focus mode · ⌘/ all shortcuts · Esc leaves replay, report and corkboard.

## The full-stack e2e suite (`e2e/`)

`playwright.config.ts` starts, never reusing a server already on a port:

1. `e2e/stack.ts`: a **fresh Postgres database** per run (dropped on exit; leftovers of killed runs are dropped at start), a real Durable Streams server on a random port, and the real ledger service through `loadConfig` → `startFromConfig` on **3250** with `MODEL_ADAPTER=mock` (the lens-driven mock reviewer, `apps/server/src/agent/mock-script.ts`) and a fresh witness key;
2. a production build of this app (`NEXT_DIST_DIR=.next-e2e`) on **3150**.

Every test ends with the invariant checked from the outside (`assertHumanManuscript` in `e2e/helpers.ts`): every project's ledger is fetched from `/commits` and replayed, and every commit that changed any document's text must have a human actor and a manuscript event type.

| #   | Test                | Proves                                                                                                                                                                                                |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | save and reload     | a new document has the caret and the hint; typing reaches the ledger within the batch window, the status line says Saved, the text survives a reload                                                  |
| 2   | external paste      | two clipboard pastes (the second finishing a word) fold as `pasted-external` runs with `PasteOccurred`s; the tint draws them as one seamless span, typed text stays plain, and the legend counts them |
| 3   | internal copy/paste | `SliceCopied → PasteOccurred → TextEdited(pasted-internal)` and the pasted text keeps the `typed` class                                                                                               |
| 4   | ask for feedback    | nothing appears until asked; cards stream into the margin while the review runs; the summary arrives; agent commits only; text unchanged                                                              |
| 5   | trace-over          | retyping a word-choice alternative resolves it **adopted** with `typed-from-suggestion` provenance and the trace hint on the run                                                                      |
| 6   | proposals           | accepting a paragraph move moves the text, keeps its `originSeq` and class and records the move; rejecting the other with a reason                                                                    |
| 7   | dismiss and discuss | dismiss with reason _Later_; Discuss gets the editor's reply, which never enters the text                                                                                                             |
| 8   | ghost text          | the inline ghost is `user-select: none` and `aria-hidden`; copying across it (and across a card's alternatives) never yields AI text                                                                  |
| 9   | binder              | nested folders, a keyboard move (M, ↓, Enter), a drag into a folder, a corkboard synopsis, a note written like any document                                                                           |
| 10  | research            | a source added by hand, cited (`CitationInserted`, quoted run), a clipping placed as a quote block, the bibliography                                                                                  |
| 11  | replay              | scrubbing back shows a strict earlier prefix of the text; End returns to the head                                                                                                                     |
| 12  | report              | the disclosure and numbers equal `computeReport` over the ledger (40 words: 90.0% typed, 10.0% pasted)                                                                                                |
| 13  | bundle              | the downloaded bundle passes all six verifier checks (also against the published key) and on `/verify`; one changed byte fails the chain                                                              |
| 14  | export              | Markdown, DOCX (unzipped) and PDF (pdfjs) downloads contain the text and the appendix                                                                                                                 |
| 15  | offline             | offline typing shows _Offline · changes queued_, flushes on reconnect, and the report shows the unwitnessed interval                                                                                  |
| 16  | import              | an imported draft shows _imported (unverified)_ in the title, the tint and the report                                                                                                                 |
| —   | screens             | every main view in light and dark, saved to `test-results/screens/`                                                                                                                                   |
| —   | live                | one real light-touch review from the UI (`LONGHAND_LIVE_CLAUDE=1`)                                                                                                                                    |

Test 15 makes the page's clock read three minutes earlier while offline (Playwright `clock.setFixedTime`), because the report flags a commit as queued offline when it reaches the server more than 60 s (`UNWITNESSED_LAG_MS`) after it was written.

## Known gaps

- **One document per editor.** The annotation controller follows the open document; a project-wide review lists items in other documents as plain labels until you open them.
- **Replay freezes its timeline** when opened; newer changes are offered as a refresh rather than redrawing under the writer's hand.
- **Binder and research events with no document open** are posted directly and retried in memory, not queued in IndexedDB.
- **Report times** are formatted by the report package in UTC; the inspector and replay use local time.
- **Cognito sign-in** is unit-tested (PKCE, token exchange and refresh with a mocked endpoint) but has not been run against a real user pool.
- **Amplify** has not been tried with Next 16; `docs/DEPLOY.md` documents the plan.
