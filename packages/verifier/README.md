# @longhand/verifier

The open-source verifier for Longhand verification bundles. Its partner package is `packages/report`. Give it a bundle (a project's ledger, the server's witness signatures, the witness public key and an authorship report) and it checks everything from scratch. You do not need to trust Longhand's report; you trust the ledger's signatures and recompute the rest.

It is small on purpose. The checks live in `src/verify.ts` (under 400 lines, commented). Everything else is the CLI, the web page and tests.

## The checks

| #   | Check             | Passes when                                                                                                                                                                                                     |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Bundle format** | The JSON matches `VerificationBundleSchema`, and the bundle's `projectId` is its ledger's.                                                                                                                      |
| 2   | **Witness key**   | `publicKeyPem` is an ECDSA P-256 key and `keyId` is its fingerprint (SHA-256 of the SPKI DER). With `--key-id` / `expectedKeyId`, it must also be the key you expect.                                           |
| 3   | **Hash chain**    | Every commit hashes to its `hash` (SHA-256 of RFC 8785 canonical JSON), links to the previous one, and seqs run 1, 2, 3… The chain must end at the head named by the last witness, so a truncated ledger fails. |
| 4   | **Witnesses**     | Every commit has exactly one witness over `(projectId, seq, hash, serverTime)` that verifies with the key, and every witness embedded in the chain (`ChainHeadWitnessed`) verifies too.                         |
| 5   | **Re-fold**       | The ledger folds into documents and provenance without an error and without fold issues. A fold issue would catch, for example, a server whose `SuggestionResolved` disagrees with what the fold derives.       |
| 6   | **Report**        | `computeReport` over the ledger gives a report whose canonical JSON is byte-for-byte the bundled report's. Otherwise it fails and lists each differing path (`words.byClass.typed: bundled 57, recomputed 54`). |

A bundle verifies only when all six pass. A ledger that fails the format or chain check is never re-folded: checks 5 and 6 are skipped.

Note what check 2 means without `--key-id`. It proves the bundle is consistent with **its own** key. To know the Longhand server signed it, compare the key id with the one Longhand publishes, or pass it with `--key-id`. The spec's "What the record proves" table, printed in every report, says what a verified record does and doesn't prove.

## CLI

```sh
pnpm --filter @longhand/verifier build          # → dist/longhand-verify.mjs (one file, every dependency inlined)
node packages/verifier/dist/longhand-verify.mjs bundle.json
node packages/verifier/dist/longhand-verify.mjs bundle.json --json
node packages/verifier/dist/longhand-verify.mjs bundle.json --key-id <64 hex chars>
```

The package also declares a `bin` entry, `longhand-verify` (`./dist/longhand-verify.mjs`).

The CLI exits with **0** when the bundle is verified, **1** when it is not verified, and **2** on a usage error, an unreadable file or a file that is not JSON. `--json` prints the full result, including the recomputed report.

```
Longhand verification: examples/novel-doctored-report.bundle.json
project proj-1 · 27 commits · 27 witnesses · key 183d770612f8…

  PASS  Bundle format  The bundle matches the Longhand bundle format (version 1).
  PASS  Witness key    Key 183d770612f8… matches the bundle's public key.
  PASS  Hash chain     27 commits link from the start to the last witnessed head, seq 27 (5ce20208be1c…).
  PASS  Witnesses      All 27 commits carry a valid server signature.
  PASS  Re-fold        The ledger re-folds into its documents and provenance with no issues.
  FAIL  Report         The bundled report differs from the one recomputed from the ledger.
                       words.byClass.typed: bundled 57, recomputed 54

NOT VERIFIED. Failed: Report.
```

`examples/` has bundles to try, made from the ledger's golden fixtures and signed with the **test-only** fixture key:

- `novel.bundle.json` and `research.bundle.json` verify;
- `novel-doctored-report.bundle.json` has one number changed in its report;
- `tampered-edited.bundle.json` has a commit edited after it was witnessed.

Regenerate them with `pnpm --filter @longhand/verifier examples`; a test fails when they are stale.

## Web page

```sh
pnpm --filter @longhand/verifier web           # dev server on http://localhost:4391
pnpm --filter @longhand/verifier web:build     # static files in packages/verifier/web/dist
```

A static page: drop a bundle (or choose a file) and see each check and the recomputed report, rendered with `<AuthorshipReport>` from `@longhand/report`. When the bundled report is wrong, the page shows the recomputed one, labelled as such. It is fully client-side. The file is read with the File API and checked with WebCrypto, nothing is uploaded, and an end-to-end test asserts that dropping a file makes no network request. Any static host can serve `web/dist` (relative asset paths).

## Library

```ts
import { verifyBundle } from '@longhand/verifier';
const result = await verifyBundle(JSON.parse(text), { expectedKeyId });
result.ok; // all six checks passed
result.checks; // [{ id, title, status: 'pass' | 'fail' | 'skip', summary, details }]
result.report; // the recomputed report (when the ledger re-folded)
```

`verifyBundle` never throws; anything wrong is a failed check. It runs in Node ≥ 22 and in browsers: `src/browser.test.ts` bundles it for the browser with esbuild and checks it reaches the same verdicts. Also exported: `diffJson`, `describeDifference`, `formatResult`.

## Tests

```sh
pnpm --filter @longhand/verifier test          # checks, CLI (in process and the bundled executable), browser bundle, examples
pnpm --filter @longhand/verifier e2e           # Playwright in Chrome against the built page; screenshots in test-results/screenshots
pnpm --filter @longhand/verifier typecheck
```

What the tests cover:

- **Good bundles.** Every golden fixture verifies, as a project report and as a document report.
- **Tampered fixtures.** Every tampered fixture fails at the hash chain, with the specific problem: `hash-mismatch`, `prev-hash-mismatch`, `seq-out-of-order`, `seq-gap`, `invalid-commit` (plus the format check) and `head-mismatch`.
- **Keys.** A wrong key fails at the witnesses (`key-mismatch`). A wrong `keyId`, an unusable PEM and an unexpected `--key-id` fail at the key check.
- **Witnesses and truncation.** A dropped witness fails (`missing-witness`); a dropped last witness also fails the chain head. A truncated chain fails at the chain head.
- **Report.** A doctored report or disclosure fails with the exact differing path. So does a truncated chain whose witnesses were truncated to match.
- **Re-signed ledger.** A ledger re-signed by someone holding the key, in which the server lied about an outcome, fails at the re-fold.

## License

MIT. The Longhand repository has no top-level LICENSE file yet; this package is intended to be published under the MIT license so anyone can read, run and adapt the verifier.

## Known gaps

- The verifier trusts the witness key it is given. Without `--key-id` it can only say the bundle is self-consistent. Public anchoring and RFC 3161 timestamps are later work (spec, "Integrity").
- The witness check requires a witness for every commit, so a bundle exported before the server witnessed queued offline commits will not verify. Wait for the queue to sync before exporting.
- Example bundles are signed with the ledger's test-only fixture key.
- The web page bundles the fold and the schema (about 0.5 MB, 155 kB gzipped).
