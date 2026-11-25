# Build status

The coordinator updates this file after every phase. A resumed session reads it first.

| Phase | Work | State | Commit |
| --- | --- | --- | --- |
| 0 | Preflight, spec export, build brief | done | — |
| 1 | Scaffold + contracts (`packages/schema`) | done (270 tests) | dec3bd6 |
| 2a | Ledger core + golden fixtures (`packages/ledger`) | running | |
| 2b | Lanes needing contracts: editor, agent, binder, export, research | running | |
| 3 | Lanes needing ledger core: server, provenance-ui, report + verifier | pending | |
| 4 | Annotations lane | pending | |
| 5 | Integration: `apps/web`, dev orchestration, end-to-end in Chrome | pending | |

## Notes

- Commits go straight to `main` and are pushed after each phase.
