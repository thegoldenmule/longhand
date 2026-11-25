# @longhand/report

**Lane:** Report and verifier (F7). The authorship report, the disclosure template, verification bundles, the export appendix input and the `<AuthorshipReport>` page. Its partner package is `packages/verifier`.

```sh
pnpm --filter @longhand/report test        # fixtures, disclosure, unwitnessed, browser determinism, component
pnpm --filter @longhand/report test -u     # after an intended change: rewrite snapshots/, then review the diff
pnpm --filter @longhand/report typecheck
```

## API

| Export                                                                                            | What                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `computeReport(commits, { scope, witnesses? })`                                                   | The `AuthorshipReport` for a ledger (typed as `Report`, the schema shape plus this lane's fields). `scope` is `'project'`, `{ documentId }` or a schema `ReportScope`. Throws if the ledger does not fold or the document is unknown. |
| `disclosureStatement(report)`                                                                     | The disclosure template (already in `report.disclosure`).                                                                                                                                                                             |
| `wordShares(words)`                                                                               | Per-class shares as the disclosure prints them; the page uses it so the two never disagree.                                                                                                                                           |
| `buildBundle({ commits, witnesses, publicKeyPem, keyId, scope, createdAt? })`                     | A `VerificationBundle` with a freshly computed report. `createdAt` defaults to the head commit's server time (the server passes its clock).                                                                                           |
| `provenanceSummaryForExport(report, note?)`                                                       | The `ProvenanceSummary` for `@longhand/export`'s appendix (wraps the schema's `provenanceSummaryFromReport`).                                                                                                                         |
| `unwitnessedIntervals(commits, { witnesses?, include? })`, `UNWITNESSED_LAG_MS`                   | The unwitnessed-interval rule on its own.                                                                                                                                                                                             |
| `<AuthorshipReport report title? copyText?>`                                                      | The report page. Import `@longhand/report/styles.css` once.                                                                                                                                                                           |
| `formatInt`, `count`, `joinList`, `allocateTenths`, `percentLabel`, `formatDuration`, `formatUtc` | The deterministic text helpers the template uses.                                                                                                                                                                                     |

## What the report counts

`computeReport` is pure and deterministic: no `Date.now`, no `Intl`, no locale or time-zone APIs. A verifier recomputing it gets identical canonical JSON; `src/browser.test.ts` runs it in an esbuild browser bundle and compares byte for byte with Node.

- **Words and characters**: the text as it stands now, by the shared least-trusted-class rule (`projectWordsByClass` / `wordsByClass` from `@longhand/ledger`). A project report counts the non-archived manuscript documents; a document report counts that document.
- **Process figures** (active time, sessions, AI activity, pastes, imports): the history. A project report counts the whole project, notes and archived documents included, so nothing is left out. A document report counts that document's edits, pastes, imports and annotations, feedback requests scoped to it or to the whole project, and Discuss threads about its annotations.
- **Sessions**: a project report uses the fold's `writingSessions`. A document report rebuilds them from that document's commits with the same rules (a test checks the rebuild equals the fold's sessions on every fixture). `days` counts the UTC days any session touches.
- **AI**: `ai.sessions` lists every agent session in scope with model, `systemPromptVersion`, kind, status, lenses, intensity and annotation count. `ai.sourceSuggestions` is extra.
- **Suggestions and proposals**: counts by kind and outcome. `extensions.suggestions.byKind` has outcome counts per kind; `extensions.proposals.moves` splits moves by unit (sentence, paragraph, section).
- **Pastes**: every `PasteOccurred` in scope with its measured size; events also carry `id`, `insertedSeq` and `verifiedInternal`. `time` is the paste's client time.
- **Imports**: `imports.words` is the words in the imported content at import. `extensions.imports` lists each import.
- **`extensions.assisted`**: the distinct AI texts behind `typed-from-suggestion` words, by kind (`word-choice`, `rephrase`, `insertion`, `comment`, `question`, `proposal`, research kinds, `discuss`, `review`), read from `ProvenanceRun.matchedKind`.
- **`extensions.quoted.sources`**: the distinct library sources behind `quoted` words.

## Unwitnessed intervals

A human commit counts as **queued offline** when it reached the server more than **60 seconds** (`UNWITNESSED_LAG_MS`) after the writer finished it: `serverTime − (clientTime + durationMs)`. `durationMs` applies to `TextEdited` only.

- **Why 60 seconds.** An online editor flushes about 2 s after the last keystroke, and the service appends within a second or two. Retries stay well under a minute. A minute of queued writing is worth telling a reader about.
- **Clock skew.** A device clock running slow by more than a minute makes everything look late. That errs toward under-claiming. A fast clock hides lag, which is why the report prints the threshold (`extensions.unwitnessedThresholdMs`).
- **Grouping.** Queued commits form one interval while no on-time human commit comes between them and each was written before the interval's first commit reached the server.
- **Fields.** Each interval has `fromSeq`, `toSeq`, first and last client time, `serverTime` (when the server first saw it), `reason: 'queued-offline'`, `commits` and `maxLagMs`.
- **Missing witnesses.** When witnesses are passed, runs of commits without a matching witness (same `seq` and `hash`) are also reported, as `reason: 'not-witnessed'`. This looks only at which witnesses exist; the verifier checks their signatures.

## Disclosure template

> Written in 14 sessions over 9 days. 1,000 words: 97.8% typed directly; 1.6% retyped from 11 AI word-choice suggestions; 0.6% pasted (2 external pastes). AI feedback was requested 3 times. AI proposed 3 paragraph moves; 2 accepted.

`snapshots/disclosures.txt` lists the statement for every fixture and document.

- **Zero cases** have their own sentences: "No writing sessions were recorded in Longhand.", "The manuscript has no words yet.", "No AI feedback was requested in Longhand."
- **Plurals and wording.** Counts are pluralized ("1 session", "once", "twice", "3 times"), and lists read "a, b and c".
- **Rounding.** Shares are tenths of a percent and sum to exactly 100% (largest remainder). The **typed-directly share is always rounded down**, and rounding ties go to the less trusted class. A non-zero share never prints as 0% ("under 0.1%"). A share that is not everything never prints as 100% ("over 99.9%").
- **Retyped AI text.** Retyped words name what they matched. With one kind: "retyped from 11 AI word-choice suggestions". With several: "retyped from AI text (2 word-choice suggestions, 1 suggested sentence and 1 comment)".
- **Pasted words.** They read "pasted (N external pastes)". When no external paste is behind them (an unverifiable undo or internal paste), they read "pasted or unverified".
- **Imports and unwitnessed intervals** get a sentence whenever there are any.
- **Never overclaims.** Claims about AI are scoped to "in Longhand".

## The page

`<AuthorshipReport>` has these parts:

- the disclosure, with a Copy button (async clipboard, with a fallback);
- summary numbers;
- a segmented bar of words by origin, with its table;
- a sessions timeline (two or more sessions) and table;
- AI sessions, suggestion and proposal outcomes;
- pastes, imports and unwitnessed intervals;
- the proves table, printed verbatim.

Styling:

- The class colours are the first five slots of a colour-blind-validated categorical palette, with dark-mode steps.
- Light and dark follow `prefers-color-scheme`, and `data-theme` overrides it.
- The print stylesheet forces black on white, hides the copy button, opens the session list and keeps sections whole.

## Snapshots

`snapshots/<fixture>.json` holds the project report and one report per document for each golden fixture, formatted with the repo's prettier. `snapshots/disclosures.txt` holds every disclosure. These files are the reviewable expected outputs.

## Known gaps

- Project reports count notes and archived documents in the process figures but not in the words. That is deliberate (over-disclose the process, describe the text as it stands), but it means a project report's time can exceed the time spent on the visible manuscript.
- A document report counts a project-wide feedback request for every document, because the review covered them all.
- "Typed directly" can only be as good as the client's input-method claims. The proves table says so, and the report does not detect AI text retyped from elsewhere (spec, "Not in v1").
- Paste `time` and session times are device clock times. Unwitnessed intervals flag late arrival, but not a device clock that runs fast.
