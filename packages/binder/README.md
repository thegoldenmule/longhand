# @longhand/binder

**Lane:** Binder (F2). The project tree with Manuscript and Notes areas, nested folders (Part › Chapter › Scene), drag and keyboard reordering, archive and restore, a corkboard with synopses, and the project settings the AI editor reads.

Components take state and an `onDraft(draft)` callback. They never talk to the network. Everything they emit comes from pure draft builders, and an optimistic reducer applies those drafts the way the ledger fold does, so the UI can update at once.

```sh
pnpm --filter @longhand/binder test        # vitest (jsdom)
pnpm --filter @longhand/binder typecheck
```

## Wiring it up

```tsx
import '@longhand/binder/styles.css';
import {
  BinderTree,
  Corkboard,
  ProjectSettingsForm,
  applyBinderDrafts,
  createCommitDrafter,
  type BinderDraft,
} from '@longhand/binder';

const drafter = createCommitDrafter({ projectId, actorId, deviceId, sessionId });

function Binder({ state /* ProjectState from the read model */ }) {
  const [pending, setPending] = useState<BinderDraft[]>([]);
  const view = applyBinderDrafts(state, pending).model; // optimistic view
  const onDraft = (d: BinderDraft) => {
    setPending((p) => [...p, d]);
    submit(drafter(d)); // CommitDraft for the ledger service; drop from `pending` once folded
  };
  return <BinderTree model={view} onDraft={onDraft} selected={sel} onSelect={setSel} />;
}
```

`ProjectState` satisfies `BinderModel` structurally, so pass it straight in. React's `useOptimistic(state, binderReducer)` also works.

## Public API

### Model and queries (`model.ts`)

- `BinderModel`: `{ binder, folders, documents, settings }`, the slice of `ProjectState` the binder reads.
- `Placement`: `{ parentId, index }`. `Location` adds `area`. `DropPosition`: `'before' | 'after' | 'inside'`.
- `soleManuscriptDocument(model)`: the id of the manuscript's only document, when the Manuscript area's root holds exactly one live node and it is a document (notes and archived nodes don't count). Otherwise null.
- Queries: `locate`, `getNode`, `childrenOf`, `visibleChildren`, `ancestorIds`, `descendants`, `isSelfOrDescendant`, `isEffectivelyArchived`, `archivedNodes`, `flattenVisible`, `titleOf`, `refKey`, `sameRef`, `areaForKind`, `kindForArea`, `BINDER_AREAS`.
- Placement helpers:
  - `placementForDrop(model, moving, target, position)`: the after-removal index for a drop.
  - `placementAtEnd`.
  - `stepPlacement(model, ref, 'up' | 'down' | 'in' | 'out')`: one keyboard move step.
  - `describeLocation`: text for screen readers.

### Draft builders (`drafts.ts`)

Each builder returns `DraftResult<D> = { ok: true, draft } | { ok: false, error: { code, message } }`. A draft is `BinderDraft = { type, payload }` for one of `BINDER_EVENT_TYPES`.

| Builder                                                          | Emits                                           | Refuses (`code`)                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `createDocument(model, { area, title, parentId?, index?, id? })` | `DocumentCreated` (kind `note` in Notes)        | `invalid-title`, `invalid-id`, `duplicate-id`, `not-found`, `invalid-parent`, `cross-area`, `archived`, `invalid-index` |
| `createFolder(model, { … })`                                     | `FolderCreated`                                 | same                                                                                                                    |
| `renameNode(model, ref, title)`                                  | `DocumentRenamed` / `FolderRenamed`             | `not-found`, `invalid-title`, `no-op`                                                                                   |
| `moveNode(model, ref, placement)`                                | `DocumentMoved` / `FolderMoved`                 | `not-found`, `cross-area`, `invalid-parent`, `cycle`, `archived`, `invalid-index`, `no-op`                              |
| `archiveNode` / `restoreNode` / `setArchived(model, ref, bool)`  | `DocumentArchived` / `FolderArchived`           | `not-found`, `no-op`                                                                                                    |
| `editSynopsis(model, ref, text)`                                 | `SynopsisEdited` (`documentId` or `folderId`)   | `not-found`, `invalid-synopsis`, `no-op`                                                                                |
| `changeProjectSettings({ settings }, patch)`                     | `ProjectSettingsChanged` with only changed keys | `invalid-title`, `invalid-settings`, `no-op`                                                                            |

Builders trim titles, clamp indexes and default `index` to the end. They validate the payload against the schema before returning. `id` defaults to `crypto.randomUUID()`.

Titles:

- `UNTITLED` is `'Untitled'`, the name of anything nobody has named yet. Names need not be unique.
- `titleOrUntitled(raw)` trims, turns newlines into spaces, and makes a blank title `UNTITLED`.

To add the commit envelope:

- `toCommitDraft(draft, { commitId, projectId, clientTime, actorId, deviceId, sessionId })` returns a human `CommitDraft` that passes `CommitDraftSchema`.
- `createCommitDrafter(ctx)` fills in the commit id and time for you.

### One document, one name (`titleLink.ts`)

While the manuscript is a single document, it goes by the project's name. The link is a UI rule kept with ordinary events; the fold stores both titles as before.

- `renameProjectAndDocument(model, documentId, raw)` returns `{ ok, drafts }` with 0, 1 or 2 drafts: `ProjectSettingsChanged {title}` first, then `DocumentRenamed`, each only if it changes something. Refuses invalid titles, and returns `no-op` when neither changes.
- `withTitleLink(model, draft)` returns the drafts to emit for `draft`: just `draft`, unless it ends single-document mode (a second manuscript document, a manuscript folder, a restore) while the sole document's stored title differs from the project's. Then a `DocumentRenamed` to the project's name comes first.

It lives apart from `drafts.ts` because it applies drafts with the reducer, which imports `drafts.ts`.

### Optimistic reducer (`reducer.ts`)

- `applyBinderDraft(model, draft, { seq? })` returns `{ ok, model } | { ok: false, error }`.
- `applyBinderDrafts(model, drafts)` returns `{ model, rejected }`.
- `binderReducer(model, draft)` keeps the old state on refusal.

It is immutable with structural sharing, and other `ProjectState` fields pass through untouched.

### Word counts (`wordCount.ts`)

`documentText`, `documentWordCount`, `nodeWordCount` (folders sum their non-archived subtree; accepts per-document overrides). Counting uses `countWords` from the schema.

### Components

**`<BinderTree>`** props:

- Required: `model`, `onDraft`.
- Optional: `selected`, `onSelect`, `areas`, `showWordCounts`, `wordCounts`, `defaultExpanded` (`'all'` or folder ids), `newId`, `onError`, `hide`, `label`, `className`.
- `hide` leaves nodes (and their subtrees) out of the tree: they are not rendered, not reachable by keyboard and never the target of Archive. A hidden selection still places new nodes after it, and an area whose rows are all hidden shows no empty message.

What it renders and does:

- Each area is an ARIA `tree` with nested `group`s. Each item carries `aria-level`, `setsize`, `posinset`, `expanded` and `selected`. The tree uses a roving tabindex, so it is one tab stop.
- A toolbar per area has New document (or New note), New folder and Archive. New items go inside the focused folder, or after the focused document, and open in rename mode.
- Keyboard:
  - Arrows navigate; Right and Left expand and collapse.
  - Home and End jump to the first and last row.
  - Enter or Space selects.
  - F2 or a double-click renames inline: Enter commits, Escape cancels.
  - Delete archives.
  - **M** starts move mode. Up and Down reorder, and step out of the folder past its first or last child. Right nests into the folder above, Left moves out. Enter drops and Escape cancels. The move is previewed through the reducer and announced in a live region.
- Pointer: HTML5 drag and drop.
  - On a document row, the top or bottom half drops before or after it.
  - On a folder row, the top quarter drops before it, the bottom quarter after it, and the middle inside it. Just below an open folder means first inside it.
  - A strip under each area drops at the end of its root.
  - Invalid targets (another area, the folder's own subtree, no-ops) never accept the drop.
- The archive view lists archived nodes with Restore, and notes when a node sits inside a folder that is still archived.

**`<Corkboard>`** props:

- Required: `model`, `area`, `folderId` (null for the area root), `onDraft`.
- Optional: `onOpen`, `selected`, `showWordCounts`, `wordCounts`, `onError`, `label`, `className`.

What it does:

- Shows index cards for the non-archived children: title, synopsis (documents and folders), and for folders an item count.
- The synopsis is edited in place, on document and folder cards alike. It saves on blur or Ctrl/Cmd+Enter, and Escape discards it.
- Cards reorder by dragging (left or right half of a card), or with each card's **Move** button: arrows move the card, Enter or Space drops it, Escape cancels.

**`<ProjectSettingsForm>`** props:

- Required: `settings`, `onDraft`.
- Optional: `citationStyles`, `onError`, `heading`, `showTitle` (default true), `className`.

What it does:

- Fields: title, genre, audience, goals, style notes, daily word goal (empty means none), and citation style.
- There is no save button. A field commits on blur, or on Enter in one-line fields. Each commit emits a single `ProjectSettingsChanged` holding only that field's change. Errors are shown inline with `aria-invalid`.

**Styles.** `@longhand/binder/styles.css` is plain CSS:

- Class names are prefixed `lh-binder-*`, `lh-card-*` and `lh-settings-*`.
- Every colour and font is a `--lh-binder-*` variable that falls back from an app-wide `--lh-*` token.
- Dark mode follows `prefers-color-scheme` unless the root has `data-theme="light"`. `data-theme="dark"` forces it.
- Motion is disabled under `prefers-reduced-motion`.

## Semantics the reducer assumes (must match the ledger fold)

From the schema and the BUILD.md contract decisions:

- A document's area follows its kind: `note` goes in `notes`, everything else in `manuscript`. A folder's area is fixed at creation. Nothing moves between areas.
- `parentId` null means the area root. Otherwise it must be a folder in the same area.
- `index` is counted after the node is removed from its old parent, then clamped to the child count.
- A folder never moves into itself or a descendant (`cycle`).
- Archiving only sets the flag. The node keeps its place, so restoring returns it there. A folder's subtree is hidden while it is archived, but the children's own flags are unchanged.
- A new document gets `content = EMPTY_DOC_JSON`, `version 0`, `provenance []`, `synopsis ''` and `imported null`. A new folder gets `synopsis ''`. Its `createdSeq`, `contentSeq` and `updatedSeq` are the event's seq: 0 ("pending") unless `{ seq }` is passed.

Rules the ledger fold confirms (`packages/ledger/README.md`, "Binder", and the `binder` golden fixture):

1. When a folder's `children` change through a create or move, its `updatedSeq` is bumped.
2. The fold accepts a move into an archived folder. The reducer accepts it; the builders refuse it.
3. A duplicate id is rejected only within the same collection (documents or folders). The builders refuse an id used in either.

## Tests

- `drafts.test.ts`: every builder, ok and refused, plus the envelope checked against `CommitDraftSchema`.
- `reducer.test.ts`: creation defaults, after-removal indexes, clamping, cross-area moves, cycles, archive, settings and immutability. It also has a fast-check property: whatever a builder emits, the reducer accepts, and the tree stays well formed.
- `model.test.ts`: queries, drop placement, keyboard steps, word counts and `soleManuscriptDocument`.
- `titleLink.test.ts`: `titleOrUntitled`, `renameProjectAndDocument` (0, 1 and 2 drafts, blank, too long) and `withTitleLink` (each way out of single mode, notes, multi mode).
- Component tests use `@testing-library/react` in jsdom:
  - The tree: rendering and ARIA, navigation, rename, create, keyboard moves (including Escape), archive and restore, hidden rows, and drag and drop, including refused drops.
  - Corkboard: reorder by keyboard and by drag, and synopsis edits.
  - Settings form: each field and its validation, and `showTitle={false}`.
  - `src/test/setup.ts` polyfills `DragEvent`, which jsdom lacks.

All test models are built by hand from the schema types (`src/test/fixtures.ts`). Nothing depends on the ledger package.

## Known gaps

- Pointer drag uses HTML5 drag and drop, which some touch browsers do not support. Keyboard move mode covers those cases.
- During a drag, folders do not auto-expand on hover and the tree does not auto-scroll.
- There is no multi-select, typeahead or drag between the tree and the corkboard.
- On the corkboard, a card cannot be dropped _into_ a folder card; cards only reorder.
- `DocumentImported` is not built or applied here. Import belongs to whichever lane owns import; the reducer would need the fold's `imported` provenance.
- Word counts are computed from `content` on render when no `wordCounts` map is passed. That is fine for normal projects; pass live counts from the editor for very large ones.
- The repo's ESLint config has no `react-hooks` plugin, so hook dependency lists are checked by hand.

## Contract requests

None open. Applied in the contract revision pass (phase 2c): folder synopses (`SynopsisEdited` takes `{documentId} | {folderId}`, `FolderState.synopsis`), and the ledger confirmed the three fold rules above.
