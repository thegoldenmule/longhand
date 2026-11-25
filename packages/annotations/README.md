# @longhand/annotations

**Lane:** Annotations. Everything the writer sees of the AI editor: the feedback chat (F3), margin cards for every annotation kind, ghost text and trace-over (F4), proposal diff previews with one-click accept (F5), dismiss, Discuss (in the chat), and the research cards (F8).

The AI writes only to the annotation layer, and this package keeps it there:

- **Ghost text is decoration, never document text.** In the editor it is a widget decoration. On cards it is a span outside any editable. Either way it is `aria-hidden`, `contenteditable="false"` and `user-select: none`, and a clipboard guard strips it from any copy or cut.
- **The writer's choices become human events.** Dismiss, reject, discuss and feedback requests go through `editor.submitEvent`. Accept goes through `editor.acceptProposal`, which carries no text: the fold derives the steps, so moved words keep their provenance.
- **Outcomes come from the fold.** Adopted, adapted and stale are read from `ProjectState`; nothing here decides them.
- **Calm by default.** Nothing appears until a review is requested. Word-choice ghosts show inline only for the suggestion the caret, pointer or a click is on. Proposal previews show only on hover or focus.

```sh
pnpm --filter @longhand/annotations typecheck
pnpm --filter @longhand/annotations test    # Vitest + Testing Library (jsdom)
pnpm --filter @longhand/annotations demo    # http://localhost:4319
pnpm --filter @longhand/annotations e2e     # Playwright against the demo (installed Chrome)
```

## Wiring it into the web app

```tsx
import { LonghandEditor, type EditorHandle } from '@longhand/editor';
import { AnnotationMargin, FeedbackChat, useAnnotations } from '@longhand/annotations';
import '@longhand/editor/styles.css';
import '@longhand/annotations/styles.css';

function Writing({ projectState, transport, documentId, progress }) {
  const [editor, setEditor] = useState<EditorHandle | null>(null);
  const ann = useAnnotations({
    documentId,
    editor, // the handle from onReady
    state: projectState, // the latest folded ProjectState from the ledger stream
    onCite: (req) => openCitationPicker(req), // research lane's <CitationPicker>
    onAddSource: (req) => openSourceCheck(req), // verify, then SourceAdded (fromSurfacedId)
  });
  // Live progress from the agent runner, relayed by the server (optional):
  useEffect(() => progress.subscribe((e) => ann.pushProgress(e)), [ann]);

  return (
    <>
      <div className="writing-page">
        {' '}
        {/* one scrolling container */}
        <LonghandEditor
          projectId={projectState.projectId}
          documentId={documentId}
          doc={projectState.documents[documentId].content}
          version={projectState.documents[documentId].version}
          transport={transport}
          extraPlugins={ann.plugins} // stable array: decoration layer + trace-over
          onReady={setEditor}
          {...rest}
        />
        <AnnotationMargin controller={ann} /> {/* beside the editor, same scroll */}
      </div>
      <FeedbackChat controller={ann} editors={editors} documentTitle={title} />
    </>
  );
}
```

Layout: put `<AnnotationMargin>` next to the editor in the **same scrolling container**, for example as the second column of a grid. It is `position: relative` and draws its cards absolutely, at the vertical position of their anchors. The chat can live anywhere with a fixed height (it fills its container). Add the provenance-ui plugins to the same `extraPlugins` array if you show provenance; the layers don't interact.

### What the host provides

| Input                        | From                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editor`                     | `<LonghandEditor onReady>`. The controller re-attaches if the editor is recreated.                                                                                                     |
| `state`                      | The folded `ProjectState` for the project, updated as commits arrive. Ranges are read at `state.documents[documentId].version` and mapped onto the editor's local document.            |
| `pushProgress(e)`            | Optional. `SessionProgressEvent`s from `@longhand/agent`'s `onProgress`, relayed over SSE. Every agent event names its session (`feedbackSessionId`).                                  |
| `onCite(req)`                | Opens the citation picker for a citation-needed flag or a source suggestion. `req` has `cardId`, `kind`, `documentId`, `sourceId` (source suggestions), `claim` and the local `range`. |
| `onAddSource(req)`           | Lets the writer check an AI-surfaced candidate and add it. Use the research lane's `surfacedSourceAddedDraft`.                                                                         |
| `onSubmit(event)`            | Optional observer for every event the controller submits.                                                                                                                              |
| `onOpenChat()`               | Shows the chat (the side panel). Setting it turns on chat mode: Discuss goes to the chat.                                                                                              |
| `onCancelSession(id)`        | The chat's Stop: cancel the agent session (`client.cancelSession`).                                                                                                                    |
| `submitWithoutEditor(event)` | Optional. Submits events when no document is open, so the chat works without one.                                                                                                      |
| `onError(error)`             | Optional. Default: `console.error`.                                                                                                                                                    |

The server starts a chat session when it sees `ChatMessageSent` (and, for older clients, a review session for `FeedbackRequested` and a discuss session for `DiscussRequested`).

## API

### `AnnotationsController` (framework-free) and `useAnnotations`

`useAnnotations(options)` creates one controller for the component's lifetime and keeps it attached to `editor`, `state` and the callbacks. It is StrictMode-safe. `useAnnotationsSnapshot(controller)` subscribes a component to it.

Without React: `new AnnotationsController({ documentId, editor?, state?, … })`, then `controller.connect()` (installs the clipboard guard), `attach(handle)`, `setState(state)` on every new state, and `destroy()`. Add `controller.plugins` to the editor.

| Member                                                     | What                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins`                                                  | The decoration layer (`createDecorationLayer('annotations')`) and the trace-over plugin. Stable.                                                                                                                                                          |
| `attach(handle \| null)`, `setState(state)`, `setOptions`  | Inputs.                                                                                                                                                                                                                                                   |
| `pushProgress(event, sessionId?)`                          | Live review progress. The session is the event's `feedbackSessionId`; `sessionId` is only a fallback for events that name none (events naming no session are ignored).                                                                                    |
| `subscribe`, `getSnapshot`                                 | Store for `useSyncExternalStore`. The snapshot has `cards` (this document's cards plus unanchored ones, in document order), `marginCards`, `reviews`, `progress`, `activeId`, `hoverId`, `tracingId`, `trace`, `preferred`, `selection` and `layoutTick`. |
| `requestFeedback(input)`                                   | `FeedbackRequested`. Returns the request id.                                                                                                                                                                                                              |
| `retryReview(requestId)`                                   | A new `FeedbackRequested` with the failed request's scope, lenses, intensity, ask and editor. (The fold maps the scope to the current version.)                                                                                                           |
| `dismiss(id, reason?, note?)`                              | `SuggestionDismissed`. For a proposal it rejects instead.                                                                                                                                                                                                 |
| `reject(proposalId, reason?)`                              | `ProposalRejected`.                                                                                                                                                                                                                                       |
| `accept(proposalId)`                                       | `editor.acceptProposal`. One click.                                                                                                                                                                                                                       |
| `discuss(targetId, message)`                               | `DiscussRequested`. The first message opens a thread, and follow-ups and retries reuse it. Returns the thread id.                                                                                                                                         |
| `sendChat({chatId, text, editor, scope, aboutId?})`        | `ChatMessageSent` (a new chat when `chatId` is null). The editor's lenses and intensity bound any notes, and the editor is recorded as it is now. Returns `{chatId, messageId}`.                                                                          |
| `openChat({aboutId?})`, `discussInChat(cardId)`            | Bring the chat forward (`onOpenChat`) and focus its composer, attaching a note for Discuss. The snapshot's `chatFocus` carries the request.                                                                                                               |
| `cancel(sessionId)`, `chatMode`                            | Stop a running reply (`onCancelSession`). `chatMode` is true when the host shows the chat; then a card's Discuss goes to the chat and per-card threads are not drawn.                                                                                     |
| `cite(cardId)`, `addSource(surfacedId, index)`             | Hand off to `onCite` / `onAddSource`.                                                                                                                                                                                                                     |
| `focus(id \| null)`                                        | Highlights the card's span, scrolls it into view, pins the margin card to its anchor and shows a proposal's preview.                                                                                                                                      |
| `hover(id \| null)`                                        | Shows the proposal preview, or the inline ghost of a word choice.                                                                                                                                                                                         |
| `startTrace(id)`                                           | Selects a word-choice span, or puts the caret at an insertion point, and focuses the editor.                                                                                                                                                              |
| `chooseAlternative(id, index)`                             | Which alternative the inline ghost shows.                                                                                                                                                                                                                 |
| `anchorTop(id, container)`, `anchorPosition`, `localRange` | Where a card's text is now, in the local document. Used by the margin.                                                                                                                                                                                    |

Options: `inlineGhosts: 'focus' | 'always'` (default `'focus'`), `clipboardGuard` (default true), `newId`.

### Components

| Component                                                            | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<FeedbackChat controller editors documentTitle manageEditorsHref?>` | The feedback chat, filling its container's height (messages scroll, the composer is pinned). Header: the editor dropdown (name and role), **History** (every chat, plus older reviews and Discuss threads, read only) and **New chat**. Writer messages sit right with their context chips; replies sit left under the editor's name, as plain-text paragraphs, with chips for the notes the session left (click to focus the card). While a reply runs: "Margaret is reading…", the current activity, a line per note as it lands ("Left a note on “sideways”"), and **Stop** (`onCancelSession`). A failed reply shows inline with **Retry** (the same message, editor and context). Composer: an auto-growing textarea (Enter sends, Shift+Enter is a newline), a quoted, removable chip for the editor selection, a chip for the note being discussed, and a **Whole project** toggle; otherwise the open document is the context (the project when none is open). An empty chat offers the editor's canned questions; tapping one fills the composer. It opens on the most recent chat. |
| `<AnnotationMargin controller gap?>`                                 | Margin cards beside their text. Cards follow the editor's mapped positions through every local edit, stack without overlapping, and the active card sits exactly at its anchor. It also renders the hidden accessible descriptions that spans and cards point at with `aria-describedby`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `<AnnotationCard controller card variant?>`                          | One card. It covers comments, questions, word choice (ghost alternatives you can pick), insertions (ghost sentence), rephrase hints (guidance, no text), proposals (Accept, Reject with a reason), citation flags (Cite), surfaced sources (candidates, Check and add) and source suggestions (Cite). Research cards say _AI-surfaced — unverified_. Every open card has Discuss (with its thread) and Dismiss (reasons: not my voice, wrong, later).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GhostText`, `GhostDescriptions`, `cardDescription`                  | Building blocks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Pure helpers

- `cardsFromState(state, { documentId? })` → `Card[]`. Each card has `kind`, `group`, `phase` (`open` / `stale` / `resolved`), `outcome` ("Adopted · retyped", "Dismissed · later", …), `range`, `anchorPos`, `quote`, `aiSurfaced` and the folded `data`.
- `filterCards`, `groupCards`, `reviewsFromState`, `threadFor`, `threadFailure`, `proposalTitle`, `proposalRange`, `snippet` and `hasAnyAnnotations`.
- Events: `chatMessageSent`, `feedbackRequested`, `feedbackRequestFor` (from an `EditorProfile`), `suggestionDismissed`, `proposalRejected`, `discussRequested` and `retryRequest`. Each returns a zod-validated `{ type, payload }`.
- Progress: `reduceProgress` and `toolActivity`. `ReviewProgressEvent` is structurally the agent's `SessionProgressEvent`.
- Ghost: `createGhostElement`, `installGhostClipboardGuard`, `scrubGhostHtml`, `GHOST_ATTR` (`data-lh-ghost`) and `ghostDescriptionId`.
- Trace: `createTracePlugin`, `traceKey` and `traceProgress`.
- Decorations: `annotationDecorations(cards, ui, doc)` → `LayerDecoration[]`.

### Styling

Import `@longhand/annotations/styles.css` once. Everything is themed with `--lh-ann-*` variables on `:root`. Dark mode follows `prefers-color-scheme` unless an ancestor sets `data-theme="light"` or `data-theme="dark"`, the same convention as the editor. The AI has its own ink, `--lh-ann-ai`, a quiet indigo that is clearly distinct from the writer's `--lh-ink`. Ghost text, AI underlines and card accents use it. Retyped characters turn from it to the writer's ink.

| In the manuscript            | Look                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Suggestion span              | Dotted underline in the AI colour                                                                    |
| Comment, question, flag span | Thin solid, dashed and wavy underlines in a soft AI tint                                             |
| Word-choice ghost            | The alternative after the span, in AI ink on a faint tint (on focus)                                 |
| Insertion ghost              | The sentence at its point, in AI ink on a faint tint                                                 |
| Trace-over                   | Typed characters in the writer's ink; the rest of the ghost waits after the caret; divergence dotted |
| Move preview                 | Source outlined (dashed), a "move here" drop marker (a caret, or a rule between blocks)              |
| Cut preview                  | Strike-through in a muted red                                                                        |
| Split / merge preview        | "¶ new paragraph" at the split point; both paragraphs outlined with a "⤵ joins" mark at the join     |
| Active card                  | A soft highlight on its span                                                                         |
| Stale card                   | Grey underline, dimmed card with "Stale · the text changed"                                          |

## How trace-over works

1. When the caret enters an open word-choice span (or sits at an insertion point), the trace plugin activates it and the controller calls `editor.setTraceSuggestion(id)`. From then on, typed runs carry `traceSuggestionId`. **Trace over** on the card selects the span for you. Activation needs the caret strictly inside the span, or a selection within it, so typing next to a word doesn't start a trace by accident.
2. The plugin tracks the region the way the fold does once a hint is present: typing at its edges is absorbed. It compares the typed text with the closest alternative and draws matching characters in the writer's ink, with the rest of the ghost after the caret. Typing that diverges is shown plainly, and the card says it will count as adapted.
3. When the caret leaves, the hint is cleared. The next commit is folded, and the fold appends `SuggestionResolved`. The card then shows the fold's outcome: **Adopted · retyped**, **Adapted**, or stale.

## Tests

- **Vitest (jsdom), 61 tests.**
  - Cards for every annotation in the `feedback-session`, `suggestions`, `proposals`, `discuss` and `research` fixtures, both final and after their first review. Every card renders with the right kind, phase, outcome and AI-surfaced label.
  - Review views: running, waiting, finished and failed.
  - The chat shows a conversation (who replied, paragraphs, note chips that focus cards, the attached selection mapped to the current text), sends with Enter to the chosen editor in a new chat, attaches the selection or the whole project, takes a card's Discuss with the note attached (no `DiscussRequested`, no thread on the card), streams a running reply with Stop, retries a failed one with the same message, and keeps older reviews readable in history.
  - With the real editor over `FoldingTransport` (a transport that validates and folds every draft with `@longhand/ledger`, and sends the fold's `derivedSteps` as each `RemoteUpdate`'s steps):
    - dismiss emits `SuggestionDismissed`, and `dismiss` on a proposal emits `ProposalRejected`;
    - reject, accept and discuss emit the right drafts, and the ledger accepts them;
    - an accepted move keeps its words' `originSeq` and class, and the editor ends on exactly the fold's document via the fold's own derived steps;
    - trace-over sets the hint, and the fold resolves the suggestion as adopted (with `typed-from-suggestion` runs) or adapted;
    - insertion trace-over works;
    - the margin and list cards emit the same events;
    - a discuss thread shows the editor's reply, and a failed one offers a retry;
    - nothing appears before a request.
  - The clipboard guard strips ghost text from native selections. A copy through the editor across a ghost yields only manuscript text.
  - Margin layout.
- **Demo** (`demo/`).
  - The real `<LonghandEditor>` runs over `test-support/FoldingTransport`, seeded from a golden fixture and stopped after its first finished review.
  - `test-support/MockReviewer` replays a scripted chat reply (notes first when the message contains "review"; Stop cancels; "fail" fails), review or discuss answer with `SessionProgressEvent`-shaped progress whenever the writer asks.
  - Query parameters: `seed=suggestions|proposals|feedback-session|discuss|research|empty`, `upto=all`, `theme=light|dark`, `idle=<ms>`, `fail=1` and `step=<ms>`.
- **Playwright** (`e2e/annotations.spec.ts`, Chrome):
  - trace-over turns the ghost to the writer's colour and resolves as adopted (retyped), with the hint on the typed run and `typed-from-suggestion` provenance;
  - divergent typing resolves as adapted;
  - ghost text can't be copied: a mouse selection across the inline ghost sentence is copied and the clipboard text and HTML are checked, and the same is done on a card's alternatives;
  - accepting a move moves the text and keeps its provenance;
  - dismiss with a reason;
  - nothing appears until asked, then a review streams in and finishes;
  - a failed review offers a retry.
- **Screenshots** (`e2e/screens.spec.ts`) go to `test-results/screens/`: suggestions, trace-over, proposal previews, finished and failed reviews, research cards, and the empty and reviewing states, each in light and dark.

## Needed changes in other packages

None. (The fold-derived proposal steps, `loadFixture` under jsdom and session ids on agent progress events have landed.)

## Known gaps

- **One document per controller.** Cards for other documents are filtered out. A project-wide review lists its items in the panel only for the open document, and items elsewhere show as plain labels. Use one controller per open editor.
- **The trace display matches more strictly than the fold.** The display compares the typed text with the ghost case-insensitively, while the fold also folds curly apostrophes and whitespace. The display can therefore show divergence where the fold will still adopt. The outcome always comes from the fold.
- **No virtualization.** The margin measures every card on each layout change. That is fine for chapters, but not tuned for hundreds of open cards.
- **The accessible descriptions live in the margin.** Ghost-text descriptions are rendered by `<AnnotationMargin>`. A host that shows only the panel loses the `aria-describedby` targets.
- **Legacy Discuss threads** are shown read only, from the chat history. New questions about a note go through the chat.
- **Chrome only.** The e2e suite ran against installed Chrome. Safari and Firefox clipboard and selection behaviour are untested.
