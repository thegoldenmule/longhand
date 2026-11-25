# Longhand

Longhand is a calm writing app with an AI editor that critiques and proposes but can never put a word in your manuscript. Every change goes into an append-only, server-witnessed ledger, so you can show exactly what you wrote and how AI helped.

**The invariant:** no word appears in the manuscript unless a human typed it, or pasted it, which is flagged. AI output lives only in a separate annotation layer. The AI can rearrange or remove your words only through proposals you accept, and each acceptance is logged.

`docs/SPEC.md` is the product spec, `docs/BUILD.md` the technical brief, and `docs/BUILD_STATUS.md` the build log and known gaps.

## Quick start

Needs Node ≥ 22, pnpm 11, Docker (for Postgres) and Google Chrome (for the e2e suites). Real reviews use the local [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI; without it, run with the mock reviewer.

```sh
pnpm install
pnpm dev                      # Postgres (compose if needed), witness key, ledger service, web app
MODEL_ADAPTER=mock pnpm dev   # the same, with a canned AI reviewer
```

Open http://localhost:3100. In `AUTH_MODE=dev` (the default) you are signed in as the dev writer. `pnpm dev` checks that Postgres answers on 5434 (or runs `docker compose up -d`), runs `pnpm dev:setup` when `.dev/witness-key.pem` is missing, then starts the ledger service (API on 3200, Durable Streams on 3300) and the web app with prefixed output. Ctrl-C stops everything cleanly.

Settings come from a repo-root `.env` (copy `.env.example`); every variable is documented there.

## What you can do

| Feature                                                                                                       | Where                                                |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| F1 Editor: typewriter scrolling, focus mode, Markdown shortcuts, word counts and a daily goal, no save button | the page; Settings tab; status line                  |
| F2 Binder: Manuscript and Notes, nested folders, drag and keyboard moves, corkboard with synopses             | left pane; Corkboard switch                          |
| F3 Ask for feedback: scope (selection, document, project), lenses, intensity, a free-text ask                 | **Ask for feedback**                                 |
| F4 Suggestions: ghost text, trace-over retyping, dismiss with a reason, Discuss                               | margin cards                                         |
| F5 Proposals: move, cut, split, merge with diff previews and one-click accept                                 | margin cards                                         |
| F6 Provenance tint, legend, span inspector and replay                                                         | **Provenance**, **Replay**                           |
| F7 Authorship report, disclosure statement and verification bundle                                            | **Report**; `/verify` checks a bundle in the browser |
| F8 Sources (DOI, ISBN, URL or by hand), clippings, citations, bibliography                                    | side panel → Research                                |
| F9 Export to Markdown, DOCX and PDF with an optional provenance appendix                                      | **Export**                                           |

Keyboard: ⌘\ binder, ⇧⌘\ side panel, ⌥⌘\ just the page, ⌥⌘P provenance tint, ⌥⌘. focus mode, ⌘/ all shortcuts (Ctrl instead of ⌘ elsewhere).

## Architecture

```
browser (apps/web, Next.js)                         ledger service (apps/server, EC2)
  LonghandEditor ── HttpCommitTransport ──HTTP/SSE──► ingest + validation ──► Durable Stream per project
  ProjectStore: /commits + project SSE                  hash chain, witness signatures (KMS)
    └ fold (@longhand/ledger) → ProjectState            Postgres read model (rebuildable)
       binder · annotations · tint · replay · report    agent sessions ── claude -p + MCP tools
```

- The **ledger service** is the single enforcement point. It re-applies every commit's steps, rejects any agent event that would change text, witnesses each commit (ECDSA P-256), and runs the AI editor server-side, whose only tools write to the annotation layer.
- The **web app** keeps the project's commits and folds them in the browser with the same deterministic fold the server and the verifier use. The editor syncs its document through `HttpCommitTransport`; everything else reads the fold.

| Package                  | What                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `packages/schema`        | Contracts: events, the ProseMirror schema, anchors and segmenter, tool schemas, bundle format, canonical JSON |
| `packages/ledger`        | The deterministic fold, authorship classes, hash chain, replay, golden fixtures                               |
| `packages/editor`        | The ProseMirror editor: input guard, typewriter, focus, batching, offline queue                               |
| `packages/annotations`   | Feedback form and panel, margin cards, ghost text, trace-over, proposal previews                              |
| `packages/provenance-ui` | Tint, legend, span inspector, replay scrubber                                                                 |
| `packages/binder`        | Binder tree, corkboard, project settings                                                                      |
| `packages/research`      | Sources, metadata lookup, clippings, citations, CSL bibliographies                                            |
| `packages/export`        | Markdown, DOCX and PDF                                                                                        |
| `packages/report`        | Authorship report, disclosure template, verification bundles                                                  |
| `packages/verifier`      | The open-source verifier: library, CLI and web page                                                           |
| `packages/agent`         | The AI editor: context, prompts, MCP annotation tools, model adapters                                         |
| `packages/client`        | Typed client and `HttpCommitTransport` for the ledger service                                                 |
| `apps/server`            | The ledger service                                                                                            |
| `apps/web`               | The web app                                                                                                   |

Each package has a README with its API, decisions, tests and gaps.

## Testing

```sh
pnpm typecheck
pnpm lint
pnpm format:check
LONGHAND_REQUIRE_DB=1 pnpm test   # every package's Vitest suite; integration tests need Postgres on 5434
pnpm e2e                          # every Playwright suite, one after another
pnpm e2e web                      # just the full-stack suite (also: editor, provenance-ui, annotations, verifier)
LONGHAND_LIVE_CLAUDE=1 pnpm --filter @longhand/web e2e   # one real review from the UI with the claude CLI
```

`pnpm e2e` runs each suite on its own ports (editor 4317, provenance-ui 4318, annotations 4319, verifier 4391, web 3150 with the ledger on 3250) and fails rather than reusing a server already on a port. The full-stack suite (`apps/web/e2e`) starts a fresh Postgres database, a real Durable Streams server, the real ledger service with the mock reviewer, and a production build of the web app, and drives Chrome. After every test it replays every project's ledger from the API and checks that each commit that changed manuscript text has a human actor. Screenshots of every view in both themes land in `apps/web/test-results/screens/`.

## Environment

All variables live in `.env.example` (local) and `docs/DEPLOY.md` (production). The ones you are most likely to set:

| Variable                                | Default                                                | What                                           |
| --------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `MODEL_ADAPTER`                         | `claude`                                               | `mock` for a canned reviewer (no model calls)  |
| `AUTH_MODE`                             | `dev`                                                  | `cognito` for the Hosted UI (with `COGNITO_*`) |
| `DATABASE_URL`                          | `postgres://longhand:longhand@localhost:5434/longhand` | the read model                                 |
| `LEDGER_URL`                            | `http://localhost:3200`                                | where the browser reaches the ledger service   |
| `WEB_PORT`, `LEDGER_PORT`               | 3100, 3200                                             | local ports                                    |
| `AGENT_MODEL_FULL`, `AGENT_MODEL_QUICK` | `opus`, `sonnet`                                       | models for document and selection reviews      |

## Deploying

The web app runs on AWS Amplify and the ledger service on EC2, with Cognito for sign-in and a KMS key for witness signatures. See `docs/DEPLOY.md`.

## License

MIT. See [LICENSE](LICENSE).
