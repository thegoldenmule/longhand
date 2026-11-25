# @longhand/research

**Lane:** Research (F8). Sources library, metadata fetch (Crossref, Open Library, page metadata) into CSL-JSON, candidate search for the AI `search_sources` tool, clippings, Cite and Place clipping commands, CSL bibliographies, and the React components for the research pane.

Nothing here writes manuscript text. Citations are structured `citation` nodes. Clippings are placed as `quote_block`s that the fold classes `quoted`. AI-surfaced sources stay labeled *AI-surfaced — unverified* until the writer checks them and adds them with `SourceAdded`.

```sh
pnpm --filter @longhand/research test        # vitest (node + jsdom), no network
pnpm --filter @longhand/research typecheck
pnpm --filter @longhand/research record-fixtures   # re-record HTTP fixtures (network; add --force to overwrite)
pnpm --filter @longhand/research build-styles      # re-embed vendor/csl/* after updating them
```

## Exports

| Area | Exports |
| --- | --- |
| HTTP | `FetchLike`, `HttpOptions` (`fetch`, `userAgent`), `USER_AGENT` (`Longhand/0.1`), `MetadataError` (`code`: `invalid-input`, `not-found`, `http-error`, `network-error`, `bad-response`) |
| Identifiers | `normalizeDoi`, `doiKey`, `normalizeIsbn` (check digit, returns ISBN-13), `isbn10to13`, `normalizeUrl`, `classifyIdentifier` |
| Fetchers | `fetchDoi` (Crossref `api.crossref.org/works/{doi}`), `fetchIsbn` (Open Library Books API), `fetchUrl` (page metadata), `createMetadataClient({ fetch, pageFetch?, userAgent?, now? })` → `{ fetchDoi, fetchIsbn, fetchUrl, lookup }`, each returning `{ csl, origin, provider }`. Lower-level mappers: `crossrefWorkToCsl`, `openLibraryBookToCsl`, `openLibraryDocToCsl`, `scanHtml`, `pageMetadataToCsl`, plus the URL builders |
| Search | `SourceSearch` (`search(query, limit): Promise<CslItem[]>`), `createSourceSearch(opts)` → `LonghandSourceSearch` (adds `searchCandidates(query, limit?)` → `SurfacedCandidate[]`), `mergeResults`, `providerOf`, `toSurfacedCandidate` |
| Manual entry | `ManualEntry`, `emptyManualEntry`, `validateManualEntry(form, id, base?)` → `{ ok, csl, warnings } \| { ok: false, errors }`, `cslToManualEntry`, `SOURCE_TYPES`, `sourceTypeLabel` |
| CSL helpers | `parseName`, `parseNames`, `formatName`, `parseDate`, `formatDate`, `yearOf`, `cleanText`, `sourceLabel` |
| Bibliography | `STYLES`, `StyleId` (`apa`, `modern-language-association`, `chicago-author-date`), `resolveStyle` (also takes `mla`, `chicago`), `formatCitation(items, sourceId, locator, style)`, `formatCitations(items, cites, style)`, `formatBibliography(items, style, ids?)` (text, HTML, per-entry and layout hints), `parseLocator`, `referencedSourceIds(docJSON)` (citations, footnote citations and quote blocks) |
| Drafts | `DraftContext`, `makeDraft`, `sourceAddedDraft`, `surfacedSourceAddedDraft`, `sourceUpdatedDraft`, `clippingSavedDraft`, `clippingRemovedDraft`, `citationInsertedDraft`, `researchCardDismissedDraft` (`SuggestionDismissed` for AI research cards), `normalizeClippingText`, `ResearchDraft` |
| Commands | `insertCitation(sourceId, locator, { documentId, citationId?, newId? })`, `placeClipping(clipping, { pos? })`, the non-dispatching `citationTransaction` / `clippingTransaction`, `clippingNode`, `RESEARCH_INPUT_META`, `getResearchInput(tr)`, `ResearchInput` |
| Components | `<SourcesPanel>`, `<ClippingsList>`, `<CitationPicker>`, `<Bibliography>`, `<SourceForm>`, `AiSurfacedBadge`, `AI_SURFACED_LABEL`, `SourceSummary` |
| CSS | `@longhand/research/research.css` (classes `lh-research-*`, themed by `--lh-research-*` variables, light and dark) |

`items` for the bibliography functions may be `CslItem[]`, `SourceState[]` or `ProjectState.sources`. For sources, the source id is the citeproc item id.

## Metadata fetchers

- Every request goes through the injected `fetch` (default `globalThis.fetch`) and sends `User-Agent: Longhand/0.1` with no contact details. Pass `userAgent: null` in browsers, which do not let pages set it.
- **Page metadata** is read in this order of trust: Highwire `citation_*` tags, then JSON-LD (the most specific creative-work object), Dublin Core, Open Graph and Twitter tags, and finally `<title>` with any `| Site` suffix removed. `accessed` is set from `now()`. The scanner is a small tag tokenizer, not a DOM parser, so it behaves the same in Node and browsers.
- **CORS.** Crossref and Open Library allow cross-origin requests. Arbitrary pages do not. In the browser, pass `pageFetch`: a fetch that goes through an app-server proxy for page lookups.
- Every fetched item records its provider in CSL `source` (`Crossref`, `Open Library` or `Web`), which `providerOf` reads.
- The CSL `id` of a fetched item is a placeholder (`doi:…`, `isbn:…`, `url:…`). `sourceAddedDraft` replaces it with the source id.

## Search (agent lane)

`createSourceSearch({ fetch })` implements `SourceSearch`. It runs Crossref `works?query.bibliographic=` and Open Library `search.json` in parallel. It then interleaves the results (first from each provider, then second from each, and so on) and drops duplicates by DOI (case-insensitive), ISBN (10 and 13 compared) and normalized title, first author and year. A provider that fails is skipped; it is reported through `onProviderError`. `searchCandidates` returns `SurfacedCandidate[]` clamped to `BOUNDS.searchMaxCandidates`, ready for `SourceSurfaced.candidates`.

## Editor integration

The schema doesn't define how the editor tags transactions. These commands use their own meta key. The editor lane's batcher must honour it as follows.

1. **Tag.** `insertCitation` and `placeClipping` each dispatch one transaction with exactly one `ReplaceStep`, and set `tr.getMeta(RESEARCH_INPUT_META)` (`'longhand/research-input'`) to a `ResearchInput`:
   ```ts
   {
     run: { steps: 1, method: 'citation', citationId } | { steps: 1, method: 'clipping', clippingId },
     companions: [{ type: 'CitationInserted', payload: { citationId, documentId, sourceId, locator } }], // [] for clippings
     characters: number,            // 0 for a citation; clipping text length without the \n separators
     keystroke: { kind: 'paste', len: characters },
   }
   ```
2. **Runs.** Append `run` to the batch's `TextEdited.runs` as its own run. Don't merge it with neighbouring typed runs, and don't let the typed-input capture classify these steps. `run.steps` always equals `tr.steps.length`.
3. **Companions first.** Commit each companion before the `TextEdited` that carries the steps, so it gets a lower seq. Wrap it with `citationInsertedDraft(ctx, companion.payload)` or `makeDraft`. It doesn't change text, so the editor doesn't need to flush pending steps first. A clipping's `ClippingSaved` was committed when the clipping was saved, so a clipping has no companion.
4. **Timeline and counts.** Add `characters` to `TextEdited.characters`. Record one timeline entry `{ t, kind: keystroke.kind, len: keystroke.len }`. The schema has no dedicated keystroke kind for these actions, so they are recorded as `paste`, which isn't typing.
5. **Undo.** Undoing or redoing these steps is ordinary `history` input. The fold handles it.

Placement rules:

- **Citation.** The citation goes at the end of the selection. Selected text is kept, and the citation follows it. The cursor ends up after the citation. The command refuses (returns `false`) where an inline node can't go. A locator over 100 characters throws.
- **Clipping.** The quote block goes after the top-level block that holds the selection, or at `opts.pos` if given, which must be between top-level blocks. It has one paragraph per `\n` line, so its inline text equals the clipping text exactly. That match is what the fold checks before classing it `quoted`. The cursor moves to the nearest position after it. The command adds no trailing paragraph, because a second step would break that check. If the quote ends the document, the editor needs its own trailing-paragraph or gap-cursor handling.

Typical host wiring:

```tsx
<CitationPicker sources={state.sources} style={settings.citationStyle}
  onInsert={(sourceId, locator) =>
    insertCitation(sourceId, locator, { documentId })(view.state, view.dispatch)} />
<ClippingsList clippings={state.clippings} sources={state.sources}
  draftContext={ctx} onDraft={queueCommit}
  onPlace={(c) => placeClipping(c)(view.state, view.dispatch)} />
```

## Components

The components are controlled by `ProjectState` slices and make no network requests of their own. `<SourcesPanel>` fetches only through the `metadata` client it is given. Every change goes out as a commit draft through `onDraft`, built from `draftContext`.

- **`<SourcesPanel sources surfaced? sourceSuggestions? metadata draftContext onDraft onCite? onShowTarget? showArchived?>`.** The writer looks up a DOI, ISBN or URL, sees a preview, and chooses Add, Edit first, or Cancel. Sources can also be entered by hand. In the library, each source can be edited (metadata and note → `SourceUpdated`) or archived and restored. AI-surfaced cards carry the *AI-surfaced — unverified* label on the card and on every candidate not yet added. *Verify and add…* opens the details form with a link to the source. Submitting it emits `SourceAdded` with origin `surfaced`, `fromSurfacedId` and `candidateIndex`. Candidates already added show *Verified and added*. *Dismiss* emits `SuggestionDismissed`. The panel also lists `suggest_source` suggestions, with Cite and Dismiss.
- **`<ClippingsList clippings sources sourceId? onPlace? draftContext onDraft>`.** Save a quote with its location and an optional note (`ClippingSaved`), place it (`onPlace`), or remove it (`ClippingRemoved`).
- **`<CitationPicker sources initialSourceId? style? onInsert onCancel?>`.** Filter the library, choose a source, enter a locator, preview the formatted citation, and insert it.
- **`<Bibliography sources sourceIds? style? onStyleChange? title?>`.** citeproc HTML with an APA / MLA / Chicago switcher and *Copy as text*. Persist the chosen style with `ProjectSettingsChanged { patch: { citationStyle } }`.

## Tests

- Real responses were recorded once by `scripts/record-fixtures.ts` into `src/__fixtures__/http/`. They are Crossref DOI lookups (journal article, conference paper, book chapter, 404), Crossref searches, Open Library ISBN lookups and searches, and four pages: arXiv, Wikipedia, example.com and a New Yorker article. The suite reads them through `src/test-support/fixture-fetch.ts`, which fails on any URL that wasn't recorded. HTML fixtures keep the `<head>`, with inline style and script bodies removed, plus any JSON-LD from the body.
- There are exact citeproc outputs for every style, both citations and bibliographies.
- Command tests check:
  - one step, the right node and the input-method tag;
  - that the steps replay with `Step.fromJSON`;
  - that `TextEditedSchema` accepts the resulting run;
  - that the quote block's `inlineTextBetween` equals the clipping text.
- Component tests use `@testing-library/react` in jsdom (`// @vitest-environment jsdom`).

## Contract changes requested (coordinator)

1. **A shared transaction meta key for input methods** in `packages/schema`, for example `INPUT_METHOD_META` with an `InputRun`-shaped value plus companion payloads. That would give the editor, research and annotations lanes one convention. Until then, research uses `RESEARCH_INPUT_META = 'longhand/research-input'` as described above.
2. **Keystroke kinds `cite` and `clip`**, or guidance on which existing kind to use. Research currently suggests `paste`.
3. **Blank lines in clippings.** `inlineTextBetween` skips empty paragraphs, so a clipping whose text contains `\n\n` or starts or ends with `\n` can never place as `quoted`. Research's `clippingSavedDraft` collapses blank lines, but another client could still save one. Proposal: `ClippingSavedSchema.text` rejects empty lines, or the fold compares the text with blank lines collapsed.
4. **`SourceSearch` in the schema.** The agent lane needs the `SourceSearch` interface. Defining it in `packages/schema`, next to the tool catalog, would mean neither lane has to depend on the other.
5. Optional: a CSL `source` convention, or a `provider` field on library sources, so the origin provider survives `SourceAdded`. Today it survives only in CSL `source`.

## Known gaps

- **Web search.** The `search_sources` description mentions "the web", but only Crossref and Open Library are searched. There is no web search provider; a `web` provider would need an API key and a server-side proxy.
- **Page fetching in the browser** needs the app to supply a proxy `pageFetch`. Pages that are paywalled, need JavaScript or block bots return little or no metadata. When a page has no title, the writer is pointed to manual entry.
- **The DOI found on a page isn't followed up.** A page whose `citation_doi` is found keeps the page metadata and isn't re-fetched from Crossref.
- **Notes-style Chicago isn't bundled.** Only author-date styles and en-US are bundled. Citations are formatted one cluster at a time, so author-date disambiguation across a document (2015a/2015b) is computed only within a bibliography call. Notes styles would need document-order cluster processing.
- **Footnote citations.** `insertCitation` works wherever the main editor's selection is in inline content. Inserting into a footnote depends on how the editor lane's footnote node view dispatches.
- **No library-wide duplicate merging.** Duplicate detection is a hint ("Already in your library"); it doesn't stop the add.
- **Crossref polite pool.** Requests are anonymous, with no `mailto`. The polite pool needs a contact address, which the brief rules out.
