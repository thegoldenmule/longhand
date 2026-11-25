# @longhand/ledger

The ledger core: the deterministic fold (commits → documents, provenance and annotation state), the "typed from a suggestion" matcher and the suggestion lifecycle, ingest validation, the hash chain and witnesses, word attribution, replay helpers, a ledger builder for tests, and the golden fixtures every other lane tests against.

Isomorphic and deterministic. `src/` uses no Node-only API, no `Date.now`, no `Math.random`, no `Intl`, `localeCompare`, `normalize` or `\p{…}` (a test bundles it for the browser with esbuild and checks the output is byte-identical to Node's). `fixtures/` and `scripts/` are Node-only.

```sh
pnpm --filter @longhand/ledger test        # unit, fixture, property and browser-runtime tests
pnpm --filter @longhand/ledger typecheck
pnpm --filter @longhand/ledger fixtures    # regenerate fixtures/*.json (a test fails if they are stale)
FC_RUNS=2000 pnpm --filter @longhand/ledger test src/property.test.ts   # longer property runs
```

## API

### The fold

| Export                                                  | What                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emptyState()`                                          | The state before any commit.                                                                                                                                                                                                                                                                                                      |
| `applyCommit(state, commit) → state`                    | Folds one commit. Pure; `state` is never modified (copy-on-write with structural sharing). Throws `FoldError` when the commit cannot be folded: `seq` not `headSeq + 1`, wrong `prevHash`, `ProjectCreated` not first, another project, unknown document, steps that do not apply, a non-manuscript event that would change text. |
| `foldCommits(commits, from?)`                           | Folds a ledger (optionally continuing from a state).                                                                                                                                                                                                                                                                              |
| `projectState(state) → ProjectState`                    | The public `ProjectState` from `@longhand/schema`. Memoized per state; unchanged documents keep their objects. Read-only.                                                                                                                                                                                                         |
| `documentNode`, `documentVersion`, `documentProvenance` | The ProseMirror node, version and runs of one document.                                                                                                                                                                                                                                                                           |
| `foldIssues(state)`                                     | Semantic problems the fold recorded (unknown targets, closed sessions, caps, mismatched positions, a disagreeing `SuggestionResolved`…). A valid ledger has none: the verifier must fail a bundle with issues.                                                                                                                    |
| `headSeq`, `headHash`, `commitInfo(state, seq)`         | Head and per-commit envelope facts.                                                                                                                                                                                                                                                                                               |
| `LedgerState`                                           | Opaque. Internals (copy registry, tombstones, step-map history, trackers) stay behind it.                                                                                                                                                                                                                                         |

The fold checks contiguity and `prevHash` but does not re-hash; run `verifyChain` first on untrusted input.

### Ingest validation (server)

`validateDraft(state, draft, actor, { serverTime?, accountId? })` → `{ ok: true, commit, state, resolutions } | { ok: false, errors: [{ code, message, path? }] }`.

It checks, in order: the actor kind may emit the type (`actor-not-permitted`); the draft's actor is the authenticated one (`actor-mismatch`); `CommitDraftSchema` (`invalid-draft`, with paths); project (`project-not-created`, `project-already-created`, `project-mismatch`); base version (below); agent position stamps are at the document's current `version` (`invalid-version`); then it folds the draft and rejects any `FoldError` or new fold issue with that code. On success `resolutions` lists the `SuggestionResolved` payloads the service should append right after the commit (`resolutionsBetween(prev, next, seq)` gives the same).

**Rebase policy: reject, never rebase.** A `TextEdited` must have `baseVersion === document.version`. Lower → `stale-base-version` (the client rebases its unconfirmed steps over the ones it has not seen, prosemirror-collab style, and resubmits); higher → `future-base-version`. The service never transforms a writer's steps, so the ledger holds exactly what the client applied and what its keystroke timeline describes. A `ProposalAccepted` is accepted at **any** `baseVersion` up to the current one while the proposal is open (not stale): the fold derives its steps from the positions it has been mapping, so there is nothing to rebase (coordinator decision). A stale, accepted or rejected proposal gives `not-open`.

The server flow: `const v = validateDraft(state, draft, actor, { serverTime })`; if ok, `appendToChain(head, draft, serverTime)` (identical to `v.commit`), store, witness, then append each `v.resolutions` entry as a system commit.

### Hash chain and witnesses

| Export                                                               | What                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appendToChain(prev, draft, serverTime, { accountId? })`             | Parses the draft, assigns `seq`, `prevHash`, `serverTime`, `accountId` (from `prev`, or the option for seq 1), parses the result with `CommitSchema` and hashes the parsed commit. Throws `ChainError` (`invalid-draft`, `actor-not-permitted`, `project-mismatch`, `invalid-commit`).                                                                                                                      |
| `verifyChain(commits, { expectedHead? })`                            | Checks the commits exactly as given. Reports every problem with index and seq: `invalid-commit`, `hash-mismatch` (edited), `prev-hash-mismatch` (edited and re-hashed, dropped, reordered), `seq-gap` (dropped), `seq-out-of-order` (reordered), `duplicate-seq`, `duplicate-commit-id`, `genesis-mismatch`, `project-mismatch`, `account-mismatch`, `head-mismatch` (truncated, only with `expectedHead`). |
| `signWitness(signer, commit)`                                        | A `Witness` (P1363 base64) from any `WitnessSigner`.                                                                                                                                                                                                                                                                                                                                                        |
| `verifyWitnesses(commits, witnesses, publicKeyPem, { requireAll? })` | One valid witness per commit (`missing-witness`, `extra-witness`, `subject-mismatch`, `key-mismatch`, `bad-signature`), plus every embedded `ChainHeadWitnessed` (`embedded-mismatch`, `embedded-bad-signature`). WebCrypto, so it runs in browsers. `requireAll: false` tolerates not-yet-witnessed offline commits.                                                                                       |
| `webCryptoSigner(privateKey, publicKeyPem)`                          | A `WitnessSigner` over a WebCrypto key (tests, local dev).                                                                                                                                                                                                                                                                                                                                                  |

Truncation (dropping the last commits) is invisible to the chain alone; witnesses or an expected head catch it.

### Word attribution

`attributeWords(doc, runs)` → `[{ from, to, text, class, blockId, originSeqs, suggestionIds? }]`. Words are `tokenizeWords` tokens of each block's inline text (textblocks and footnotes, anchor rules). A word whose characters span classes takes the least trusted: `pasted-external` < `imported` < `quoted` < `typed-from-suggestion` < `typed` (`TRUST_ORDER`). A character with no run counts as `pasted-external`.

`wordsByClass(doc, runs)` and `charactersByClass(doc, runs)` → `{ total, byClass }` with all six classes (`pasted-internal` always 0). Characters are the UTF-16 code units of the inline text (text and hard breaks; citations and block boundaries excluded). `projectWordsByClass(state, scope?)` / `projectCharactersByClass` sum documents (default: non-archived manuscript documents; `{ documentIds }`, `includeNotes`, `includeArchived`).

### Replay and the span inspector

- `new Replay(commits, { snapshotEvery = 64 })`: `stateAt(seq)` (0 = empty) folds lazily and keeps a snapshot every N commits, so scrubbing costs at most N − 1 folds. `stateAtSeq(commits, seq)` caches a `Replay` per array.
- `spanHistory(state, documentId, pos)` → `{ run, origin: { seq, type, clientTime, serverTime, editorSessionId, deviceId, methods, writingSessionIndex }, matched, visibleSuggestions, moves: [{ seq, kind: 'move' | 'paste' | 'drop', proposalId, … }] }`.

### Test support

`LedgerBuilder` (exported from the package) builds valid, hashed ledgers: `type`, `compose` (IME), `backspace`, `typeOver`, `enter`, `format`, `deleteText`, `pasteExternal`, `copy`/`pasteInternal`, `drop`, `undo`/`redo`, `cite`, `placeClipping`, binder and library helpers, and every agent tool (`comment`, `suggestWordChoice`, `proposeMove`, …, `finishReview`, `answerDiscussion`). Every draft goes through `validateDraft`; like the service it appends `SuggestionResolved` automatically (`autoResolve`). Anchors are given by quote (`{ documentId, sentenceId, quote }`), optionally at an older `readVersion` to model stale-on-arrival.

## Golden fixtures

`import { loadFixture, FIXTURE_NAMES, loadTamperedFixture, TAMPERED_FIXTURE_NAMES } from '@longhand/ledger/fixtures'` (Node; or import the JSON files directly).

A fixture file has `commits`, `witnesses` (signed with the test key in `fixtures/witness-test-key.json`, **test only**), `publicKeyPem`, `keyId` and `expected`: `headSeq`, `headHash`, the full `state` (`ProjectState`: document JSON, provenance runs, annotations…), per document `text`, `words` (attribution), `wordsByClass`, `charactersByClass`, plus `projectWords`, `projectCharacters` and `issues` (always empty).

| Fixture            | Covers                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plain-typing`     | typing in batches, backspace, typing over a typo, emphasis, a heading                                                                                                                                                               |
| `ime`              | IME composition mixed with typing                                                                                                                                                                                                   |
| `external-paste`   | inline, multi-paragraph and replacing pastes; typing inside a pasted span                                                                                                                                                           |
| `internal-paste`   | copy/paste inheriting typed and pasted classes, across documents, cut and paste, editing the source after copying, a mismatching paste downgraded, drag and drop                                                                    |
| `undo-paste`       | undo/redo of a paste stays pasted-external; undo of a deletion restores typed text; forged history insert → pasted-external                                                                                                         |
| `import`           | imported draft, edited; a word mixing imported and typed characters counts as imported                                                                                                                                              |
| `feedback-session` | request, review session, anchored and span comments, questions, `finish_review`, a dismissal, a failed session, a selection scope mapped through later edits                                                                        |
| `suggestions`      | word choice adopted, adapted (trace-over), stale (edited away), dismissed, stale on arrival; insertion retyped; rephrase adapted; four-word match from a comment                                                                    |
| `proposals`        | sentence and paragraph moves, cut, split, merge: accepted, rejected and stale; an accept at an older `baseVersion`                                                                                                                  |
| `discuss`          | Discuss thread answered, followed up, failed                                                                                                                                                                                        |
| `research`         | sources, clippings, citation-needed flags (one becomes cited), surfaced sources with a verified candidate added, a source suggestion, clippings as quote blocks (one with blank lines collapsed), a mismatching clipping downgraded |
| `binder`           | nested folders, notes, reorder and moves, rename, synopsis, archive/restore, a move into an archived folder, a folder and a document sharing an id, settings                                                                        |
| `novel`            | three chapters and a note, three writing sessions over two days and two devices, an internal paste across chapters, a review, an embedded `ChainHeadWitnessed`                                                                      |

Tampered copies (`fixtures/tampered/`) carry `trueHead` and the expected `verifyChain` problems (with and without `expectedHead`) and witness problems: `tampered-edited` (`hash-mismatch`), `tampered-rehashed` (`prev-hash-mismatch` on the next commit), `tampered-reordered`, `tampered-dropped` (`seq-gap` + `prev-hash-mismatch`), `tampered-actor` (an agent commit relabelled human: `invalid-commit` + `prev-hash-mismatch`), `tampered-truncated` (chain alone passes; `head-mismatch` with the true head; `extra-witness` for the dropped commits).

Fixtures are defined as builder scripts in `fixtures/definitions.ts`. `pnpm --filter @longhand/ledger fixtures` regenerates the JSON (unchanged commits keep their witnesses, so regeneration is byte-stable); `src/fixtures.test.ts` fails if any file is stale.

## Semantics decisions

These are the fold's rules beyond `docs/BUILD.md`; any change to them goes through this package.

### Provenance

- Runs follow every step through its `StepMap`: units outside a replaced range survive and are mapped, units inside are deleted (and buried as tombstones), units in the new range are inserted and get a class from their input-method run.
- **Typed, IME, autocorrect** → `typed` with the commit seq. When a typed step replaces text, a common prefix/suffix of the deleted and inserted units keeps the old provenance (so retyping or spellcheck-replacing pasted text never upgrades it).
- **Internal paste** inherits only if the inserted units equal the `SliceCopied` snapshot exactly (unit keys: characters, and node type + attrs for leaves; marks ignored). The snapshot is taken at `SliceCopied` and is invalid unless its `version` is current and its `textHash` matches. The `PasteOccurred` must exist, be internal, be for this document and not already used. Inherited units keep `class`/`originSeq` and gain the paste seq in `moves`. Otherwise `pasted-external`.
- **Drop** inherits if the run's inserted units equal the units the same run deleted (in order); the dropped text gains the seq in `moves`.
- **Undo/redo (`history`)** inherits from tombstones: deleted content kept in document order at the gap where it was deleted. Per step, the inserted units must equal a contiguous run of a tomb at that position (most recently deleted wins), falling back to any tomb in the document; otherwise `pasted-external`. A redo of a paste therefore comes back as `pasted-external`.
- **Citation** → `quoted` if the run inserts only citation nodes whose `sourceId`/`locator` equal the (unused) `CitationInserted`'s and the source exists; **clipping** → `quoted` if the run's inserted units are exactly the units of one new `quote_block` with that clipping's `clippingId` and `sourceId` and its paragraphs joined by `\n` equal the clipping text, both with blank lines collapsed; otherwise `pasted-external`.
- `PasteState.characters` and `words` are measured from what the run actually inserted (not the client's claim); `insertedSeq` is the first run that used it.
- Moves and accepted proposals never change class; `moves` records the relocating commits.

### "Typed from a suggestion"

- **Edit-distance rule:** while a word-choice or insertion suggestion is open, the writer's edits inside its _region_ (see below) are compared with each alternative (or the sentence), normalized by ASCII case folding, curly-apostrophe folding and whitespace collapsing; distance ≤ 0.15 upgrades the region's `typed` units typed after the suggestion arrived.
- **Four-word rule:** every agent text (suggestion alternatives, sentences, rationales, purposes, rephrase guidance, comment bodies, questions, proposal rationales, flag claims, surfaced queries and candidate titles, source-suggestion rationales, review summaries/strengths/priorities, discuss answers) contributes its 4-grams, minus 4-grams present in any project document when it arrived. A window of 4 consecutive words containing newly typed text that matches upgrades its `typed` units typed after that text arrived (earliest annotation wins).
- A trace-over `traceSuggestionId` upgrades its run's typed text unconditionally.
- `suggestionId` names the matched annotation: a suggestion, comment, question, flag, surfaced source, source suggestion or proposal id; a discuss **thread** id for discuss answers; a **feedback session** id for review text. `spanHistory().matched.group` says which.

### Suggestion lifecycle

An open suggestion tracks a region: its anchor (a point for insertions). Once the writer edits inside it, text typed at its edges is absorbed (so keystroke-by-keystroke retyping stays inside); a trace-over hint absorbs edge insertions from the start. At the end of each commit that touched the region:

1. **adopted** — an alternative (normalized) appears word-bounded in the region and its characters are typed; `adoptedAlternative` is the longest such alternative.
2. back to the original text → still **open**.
3. a proper prefix of an alternative, typed only → still **open** (retyping in progress across batches).
4. **adapted** — typed edits that show the suggestion's influence: a trace-over hint, edit distance ≤ 0.15, or a shared 4-gram.
5. otherwise **stale** (deleted, pasted over, replaced with unrelated text).

Insertions go stale only when the sentence they are relative to is deleted. Rephrase hints are adapted when the writer types inside the span and stale when it is edited otherwise; they never change provenance. **Stale on arrival:** a suggestion or proposal whose target was touched by any step between `readVersion` and `version`, or whose anchor quote no longer matches, arrives stale. `resolvedSeq` is the triggering commit; a `SuggestionResolved` must agree or it is a fold issue.

### Proposals

Steps are derived from the mapped positions (never by re-resolving ids). Move: delete the source, insert the same slice at the mapped insertion point; annotations wholly inside the moved text move with it. Sentence moves insert one U+0020 on a side where neither neighbour has whitespace, and remove one whitespace character where the source left a double (or edge) space. Cut: delete (inline cuts get the same gap clean-up; cutting the whole document leaves an empty paragraph). Split: split at the sentence start, removing the whitespace between the two sentences. Merge: join, inserting one U+0020 when neither side has whitespace. Inserted spaces are `typed` with the accept seq. A proposal goes stale when any step touches it (for paragraph/section spans and merges, also edits at their node boundaries; for splits, edits inside the paragraph; for moves, the insertion point being deleted). A proposal whose positions no longer form valid structure at accept time throws `proposal-failed`.

### Positions and annotations

- Ranges map with `from` associating right and `to` left; a range whose text is deleted becomes `null` and stays null. Feedback selection scopes are mapped too (to the current `version`) and collapse to a point instead of becoming null.
- Agent positions: `version` may not be ahead of the document; when `readVersion === version` the positions must equal what the schema resolvers give (`target-mismatch`).
- Citation flags become `cited` (and stay cited) once a `quoted` citation node sits inside the flag's range or after it in the same sentence (up to the next sentence's first character).
- Dismissing a closed card is `not-open`. Proposals are rejected with `ProposalRejected`, never dismissed.
- Sessions: annotation events need a running session of the right kind whose id is the envelope `sessionId`, within the caps of its request's intensity.

### Binder

`{parentId, index}`, index counted after removal and clamped. A folder's `updatedSeq` bumps whenever its children list changes (child created, moved in or moved out). Moves into archived folders are accepted. Ids are unique per collection: a folder and a document may share an id. Nodes never change area; folders never move into a descendant.

### Writing sessions

Built from `TextEdited` and accepted proposals (not imports), in `(clientTime, seq)` order; a gap of ≥ 30 minutes between consecutive `clientTime`s starts a new session. `endTime` is the latest `clientTime + durationMs`; `charactersInserted` counts text characters inserted by the commit's steps.

## Known gaps

- Tombstones and step-map history are kept for the life of the document (memory grows with deleted text and step count).
- Per-step cost is linear in the number of runs, tombstones and trackers of the document; fine for book-length documents, not tuned beyond that.
