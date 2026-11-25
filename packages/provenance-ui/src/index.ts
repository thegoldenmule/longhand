/**
 * @longhand/provenance-ui — the provenance view (F6): the tint, the legend, the
 * span inspector and the replay scrubber. Styles: `@longhand/provenance-ui/styles.css`.
 * See README.md.
 */

// Classes and labels
export {
  CLASS_META,
  INPUT_METHOD_LABEL,
  MATCHED_KIND_LABEL,
  MATCHED_KIND_SHORT,
  TINT_CLASSES,
  tintClassName,
  type ClassMeta,
  type TintClass,
  type UnderlineStyle,
} from './classes';

// Tint
export {
  createProvenanceTint,
  defaultInspectKey,
  provenanceDecorations,
  runAttrs,
  staticTintHost,
  type InspectRect,
  type InspectRequest,
  type ProvenanceTint,
  type ProvenanceTintOptions,
  type TintHost,
  type TintSnapshot,
} from './tint';

// Legend
export {
  documentLegend,
  legendFromCounts,
  matchedKindCounts,
  projectLegend,
  type LegendData,
  type LegendDocument,
  type LegendRow,
  type MatchedBreakdown,
} from './legendData';
export { ProvenanceLegend, type ProvenanceLegendProps } from './react/ProvenanceLegend';

// Span inspector
export {
  inspectSpan,
  type InspectorMatch,
  type InspectorModel,
  type InspectorMove,
  type InspectorPaste,
  type InspectorVisibleSuggestion,
} from './inspector';
export {
  ProvenanceInspector,
  SpanInspector,
  type ProvenanceInspectorProps,
  type SpanInspectorProps,
} from './react/SpanInspector';

// Replay
export {
  DEFAULT_MAX_GAP_MS,
  commitEndMs,
  describeCommit,
  frameAtTime,
  frameIndexForSeq,
  playbackOffsets,
  replayFrames,
  replayMarkers,
  type ReplayMarker,
  type ReplayScope,
} from './replay/timeline';
export {
  REPLAY_SPEEDS,
  ReplayPlayer,
  realClock,
  type PlayerClock,
  type ReplayPlayerOptions,
  type ReplaySpeed,
} from './replay/player';
export { ReplayScrubber, type ReplayScrubberProps } from './react/ReplayScrubber';

// Hooks and formatting
export { useProvenanceTint } from './react/useTint';
export {
  excerpt,
  formatCount,
  formatDuration,
  formatShare,
  formatTime,
  type TimeFormatter,
} from './format';
