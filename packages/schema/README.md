# @longhand/schema

The contracts every Longhand lane codes against: event types and payloads, the commit envelope and hash chain, witnesses, the ProseMirror schema, the segmenter and anchor format, the agent tool catalog, provenance types, the fold's output types and the verification bundle.

Isomorphic and deterministic. It runs the same in Node and browsers, uses no Node-only APIs (ESLint enforces this), and uses no ICU- or locale-dependent APIs (`Intl.Segmenter`, `\p{…}`, `localeCompare`, `normalize`). Every export has JSDoc, so read the source next to this file.

Only the coordinator's serial agents change this package. If you need a new event, field or tool argument, ask for it. Do not edit it yourself.

```sh
pnpm --filter @longhand/schema test       # vitest
pnpm --filter @longhand/schema typecheck
```

## The one rule

No word enters the manuscript unless a human input event put it there. Three layers enforce this:

1. **Schema.** `CommitSchema` rejects any commit whose `actor.kind` may not emit its `type` (`canActorEmit`). Each event type has exactly one permitted actor kind.
2. **Event table.** Only `MANUSCRIPT_EVENT_TYPES` (`TextEdited`, `ProposalAccepted`, `DocumentImported`) can change manuscript text, and all three are human-only. `TextEdited` is the only event that carries steps. `ProposalAccepted` makes the fold derive its own steps, and those steps only move, delete or split/join existing content.
3. **Tools.** No agent tool takes text bound for the manuscript. AI text (alternatives, insertion sentences, comments, answers) lives only in annotation events.

## Modules

| Module       | What                                                                                                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonical`  | `canonicalize` (RFC 8785 JCS), `sha256Hex`, `canonicalHash`. It omits `undefined` object properties and escapes lone surrogates; it never throws on writer text.                                                                             |
| `ids`        | `IdSchema` (1–64 chars `[A-Za-z0-9_-]`, so UUIDs fit), `IsoTimeSchema` (exact `Date#toISOString()` form), `Sha256HexSchema`, `PosSchema`, `VersionSchema`, `SeqSchema`                                                                       |
| `document`   | `schema` (ProseMirror), `docFromJSON`, `DocJSONSchema`, `EMPTY_DOC_JSON`, `PMNodeJSON`                                                                                                                                                       |
| `text`       | `countWords`, `tokenizeWords`, `splitSentences`, `isWordCodePoint`, abbreviation lists                                                                                                                                                       |
| `anchors`    | `segmentDoc`, `segment`, `resolveAnchor`, `resolveSpan`, `resolveMove`, `resolveInsertionPoint`, `resolveSplit`, `resolveMerge`, `inlineTextBetween`, `AnchorSchema`, `SpanRefSchema`, id helpers                                            |
| `domain`     | lenses, intensity, severity, dismiss reasons, `InputMethod`, keystroke kinds, `ProjectSettings`, `CslItem`                                                                                                                                   |
| `bounds`     | `BOUNDS` (tool argument limits), `CAPS`, `capsFor`                                                                                                                                                                                           |
| `events`     | every payload schema, `EVENTS`, `EVENT_TYPES`, `ACTOR_PERMISSIONS`, `MANUSCRIPT_EVENT_TYPES`, `canActorEmit`, `parsePayload`, `Target`/`ResolvedAnchor`/`ResolvedSpan`                                                                       |
| `ledger`     | `Commit`, `CommitDraft`, `CommitSchema`, `CommitDraftSchema`, `computeCommitHash`, `verifyCommitHash`, `GENESIS_PREV_HASH`, `SCHEMA_VERSION`, `Witness`, `witnessMessage`, `verifyWitnessSignature`, key/PEM/base64 helpers, `WitnessSigner` |
| `tools`      | `TOOLS`, `TOOL_NAMES`, `TOOL_JSON_SCHEMAS`, per-tool input schemas, `capViolation`, `countCall`, `rephraseGuidanceViolation`, `toolsForSession`, `ToolResult`                                                                                |
| `provenance` | `ProvenanceClass`, `ProvenanceRun`, `checkProvenanceRuns`, `provenanceUnits`, `runAt`                                                                                                                                                        |
| `state`      | `ProjectState` and all its parts (types only), `SESSION_GAP_MS`                                                                                                                                                                              |
| `bundle`     | `VerificationBundleSchema`, `AuthorshipReportSchema`, `PROVES_TABLE`                                                                                                                                                                         |

## Actor permission table

Exactly one actor kind may emit each event type. The "Manuscript" column marks the only events whose fold may change manuscript text.

| Event                    | Actor  | Manuscript |
| ------------------------ | ------ | ---------- |
| `ProjectCreated`         | human  | no         |
| `ProjectSettingsChanged` | human  | no         |
| `DocumentCreated`        | human  | no         |
| `DocumentImported`       | human  | **yes**    |
| `DocumentRenamed`        | human  | no         |
| `DocumentMoved`          | human  | no         |
| `DocumentArchived`       | human  | no         |
| `SynopsisEdited`         | human  | no         |
| `FolderCreated`          | human  | no         |
| `FolderRenamed`          | human  | no         |
| `FolderMoved`            | human  | no         |
| `FolderArchived`         | human  | no         |
| `TextEdited`             | human  | **yes**    |
| `PasteOccurred`          | human  | no         |
| `SliceCopied`            | human  | no         |
| `ProposalAccepted`       | human  | **yes**    |
| `ProposalRejected`       | human  | no         |
| `SuggestionDismissed`    | human  | no         |
| `FeedbackRequested`      | human  | no         |
| `DiscussRequested`       | human  | no         |
| `SourceAdded`            | human  | no         |
| `SourceUpdated`          | human  | no         |
| `CitationInserted`       | human  | no         |
| `ClippingSaved`          | human  | no         |
| `ClippingRemoved`        | human  | no         |
| `FeedbackSessionStarted` | agent  | no         |
| `CommentAdded`           | agent  | no         |
| `QuestionAsked`          | agent  | no         |
| `SuggestionProposed`     | agent  | no         |
| `MoveProposed`           | agent  | no         |
| `CutProposed`            | agent  | no         |
| `SplitProposed`          | agent  | no         |
| `MergeProposed`          | agent  | no         |
| `CitationNeededFlagged`  | agent  | no         |
| `SourceSurfaced`         | agent  | no         |
| `SourceSuggested`        | agent  | no         |
| `ReviewFinished`         | agent  | no         |
| `DiscussAnswered`        | agent  | no         |
| `SuggestionResolved`     | system | no         |
| `ChainHeadWitnessed`     | system | no         |
| `FeedbackSessionFailed`  | system | no         |

## Commits, hashing, witnesses

- A commit has the envelope `{ commitId, projectId, accountId, seq, prevHash, hash, clientTime, serverTime, actor: {kind, id}, deviceId, sessionId, type, schemaVersion, payload }`. `CommitSchema` is strict about envelope keys.
- **Who fills what.** Clients submit a `CommitDraft` without `seq`, `prevHash`, `hash`, `serverTime` or `accountId`. The ledger service assigns `seq` (1-based), `prevHash` (`GENESIS_PREV_HASH`, 64 zeros, for seq 1), `serverTime` and `accountId`, then sets `hash = computeCommitHash(commit)`, which is SHA-256 over the JCS of every field except `hash`. `commitId` is the emitter's idempotency key, and the service dedupes resends by it.
- **What gets hashed.** The service hashes and stores the parsed commit. A verifier hashes commits exactly as they appear in the bundle.
- **Field conventions.**
  - Times use the `Date#toISOString()` format.
  - `clientTime` is when the action happened. For `TextEdited` it is the batch's first input event.
  - `deviceId` is random per browser install, or `server`.
  - `sessionId` is the editor session for human commits, the feedback session for agent commits, and `system` for system commits.
- **Witnesses.** A witness is `{projectId, seq, hash, serverTime, signature, keyId}`.
  - `witnessMessage()` gives the bytes to sign: UTF-8 of `canonicalize({projectId, seq, hash, serverTime})`.
  - The signature is ECDSA P-256 / SHA-256, encoded as base64 of the 64-byte **IEEE P1363** `r‖s` form. That is WebCrypto's native form. Node produces it with `dsaEncoding: 'ieee-p1363'`; convert KMS DER signatures to it.
  - `keyId` is `sha256Hex(SPKI DER)` (`keyIdFromPublicKeyPem`).
  - `verifyWitnessSignature` uses WebCrypto, so it works in Node and in browsers.

## Documents, ids and anchors

- **No stable block ids.** Blocks are positional. `segmentDoc(doc)` numbers every textblock (paragraphs and headings at any depth) `p1, p2, …` in document order, footnotes `fn1, …`, and sentences `p3.s2` (1-based). The numeric `blockIndex` and `sentenceIndex` fields are 0-based. Ids are valid only for one document version. Anything durable stores positions and maps them through steps.
- **Inline text** is what anchors quote against:
  - text nodes are verbatim;
  - `hard_break` is `"\n"`;
  - `citation` and `footnote` contribute nothing, but still occupy positions;
  - footnote text belongs to its own `fnN` block.
- **Anchors.**
  - An `Anchor` is `{documentId, sentenceId, quote, occurrence}`. The quote must be an exact substring of that one sentence. `occurrence` is 0-based and counts overlapping matches.
  - In tool input `occurrence` may be omitted only when the quote is unique. Stored anchors always carry it.
  - `resolveAnchor` returns `{from, to}` or an error whose message is written for the model.
- **Spans** (`{documentId, unit, ids}`) take one of three units:
  - `sentence`: consecutive sentences of one block. The range covers their text.
  - `paragraph`: adjacent top-level textblocks. The range covers the whole nodes.
  - `section`: top-level headings. A section runs to the next top-level heading of the same or higher level.
- **Moves** go before or after a unit of the same kind and must lie outside the source span. **Splits** go before a non-first sentence of a paragraph. **Merges** take two directly adjacent sibling paragraphs.
- **Sentence splitter** (`splitSentences`) is rule-based. It handles abbreviations, initials, decimals, ellipses, closing quotes and brackets, enumerators, and CJK terminals.
- **Word counter** (`countWords`) treats ASCII letters and digits, plus any non-ASCII code point outside explicit punctuation and symbol ranges, as word characters. Apostrophes and hyphens join words; `.` and `,` join digits.

## TextEdited, input methods and how the fold classifies text

A `TextEdited` carries the following fields:

- `steps`: `Step#toJSON()` values, at most 500.
- `runs`: input-method runs as `{steps: n, method, pasteId?, citationId?, clippingId?, traceSuggestionId?}`. They partition `steps` in order.
- `timeline`: the full keystroke timeline as `{t, kind, len}`, where `t` is ms after `clientTime`.
- `characters` and `durationMs`.
- `baseVersion`: the document version, which is the cumulative count of steps applied to that document.

| Method                                                                                  | Class the fold assigns to inserted text                                                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typed`, `ime`, `autocorrect`                                                           | `typed`, upgraded to `typed-from-suggestion` by the matcher                                                                                          |
| `pasted-external` (needs `pasteId`)                                                     | `pasted-external`                                                                                                                                    |
| `pasted-internal` (needs `pasteId`, whose `PasteOccurred.copyId` names a `SliceCopied`) | inherits the copied span's classes if the inserted text equals the snapshot taken at `SliceCopied`, otherwise `pasted-external`                      |
| `drop-internal`, `history`                                                              | inherits from content deleted earlier (same run for drops, earlier deletions for undo/redo) if the text matches exactly, otherwise `pasted-external` |
| `citation` (needs `citationId`)                                                         | `quoted`; may insert only `citation` nodes, otherwise `pasted-external`                                                                              |
| `clipping` (needs `clippingId`)                                                         | `quoted` if it inserts one `quote_block` whose inline text (`"\n"` between paragraphs) equals the clipping text, otherwise `pasted-external`         |

The client reports a method. The fold derives the class, and when it cannot verify a claim it **downgrades**; it never upgrades. Companion events (`PasteOccurred`, `CitationInserted`, `SliceCopied`) never change text, and each must have a lower seq than the `TextEdited` that references it. `traceSuggestionId` is an optional hint that can only add disclosure.

## Agent events and positions

The ledger service resolves an agent event's anchor or span against the version the agent read (`readVersion`). It maps the result to the document's current version (`version`) under the project's append lock and stores `{anchor | span, from, to, readVersion, version}` (`Target`, `ResolvedAnchor`, `ResolvedSpan`, `ResolvedPoint`). The fold maps those positions through every later step.

- A suggestion or proposal whose text changed between `readVersion` and arrival is stale on arrival.
- `SuggestionDismissed` applies to every card except proposals, which use `ProposalRejected`.

## Tools and caps

`TOOLS` covers the spec catalog plus `answer_discussion`, which serves F4 Discuss.

- **Session kinds.** Review sessions end with `finish_review`. Discuss sessions get only read tools plus `answer_discussion` (`toolsForSession`).
- **Validation.** The zod input schemas check every bound that needs no document: lengths, `countWords` limits, the one-sentence rule and exactly-one-target. The handler then:
  - resolves anchors and spans with the `anchors` resolvers;
  - runs `rephraseGuidanceViolation`, which rejects quoted new wording of 3 or more words;
  - checks caps with `capViolation`.
- **JSON Schemas.** `TOOL_JSON_SCHEMAS` holds draft 2020-12 JSON Schemas for MCP, without the `$schema` key.

| Cap                                     | light | standard | thorough |
| --------------------------------------- | ----- | -------- | -------- |
| items (every annotation-producing call) | 5     | 20       | 40       |
| suggestions (hard max 15)               | 5     | 10       | 15       |
| insertions (hard max 3)                 | 1     | 2        | 3        |
| proposals                               | 2     | 5        | 10       |
| questions                               | 2     | 4        | 6        |
| searches                                | 2     | 4        | 5        |

## Provenance and ProjectState

- **Canonical runs.** A `ProvenanceRun` is `{from, to, class, originSeq, suggestionId?, moves?}`. Runs cover exactly the _units_: text characters and inline leaves (`citation`, `hard_break`). They never span block boundaries or footnote tokens. They are sorted, and identical adjacent runs are merged. `checkProvenanceRuns(doc, runs)` validates this canonical form.
- **No `pasted-internal` runs.** `pasted-internal` never appears as a run class, because internal pastes inherit their source's class.
- **`ProjectState`.** It holds `binder`, `folders` (with synopsis), `documents` (content JSON, `version`, `provenance`, synopsis), `annotations` (comments, questions, suggestions, proposals, flags, surfaced sources, source suggestions, feedback requests, agent sessions, discuss threads), `sources`, `clippings`, `pastes` and `writingSessions`.
- **Ranges and records.** Ranges are in the current version, or `null` once their text is deleted. Records are keyed by id and carry their creating `seq`.

## Bundle

`VerificationBundle = { format: 'longhand-bundle', version: 1, projectId, createdAt, commits, witnesses, publicKeyPem, keyId, report }`.

- **Report shape.** `AuthorshipReportSchema` fixes the required top-level fields: words and characters by class, active time, sessions, AI activity, suggestions by kind and outcome, proposals by kind and outcome, pastes, imports, unwitnessed intervals, the disclosure text and `provesTable`.
- **Extensions.** The report is a loose object, and lane extras go under `extensions`.
- **Proves table.** `PROVES_TABLE` is the spec's proves / does-not-prove table, verbatim.

## Contract revisions (phase 2c)

Applied after the phase 2b lanes merged. None changes a stored payload incompatibly, so `SCHEMA_VERSION` stays 1.

- **Folder synopses.** `SynopsisEdited` is `{documentId, synopsis} | {folderId, synopsis}`; exactly one id is present. `FolderState.synopsis` is `''` until edited.
