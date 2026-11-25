# Longhand — Writing App Spec

2026-11-24 · @Benjamin

Longhand is a calm writing app with an AI editor that critiques and proposes but can never put a word in your manuscript. Every change goes into an append-only ledger, so you can show exactly what you wrote and how AI helped. "Longhand" is a working title.

**The invariant:** no word appears in the manuscript unless a human typed it, or pasted it, which is flagged. AI output lives only in a separate annotation layer. The AI can rearrange or remove your words only through proposals you accept, and each acceptance is logged.

## Principles

1. **Human words only.** Only the writer's own input puts words in the manuscript.
2. **Everything is logged.** Every edit, suggestion, proposal, accept and dismissal goes into one append-only ledger.
3. **Editor, not ghostwriter.** The AI diagnoses, asks questions and proposes small, bounded changes. It has no "rewrite this" tool.
4. **Honest provenance.** Pastes, imports and text retyped from a suggestion are labeled, never hidden. The app never overclaims what the log proves.
5. **Calm by default.** The AI speaks only when asked. No autocomplete, no ambient nudges.
6. **The writer owns the data.** Text and ledger export in full, and the verification format is open.

## Users

| Persona | Need | What matters most |
| --- | --- | --- |
| Student or essayist | Prove the essay is theirs, and disclose how AI helped | Authorship report, replay, paste flagging |
| Novelist (Scrivener user) | Long projects split into chapters and scenes, with developmental feedback | Binder, structure-level feedback, move proposals |
| Journalist or academic | Sources, citations and a process they can defend | Research pane, citation-needed flags, bibliography |

## Features

The MVP is a single-user web app with every feature below, F1–F9, in full. Only stronger proof (independent timestamps) and the read-only share link come after it.

| # | Feature | Milestone |
| --- | --- | --- |
| F1 | Editor with typewriter scrolling | M0 |
| F2 | Binder (projects, documents, notes, nested folders, corkboard) | M5 |
| F3 | Ask for feedback | M2 |
| F4 | Suggestions (wording) | M3 |
| F5 | Proposals (move, cut, split, merge) | M3 |
| F6 | Provenance view and replay | M1 |
| F7 | Authorship report and verification bundle | M4 |
| F8 | Research and citations | M6 |
| F9 | Export (Markdown, DOCX, PDF) | M5 |

### F1 — Editor

- **Typewriter scrolling.** The caret line stays at a fixed height, 50% of the viewport by default and adjustable from 33% to 60%. The page scrolls; the caret doesn't move.
  - Holds across soft-wrapped lines, Enter, Backspace across lines, IME composition and paste.
  - About 50vh of padding at the end so the last line can still reach the center.
  - Clicking or scrolling elsewhere never jumps the view. The next keystroke re-centers over about 120 ms, and the jump is instant under `prefers-reduced-motion`.
- **Focus mode** dims everything except the current sentence or paragraph.
- Minimal chrome: a ~66ch writing column, with the sidebar and margin hideable.
- Light formatting, the basics Medium allows: bold, italic, links, inline code, headings, block quotes, lists, scene breaks and footnotes, all with Markdown-style input shortcuts.
  - A quiet bubble toolbar above a text selection: Bold, Italic, Link, Heading, Subheading, Quote and Code. It never takes focus while you type. Alt+F10 (or Tab) moves into it and Esc returns. In a footnote it offers only the marks.
  - Links: ⌘K or the toolbar's inline URL field, `[text](url)`, or paste a URL over a selection. Only http, https and mailto links, and a bare `example.com` becomes `https://`. A click never navigates, and ⌘-click opens a new tab. With the caret in a link, a small popover shows the URL with Edit and Remove.
  - Formatting is never words: adding or removing a mark (or a link's address) leaves the text, its provenance and the word counts unchanged.
- Word counts per document, selection and session, plus optional daily goals.
- No save button. Every change is committed to the ledger within about 2 s.

### F2 — Binder

- A project holds documents (chapters, scenes, essays), a **Notes** area (characters, outline, style guide, thesis) and a **Sources** library (F8).
- Nested folders (Part › Chapter › Scene), drag to reorder, and a corkboard view with synopses.

### F3 — Ask for feedback

- **Named editors.** The writer keeps a roster of named editors, shared by every project and managed on an app-level **Editors** page. Each editor has:
  - a **name** ("Margaret", "Theo");
  - **lenses** (one or more): structure · argument and logic · clarity · pacing · character and dialogue · word choice · tone and voice consistency · claims and citations · grammar and mechanics;
  - an **intensity:** light touch (at most 5 items), standard, or thorough;
  - a short **brief** in the writer's words ("a blunt line editor who hates adverbs") that shapes what the editor looks at first and how it phrases its notes. It never changes the rules: the editor still cannot write the manuscript, and the caps still hold;
  - up to five **canned questions**, one tap each ("Is the opening too slow?").
  - a short **role** shown beside the name ("Line editor").
- **Starter editors.** A new writer starts with four they can edit, rename or delete, or reset to: Margaret (developmental: structure, argument, pacing; light), Theo (line: clarity, word choice, tone and voice; standard), Ruth (copyedit: claims and citations, grammar and mechanics; thorough) and Sam (first reader: clarity, pacing, character and dialogue; light).
- **Feedback is a chat.** The Feedback panel is a conversation, like a chatbot. Choose an editor from a dropdown (name and role) and say anything: a canned question, a question of your own, or "review this chapter". The editor always answers in the chat. When the message calls for it ("review this", "where does it drag?") it also leaves margin notes, within its lenses and intensity caps, and the reply links to them; a plain question ("is this title working?") gets only an answer.
- **Context is automatic.** By default the editor reads the open document. A selection is attached to the message as a removable quoted chip, and a **Whole project** toggle sits by the composer.
- **One conversation per project, plus New chat.** The editor remembers the running conversation (prior turns go into its context within a budget). **New chat** starts fresh; past chats stay in a history list you can reopen. You can switch editors mid-chat; each reply is labeled with the editor who gave it. Reviews and Discuss threads from before the chat stay readable in history.
- **While the editor works:** "Margaret is reading…" with live progress as notes land ("Left a note on ‘sideways’"), and **Stop**. A failure shows inline with **Retry**. You can keep writing meanwhile; anchors survive your concurrent edits.
- **The record.** Each message records, in the project's ledger, which editor was asked and its name, role, brief, lenses and intensity at that moment, so the record stays self-contained after the editor changes or is deleted. Nothing the editor says enters the manuscript.
- An empty chat offers the editor's canned questions; tapping one fills the composer.

### F4 — Suggestions (wording)

- Kinds: **word or phrase choice** (1–3 alternatives), **insert one sentence**, and a **rephrase hint** that says what to change without supplying the text.
- Shown in a distinct AI color and style, with a dotted underline on the original span. The suggested text appears as ghost text inline or on a margin card.
- **You can't select or copy ghost text.** It's drawn as a decoration, not stored as document text.
- **Trace-over retyping:** put the caret on the span and type. Characters that match the ghost turn from AI color to your color as you go. A full match resolves the suggestion as **adopted (retyped)**. If you diverge, it resolves as **adapted**.
- Each card has **Dismiss** (with an optional reason: not my voice, wrong, later) and **Discuss**, which opens the feedback chat with that note attached (a chip above the composer). The editor's answer arrives in the chat and stays in the annotation layer.
- A suggestion goes **stale** automatically when the text under its anchor changes.

### F5 — Proposals (structure)

- Kinds: **move** a contiguous span (sentence, paragraph or section), **cut** a span, **split** a paragraph, **merge** adjacent paragraphs.
- Shown as a diff preview: the source span outlined, a drop marker at the destination, strike-through for cuts.
- **Accept** is one click, logged as a human-authorized edit of an AI proposal. Moved words keep their original provenance.
- A proposal can never change any words inside the span it moves.

### F6 — Provenance view

- A toggle tints text by origin: typed, typed from a suggestion, pasted, imported, quoted from a source. A legend shows the share of words in each.
- **Span inspector:** click any text to see when it was typed, in which session, whether a suggestion was showing at the time, and how it has moved.
- **Replay:** a timeline scrubber redraws the document at any point in the ledger, with playback at 1–64×. AI sessions appear as markers.

### F7 — Authorship report

- For a document or project: words by provenance class, active writing time, sessions, AI sessions requested, suggestions by outcome, proposals accepted, and paste events with their sizes.
- **Disclosure statement** generated from the data by a template, not by an LLM. For example: "Written in 14 sessions over 9 days. 97.8% typed directly; 1.6% retyped from 11 AI word-choice suggestions; 0.6% pasted (2 cited quotations). AI proposed 3 paragraph moves; 2 accepted."
- **Verification bundle:** the ledger, the server's witness signatures and the report, checkable with an open-source verifier. A read-only share link with replay comes later.

### F8 — Research and citations

- **Sources library:** add a source by URL, DOI, ISBN or by hand. Metadata is fetched (Crossref, Open Library, page metadata) and stored as CSL-JSON.
- **Clippings:** quotes saved with their location. Placed in the manuscript, a clipping becomes a quote block that carries its source's provenance; it is never counted as typed.
- **Cite:** inserts a structured citation node, not text, tied to a source and a page locator. The bibliography renders in CSL styles such as APA, MLA and Chicago.
- **AI research tools:** flag claims that need a source, search for candidate sources (labeled *AI-surfaced*, unverified until you check them), and suggest which library source supports a claim. The AI never writes the claim itself.

### F9 — Export

- Markdown, DOCX and PDF, with an optional provenance appendix or verification link. Links stay live (`[text](url)`, Word hyperlinks, PDF link annotations) and inline code is set in a monospaced face.

### Not in v1

- AI drafting, continuation, autocomplete, or "accept all".
- Real-time co-editing between people. The ledger records an actor on every event, so it can come later.
- Detecting AI text written elsewhere and retyped. The report says plainly that it can't.
- Offline writing and desktop apps. Longhand is web-only. Short connection drops are queued, but it isn't built for offline work.
- Sign-up, sharing and billing. The data model is ready for them (see Architecture).

## Suggestion lifecycle

_[Diagram: suggestion lifecycle · 1 open state, 4 outcomes]_

Only the two highlighted outcomes put words on the page, and the writer types both. Proposals (move, cut, split, merge) follow the same path but close with one click on Accept or Reject. Every transition is a ledger event.

## Provenance and ledger

Who wrote what is **derived by replaying the ledger, never stored as editable marks**. Any copy of the ledger re-folds to the same document and the same provenance, so a verifier can check it on its own.

### Authorship classes

| Class | How text gets it | Counts as the writer's own? |
| --- | --- | --- |
| Typed | Keyboard input in the editor | Yes |
| Typed from a suggestion | Typed while a matching suggestion was open nearby (normalized edit distance of 0.15 or less, or 4 or more consecutive words matching any open suggestion) | Yes, disclosed as AI-assisted |
| Pasted (external) | Clipboard content not from this project | No, flagged with its size |
| Pasted (internal) | Copied from elsewhere in the project | Inherits the original span's class |
| Imported | An existing draft brought in at creation | Unverified, labeled as such |
| Quoted from a source | A clipping or quote block tied to a source | Quoted, not authored |

Moves and cuts don't change a span's class; they're recorded in its history.

### Ledger shape

One ledger per project: an append-only stream that is the unit of consistency (the same aggregate pattern as hotseat's workspace stream). Each commit carries `seq`, `prevHash`, `hash`, client time, server time, `actor` (human, agent or system, plus an id), `deviceId`, `sessionId`, `type`, `schemaVersion` and `payload`.

| Actor | Events | Touches the manuscript? |
| --- | --- | --- |
| Human | `TextEdited` (a batch of editor steps, input method typed, pasted or IME, and its keystroke timeline) · `PasteOccurred` · `ProposalAccepted` / `ProposalRejected` · `SuggestionDismissed` · `ChatMessageSent` · `FeedbackRequested` · `SourceAdded` · `CitationInserted` | Yes. These are the only events that can |
| Agent | `FeedbackSessionStarted` · `CommentAdded` · `SuggestionProposed` · `MoveProposed` / `CutProposed` · `CitationNeededFlagged` · `SourceSurfaced` · `QuestionAsked` · `ChatReplied` · `ReviewFinished` | Never. Annotation layer only |
| System | `SuggestionResolved` (adopted, adapted or stale) · `ChainHeadWitnessed` | Never |

- **Batching:** the client coalesces editor steps into one commit after about 2 s idle or 50 steps, whichever comes first.
- **Cadence:** each `TextEdited` carries a full keystroke timeline: a timestamp for every key event, plus characters and duration. It's always recorded, and it's included in the verification bundle.
- **Ingest validation:** the server re-applies every commit's steps to its own copy of the document and rejects any agent-actor event that would change manuscript text.

### Integrity

- **Hash chain:** each commit hashes its contents with the previous hash, so any later edit to history breaks the chain.
- **Server witnessing:** the server signs `(projectId, seq, hash, serverTime)` for each commit. Even the account owner can't backdate or rewrite history without the signatures failing.
- **Later:** RFC 3161 timestamps or public anchoring of chain heads, so the record doesn't depend on trusting our server.

### What the record proves, and what it doesn't

| Proves | Does not prove |
| --- | --- |
| The text came in through the editor's input channel, at these times and this cadence | That the account holder was the one typing |
| Exactly which AI suggestions were visible, and which were retyped or used | That nothing was transcribed from another screen or another AI |
| The history hasn't been changed since the server witnessed it | That a modified client didn't misreport pastes as typing (the keystroke timeline makes this costly, not impossible) |

The report prints this table, so readers know exactly what they're looking at.

### Verifier

An open-source CLI and a web page take a verification bundle, check the chain and signatures, re-fold the ledger, and recompute the report from scratch. If the recomputed report doesn't match the one shared, verification fails.

## The AI editor

The editor runs server-side as a Claude agent with read tools and narrow, bounded annotation tools. **None of its tools writes manuscript text**, so the invariant holds by construction, not by prompt.

### Context it gets

1. **System prompt** (stable, prompt-cached): role, the authorship covenant, how to give feedback.
2. **Project context:** genre, audience, the writer's stated goals, their style notes, and the binder outline with synopses.
3. **Target text, segmented:** each sentence gets a stable id, e.g. `[p3.s2] The rain fell sideways…`. Nearby chapters come as summaries.
4. **Feedback history:** past suggestions and what happened to each, so the editor doesn't repeat itself and learns the writer's voice.
5. **The message:** the editor asked (its name, role, and its brief quoted as the writer's own words), what the writer is looking at (the document, an attached selection, the whole project, or a note they are asking about), lenses, intensity, and the writer's message.
6. **The conversation so far:** earlier turns of the chat, each labeled by speaker and editor, newest kept within a budget.

### How it points at text

An anchor is a sentence id plus an **exact quote** of the span, and an occurrence index if the quote repeats. The server checks that the quote really appears there, and the anchor then maps onto the editor's own positions. That's sturdier than character offsets, which models get wrong.

### Tool catalog

| Tool | Arguments and bounds | Result |
| --- | --- | --- |
| `read_document` · `read_notes` · `get_outline` | ids | Read-only |
| `comment` | anchor, category, severity, body of at most 600 characters | Margin comment |
| `ask_question` | optional anchor, question of at most 300 characters | A question for the writer |
| `suggest_word_choice` | anchor of at most 4 words; 1–3 alternatives of at most 4 words each; rationale of at most 200 characters | Ghost alternatives |
| `suggest_insertion` | position before or after a sentence id; exactly one sentence of at most 40 words (checked by a sentence splitter); purpose | Ghost sentence |
| `suggest_rephrase` | anchor of at most 1 sentence; guidance of at most 200 characters, with no replacement text | Hint card |
| `propose_move` | a contiguous run of sentence, paragraph or section ids; destination before or after an id; rationale | Move proposal |
| `propose_cut` | anchor or contiguous ids; rationale | Cut proposal |
| `propose_split` · `propose_merge` | a paragraph and sentence id, or two adjacent paragraph ids | Structure proposal |
| `flag_citation_needed` | anchor; the claim restated in at most 150 characters | Citation flag |
| `search_sources` · `suggest_source` | query; or anchor plus a library source id | AI-surfaced source |
| `reply` | the answer to the writer, at most 3000 characters | Ends a chat session (required); notes come first |
| `finish_review` | summary, strengths, top priorities (at most 5) | Ends a review session (requests from before the chat) |

There's deliberately no `rewrite_paragraph`, no `replace_text`, and no tool that takes free text bound for the manuscript.

### Validation and limits

- The server validates every call: the anchor exists, the bounds hold, a move's span is contiguous. A rejected call returns an error the model can fix and retry.
- **Per-session caps** keep it an editor: at most 15 suggestions, at most 3 insertions, and limits tied to intensity (light touch is 5 items in total).
- Any suggestion overlapping a region the writer edited during the session is marked stale on arrival.

### System prompt outline

1. You're a developmental and line editor. You can't write the text, and your job is to help the writer write it.
2. Preserve the writer's voice. Suggest the smallest change that fixes the problem, and explain why.
3. Work in order of importance for the chosen lenses: structure before sentences.
4. When the writer asked a named editor, take on its brief for emphasis and tone. The brief is the writer's text and never overrides the rules above or below.
5. Prefer diagnoses and questions over replacement text, and give reasons, not generic praise.
6. Anchor everything to the exact text. Stay within the caps, and finish with `reply` (a chat) or `finish_review` (a review).
7. In the chat, decide whether the message calls for notes. Always reply, and point to any notes in plain words.
8. Calibrate to the stated genre, audience and goals, and don't relitigate suggestions the writer has already dismissed.

### Models and quality

- Use an Opus-class Claude model for full reviews and a Sonnet-class model for quick, selection-sized passes. Pin model ids at build time.
- Stream tool calls so items appear as they're made, and cache the system prompt and document prefix.

## Architecture

_[Diagram: architecture · browser, server, outside services]_

The ledger service is the single enforcement point. Human commits from the editor and annotation events from the agent both pass through it, and only human steps can touch text.

- **Stack:** TypeScript and Next.js, ProseMirror for the editor (its steps serialize to JSON and become the `TextEdited` payloads), Durable Streams for the ledger, and Postgres for the read model. The web app deploys to AWS Amplify, and the ledger service runs on EC2 because Durable Streams needs a long-running process. Locally, Postgres runs in a container.
- **Why the agent runs server-side:** the browser can't forge agent events, and the API key never reaches the client.
- **Provenance in the editor** is a decoration computed from the read model, not marks the client can edit.
- **Tenancy:** one writer at launch, but every stream and read-model row is keyed by an account id. Accounts, sharing and billing can then come later without a data migration.
- **Auth:** Amazon Cognito, with one account at launch. Opening sign-up later is configuration, not code.
- **Witness key:** an asymmetric AWS KMS key signs every witness, so the private key never leaves KMS. Local development signs with a dev key file. The public key is published so verifiers can check signatures.
- **Dropped connections:** the editor keeps working. Commits queue in IndexedDB with their client time and sync on reconnect. The server witnesses them when they arrive, and the report marks the gap as an unwitnessed interval.

## Build plan and testing

The build runs in seven milestones, each ending in something you can use. The MVP ships after M6. The ledger comes before the AI, because everything else depends on the record being right.

1. **M0 — Editor spike.** ProseMirror editor with typewriter scrolling and focus mode, plus a local ledger with replay. This proves the core feel.
2. **M1 — Ledger and provenance.** Server ledger with hash chain and witnessing, paste detection, the provenance tint, span inspector and replay scrubber.
3. **M2 — AI feedback.** Feedback requests, the agent service, comments, questions and `finish_review`, streamed into the margin.
4. **M3 — Suggestions and proposals.** Word choice, insertion and rephrase with trace-over retyping, move, cut, split and merge proposals, and stale detection.
5. **M4 — Report and verifier.** Authorship report, disclosure statement, verification bundle, and the open-source verifier CLI.
6. **M5 — Binder and export.** Projects with multiple documents, notes, nested folders, and Markdown, DOCX and PDF export.
7. **M6 — Research and citations.** Sources library, clippings, citation nodes, CSL bibliographies and the AI research tools.

### What we test

- **Invariant property tests:** for any random sequence of events, no agent-actor event ever changes manuscript text, and every manuscript character traces back to a human input event.
- **Determinism:** replaying the ledger always yields byte-identical document and provenance, and the verifier agrees with the server.
- **Tamper detection:** editing, reordering or dropping any event breaks verification.
- **Editor end-to-end (Playwright):** the caret stays centered across wrapping, IME and paste; trace-over turns ghost text to human color and resolves the suggestion; external paste is flagged; ghost text can't be copied.
- **Agent tools:** each tool rejects anchors that don't exist, out-of-bounds lengths, multi-sentence insertions and non-contiguous moves, and caps are enforced.

## Implementation

Only the contracts, the ledger core and the integration gates are serial, and one orchestrating agent owns them. Everything else runs as nine parallel lanes, one subagent per lane, tested against shared fixtures. Milestones become integration checkpoints rather than a strict sequence: a lane starts once its inputs exist, whatever milestone it belongs to.

_[Diagram: implementation fan-out · 4 serial steps, 9 lanes]_

The lanes are step 4. Every lane meets again at the integration gate, which is the only place cross-lane behavior gets tested.

### Serial spine

The orchestrator does these steps in order. Nothing fans out until step 2 has merged.

1. **Scaffold.** A monorepo in the longhand repo with one package per lane, shared lint, type-check and test config, Docker Compose for local Postgres, and CI that runs every package's tests.
2. **Contracts (****`packages/schema`****).** Everything two lanes both depend on, written as types and JSON schemas:
  - the ledger event types and payloads, with `schemaVersion`
  - the ProseMirror document schema, including citation nodes, quote blocks, scene breaks and footnotes
  - the anchor format (sentence id, exact quote, occurrence index) and the sentence segmenter that assigns ids
  - the agent tool schemas and the verification bundle format
3. **Ledger core (****`packages/ledger`****).** The deterministic fold from events to document and provenance, the authorship classes (including the "typed from a suggestion" matcher), and the hash chain. It ships with **golden fixtures**: hand-built ledgers with their expected documents, provenance and reports. Lanes test against these, so no lane waits on another to run its tests.
4. **Fan out** to the lanes below.
5. **Integration gate**, one per milestone. Merge the lanes that milestone needs, run the invariant property tests, the determinism tests and the Playwright suite, and fix what breaks before the next gate opens.

### Parallel lanes

Each lane is one subagent working in one package. Five lanes need only the contracts. Three wait for the ledger core. Annotations is the only lane that waits on another lane, the editor, and it can build its cards against a stub editor until then.

| Lane | Package | Builds | Can start after | Tests against |
| --- | --- | --- | --- | --- |
| Editor | `packages/editor` | F1: typewriter scrolling, focus mode, input rules, word counts, input-method and paste capture, offline commit queue | Contracts | Playwright on the editor alone |
| Agent | `packages/agent` | F3 backend: context builder, tool handlers and validation, caps, system prompt | Contracts | Fixture documents |
| Binder | `packages/binder` | F2: projects, nested folders, drag to reorder, corkboard, notes | Contracts | Component tests |
| Export | `packages/export` | F9: Markdown, DOCX and PDF, provenance appendix | Contracts | Golden documents, snapshot outputs |
| Research | `packages/research` | F8: sources library, metadata fetch, clippings, citation nodes, CSL bibliography, research tools | Contracts | Recorded metadata responses |
| Server | `apps/server` | Cognito auth, ingest and validation, KMS witnessing, Durable Streams storage, Postgres read model | Ledger core | Golden fixtures, agent-event rejection tests |
| Provenance | `packages/provenance-ui` | F6: tint and legend, span inspector, replay scrubber | Ledger core | Golden fixtures |
| Report and verifier | `packages/report`, `packages/verifier` | F7: report, disclosure template, bundle export, verifier CLI and web page | Ledger core | Golden fixtures with expected reports |
| Annotations | `packages/annotations` | F3 feedback panel, F4 ghost text and trace-over, F5 diff previews and accept | Editor lane | A mock agent that replays recorded event streams |

### What stays serial after fan-out

- **Contract changes.** A lane that needs a new event type, schema field or tool argument asks the orchestrator. The orchestrator changes `packages/schema`, bumps `schemaVersion` where needed, regenerates the fixtures and rebases the affected lanes. No lane edits the contracts itself.
- **The fold.** Any change to how the document or provenance is derived goes through `packages/ledger`, one change at a time. Two agents editing the fold at once is how determinism breaks.
- **Database migrations.** Postgres migrations are numbered and merged one at a time, and only the server lane writes them.
- **The enforcement point.** Changes to ingest validation get their own review before merge, because that's where the invariant is enforced.

### How each subagent works

- **Its own worktree.** Each subagent works on its own git worktree and branch, and touches only its own package.
- **A narrow brief.** It gets its row of the lanes table, the contracts, the golden fixtures, and the spec sections for its features. Nothing else.
- **Done means green on fixtures.** A lane is ready to merge when its own tests and the contract tests pass. Behavior that spans lanes is proven at the integration gate, not inside a lane.
- **Test runs fan out too.** Playwright suites and fixture tests can be split across subagents at any gate.

## Decisions

All open questions were settled on 2026-11-24.

| Question | Decision |
| --- | --- |
| Where does it get built? | In the longhand repo, as a standalone app. It reuses Durable Streams for the ledger and borrows hotseat's patterns (one stream per aggregate, consistency tokens, deterministic folds). It isn't a hotseat page type: prose editing produces character-level operations at a high rate, and hotseat's block model defers inline splicing. |
| Who is it for? | Personal first, built so it can become a product. One writer at launch, with no sign-up, sharing or billing. Data is keyed by account id from day one. |
| Which platform? | Web only, online. No offline writing or desktop app in v1. |
| Do moves and cuts stay one-click? | Yes. They add no AI words, and every accept is logged. |
| How strong is verification at launch? | The server-witnessed hash chain, so readers trust the server's signatures. RFC 3161 timestamps or public anchoring come later. |
| How much keystroke timing do we keep? | The full keystroke timeline, always. It's stronger evidence that text was typed, at the cost of storage and of putting personal typing data in every shared bundle. |
| Can existing drafts be imported? | Yes, labeled *imported (unverified)* in every report. |
| How do you sign in? | Amazon Cognito, with one account at launch. Opening sign-up later is configuration. |
| Where does it run? | In production, the web app runs on AWS Amplify and the ledger service on EC2. Locally, Postgres runs in a container. |
| Where does the witness signing key live? | An asymmetric AWS KMS key in production and a dev key file locally. The public key is published for verifiers. |
| How strict is "typed from a suggestion"? | Strict: normalized edit distance of 0.15 or less against an open suggestion, or 4 or more consecutive matching words. |
| What happens when the connection drops? | Writing continues. Commits queue in IndexedDB and sync on reconnect, and the report marks the gap as an unwitnessed interval. |
