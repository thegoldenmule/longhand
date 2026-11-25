/**
 * @longhand/schema — the contracts every Longhand lane codes against.
 *
 * Isomorphic (Node and browsers), deterministic, no Node-only APIs. See
 * `packages/schema/README.md` for an overview, the actor permission table and the
 * rules the fold applies.
 *
 * Modules:
 * - canonical  — RFC 8785 canonical JSON and SHA-256
 * - ids        — id, timestamp, hash, position schemas
 * - document   — the ProseMirror schema
 * - text       — word counter and sentence splitter
 * - anchors    — segmenter (`p3.s2` ids), anchors and span/move/split/merge resolvers
 * - domain     — lenses, intensity, input methods, settings, CSL-JSON
 * - bounds     — tool argument bounds and per-session caps
 * - events     — every ledger event, actor permissions, manuscript event types
 * - ledger     — commit envelope, hash chain, witnesses
 * - tools      — agent tool catalog (zod + JSON Schema), cap helpers
 * - provenance — authorship classes and provenance runs
 * - state      — the fold's output (`ProjectState`), types only
 * - bundle     — verification bundle and authorship report shape
 */
export * from './canonical';
export * from './ids';
export * from './document';
export * from './text';
export * from './anchors';
export * from './domain';
export * from './bounds';
export * from './events';
export * from './ledger';
export * from './tools';
export * from './provenance';
export * from './state';
export * from './bundle';
