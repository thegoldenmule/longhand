# @longhand/export

**Lane:** Export (F9). Turns Longhand documents into Markdown, DOCX and PDF files, with citations, a bibliography and an optional provenance appendix.

The functions are pure: data in, bytes out. The package never folds the ledger, reads the clock (except PDF metadata, which you can pin) or touches storage.

```sh
pnpm --filter @longhand/export test       # vitest
pnpm --filter @longhand/export typecheck
```

## Entry points

| Import                      | What                                | Runs in                                  |
| --------------------------- | ----------------------------------- | ---------------------------------------- |
| `@longhand/export`          | everything below, plus `exportFile` | Node                                     |
| `@longhand/export/markdown` | `exportMarkdown`, `renderMarkdown`  | Node and browser                         |
| `@longhand/export/docx`     | `exportDocx`, `buildDocxDocument`   | Node and browser                         |
| `@longhand/export/pdf`      | `exportPdf`, `renderPdf`            | Node only (pdfkit, fonts read from disk) |

```ts
exportMarkdown(input: ExportInput): string
exportDocx(input: ExportInput, options?: DocxOptions): Promise<Uint8Array>
exportPdf(input: ExportInput, options?: PdfOptions): Promise<Uint8Array>
exportFile(format: 'markdown' | 'docx' | 'pdf', input, { docx?, pdf? }): Promise<{ bytes, mimeType, filename }>
```

`exportFile` is meant for a download route: it returns the bytes, the MIME type and a file name based on the project title.

Lower-level exports:

- `buildExportModel(input)` builds the format-neutral model that every renderer consumes.
- `renderMarkdown`, `buildDocxDocument` and `renderPdf` render a model.
- `authorDateCitation`, `numberedCitation`, `defaultBibliographyEntry`, `defaultQuoteAttribution` and `formatLocator` are the citation fallbacks.
- `provenanceSummaryFromReport` copies the appendix fields out of an authorship report.
- `ExportError`, `HANDLED_NODE_TYPES` and `HANDLED_MARK_TYPES` cover validation.

## Input

```ts
interface ExportInput {
  project: { title; subtitle?; author?; date?; language? }; // date is a display string, printed as given
  documents: { id?; title; content: PMNodeJSON }[]; // reading order; content is DocumentState.content
  sources?: CslItem[]; // SourceState.csl, id = source id
  provenance?: ProvenanceSummary | null; // appendix, optional
  options?: ExportOptions;
}

// From @longhand/schema (re-exported here), so the report lane can produce it.
interface ProvenanceSummary {
  wordsByClass: Partial<Record<ProvenanceClass, number>>; // report.words.byClass
  disclosure: string; // report.disclosure
  provesTable: { proves: string[]; doesNotProve: string[] }; // report.provesTable (PROVES_TABLE)
  verificationNote?: string | null; // share link, head hash, how to verify
}
```

**The provenance summary is data.** Export prints the numbers it is given and computes nothing. The report lane counts words with the shared least-trusted-class rule (`attributeWords` in `packages/ledger`), and `provenanceSummaryFromReport(report, note)` (also in `@longhand/schema`, re-exported here) fills the summary from an `AuthorshipReport`. The appendix contains:

- the disclosure statement;
- a words-by-origin table with every class in `PROVENANCE_CLASSES` order, a share of the total to one decimal place, and a total row. `pasted-internal` is shown only when it is non-zero, because internal pastes inherit their source's class;
- the "proves / does not prove" table;
- the verification note, with one line per line of the note.

### Options (`ExportOptions`, all optional)

| Option                    | Default                                        | What it does                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `citationStyle`           | `author-date`                                  | The built-in style. `author-date` renders `(Woolf 1929, p. 12)` and `numbered` renders `[1, p. 12]`. It also sets the default bibliography title and order.                                                                                       |
| `formatCitation`          | fallback for the style                         | `(sourceId, locator, { source, number, inFootnote, documentIndex }) => string`. The research lane injects its CSL renderer here. `number` is the source's first-citation number across the export, and quote blocks count as citing their source. |
| `formatBibliographyEntry` | `defaultBibliographyEntry`                     | `(item, { number }) => string \| TextSpan[]`. Return spans to get italic titles.                                                                                                                                                                  |
| `formatQuoteAttribution`  | `defaultQuoteAttribution`                      | `(sourceId, { source, locator, clippingId }) => RichText \| null`. Renderers print it after "— ".                                                                                                                                                 |
| `bibliography.include`    | `cited`                                        | `cited`, `all` or `none`                                                                                                                                                                                                                          |
| `bibliography.order`      | `alphabetical`, or `first-cited` when numbered |                                                                                                                                                                                                                                                   |
| `bibliography.title`      | `Bibliography`, or `References` when numbered  |                                                                                                                                                                                                                                                   |
| `titleBlock`              | `true`                                         | Prints the title, subtitle, author and date.                                                                                                                                                                                                      |
| `documentTitles`          | `auto` (on when there are 2+ documents)        | When document titles print, document headings move down one outline level.                                                                                                                                                                        |
| `sceneBreak`              | `* * *`                                        |                                                                                                                                                                                                                                                   |
| `provenanceTitle`         | `Provenance`                                   |                                                                                                                                                                                                                                                   |
| `onWarning`               | none                                           | Receives `missing-source` warnings, once per document and source. The citation then renders as `[missing source]`.                                                                                                                                |

## Behaviour common to every format

- **Every schema node and mark is handled.** Each document is validated with `docFromJSON`. Anything invalid, including an unknown node or mark type, throws an `ExportError` that names the document. A test asserts that `HANDLED_NODE_TYPES` and `HANDLED_MARK_TYPES` equal the schema's types.
- **Footnotes are numbered continuously** across the whole export, in reading order. Citations inside a footnote are numbered when the footnote is reached.
- **Empty paragraphs are dropped.** Adjacent text runs with the same marks are merged.

### Outline levels

| Item                                       | Markdown      | DOCX            |
| ------------------------------------------ | ------------- | --------------- |
| Project title                              | `#`           | `Title`         |
| Document titles, bibliography and appendix | `##`          | `Heading 1`     |
| Document headings, levels 1–3              | `###`–`#####` | `Heading 2`–`4` |

When the title block or document titles are off, the levels move up to fill the gap.

## Formats

### Markdown

The output is CommonMark plus GFM tables and footnotes (`[^n]`).

- Footnote definitions go at the end of each document. Hard breaks become `\` followed by a newline.
- Quote blocks are blockquotes with a final `— attribution` paragraph.
- Scene breaks are thematic breaks (`* * *`). A custom scene break that is not a valid thematic break is printed as escaped text.
- Writer text is escaped so that it renders literally. This covers emphasis characters, brackets, HTML, and block syntax at the start of a line, such as `#`, `>`, list markers and setext underlines.
- Generated citation text keeps `[3]` readable, and brackets are escaped only where they could form a link.
- Whitespace at the edge of a marked run is moved outside its delimiters.
- Links are `[text](href)`, with `(`, `)` and `\` escaped in the destination. Emphasis that covers the whole link goes outside the brackets, and emphasis inside it stays inside. Inline code is a code span whose fence is longer than any backtick run in the code, padded with a space when the code starts or ends with a backtick.
- Two adjacent lists of the same kind are separated with `<!-- -->`.
- Tests snapshot the golden output (`src/__snapshots__/*.md.snap`) and parse it back with markdown-it to check the structure.

### DOCX (`docx` package)

Styles:

- `Title`, `Subtitle` and `Byline` for the title block.
- `Heading 1`–`4` for titles and headings.
- `Quote` for writers' block quotes and for quote blocks.
- `Quote Attribution`, right-aligned, for the line under a quote block.
- `Scene Break`, centered.
- `Bibliography`, with a hanging indent.
- `FootnoteText` for footnotes.

Other behaviour:

- Footnotes are **real Word footnotes**.
- Links are **real Word hyperlinks** (external relationships) in Word's `Hyperlink` character style. Inline code is set in Courier New.
- Lists use Word numbering. Each ordered list has its own definition, so it starts at its `order` and restarts after other content.
- Each document title starts a new page.
- Page numbers sit in the footer, with none on the title page.
- The appendix tables are Word tables.
- `DocxOptions` has `fontFamily` (default `Georgia`), `fontSize` (default 12) and `pageSize` (`letter` or `a4`).
- Tests unzip the file and assert on `document.xml`, `footnotes.xml`, `styles.xml`, `numbering.xml` and the footer.

### PDF (`pdfkit`, pure Node)

The body font is **EB Garamond** (SIL OFL 1.1), embedded from the full TTFs in `@expo-google-fonts/eb-garamond`. The package uses the regular, italic, semibold and semibold italic faces. You can pass your own faces with `PdfOptions.fonts` as bytes or paths.

**Footnotes are true footnotes, not endnotes.** pdfkit only draws, so `pdf.ts` does its own layout:

- Paragraphs are broken greedily into justified lines, without hyphenation. A line that would need very wide gaps is set ragged instead.
- Each body line is placed together with the footnotes it references, at the foot of the same page under a short rule.
- If a footnote doesn't fit, at least its first lines stay with the reference and the rest continues at the foot of the next page, as in Chicago style. Later footnotes wait until the continuation has been placed, so footnote order is always kept.

Typography:

- Margins: 1 in at the top and 1.5 in at the sides on letter and A4, and ¾ in on A5 and trade (6 × 9 in) pages.
- Body text is 12 pt on letter and A4, and 10.5 pt on A5 and trade, with 1.42 leading.
- There is a title page, and each document, the bibliography and the appendix open on a new page with the title set lower on the page.
- Each of those openings gets a PDF bookmark.
- Paragraphs have book-style first-line indents, with none after headings, scene breaks, quotes and lists.
- Block quotes and quote blocks are indented on both sides and set slightly smaller.
- Scene breaks are centered.
- List markers hang in the left indent.
- Page numbers are centered at the foot of every page except the title page.
- Headings are kept with the next two lines, and a paragraph won't leave a single first line at the foot of a page.
- A quote block of up to a third of a page is kept on one page.
- Links are underlined and clickable (a URI annotation over each piece of linked text). Inline code is set in Courier, slightly smaller.

`PdfOptions` has `pageSize` (`letter`, `a4`, `a5` or `trade`), `fontSize`, `fonts` and `creationDate`. Pass a fixed `creationDate` and the output is byte-for-byte reproducible.

Tests parse the output with pdfjs-dist and assert:

- the text, in order;
- the page count and the page each section starts on;
- that each footnote is on the same page as its reference, and that a long footnote continues on the next page without losing text;
- that the fonts are embedded;
- that links are clickable annotations with the right URLs;
- the metadata, bookmarks and page numbers.

## Tests

The golden documents are in `src/fixtures.test-helpers.ts`: three documents that together use every node and mark type. They include nested mixed lists, an ordered list starting at 3, a block quote holding a list, a quote block, footnotes containing marks, hard breaks and citations, citations with and without locators, and text that looks like Markdown. The sources cover a book, a journal article, an edited collection, a web page with no date and an uncited book.

## Known gaps

- **The PDF exporter is Node-only.** It needs pdfkit's Node build and reads the default fonts from disk. Browser code should call a server route.
- **Glyph coverage.** EB Garamond covers Latin, Greek and Cyrillic. There is no fallback font, so other scripts (CJK, Arabic, emoji) render as missing glyphs. Pass `fonts` to use another family.
- **PDF typography is deliberately simple.** There is no hyphenation, no widow control (only orphan control), no "continued" marker on a split footnote, and no running heads.
- **Fallback citations.** The built-in citation and bibliography formatting is a readable fallback, not a CSL processor. APA, MLA and Chicago come from the research lane through `formatCitation` and `formatBibliographyEntry`.
- **No reproducible DOCX.** The DOCX core properties carry the time of export (set by the `docx` package), so DOCX output isn't byte-reproducible. Markdown always is, and PDF is with `creationDate`.
- **Footnote numbering never restarts per chapter.**
- **Links.** The writer's links (the `link` mark) are live in all three formats. The verification note and URLs in generated text still print as plain text.
- **Inline code in PDF** uses the standard Courier font, which draws only Latin-1. Code with other characters falls back to the body font.
- **DOCX hyperlink ids are random** (the `docx` package picks them), another reason DOCX output isn't byte-reproducible.
- **Markdown emphasis edge cases.** Emphasis next to punctuation and letters, as in `*foo.*bar`, can fail CommonMark's flanking rules and print literal asterisks. This is rare in prose.
