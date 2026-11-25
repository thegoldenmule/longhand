# @longhand/provenance-ui

**Lane:** Provenance (F6). The provenance view: a tint over the manuscript by authorship class, a legend with the share of words in each class, a span inspector that shows one character's history, and a replay scrubber that redraws a document at any point in the ledger.

Everything here is derived from the ledger (`@longhand/ledger`): runs from the fold, word counts from `wordsByClass` / `projectWordsByClass`, history from `spanHistory`, replay from `Replay`. Nothing here can change the manuscript. The tint and the inspector outline are decorations, and the replay view is a separate read-only ProseMirror view.

```sh
pnpm --filter @longhand/provenance-ui typecheck
pnpm --filter @longhand/provenance-ui test    # Vitest (jsdom), driven by the golden fixtures
pnpm --filter @longhand/provenance-ui demo    # http://localhost:4318
pnpm --filter @longhand/provenance-ui e2e     # Playwright against the demo (Chrome)
```

The e2e suite uses installed Google Chrome (`channel: 'chrome'`) when it finds it, else Playwright's bundled Chromium (`PW_BUNDLED_CHROMIUM=1` forces it). It starts the demo itself, or reuses a running `pnpm demo`. Screenshots in light and dark themes land in `test-results/screens/` (gitignored).

## Wiring it into the editor

```tsx
import { LonghandEditor } from '@longhand/editor';
import { foldCommits, projectState } from '@longhand/ledger';
import {
  createProvenanceTint,
  ProvenanceInspector,
  ProvenanceLegend,
  ReplayScrubber,
} from '@longhand/provenance-ui';
import '@longhand/editor/styles.css';
import '@longhand/provenance-ui/styles.css';

// One tint per editor page. Its plugins go into the editor; its handle comes back in onReady.
const tint = createProvenanceTint();

function Manuscript({ commits, documentId, transport }) {
  const ledger = useMemo(() => foldCommits(commits), [commits]); // or replay.head()
  const doc = projectState(ledger).documents[documentId]; // content, version, provenance

  // Fresh runs (from a new ledger state, or the read model) go in with their version.
  useEffect(() => {
    tint.setRuns(doc.provenance, doc.version);
  }, [doc]);

  return (
    <>
      <LonghandEditor
        documentId={documentId}
        doc={doc.content}
        version={doc.version}
        transport={transport}
        extraPlugins={tint.plugins}
        onReady={(handle) => {
          tint.attach(handle);
          tint.setRuns(doc.provenance, doc.version);
        }}
        /* projectId, actorId, … */
      />
      <ProvenanceLegend document={doc} tint={tint} />
      <ProvenanceInspector tint={tint} state={ledger} documentId={documentId} />
    </>
  );
}

// Elsewhere (a Replay route or panel):
<ReplayScrubber commits={commits} documentId={documentId} />;
```

- **Positions and versions.** `setRuns(runs, version)` hands `version` to `handle.setDecorations`, so the editor maps the runs onto its local document, including steps it has not had acknowledged yet. Text typed since then has no run and stays untinted until fresh runs arrive. When `setRuns` returns `false` (and the snapshot is `stale`), the version is too old for the editor to map; fetch fresh runs and call it again.
- **The inspector needs a `LedgerState`**, the one the runs came from, because `spanHistory` reads fold internals. The app can fold the commits it already holds for replay (`foldCommits`, or `replay.head()` from a shared `Replay`). The inspector maps the clicked character back to that version with `handle.mappingFrom(version).invert()`. Text typed since that version shows "Not in the ledger yet".
- **Clicks and keys.** While the tint is on, a click on text, or **Alt-Enter** (Option-Return) at the caret, opens the inspector for that character. Escape closes it. A keyboard opening moves focus into the popover, and closing gives focus back to the editor. A click opening leaves focus in the editor.

## API

### Tint

`createProvenanceTint(options?) → ProvenanceTint`

| Option           | Default        | What                                                   |
| ---------------- | -------------- | ------------------------------------------------------ |
| `name`           | `'provenance'` | Decoration layer name (use another for a second view)  |
| `enabled`        | `false`        | Start with the tint on                                 |
| `inspectKey`     | Alt-Enter      | `(e: KeyboardEvent) => boolean`; opens the inspector   |
| `inspectOnClick` | `true`         | Clicks on text open the inspector while the tint is on |

| Member                      | What                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins`                   | The tint layer, the inspected-span layer and the tint plugin. Pass them in `extraPlugins`.                                                    |
| `layer`                     | The `DecorationLayer` (from the editor's `createDecorationLayer`).                                                                            |
| `attach(host)` → detach     | Binds an `EditorHandle`, or any `TintHost` (`{ view, setDecorations, mappingFrom? }`). `staticTintHost(view)` makes one for a read-only view. |
| `setRuns(runs, version?)`   | Sets the runs and redraws. `version` is the ledger document version they were computed at. Returns `false` when the editor cannot map it.     |
| `setEnabled`, `toggle`      | Turns the tint on or off. Off clears the decorations.                                                                                         |
| `setHighlight(cls \| null)` | Highlights one class: its spans deepen and the others fade.                                                                                   |
| `getSnapshot`, `subscribe`  | `{ enabled, highlight, runs, version, stale }`; `useProvenanceTint(tint)` is the React hook.                                                  |
| `onInspect(listener)`       | `InspectRequest { localPos, ledgerPos, version, via: 'pointer' \| 'keyboard', rect }`. `ledgerPos` is null for unsynced text.                 |
| `onDismiss(listener)`       | Escape in the editor while the tint is on.                                                                                                    |
| `inspectAt(localPos, via?)` | Requests inspection of a character programmatically (a menu item, a test).                                                                    |
| `toLedgerPos(localPos)`     | The character's position in the runs' version, or null.                                                                                       |
| `markSpan(range \| null)`   | Outlines a span (ledger positions); the inspector uses it for the span it shows.                                                              |

The plugin sets `class="lh-prov-on"` and `data-prov-highlight="<class>"` on the editable element. Each run becomes one inline decoration: `<span class="lh-prov lh-prov--<class>" data-prov="<class>" data-prov-seq="<originSeq>">`. A typed-from-suggestion run also gets `data-prov-matched="<matchedKind>"` and a `title` such as "Typed from a suggestion: matched a margin comment". A moved run gets `data-prov-moved="<count>"`. `provenanceDecorations(runs)` and `runAttrs(run)` expose this mapping.

### Legend

`<ProvenanceLegend document={docState} tint={tint} />`

| Prop                                                           | What                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `document`                                                     | `{ content, provenance }` (a `DocumentState` works). Counted with `wordsByClass`.                     |
| `project`                                                      | `{ state: ProjectState, scope?: CountScope }`. Counted with `projectWordsByClass` and the same scope. |
| `data`                                                         | Precomputed `LegendData` (`documentLegend`, `projectLegend`, `legendFromCounts`).                     |
| `tint`                                                         | Binds the toggle and the highlight to a tint.                                                         |
| `enabled`, `onEnabledChange`, `highlight`, `onHighlightChange` | The same without a tint (controlled).                                                                 |
| `title`, `showToggle`, `hint`, `className`                     | Heading (default "Provenance"), the Tint switch (default shown), the text under the rows.             |

Rows show each of the five run classes with a sample of its tint and underline, the word count and the share. A share is never rounded to 0% or 100% unless it is exactly that, so a rounding can neither hide nor overclaim. Words follow the least-trusted-class rule (`attributeWords`). Typed-from-suggestion words are split by `matchedKind` (suggestions, insertions, comments, review text…). Clicking a row highlights that class and turns the tint on; clicking it again clears the highlight. Classes with no words are disabled. `pasted-internal` is never a run class (internal pastes inherit), so it has no row.

### Span inspector

- `inspectSpan(state: LedgerState, documentId, pos) → InspectorModel | null` builds the model from `spanHistory` and the folded `ProjectState`:
  - the class, and the run's text;
  - the origin commit: client time (when it was typed), server time (witnessed), device, editor session, and an action ("Typed", "Pasted", "Cited", "Added when a proposal was accepted"…);
  - the writing session (n of N, its span and active time);
  - the input methods in words;
  - the matched AI text (`matched.group`, `matchedKind`, an excerpt, and a suggestion's outcome);
  - every suggestion open in the document when it was typed;
  - moves (`move` with the proposal kind and unit, `paste` with the paste size, `drop`);
  - the pastes that put pasted text in, with their characters and words;
  - for imported text, the draft;
  - for quoted text, the source title and locator;
  - a note when the class differs from what the input method claimed (an unverified internal paste, a clipping that did not match, a restored paste).
- `<SpanInspector model rect onClose autoFocus? inline? formatTime? />` is the popover: `role="dialog"`, labelled by its class, with Escape and a close button.
- `<ProvenanceInspector tint state documentId formatTime? onOpen? />` wires them together. It listens to the tint, outlines the inspected span, follows scrolling, closes on an outside press, on Escape, and when the tint goes off, and restores focus after a keyboard opening. It renders into `document.body`.

### Replay

`<ReplayScrubber commits={commits} />` takes the commit array the host supplies and makes no network calls.

| Prop                                                    | Default              | What                                                                  |
| ------------------------------------------------------- | -------------------- | --------------------------------------------------------------------- |
| `commits`                                               | required             | The project's commits, seq 1…n                                        |
| `replay`                                                | made from `commits`  | A shared `Replay` (so the inspector and the scrubber share snapshots) |
| `snapshotEvery`                                         | 64                   | Snapshot interval when the component makes the `Replay`               |
| `documentId` / `defaultDocumentId` / `onDocumentChange` | first manuscript doc | Which document to draw (controlled or not)                            |
| `defaultScope`                                          | `'document'`         | `'document'`: the document's commits. `'project'`: every commit       |
| `defaultSeq`, `onSeqChange(seq, state)`                 | head                 | Where to start, and a callback with the `LedgerState` shown           |
| `defaultSpeed`                                          | 8                    | 1, 2, 4, 8, 16, 32 or 64                                              |
| `defaultTint`                                           | false                | Tint the replayed document                                            |
| `maxGapMs`                                              | 4000                 | Cap on one idle gap, in ledger ms                                     |
| `formatTime`, `clock`, `className`                      |                      | Formatting, a playback clock (tests)                                  |

- **The view.** The document is drawn by a read-only ProseMirror view (`editable: false`) with the editor's stylesheet. Each step folds at most `snapshotEvery − 1` commits from the nearest `Replay` snapshot, so scrubbing stays fast on long ledgers.
- **Playback.** Wall time advances ledger time at the chosen speed. Ledger time between frames is the real time between commits, measured as `clientTime` plus `durationMs` for text batches, so the frame shows when the batch was finished. Each gap is clamped to `[0, maxGapMs]`, so overnight gaps play as a short pause. When several commits fall within one tick (16 ms), the player skips to the latest instead of falling behind. Scrubbing pauses playback, and pressing play at the end starts again from the beginning.
- **Markers.** Markers come from the head `ProjectState`:
  - AI sessions, from `FeedbackSessionStarted` to `ReviewFinished` or `FeedbackSessionFailed`, drawn as bands (a session still running extends to the head);
  - writing sessions, as bands;
  - pastes, as diamonds;
  - accepted proposals, as triangles.

  In document scope, only markers that concern the document are shown: reviews scoped to it or to the project, Discuss replies on its annotations, and its own sessions, pastes and proposals. Clicking a marker jumps to it. The status line names the commit, its time and any AI session running.

- **Keyboard and screen readers.** The timeline is a native range input, so Arrow keys, Home, End and Page Up/Down work. Its `aria-valuetext` reads "Edit 3 of 12. Typed · 50 characters · …". The markers are mouse shortcuts and hidden from assistive technology; the status line is `aria-live`.
- **Pure building blocks:**
  - `replayFrames(commits, { scope, documentId })`
  - `playbackOffsets(commits, frames, { maxGapMs })`
  - `frameAtTime`, `frameIndexForSeq`
  - `replayMarkers(head, { scope, documentId })`
  - `describeCommit(commit)`
  - `ReplayPlayer` (`play`, `pause`, `seek`, `setSpeed`, `setOffsets`, with an injectable `PlayerClock`)
  - `REPLAY_SPEEDS`

### Other exports

`TINT_CLASSES`, `CLASS_META` (label, description and underline per class), `MATCHED_KIND_LABEL` / `MATCHED_KIND_SHORT`, `INPUT_METHOD_LABEL`, and the formatters `formatTime`, `formatDuration`, `formatShare`, `formatCount` and `excerpt`. The formatters are locale-free and show local time.

## Styling

Import `@longhand/provenance-ui/styles.css` once. Every colour is a `--lh-prov-*` variable on `:root`. Dark mode follows `prefers-color-scheme` unless the root has `data-theme="light"`. `data-theme="dark"` on any ancestor forces dark mode.

| Class                   | Wash        | Underline (the non-colour cue) |
| ----------------------- | ----------- | ------------------------------ |
| Typed                   | faint sage  | none                           |
| Typed from a suggestion | soft violet | dotted                         |
| Pasted (external)       | warm amber  | wavy                           |
| Imported (unverified)   | slate       | dashed                         |
| Quoted from a source    | teal        | double                         |

The washes are low alpha. Ink on every wash keeps a contrast above 12:1 in light mode and above 9:1 in dark mode. Underline colours are above 3.5:1 against their wash. Highlighting deepens one class and clears the others. Transitions are off under `prefers-reduced-motion`. The replay view reuses the editor's `.lh-editor .lh-manuscript` typography, with its own padding.

## Demo

`pnpm --filter @longhand/provenance-ui demo` opens http://localhost:4318. It loads every golden fixture from `packages/ledger/fixtures` and mounts the real `LonghandEditor` over a `MockTransport` (memory queue, no typewriter scrolling) on the chosen document. Beside the editor are the legend (with the tint switch) and the inspector. The **Replay** tab shows the scrubber, with a legend that follows the shown seq (document or project).

- **Query parameters:** `fixture=<name>` (default `suggestions`), `doc=<documentId>`, `view=write|replay`, `theme=light|dark`, `tint=1`.
- **Playwright hook:** `window.__prov` holds `{ tint, handle, fixture, documentId, ready, textAt(seq, documentId) }`.

Typing in the demo editor works and the tint maps around new text, but the demo has no ledger service, so new text never gets runs.

## Tests

- **Vitest** (jsdom, 139 tests), all driven by the golden fixtures:
  - **Tint:** decoration ranges and DOM spans match the fixture provenance for every fixture document; mapping onto unsynced local edits; stale versions; toggle and highlight attributes; Alt-Enter and click requests; a read-only host.
  - **Legend:** `documentLegend` equals each fixture document's expected `wordsByClass`; `projectLegend` equals `projectWords`; the matched-kind split sums to the typed-from-suggestion count; the rendered counts; toggle and highlight against a real editor; share rounding.
  - **Inspector:** chosen positions in `suggestions` (typed, adopted word choice, insertion, comment match), `internal-paste` (external paste size, internal paste with size, re-pasted paste, drop, unverified internal paste), `proposals` (sentence and paragraph moves, joining space) and `research` (citation and clipping sources, mismatched clipping). The popover's rows, Escape, and `ProvenanceInspector` with keyboard focus and return, click, unsynced text, and tint off.
  - **Replay:** frames, gap capping on the two-day `novel` ledger, markers against `agentSessions` and the commit types, player timing with a fake clock (speeds, speed change mid-play, pause, restart, frame skipping), and scrubbing to every seq of every fixture rendering `stateAtSeq` text. Also document scope, the tint, marker jumps, and playback in the component.
- **Playwright** (Chrome, 9 tests):
  - tint colours and underline styles on the expected spans (every run's text equals its spans'), light and dark;
  - legend counts and highlighting;
  - the inspector by click and by keyboard (focus moves in, Tab to Close, focus returns);
  - moves after an accepted proposal;
  - keyboard scrubbing against `stateAtSeq` text, and 64× playback reaching the head in order;
  - the project-wide timeline over another document.

## Known gaps

- **Footnote text is not tinted** in the editor: footnotes are atom nodes whose content the editor draws with its own node view. Their words are counted in the legend and can be inspected through `inspectSpan`.
- **The replay view is not inspectable.** It is a non-editable view with no caret, so keyboard inspection there would need its own focus model. `inspectSpan(replay.stateAt(seq), …)` works if a host wants it.
- **New local text has no runs** until the app re-folds or the read model sends fresh ones. It shows untinted, and the inspector says it is not in the ledger yet.
- **Paste size when one commit carries several pastes:** the inspector lists every paste that commit inserted, because a run does not record which paste it came from.
- **Playback is per commit**, not per keystroke. The keystroke timeline inside a `TextEdited` is not animated.
- **Document scope steps through every commit whose payload names the document**, including companion events such as `PasteOccurred` that do not change text.
- **Times show in the viewer's local zone.** Pass `formatTime` for another convention.
