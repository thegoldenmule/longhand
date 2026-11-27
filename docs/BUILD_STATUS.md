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

## Named editors

The ask form was too much (scope, nine lens chips, intensity and a note). Writers now ask a **named editor**: an account-wide roster managed on `/editors`, each editor a name, lenses, intensity, a short brief and up to five canned questions. The form is: choose an editor, choose the scope (selection by default, else the document, or the whole project), optionally tap a question and/or type one, **Ask <Name>**.

- **Contract (additive; `SCHEMA_VERSION` stays 1; no fixture changed).** Schema `editors`: `EditorProfile` `{id, name, role, brief, lenses, intensity, questions}` with `TEXT_LIMITS` `editorNameMaxChars` 60, `editorRoleMaxChars` 40, `editorBriefMaxChars` 600, `editorQuestionMaxChars` 160, and `EDITOR_MAX_QUESTIONS` 5; `STARTER_EDITORS`. `FeedbackRequested` gains an optional `editor: {id, name, role?, brief}` (`role` only when set; a profile saved before roles existed reads as role `''`); the request's own `lenses` and `intensity` are that editor's configuration, so the record is self-contained. The fold keeps it as `FeedbackRequestState.editor`, absent (not null) when no editor was named, so older folded states stay byte-identical. A tapped canned question travels in `ask` (canned question, then the writer's own, one per line).
- **Starters** (seeded once per account on its first read; editable, deletable, and restored by "Reset to starters"): Margaret (developmental: structure, argument, pacing; light), Theo (line: clarity, word choice, tone and voice; standard), Ruth (copyedit: claims and citations, grammar and mechanics; thorough), Sam (first reader: clarity, pacing, character and dialogue; light). Between them they cover `structure` and `word-choice`, the lenses the mock reviewer reacts to.
- **Agent.** `SYSTEM_PROMPT_VERSION = 'v3'` (v1 and v2 kept). The request section names the editor and quotes its brief between triple quotes like the ask (`quoteWriterText` collapses quote runs so writer text cannot close its quote). The v3 prompt says the brief shapes emphasis and tone and never changes the covenant, tools, caps, lenses or id rules. The editor changes only the request section: the tool list and snapshot are identical. Discuss answers as the editor of the review that made the annotation. Live check: a sonnet review with a "blunt line editor who hates adverbs" brief finished with notes in that voice and no ids in writer-facing text (the executor rejected one id-bearing call, which the model fixed).
- **Server.** `migrations/002_editors.sql` (`editors`, `editor_rosters`): account settings, not derived from the streams, so `rebuild` keeps them. `GET/POST /v1/editors`, `GET/PUT/DELETE /v1/editors/:id`, `POST /v1/editors/reset`, validated with the schema (422 `invalid-editor`, 409 `too-many-editors` past 20). CORS allows PUT and DELETE. The session runner already passed the `FeedbackRequested` payload to the agent; a test confirms the brief reaches the prompt. The server does not check a request's editor against the roster (a request is valid on its own, and the editor may have changed since the page loaded).
- **Client.** `listEditors`, `getEditor`, `createEditor`, `updateEditor`, `deleteEditor`, `resetEditors`.
- **Annotations.** `<FeedbackRequestForm editors …>` and `<FeedbackPanel editors manageEditorsHref …>` (defaults to the editor asked last); `feedbackRequestFor(profile, …)`; retries ask the same editor; each review is headed by the editor's name.
- **Web.** `/editors` (list, add, edit, delete, reset), linked from the projects home header, from the request form ("Manage editors", with a way back to the project) and from the Settings tab. The workspace reloads the roster on focus. The e2e stack seeds a test editor, Iris (structure, word choice), that the feedback tests ask; test 17 covers the Editors page end to end without resetting the shared roster.
- Not done: the report's session list does not carry the editor's name (adding a field would change every recomputed report, which the verifier compares against shared ones).
- The running `pnpm dev` ledger service needs a restart to apply migration 002 and serve `/v1/editors`.

## Feedback as chat

The form-then-review flow in the Feedback tab is replaced by a chat with the writer's editors, like a chatbot: an editor dropdown (name and role), History and New chat in the header; writer messages right, replies left under the editor's name, as plain paragraphs, with chips that focus the notes the reply left; "Margaret is reading…" with live progress as notes land and Stop; failures inline with Retry; an auto-growing composer (Enter sends, Shift+Enter newline) with the selection as a removable quoted chip, the discussed note as a chip and a Whole project toggle; canned questions as starters in an empty chat. The panel is locked to the viewport height (messages scroll, the composer is pinned) and auto-scrolls unless the writer scrolled up. Ask for feedback opens it and focuses the composer; Discuss on a card opens it with that note attached (no per-card threads). One conversation per project plus New chat; prior turns go into the editor's context within a budget; switching editors mid-chat is allowed and each reply names its editor. Older reviews and Discuss threads stay readable in History.

- **Contract (additive; `SCHEMA_VERSION` stays 1).** Human `ChatMessageSent {chatId, messageId, text, editor (FeedbackEditor), lenses, intensity, context: {scope: FeedbackScope, aboutId}}`; agent `ChatReplied {feedbackSessionId, chatId, replyTo, body}` (the `reply` tool, which ends the session). Session kind `chat`, trigger `{kind: 'chat', chatId, messageId}`. Chat sessions get the read, annotation and research tools plus `reply`, capped by the message's intensity. `FeedbackSessionFailed.chat` (optional) names a message whose session never started. State: `annotations.chats`, `AgentSessionState.chatId`/`messageId`. Chat replies are AI-visible text for the four-word matcher (`matchedKind: 'chat'`, `suggestionId` = chat id). Existing ledgers fold and verify unchanged: the golden fixtures keep their commits, hashes and witnesses (expected states gained `chats: {}` and the null session fields), and a new `chat` fixture covers every event, a mapped selection, a failure before start and words retyped from a reply.
- **Report and verifier.** Chat messages count as AI feedback ("AI feedback was requested N times in chat") and chat replies as assisted text; `ai.chatMessages` and `assisted.byKind.chat` appear only when nonzero, so reports of chat-free ledgers (and bundles already shared) are byte-identical. The verifier re-folds chats like any other event.
- **Agent.** Prompt v4 adds the chat prompt (review and discuss text as v3, v1–v3 kept): always reply, leave notes first only when the message asks for them, point to notes in plain words, no ids in any writer-facing text (the executor rejects them in the reply too). `buildChatContext` carries the conversation so far (labeled by speaker and editor, newest kept within 16000 characters), the editor's name, role and brief, the attached selection or note, and the document or project. Default model `sonnet` (`AGENT_MODEL_QUICK`). Live check (sonnet, `claude -p`): a plain question got a reply and no notes; "Review this paragraph." left 4 notes, then a reply pointing to them; no ids anywhere.
- **Server.** `POST /v1/projects/:pid/chat`, and `ChatMessageSent` through `/commits` (the editor's queue) also starts a session; streamed and cancellable like reviews. Migration 003 adds `agent_sessions.chat_id`. The mock reviewer always replies; "review" in a message first leaves the lens-driven notes (structure → moves, word-choice → suggestion); a message about a note answers about it.
- **UI.** `<FeedbackChat>` replaces `<FeedbackPanel>` and `<FeedbackRequestForm>` (removed). Controller: `sendChat`, `openChat`, `discussInChat`, `cancel`, `chatMode`, and `onOpenChat` / `onCancelSession` / `submitWithoutEditor` options. Web e2e: tests 4 (notes then reply; a plain question gets a reply only), 7 (Discuss in the chat), 17 (editors) and the new 18 (selection chip, New chat from a starter, history, viewport lock).
- Deviations: a writer message may carry a selection, a note or neither, but only one scope; the "Whole project" toggle overrides the selection. The report does not list chat transcripts, only counts. Reviews and Discuss threads from before the chat are read-only; the API still accepts `FeedbackRequested` and `DiscussRequested` for older clients.

## Light formatting (links, inline code, bubble toolbar)

The owner asked for "the basics that Medium allows": bold, italics, links and so on, in the manuscript editor only (the chat stays plain text).

- **Contract change (additive, `SCHEMA_VERSION` stays 1).** The document schema gains two marks. In rank order the marks are now `link`, `em`, `strong`, `code`.
  - `link`: one attr, `href`, non-inclusive, rendered as `<a href rel="noopener noreferrer" target="_blank">`. No `title` attr (nothing in the editor sets one, and Markdown, DOCX and PDF links work without it).
  - `code`: inline code, `code: true`, excludes `em` and `strong`, may sit inside a link.
  - **Href policy** (`packages/schema/src/links.ts`, `normalizeHref`, `isAllowedHref`, `pastedLinkHref`): only `http:`, `https:` and `mailto:`. Bare `example.com` becomes `https://example.com`, `//example.com` becomes `https://example.com`, `ada@example.com` becomes `mailto:ada@example.com`. Refused: every other scheme (`javascript:`, `data:`, `file:` and so on), relative paths, whitespace, control characters, backslashes, userinfo (`https://bank@evil`) and anything over 2048 characters. `"`, `<`, `>` and backticks are percent-encoded. A stored href must equal its own normalization, and the mark's validator enforces that whenever a mark is created, so bad hrefs fail in document JSON, in `TextEdited` steps (the fold reports `invalid-step`), in `DocumentImported` and in HTML parsing (the text stays, the link goes). Pure string rules with no `URL` parser, because the fold must be deterministic and IDNA handling differs across runtimes.
  - **Why it is additive.** No existing document or commit can contain the new marks. `em` and `strong` keep their relative rank, so every existing document serializes byte-for-byte as before. Every golden fixture and tampered fixture verifies unchanged (none was regenerated), and the fold is unchanged. Marks never change text, so provenance runs, word and character counts and the matcher are unaffected by construction: the href is an attribute, never manuscript text.
- **Editor** (`packages/editor`). Mod-E (code), Mod-K (link), the `` `code` `` and `[text](url)` input rules (mark rules never fire inside code), and pasting a URL over a non-empty selection links it instead of inserting text. That paste is formatting for the guard: no `PasteOccurred`, a `typed` run, a `format` timeline entry of length 0. Clicks on links never navigate, and ⌘/Ctrl-click opens a new tab with `noopener,noreferrer`. The **bubble toolbar** (`bubblePlugin`, on by default, plain DOM in the editor root, so the demo and the web app both get it): Bold, Italic, Link, Heading (h1), Subheading (h2), Quote, Code, with `aria-pressed` and labels. Link turns it into an inline URL field (Enter applies, Esc cancels, pre-filled, Remove, "Use an http, https or mailto link" on refusal). A caret in a link shows the URL with Edit and Remove. Keyboard: it never takes focus by itself. Alt-F10 moves in (Tab too, outside lists, while it shows), arrows and Home/End rove, Esc returns with the selection intact. Footnote editors get the mark buttons only, plus the mark shortcuts and URL paste. Hidden for a collapsed selection, read-only, blur, IME, a mouse drag in progress, and while any `role="dialog"` or open `<dialog>` is in the page (the span inspector), or when the host's `bubble.suppress()` says so.
- **Consumers.**
  - Export: Markdown `[text](href)` (emphasis shared by the whole link goes outside the brackets) and code spans with safe fences, DOCX external hyperlinks in Word's Hyperlink style and Courier New, PDF underlined link annotations and Courier (Latin-1 only, else the body font). The export golden documents now use both marks, and the Markdown snapshots gained the one new paragraph.
  - Web: Markdown import reads code spans and links (emphasis inside link text) and keeps refused links as literal text. The keyboard sheet mentions the toolbar, ⌘K and ⌥F10. `globals.css` maps the bubble tokens.
  - Provenance-ui: the tint draws inside `<a>` and `<code>`, the inspector quotes words never hrefs, the replay renders both marks and its links never navigate.
  - Report and verifier: they render no manuscript text. Tests show reports are identical with or without the marks and that a bundle with them verifies.
  - Agent: sentences stay plain text (quotes and anchors still match), and each block line ends with `[links: "text" <href>]` and `[inline code: "…"]`. Blocks without either render exactly as before, so `SYSTEM_PROMPT_VERSION` is unchanged.
  - Annotations: underlines draw inside links and code, ghost widgets carry no marks, formatting changes no annotation range, and trace-over on a linked word still resolves adopted.
- **Tests** (all jsdom or Node): schema 303 (11 new), ledger 157 (7 new), export 64 (4 new), report 156 (1), verifier 60 (1), editor 102 (21 new), provenance-ui 148 (3), annotations 63 (2), agent 121 + 3 skipped (3), web 15 (2).
- **Not run.** `packages/editor/e2e/formatting.spec.ts` (toolbar placement and buttons, keyboard, links, URL paste, the input rules, light and dark screenshots) is written but has not run: this session ran no browser at all. Bubble placement is therefore untested.
- **For the owner to decide.** Heading and Subheading map to h1 and h2 (h2 and h3 is the other reading). Code excludes bold and italic but not links. The link popover shows for a caret in a link, not on hover. A pasted URL links a selection only when it plainly is one (`http(s)://`, `mailto:`, `www.`). Mod-B and Mod-I keep ProseMirror's toggle (remove when any of the selection has the mark) while the toolbar buttons add unless the whole selection has it. DOCX links use Word's blue Hyperlink style.

## One document, one name

The owner: "Most of my work will be single document." A new project should start before it has a name, as Untitled (names need not be unique), and in a single-document project the document's name is the project's, always, edited at the top of the page. Before this the title showed three times (binder head, header crumb, document title).

- **Contract: none.** No new event, no payload change, no fold change, `SCHEMA_VERSION` stays 1, no golden fixture changed. The project title stays stored, not derived: the report embeds `settings.title` and the verifier recomputes it, so deriving it in the fold would break bundles already shared. The link is a UI rule kept with ordinary events.
- **The rule.** Single mode is when the Manuscript root holds exactly one live node and it is a document (notes and archived nodes don't count, a folder means multi). Its title as shown is always `settings.title`. Renaming it at the top writes `ProjectSettingsChanged {title}` then `DocumentRenamed`, each only if it changes something. A blank title is Untitled. Leaving single mode (a second document, a folder, a restore) first renames the sole document to the project's name if its stored title differs. Archiving down to one writes nothing and says "One document left. It goes by the project’s name now." when the names differ. Old projects whose titles differ show the project's name and are fixed lazily.
- **Binder** (`packages/binder`): `soleManuscriptDocument`, `UNTITLED`, `titleOrUntitled`, `renameProjectAndDocument` and `withTitleLink` (in `titleLink.ts`, apart from `drafts.ts` because they use the reducer), `<BinderTree hide>`, `<ProjectSettingsForm showTitle>`.
- **Provenance-ui**: the replay's Document chooser shows only with more than one document.
- **Web.**
  - Single mode: the header is `[binder toggle] [‹ All projects] [Title]`, the title a `TitleField` (an input that looks like text: Enter or blur commits, Esc reverts, Enter and Esc return the caret to the page). A note open shows `[Essay ›] [Characters]`. The binder opens closed; opened, its head says only "All projects", the document has no row and there is no corkboard switch. Provenance, the report and export show no scope choice.
  - Multi mode: the binder head edits the project title, the header edits the open document's, and with the binder closed the project is a muted crumb. Scope buttons say "This document" rather than the title.
  - Everywhere: the status line never shows a title, Settings has no title field, the tab reads "<project> · Longhand". `longhand:layout` remembers the binder only for multi-document projects. Two UI strings lost their semicolons.
  - Home: New project is one click (Untitled project, Untitled document, caret in the body). The import form drops genre and audience; its Title is optional, and the name is the Title field, else the leading `# Heading` (which then leaves the body), else the file name, else Untitled.
- **Server**: the default project title is Untitled.
- **Tests** (jsdom or Node): binder 119 (24 new), provenance-ui 149 (1), web 47 (32, including a workspace render that counts every visible title in each mode), server 122 (1, with Postgres). Repo: 1558 passed, 4 skipped.
- **Not run.** The Playwright changes are written but have not run: this session ran no browser. `apps/web/e2e`: `helpers.ts` (`newProject` names the project at the top, sets genre and audience in Settings), `binder.spec.ts` (9), `writing.spec.ts` (16), `screens.spec.ts`, and the new `single-document.spec.ts` (19 to 22).

## Notes

- Commits go straight to `main` and are pushed after each phase.
