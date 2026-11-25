# @longhand/editor

**Lane:** Editor (F1). The ProseMirror manuscript editor and everything between a keystroke and a ledger commit draft: typewriter scrolling, focus mode, Markdown-style input rules, word counts, input-method and paste capture, the keystroke timeline, commit batching, the IndexedDB offline queue, and client-side rebase.

The package never lets anything but real user input change the manuscript. Every doc-changing transaction passes the **input guard**, which classifies it by input method from trusted DOM events, or refuses it.

```sh
pnpm --filter @longhand/editor typecheck
pnpm --filter @longhand/editor test   # Vitest (jsdom)
pnpm --filter @longhand/editor demo   # http://localhost:4317
pnpm --filter @longhand/editor e2e    # Playwright against the demo
```

The e2e suite uses installed Google Chrome (`channel: 'chrome'`) when it finds it. Otherwise it uses Playwright's bundled Chromium, which needs `pnpm --filter @longhand/editor exec playwright install chromium` once. Set `PW_BUNDLED_CHROMIUM=1` to force the bundled browser. The demo server starts automatically, or a running `pnpm demo` is reused.

## Usage

```tsx
import { LonghandEditor, type EditorHandle } from '@longhand/editor';
import '@longhand/editor/styles.css';

<LonghandEditor
  projectId={projectId}
  documentId={documentId}
  actorId={userId}
  doc={documentJSON} // ProseMirror JSON at `version`
  version={version} // ledger document version (cumulative steps)
  transport={transport} // your CommitTransport (see below)
  settings={{ caretRatio: 0.5, focusMode: 'off', typewriter: true, dailyGoal: 1000 }}
  extraPlugins={plugins} // annotation / provenance plugins and decoration layers
  onStatus={(s) => setSave(s.state)} // 'saved' | 'queued' | 'offline' | 'error'
  onWordCount={(c) => setCounts(c)} // { document, selection, session, daily }
  onReady={(handle) => (editor.current = handle)}
/>;
```

Without React, use `createEditorView({ mount, ...sameOptions })`. It returns the same `EditorHandle`.

`<LonghandEditor>` recreates the editor when `projectId`, `documentId`, `transport` or `queue` change. `settings`, `extraPlugins` and `editable` update in place. Callbacks may change between renders.

### Options (`CreateEditorOptions`)

| Option                                                                      | Default                                       | Notes                                                                                                  |
| --------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `projectId`, `documentId`, `actorId`                                        | required                                      | `actorId` is the human actor id on every draft                                                         |
| `doc`, `version`                                                            | empty doc, `0`                                | the ledger's document and its version                                                                  |
| `transport`                                                                 | required                                      | `CommitTransport`                                                                                      |
| `queue`                                                                     | one `IndexedDbQueue` per project per page     | `MemoryQueue` where IndexedDB is missing                                                               |
| `flusher`                                                                   | `sharedFlusher(queue, transport)`             | one flusher per queue                                                                                  |
| `deviceId` / `sessionId`                                                    | persisted in localStorage / random per load   |                                                                                                        |
| `settings`                                                                  | `DEFAULT_SETTINGS`                            | `typewriter`, `caretRatio` (clamped 0.33–0.6), `focusMode` (`off`/`sentence`/`paragraph`), `dailyGoal` |
| `extraPlugins`                                                              | `[]`                                          | appended after the core plugins                                                                        |
| `scrollContainer`                                                           | window                                        | element that scrolls, for typewriter mode                                                              |
| `batch`                                                                     | `{ idleMs: 2000, maxSteps: 50 }`              |                                                                                                        |
| `inputPolicy`                                                               | `refuse` in development, `flag` in production | see "Input guard"                                                                                      |
| `dailyBaseline`, `dailyStorage`                                             | localStorage                                  | words written today before this editor opened                                                          |
| `attributes`                                                                |                                               | extra attributes on the editable element                                                               |
| `onWordCount`, `onStatus`, `onVersion`, `onError`, `onViolation`, `onDraft` |                                               |                                                                                                        |
| `placeholder`                                                               | `'Begin here.'`                               | hint in an empty document (one empty paragraph); `null` turns it off. See "Placeholder"                |
| `bubble`                                                                    | on                                            | the bubble toolbar; `false` turns it off, `{ suppress }` says when it must hide. See "Bubble toolbar"  |
| `trustSyntheticEvents`                                                      | `false`                                       | **tests only**: treat synthetic DOM events as user input                                               |

## Extension points (for annotations, provenance-ui, research, apps/web)

All of these live on `EditorHandle` or are exported from the package root.

- **Plugins.** Pass `extraPlugins`, or call `handle.setExtraPlugins(plugins)` at runtime (state reconfigure). Plugins may add decorations, node views, props, DOM handlers and plugin views. They **cannot** change the manuscript. The guard refuses any doc change that no input event explains, including `appendTransaction` output and `view.updateState` with a hand-built state, which is reverted.
- **Decoration layers.** `createDecorationLayer(name)` returns `{ key, plugin, set, clear, get }`. Add `layer.plugin` to the editor, then call `handle.setDecorations(layer, decorations, version?)`. `decorations` are plain `LayerDecoration`s (`inline` / `node` / `widget` with numeric positions). If you pass `version` (a ledger version, for example the version the read model computed provenance runs at), positions are mapped onto the current local document, which may hold unacknowledged steps. The call returns `false` when that version is too old to map; fetch fresh data and retry. After that the set maps itself through every transaction. Ghost text belongs in widget decorations, so it can never be selected or copied as document text.
- **Versions and remote updates.**
  - `handle.version()` returns `{ confirmed, local }`.
  - `handle.mappingFrom(version)` returns a `Mapping` from that ledger version to the local document, or `null`.
  - `handle.on('version', (c: VersionChange) => …)` fires on every local capture, acknowledgement and remote update. Remote updates carry `remote: { update, mapping }`, where `mapping` maps the old local document to the new one.
- **Events.** `handle.on(event, listener)` covers these events:
  - `update` (`{ state, prevState, transactions }`)
  - `input` (`{ tr, tag }`: every captured local doc change with its `InputTag`)
  - `version`, `status`, `wordCount`, `draft` (every queued `CommitDraft`)
  - `error` (`SyncError`) and `violation` (`GuardViolation`)

  Each call returns an unsubscribe function.

- **Reading a transaction's input method.** `inputTagOf(tr)` returns the guard's `InputTag` (`method`, `kind`, `pasteId`, `citationId`, `clippingId`, `traceSuggestionId`, `paste`). `isRemoteTransaction(tr)` is true for ledger steps applied from elsewhere. Trace-over in the annotations lane can watch `input` events and compare typed text with its ghost text.
- **Trace-over.** `handle.setTraceSuggestion(id | null)`. While set, `typed`/`ime`/`autocorrect` runs carry `traceSuggestionId`. It is a disclosure hint only; the fold's matcher decides.
- **Declared input for commands (citation, clipping).** Any package can dispatch a command on a user gesture with `tr.setMeta(INPUT_METHOD_META, { run, companions, characters, keystroke })`, where `INPUT_METHOD_META = 'longhand/input-method'` and `DeclaredInput` come from `@longhand/schema` (the editor re-exports both). For one version the guard also reads the old keys `'longhand/editor-input'` (`EDITOR_INPUT_META`, deprecated) and `'longhand/research-input'` (`RESEARCH_INPUT_META_ALIAS`, deprecated), listed in `LEGACY_INPUT_META_KEYS`. The guard accepts it only if all of these hold:
  - a trusted pointer or key event happened within 500 ms;
  - `run.method` is `citation` (inserts only `citation` nodes, needs `citationId`, and every companion is a `CitationInserted` for that id) or `clipping` (inserts only a `quote_block` with paragraphs and text, needs `clippingId`, no companions);
  - `run.steps === tr.steps.length`;
  - nothing is deleted.

  The batcher then:
  - queues each companion before the `TextEdited` that carries the steps;
  - appends `run` as its own run (runs merge only when method and ids are equal);
  - records the `keystroke` entry (kind `cite` for a citation, `clip` for a clipping; `handle.insertCitation` and `handle.insertClipping` use them).

  `characters` is informational. The batch total is computed from the steps with the same rule (text plus hard breaks). `handle.insertCitation({ sourceId, locator })` and `handle.insertClipping({ clippingId, sourceId, locator, text })` are built-in versions of the same commands.

- **Other human events.** `handle.acceptProposal(proposalId)` flushes pending steps and queues `ProposalAccepted` at the local version. The steps the fold derives come back as a remote update, and local edits typed meanwhile are rebased over them. `handle.submitEvent(type, payload)` queues any other human event (`SuggestionDismissed`, `ProposalRejected`, `FeedbackRequested`, …) in order with the text drafts. `TextEdited`, `PasteOccurred`, `SliceCopied` and `CitationInserted` are excluded, because only the editor's own capture may produce them.
- **Commands and keymaps.** These are exported for reuse: `editorKeymaps(guard)`, `editorInputRules(guard)`, `insertHardBreak`, `insertSceneBreak`, `insertFootnote`, `granted(guard, cmd, grant)`, the link helpers and bubble commands (see "Links and inline code" and "Bubble toolbar"), `focusPlugin`/`focusKey`, `typewriterPlugin`/`typewriterKey`, and `createInputGuard`, for embedding the guard in another view.
- **Placeholder.** An empty document (one empty paragraph) shows a faint italic hint, `placeholder` (default `DEFAULT_PLACEHOLDER`, "Begin here."). It is a widget decoration (`placeholderPlugin`), never document text: `aria-hidden`, `contenteditable="false"`, unselectable, absolutely placed so the caret stays at the start of the line, gone on the first keystroke and hidden when the editor is read-only. `isEmptyDocument(doc)` is the test it uses.
- **Styling.** `styles.css` themes everything through CSS variables on `.lh-editor`, such as `--lh-ink`, `--lh-ink-dim`, `--lh-paper`, `--lh-accent`, `--lh-font`, `--lh-measure` (66ch) and `--lh-caret-ratio`. Dark mode follows `prefers-color-scheme` or an ancestor's `data-theme="dark|light"`.

## Input guard and capture

The guard (`createInputGuard`) is the first plugin. It classifies in `filterTransaction` from a tracker that records **trusted** events: `keydown`, `beforeinput`, `composition*`, `paste`, `drop`, `cut` and `copy` on the editor (capture phase), plus pointer and key activation anywhere in the page. Tags live in a module-private `WeakMap` and cannot be forged.

| Transaction                                                             | Method                                                                      | Needs                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typing (DOM change, `handleTextInput`, Longhand keymap and input rules) | `typed`                                                                     | editor input event ≤ 500 ms ago, and inserted characters ≤ the characters the writer actually typed (`beforeinput` data). Longhand's own commands carry grants for nodes they insert (hard break, scene break, footnote, undoing an input rule). |
| Composition                                                             | `ime`                                                                       | composition events, with inserted text ≤ composition length                                                                                                                                                                                      |
| `insertReplacementText`                                                 | `autocorrect`                                                               |                                                                                                                                                                                                                                                  |
| Undo/redo (prosemirror-history)                                         | `history`                                                                   | user input                                                                                                                                                                                                                                       |
| `uiEvent: paste`                                                        | `pasted-internal` or `pasted-external` + `PasteOccurred`                    | a trusted `paste` event. Internal only if the clipboard marker names this project **and** its hash equals the inserted text's                                                                                                                    |
| `uiEvent: drop`                                                         | `drop-internal` (drag began in this editor) or `pasted-external` via `drop` | a trusted `drop` event                                                                                                                                                                                                                           |
| `uiEvent: cut`                                                          | `typed`, kind `cut`                                                         | a trusted `cut`                                                                                                                                                                                                                                  |
| marks/block type only, no text in or out                                | `typed`, kind `format`                                                      | any user activation (toolbar buttons)                                                                                                                                                                                                            |
| declared citation/clipping                                              | `citation` / `clipping`                                                     | see above                                                                                                                                                                                                                                        |

Violations are refused under policy `refuse`. Under `flag`, a violating _insertion_ is let through as `pasted-external` with a synthesized `PasteOccurred`, so a writer never loses text to a classification gap and nothing is overclaimed. Deletions and format changes without input are refused under both policies.

**Copy/cut.** The editor flushes pending steps and queues `SliceCopied` (positions at the local version). It then writes `text/html` and `text/plain` plus the private marker (`MARKER_MIME = application/x-longhand-slice`, mirrored in a `data-longhand-slice` attribute) carrying `{copyId, projectId, documentId, textHash}`. A cut's deletion follows as a normal `typed` step with kind `cut`.

**Timeline.** Every captured transaction adds one keystroke entry, two when typing replaces a selection (`delete` then `insert`). `t` is in ms after the batch's first input event (`clientTime`), and `len` counts characters inserted or removed. Keys that do not change the document, such as arrows, are not recorded.

## Batching, queue and sync

- **Batching** (`DocumentSync`). Steps collect into one `TextEdited` after `idleMs` without input or at `maxSteps` steps. Transactions are never split unless one exceeds 500 steps. Companion events are queued before the steps that need them. The batch also flushes on copy/cut, `submitEvent`, `acceptProposal`, `pagehide` and when the tab is hidden.
- **Queue.** `IndexedDbQueue` (database `longhand-editor`, store `queue`) is a write-ahead log in enqueue order, scoped by project, unique by `commitId` (dedupe). `replace` keeps an entry's position. `MemoryQueue` has the same API.
- **Flusher** (`CommitFlusher`). Submits one draft at a time, in order, and handles each result:

  | Result               | What happens                                                                                                                                                                            |
  | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `ack` / `duplicate`  | Removed. The owning editor advances its confirmed version.                                                                                                                              |
  | `offline` or a throw | Draining pauses, with backoff (1 s up to 30 s) and an immediate retry when the transport reports it is online.                                                                          |
  | `conflict`           | The owner catches up (`fetchSince`) and rebases. Drafts no open editor owns, such as another tab's or a closed document's, are rebased headlessly with step maps (`reconcileHeadless`). |
  | `rejected`           | Dropped and reported. The owner resyncs.                                                                                                                                                |

- **Rebase.** Remote updates whose `baseVersion` equals the confirmed version are applied by undoing local steps, applying the remote steps and re-applying mapped local steps (prosemirror-collab's algorithm, `rebaseOnDoc`). Local steps that no longer apply are dropped. Every unacknowledged `TextEdited` is then re-issued with a new `commitId` and `baseVersion`. Queued `SliceCopied` positions and versions are mapped. A `ProposalAccepted` that conflicts is dropped with an error, so the writer re-accepts it against the new text. Updates that arrive early are buffered, and a stalled gap triggers `fetchSince`. A snapshot answer reloads the document and re-applies local steps where they still fit.
- **Reload.** On start the editor restores its document's queued drafts (`handle.ready`). If the first draft's `baseVersion` equals the initial version, they are replayed so the writer sees unsynced text. Otherwise they are reconciled against `fetchSince` first, and drafts the ledger already holds (lost acknowledgements) are removed.

### `CommitTransport` (implemented by apps/web against the ledger service)

```ts
interface CommitTransport {
  submit(draft: CommitDraft): Promise<SubmitResult>; // ack{seq,version?} | duplicate | conflict{currentVersion} | rejected{reason} | offline
  subscribe(documentId, listener: (u: RemoteUpdate) => void): () => void;
  fetchSince(documentId, version): Promise<CatchUp>; // {kind:'updates', updates, version} | {kind:'snapshot', doc, version}
  connection(): 'online' | 'offline';
  onConnectionChange(listener): () => void;
}
interface RemoteUpdate {
  documentId;
  commitId;
  seq;
  type: 'TextEdited' | 'ProposalAccepted';
  baseVersion;
  version;
  steps: StepJSON[];
}
```

`subscribe` must deliver every step-bearing commit of the document in ledger order, including this client's own; a matching `commitId` also counts as an acknowledgement. For `ProposalAccepted`, `steps` are the steps the fold derived: `@longhand/ledger`'s `validateDraft(...).derivedSteps[documentId]` at ingest, or `derivedStepsFor(stateBefore, commit)` from history. The engine applies them like any remote steps, so no padding or diffing is needed. `MockTransport` implements all of this in memory. It validates with `CommitDraftSchema`, dedupes, checks versions, re-applies steps, can derive proposal steps, can go offline and add latency, can simulate another device with `remoteEdit`, and can persist to localStorage.

## Typewriter scrolling and focus mode

- The caret line is held at `caretRatio` of the scroll container's height, 50% by default and clamped to 33–60%. Top padding is `ratio × 100vh` and end padding is `(1 − ratio) × 100vh`, which is 50vh at the default, so the first and last lines can reach the caret line.
- While typing, every change re-centers instantly, including soft wraps, Enter, Backspace across lines, IME, paste and remote updates. ProseMirror's own scroll-into-view is suppressed.
- A pointer selection, wheel, touch or any scroll the editor did not cause unlocks the view, so it never jumps. The next keystroke or keyboard caret move re-centers with a 120 ms ease-out, or instantly under `prefers-reduced-motion`.
- Focus mode sets `data-focus` on the editable element and dims its text color. The current paragraph gets a node decoration and the current sentence an inline decoration, both `lh-focus-current`. Sentences come from the schema's `splitSentences`.

## Formatting

| Input                                     | Result                                 |
| ----------------------------------------- | -------------------------------------- |
| `# `, `## `, `### `                       | heading 1–3                            |
| `> `                                      | block quote                            |
| `- `, `* `, `+ `                          | bullet list                            |
| `1. `                                     | ordered list                           |
| `***` or `---` on an empty top-level line | scene break                            |
| `*em*`, `_em_`                            | emphasis                               |
| `**strong**`, `__strong__`                | strong                                 |
| `` `code` ``                              | inline code                            |
| `[text](url)`                             | link (only an allowed url)             |
| `^[`                                      | footnote (Pandoc's inline note syntax) |
| Backspace right after any of these        | undoes it                              |
| Mod-B / Mod-I / Mod-E                     | strong / emphasis / inline code        |
| Mod-K                                     | add or edit a link                     |
| Alt-F10                                   | focus the bubble toolbar               |
| Mod-Alt-1/2/3, Mod-Alt-0                  | heading 1–3, paragraph                 |
| Mod-Shift-8 / Mod-Shift-7                 | bullet / ordered list                  |
| Mod-Shift-. (or Ctrl->)                   | block quote                            |
| Mod-Shift-Enter                           | scene break                            |
| Mod-Alt-F                                 | footnote                               |
| Shift-Enter                               | line break                             |
| Tab / Shift-Tab                           | indent / outdent list item             |
| Mod-Z, Mod-Shift-Z, Mod-Y                 | undo, redo                             |

- **Mark rules** never fire inside inline code, so `**` typed in code stays literal.
- **Footnotes** open a small nested editor when selected. Its edits are forwarded to the main editor as offset steps, so they pass through the same guard.
- **Gap cursor.** `prosemirror-gapcursor` is enabled. A `quote_block` (or scene break) that ends the document gets a gap cursor after it, reached with arrow keys or by clicking below. Typing there inserts a new paragraph as `typed` input. No trailing paragraph is added automatically.

## Links and inline code

The schema's `link` mark (attr `href`) and `code` mark. Both are formatting: zero input units, kind `format`, words keep their class. The href is a mark attribute, never document text, so it is not counted as words and never reaches the matcher or attribution.

- **Href policy.** Every href goes through the schema's `normalizeHref`: only `http:`, `https:` and `mailto:`; `example.com` becomes `https://example.com` and `ada@example.com` becomes `mailto:ada@example.com`; `javascript:`, `data:`, relative paths and anything with whitespace or userinfo are refused. The mark's validator enforces the same rule, so pasted HTML with a bad href keeps its text and loses the link.
- **Ways in.** Mod-K or the toolbar's Link button, the `[text](url)` input rule, and pasting a URL over a non-empty selection (as Medium does). That paste is handled by `linkPastePlugin`: it adds the mark instead of inserting text, so no `PasteOccurred` is queued, the run is `typed` and the timeline entry is `format` with length 0. Only text that plainly is a link (`http(s)://…`, `mailto:…`, `www.…`, one line) counts; anything else pastes normally.
- **Non-inclusive.** Typing at a link's end does not extend it.
- **Clicks never navigate.** `linkClickPlugin` prevents the default on every click on a link in the editor. ⌘-click (Ctrl-click elsewhere) opens it in a new tab with `noopener,noreferrer`. Rendered links carry `rel="noopener noreferrer"` and `target="_blank"`.
- **Inline code** excludes bold and italic. It may sit inside a link.
- Helpers: `linkAt($pos, side?)`, `firstLinkIn(doc, from, to)`, `setLinkTr`, `removeLinkTr`, `linkPasteTr`, `openLink`.

## Bubble toolbar

A quiet floating toolbar (`bubblePlugin`, on by default) placed above a non-empty text selection, inside the editor root, so the demo and the web app both get it. It is plain DOM, themed by `--lh-bubble-*` variables, in light and dark.

- **Buttons:** Bold, Italic, Link, Heading (heading 1), Subheading (heading 2), Quote and Code. Each is a `<button>` with an `aria-label`, an `aria-pressed` state (pressed when the whole selection has it) and a title naming its shortcut. Buttons that cannot apply are disabled. Bold, Italic and Code add the mark unless the whole selection already has it.
- **Link field.** The Link button or Mod-K turns the toolbar into a URL field (`aria-label` "Link address"), pre-filled when the selection is already a link, with Remove then. Enter applies, Esc cancels, an empty value removes the link, and a refused href shows "Use an http, https or mailto link" (`role="alert"`) and keeps the field open. Leaving the field cancels it.
- **Link popover.** With the caret inside a link, the same element shows the URL (a real link that opens in a new tab) with Edit and Remove.
- **Footnotes.** In a footnote's nested editor only the mark buttons show. The nested editor also has Mod-B, Mod-I, Mod-E, Mod-K and Alt-F10, and pasting a URL over a selection links it.
- **Hidden** when the selection is collapsed (outside a link), while the mouse is still dragging a selection, during IME composition, when the editor is read-only or has lost focus, and while a dialog is open: any `role="dialog"` element or open `<dialog>` in the page, which covers the provenance inspector and annotation popovers. Pass `bubble: { suppress }` to decide yourself, or `bubble: false` to turn it off.
- **Keyboard (the pattern chosen).** The toolbar never takes focus on its own, so typing is never interrupted. Alt-F10 (the WAI-ARIA toolbar convention) moves focus into it, and Tab also reaches it from the editor outside lists, because it follows the editor in tab order and is a tab stop only while it shows. Inside, it is one tab stop with a roving tabindex: ←/→ move between buttons, Home and End jump to the ends, Enter or Space activates and keeps focus there, and Esc returns focus to the text with the selection intact. Mouse presses on the toolbar keep focus and the selection in the editor.
- **Provenance.** Every button dispatches with the guard's `format` grant: marks and block types only, no text in or out.
- Commands for hosts: `openLinkEditor` (Mod-K), `focusToolbar` (Alt-F10), `toggleHeading(level)`, `toggleBlockquote`, `toggleMarkAll(type)`, `isHeading`, `inBlockquote`.

## Word counts

`WordCounts = { document, selection, session, daily }`, all counted with the schema's `countWords`.

- Footnote text counts toward the document, kept separate so it never fuses with the word it is attached to.
- `session` is net words since the editor opened, never below zero.
- `daily` is `{ goal, written, progress }` when a goal is set. By default it counts from the document's word count at the first open of the day, stored in localStorage per document. The host can pass `dailyBaseline` for project-wide numbers.

## Tests

- **Vitest (jsdom):**
  - classification rules, including declared input;
  - drafts (runs, timeline, schema validity via `CommitDraftSchema`);
  - `MemoryQueue` and `IndexedDbQueue` (fake-indexeddb: order, dedupe, replace, persistence);
  - rebase (on doc, headless, dropped steps);
  - `DocumentSync` with fake timers and `MockTransport`: idle and 50-step batching, companion order, `SliceCopied` flush, offline then reconnect, dedupe, restore after reload, remote rebase, submit conflict, `SliceCopied` remapping, proposal steps, `mappingFrom`;
  - word counts;
  - the core in jsdom: guard refusals, plugin append, `updateState` revert, internal and external paste, cut, programmatic paste, input rules, shortcuts, citation and clipping commands, the research meta alias, trace hint, focus decorations, decoration layers;
  - formatting (`src/formatting.test.ts`): the `` `code` `` and `[text](url)` rules (a `javascript:` url stays text), no mark rules inside code, links not extending at their end, Mod-E and code excluding bold, pasting a URL over a selection (formatting only: no `PasteOccurred`, zero characters), pasted HTML links filtered by the policy, internal paste of linked text, clicks never navigating and Mod-click opening a new tab, hrefs never counted, and the bubble toolbar: when it shows and hides, every button with its pressed state and `format` timeline entries, the link field (Enter, Esc, refusal, pre-fill, Remove), Mod-K, the caret popover, Alt-F10 with arrows and Esc, and mark-only buttons in a footnote.
- **Playwright** (`e2e/`, Chrome):
  - caret held at 50% across soft wraps, Enter, Backspace across lines, paste and IME (CDP `Input.imeSetComposition` + `Input.insertText`);
  - configured ratio and clamping;
  - clicking and wheel-scrolling never jump, and the next key re-centers;
  - instant re-centering under reduced motion;
  - focus mode;
  - idle batching (no commit at 1.2 s, one `TextEdited` after ~2 s);
  - external paste classified `pasted-external`, internal copy/paste classified `pasted-internal` with the `SliceCopied → PasteOccurred → TextEdited` chain;
  - scripted inserts and pastes refused;
  - Markdown shortcuts;
  - the offline queue surviving a reload and flushing on reconnect;
  - `e2e/formatting.spec.ts`: the bubble toolbar's placement and buttons, keyboard access, links (Mod-K, refusal, the caret popover, no navigation, Mod-click to a new tab, Remove), pasting a URL over a selection, the `` `code` `` and `[text](url)` rules, and light and dark screenshots. **Written but not run yet** (it needs Chrome); the jsdom tests cover the same behaviour without layout.

## Known gaps

- **Deletions are not budgeted.** A plugin that deletes text within 500 ms of a real keystroke is classified `typed`. Insertions are budgeted against the characters actually typed.
- **Pending steps are in memory until the batch closes.** A crash can lose up to `idleMs` (2 s) of typing. Queued drafts are durable.
- **Multiple tabs share the IndexedDB queue** but each runs its own flusher, so the same draft may be submitted twice (deduped by `commitId`). Web Locks would serialize them.
- **Dragging between two editors** in the same page is classified `pasted-external`, which never overclaims. Drag inside one editor is `drop-internal`.
- **No typewriter scrolling inside the footnote popover.** Copying from inside a footnote does write the internal marker.
- **Undo history is reset** when a snapshot reload replaces the document.
- **IME and autocorrect classification is tested on desktop Chrome only.** Safari and Android composition paths are untested. Policy `flag` keeps writers from losing text there in production.
- **The daily goal is per document by default.** Pass `dailyBaseline` for a project-wide figure.
- **Bubble placement is untested without a browser.** jsdom has no layout, so the unit tests check visibility, state and commands, not position.
- **Bundled Chromium is not installed** in this environment, so the e2e suite was run against installed Chrome only.
