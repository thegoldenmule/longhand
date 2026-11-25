/**
 * @longhand/binder — the project binder (F2): Manuscript and Notes areas with nested
 * folders, drag and keyboard reordering, archive and restore, the corkboard with
 * synopses, and the project settings the AI editor reads.
 *
 * - `model`     — `BinderModel` (a slice of `ProjectState`) and read-only queries
 * - `drafts`    — draft builders: binder action → `BinderDraft` (`{type, payload}`) or a refusal
 * - `reducer`   — the optimistic reducer that applies drafts the way the ledger fold does
 * - `wordCount` — per-document and per-folder word counts
 * - components  — `<BinderTree>`, `<Corkboard>`, `<ProjectSettingsForm>`; styles in
 *                 `@longhand/binder/styles.css`
 */
export * from './model';
export * from './drafts';
export * from './reducer';
export * from './wordCount';
