/**
 * @longhand/research — F8: sources library, metadata fetch (Crossref, Open
 * Library, page metadata) into CSL-JSON, candidate search for `search_sources`,
 * clippings, Cite / Place clipping commands, CSL bibliographies, and the React
 * components for the research pane.
 *
 * See README.md for the editor integration contract.
 */

// HTTP and identifiers
export {
  USER_AGENT,
  MetadataError,
  type FetchLike,
  type HttpOptions,
  type MetadataErrorCode,
} from './http';
export {
  classifyIdentifier,
  doiKey,
  isbn10to13,
  normalizeDoi,
  normalizeIsbn,
  normalizeUrl,
  type Identifier,
} from './identifiers';

// CSL helpers
export {
  cleanText,
  formatDate,
  formatName,
  parseDate,
  parseName,
  parseNames,
  sourceLabel,
  yearOf,
  type CslDate,
  type CslName,
} from './csl';

// Fetchers
export {
  CROSSREF_API,
  crossrefSearchUrl,
  crossrefWorkToCsl,
  crossrefWorkUrl,
  fetchDoi,
  searchCrossref,
  type CrossrefWork,
} from './crossref';
export {
  OPEN_LIBRARY,
  fetchIsbn,
  openLibraryBookToCsl,
  openLibraryDocToCsl,
  openLibraryIsbnUrl,
  openLibrarySearchUrl,
  searchOpenLibrary,
  type OpenLibraryBook,
  type OpenLibraryDoc,
} from './openlibrary';
export {
  fetchUrl,
  pageMetadataToCsl,
  scanHtml,
  type FetchUrlOptions,
  type PageCslOptions,
  type PageMetadata,
} from './page';
export {
  createMetadataClient,
  type MetadataClient,
  type MetadataClientOptions,
  type MetadataProvider,
  type MetadataResult,
} from './metadata';

// Search
export {
  createSourceSearch,
  mergeResults,
  providerOf,
  toSurfacedCandidate,
  type LonghandSourceSearch,
  type SourceSearchOptions,
} from './search';
/** Re-exported from `@longhand/schema`. */
export type { SourceSearch } from '@longhand/schema';

// Manual entry
export {
  MANUAL_LIMITS,
  SOURCE_TYPES,
  cslToManualEntry,
  emptyManualEntry,
  sourceTypeLabel,
  validateManualEntry,
  type ManualEntry,
  type ManualField,
  type ManualValidation,
  type SourceType,
} from './manual';

// Bibliography
export {
  DEFAULT_STYLE,
  STYLES,
  formatBibliography,
  formatCitation,
  formatCitations,
  itemMap,
  parseLocator,
  referencedSourceIds,
  resolveStyle,
  type BibliographyEntry,
  type CiteRef,
  type DocLike,
  type Formatted,
  type FormattedBibliography,
  type ItemsInput,
  type StyleId,
} from './bibliography/format';

// Drafts
export {
  citationInsertedDraft,
  clippingRemovedDraft,
  clippingSavedDraft,
  makeDraft,
  newId,
  normalizeClippingText,
  researchCardDismissedDraft,
  sourceAddedDraft,
  sourceUpdatedDraft,
  surfacedSourceAddedDraft,
  type ClippingInput,
  type DraftContext,
  type ResearchDraft,
  type SourceAddedInput,
} from './drafts';

// ProseMirror commands
export {
  citationTransaction,
  clippingNode,
  clippingTransaction,
  getResearchInput,
  insertCitation,
  placeClipping,
  type InsertCitationOptions,
  type PlaceClippingOptions,
  type PlaceableClipping,
} from './commands';

// React components
export { SourcesPanel, type SourcesPanelProps } from './components/SourcesPanel';
export { ClippingsList, type ClippingsListProps } from './components/ClippingsList';
export { CitationPicker, type CitationPickerProps } from './components/CitationPicker';
export { Bibliography, type BibliographyProps } from './components/Bibliography';
export { SourceForm, type SourceFormProps } from './components/SourceForm';
export {
  AI_SURFACED_LABEL,
  AiSurfacedBadge,
  SourceSummary,
  findDuplicate,
  type Collection,
  type DraftProps,
} from './components/shared';
