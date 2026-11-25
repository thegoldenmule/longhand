/**
 * @longhand/annotations — everything the writer sees of the AI editor: the
 * feedback request form and panel, margin cards, ghost text and trace-over, and
 * proposal diff previews with accept, reject, dismiss and discuss.
 *
 * The AI only ever writes to the annotation layer. This package draws that layer
 * as decorations and cards, and turns the writer's choices into human events;
 * accepting a proposal goes through `editor.acceptProposal`, whose steps the fold
 * derives. See README.md for the wiring recipe.
 */
export {
  AnnotationsController,
  type AddSourceRequest,
  type AnnotationsControllerOptions,
  type AnnotationsSnapshot,
  type CiteRequest,
  type SelectionScope,
  type SubmittedEvent,
} from './controller';
export {
  AI_SURFACED_LABEL,
  CARD_GROUPS,
  CARD_GROUP_LABELS,
  DISMISS_REASON_LABELS,
  cardKindLabel,
  cardsFromState,
  documentNodeOf,
  filterCards,
  groupCards,
  hasAnyAnnotations,
  isDismissible,
  proposalOutcome,
  proposalRange,
  proposalTitle,
  reviewsFromState,
  scopeLabel,
  snippet,
  suggestionOutcome,
  suggestionTitle,
  threadFailure,
  threadFor,
  type Card,
  type CardFilter,
  type CardGroup,
  type CardKind,
  type CardOf,
  type CardPhase,
  type CardsOptions,
  type ReviewView,
} from './model';
export {
  discussRequested,
  feedbackRequested,
  feedbackRequestFor,
  newId,
  proposalRejected,
  retryRequest,
  suggestionDismissed,
  type AnnotationEvent,
  type AnnotationEventOf,
  type AnnotationEventType,
  type FeedbackRequestInput,
} from './drafts';
export {
  reduceProgress,
  toolActivity,
  type ArrivedItem,
  type ReviewProgressEvent,
  type SessionProgress,
} from './progress';
export {
  GHOST_ATTR,
  createGhostElement,
  fragmentText,
  ghostDescriptionId,
  installGhostClipboardGuard,
  scrubGhostHtml,
  stripGhosts,
} from './ghost';
export {
  createTracePlugin,
  traceKey,
  traceProgress,
  type TraceCandidate,
  type TracePlugin,
  type TracePluginOptions,
  type TraceProgress,
  type TraceRegion,
  type TraceState,
} from './trace';
export { annotationDecorations, type DecorationUi } from './decorations';
export { useAnnotations, useAnnotationsSnapshot, type UseAnnotationsOptions } from './react/hooks';
export {
  AnnotationCard,
  GhostDescriptions,
  GhostText,
  cardDescription,
  type AnnotationCardProps,
} from './react/cards';
export { AnnotationMargin, layoutCards, type AnnotationMarginProps } from './react/margin';
export { FeedbackPanel, type FeedbackPanelProps } from './react/panel';
export {
  FeedbackRequestForm,
  INTENSITY_OPTIONS,
  composeAsk,
  type FeedbackRequestFormProps,
} from './react/form';
