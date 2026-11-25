/**
 * @longhand/editor — the Longhand manuscript editor.
 *
 * - `LonghandEditor` (React 19) and `createEditorView` (framework-free core).
 * - Input capture: every doc change is classified by input method by the input
 *   guard; untagged doc changes are refused.
 * - Batching into `TextEdited` drafts, companion events, an IndexedDB outbound
 *   queue, a flusher and client-side rebase.
 * - Extension points: `extraPlugins`, decoration layers, `on(...)` events,
 *   `mappingFrom(version)`, `setTraceSuggestion`, `insertCitation`,
 *   `insertClipping`, `acceptProposal`, `submitEvent`.
 *
 * See README.md.
 */
export { LonghandEditor, type LonghandEditorProps } from './react';
export {
  createEditorView,
  defaultQueue,
  DEFAULT_SETTINGS,
  type CreateEditorOptions,
  type EditorEvents,
  type EditorHandle,
  type EditorSettings,
  type EditorUpdate,
} from './core';
export {
  buildDecorations,
  createDecorationLayer,
  type DecorationLayer,
  type LayerDecoration,
} from './decorations';
export {
  createInputGuard,
  inputTagOf,
  isRemoteTransaction,
  readDeclaredInput,
  type GuardViolation,
  type InputGuard,
  type InputGuardOptions,
} from './input/guard';
export {
  classifyTransaction,
  EDITOR_INPUT_META,
  LEGACY_INPUT_META_KEYS,
  RESEARCH_INPUT_META_ALIAS,
  type Classification,
  type InputGrant,
  type InputTag,
  type PasteInfo,
  type TransactionFacts,
} from './input/classify';
/** Re-exported from `@longhand/schema` (import them from there). */
export { INPUT_METHOD_META, type DeclaredInput } from '@longhand/schema';
export { InputTracker, type TrackerState } from './input/tracker';
export {
  MARKER_ATTR,
  MARKER_MIME,
  decodeMarker,
  encodeMarker,
  type SliceMarker,
} from './input/clipboard';
export {
  editorInputRules,
  editorKeymaps,
  granted,
  inBlockquote,
  insertFootnote,
  insertHardBreak,
  insertSceneBreak,
  isHeading,
  toggleBlockquote,
  toggleHeading,
  toggleMarkAll,
} from './commands';
export {
  firstLinkIn,
  linkAt,
  linkClickPlugin,
  linkPastePlugin,
  linkPasteTr,
  openLink,
  removeLinkTr,
  setLinkTr,
  type LinkRange,
} from './links';
export { bubblePlugin, type BubbleOptions } from './ui/bubble';
export { bubbleKey, focusToolbar, openLinkEditor, type BubbleState } from './ui/bubbleState';
export { focusKey, focusPlugin, currentSentence, type FocusMode } from './ui/focus';
export {
  DEFAULT_PLACEHOLDER,
  isEmptyDocument,
  placeholderKey,
  placeholderPlugin,
} from './ui/placeholder';
export {
  clampCaretRatio,
  typewriterControllerOf,
  typewriterKey,
  typewriterPlugin,
  type TypewriterSettings,
} from './ui/typewriter';
export {
  countDocumentWords,
  countSelectionWords,
  countingText,
  WordCounter,
  type WordCounts,
} from './wordCount';
export {
  DocumentSync,
  type SaveState,
  type SubmittableEventType,
  type SyncError,
  type SyncHost,
  type SyncStatus,
  type VersionChange,
} from './sync/engine';
export {
  CommitFlusher,
  sharedFlusher,
  type FlushParticipant,
  type FlusherStatus,
} from './sync/flusher';
export {
  createCommitQueue,
  IndexedDbQueue,
  MemoryQueue,
  type CommitQueue,
  type QueueEntry,
} from './sync/queue';
export { MockTransport, type MockCommit, type MockTransportOptions } from './sync/mockTransport';
export type {
  CatchUp,
  CommitTransport,
  ConnectionState,
  RemoteUpdate,
  SubmitResult,
} from './sync/transport';
export { rebaseOnDoc, rebaseStepsHeadless, type RebaseResult } from './sync/rebase';
export { reconcileHeadless } from './sync/reconcile';
export {
  buildTextEdited,
  makeDraft,
  runsOf,
  type DraftContext,
  type LocalBatch,
  type LocalStep,
  type RunTag,
} from './sync/drafts';
export { changedRange, deletedChars, insertedChars, insertedUnits } from './steps';
