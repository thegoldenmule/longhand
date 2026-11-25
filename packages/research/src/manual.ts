/**
 * The manual entry form: its fields, validation into CSL-JSON, and the reverse
 * mapping used when the writer edits an existing source's metadata.
 */
import { CslItemSchema, type CslItem } from '@longhand/schema';
import { compact, formatDate, formatName, parseDate, parseNames } from './csl';
import { normalizeDoi, normalizeIsbn, normalizeUrl } from './identifiers';

/** Source types offered by the form (CSL type → label). */
export const SOURCE_TYPES = [
  ['book', 'Book'],
  ['chapter', 'Book chapter'],
  ['article-journal', 'Journal article'],
  ['article-magazine', 'Magazine article'],
  ['article-newspaper', 'Newspaper article'],
  ['paper-conference', 'Conference paper'],
  ['article', 'Preprint or article'],
  ['report', 'Report'],
  ['thesis', 'Thesis'],
  ['webpage', 'Web page'],
  ['post-weblog', 'Blog post'],
  ['entry-encyclopedia', 'Encyclopedia entry'],
  ['dataset', 'Dataset'],
  ['motion_picture', 'Film or video'],
  ['interview', 'Interview'],
  ['personal_communication', 'Personal communication'],
  ['manuscript', 'Manuscript'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

/** A CSL type the form offers. */
export type SourceType = (typeof SOURCE_TYPES)[number][0];

const TYPE_SET = new Set<string>(SOURCE_TYPES.map(([t]) => t));

/** Label for a CSL type (falls back to the raw type). */
export function sourceTypeLabel(type: string): string {
  return SOURCE_TYPES.find(([t]) => t === type)?.[1] ?? type;
}

/** The manual entry form's values. Every field is a string, as typed. */
export interface ManualEntry {
  type: string;
  title: string;
  /** One name per line or `;`-separated, `Family, Given` or `Given Family`. */
  authors: string;
  editors: string;
  /** `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or a written date. */
  issued: string;
  containerTitle: string;
  publisher: string;
  publisherPlace: string;
  volume: string;
  issue: string;
  page: string;
  edition: string;
  doi: string;
  isbn: string;
  url: string;
  accessed: string;
}

/** Field name of the manual entry form. */
export type ManualField = keyof ManualEntry;

/** An empty form (type `book`). */
export function emptyManualEntry(type: SourceType = 'book'): ManualEntry {
  return {
    type,
    title: '',
    authors: '',
    editors: '',
    issued: '',
    containerTitle: '',
    publisher: '',
    publisherPlace: '',
    volume: '',
    issue: '',
    page: '',
    edition: '',
    doi: '',
    isbn: '',
    url: '',
    accessed: '',
  };
}

/** Field limits enforced by {@link validateManualEntry}. */
export const MANUAL_LIMITS = {
  titleMaxChars: 500,
  shortFieldMaxChars: 50,
  fieldMaxChars: 300,
  maxNames: 100,
} as const;

/** Result of {@link validateManualEntry}. */
export type ManualValidation =
  | { ok: true; csl: CslItem; warnings: Partial<Record<ManualField, string>> }
  | { ok: false; errors: Partial<Record<ManualField, string>> };

/**
 * Validates the form and builds CSL-JSON. `id` becomes the item's id (the source
 * id). Fields left empty are omitted. Unknown CSL variables already on the source
 * being edited can be carried over with `base`.
 */
export function validateManualEntry(
  form: ManualEntry,
  id: string,
  base?: CslItem,
): ManualValidation {
  const errors: Partial<Record<ManualField, string>> = {};
  const warnings: Partial<Record<ManualField, string>> = {};
  const v = (k: ManualField): string => form[k].trim();

  if (!TYPE_SET.has(v('type')) && v('type') !== base?.type) errors.type = 'Choose a source type.';
  if (v('title') === '') errors.title = 'A title is required.';
  else if (v('title').length > MANUAL_LIMITS.titleMaxChars)
    errors.title = `Keep the title under ${MANUAL_LIMITS.titleMaxChars} characters.`;

  const authors = parseNames(form.authors);
  const editors = parseNames(form.editors);
  if (authors.length > MANUAL_LIMITS.maxNames) errors.authors = 'Too many names.';
  if (editors.length > MANUAL_LIMITS.maxNames) errors.editors = 'Too many names.';

  const issued = v('issued') === '' ? null : parseDate(v('issued'));
  if (v('issued') !== '' && !issued) errors.issued = 'Use a date like 2015, 2015-05 or 2015-05-27.';
  const accessed = v('accessed') === '' ? null : parseDate(v('accessed'));
  if (v('accessed') !== '' && !accessed) errors.accessed = 'Use a date like 2026-11-24.';

  const doi = v('doi') === '' ? null : normalizeDoi(v('doi'));
  if (v('doi') !== '' && !doi) errors.doi = 'That is not a DOI (they start with 10.).';
  const isbn = v('isbn') === '' ? null : normalizeIsbn(v('isbn'));
  if (v('isbn') !== '' && !isbn) errors.isbn = 'That ISBN is not valid (check the digits).';
  const url = v('url') === '' ? null : normalizeUrl(v('url'));
  if (v('url') !== '' && !url) errors.url = 'Enter a full web address.';

  for (const k of ['volume', 'issue', 'page', 'edition'] as const) {
    if (v(k).length > MANUAL_LIMITS.shortFieldMaxChars) errors[k] = 'That is too long.';
  }
  for (const k of ['containerTitle', 'publisher', 'publisherPlace'] as const) {
    if (v(k).length > MANUAL_LIMITS.fieldMaxChars) errors[k] = 'That is too long.';
  }

  if (authors.length === 0 && editors.length === 0 && form.type !== 'webpage') {
    warnings.authors = 'No author: citations will start with the title.';
  }
  if (!issued) warnings.issued = 'No date: citations will show "n.d.".';
  if ((form.type === 'webpage' || form.type === 'post-weblog') && !url) {
    warnings.url = 'Web sources are easier to find again with their address.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const {
    title: _t,
    author: _a,
    editor: _e,
    issued: _i,
    accessed: _ac,
    'container-title': _c,
    publisher: _p,
    'publisher-place': _pp,
    volume: _v,
    issue: _is,
    page: _pg,
    edition: _ed,
    DOI: _d,
    ISBN: _isbn,
    URL: _u,
    ...rest
  } = base ?? ({} as Partial<CslItem>);

  const csl = compact({
    ...rest,
    id,
    type: v('type'),
    title: v('title'),
    author: authors,
    editor: editors,
    issued: issued ?? undefined,
    accessed: accessed ?? undefined,
    'container-title': v('containerTitle'),
    publisher: v('publisher'),
    'publisher-place': v('publisherPlace'),
    volume: v('volume'),
    issue: v('issue'),
    page: v('page'),
    edition: v('edition'),
    DOI: doi ?? undefined,
    ISBN: isbn ?? undefined,
    URL: url ?? undefined,
  } as CslItem);
  const parsed = CslItemSchema.safeParse(csl);
  if (!parsed.success) return { ok: false, errors: { title: 'These details are not valid.' } };
  return { ok: true, csl: parsed.data, warnings };
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** Fills the form from an existing source's CSL (for "edit metadata"). */
export function cslToManualEntry(csl: CslItem): ManualEntry {
  return {
    type: csl.type,
    title: str(csl.title),
    authors: (csl.author ?? []).map(formatName).join('; '),
    editors: (csl.editor ?? []).map(formatName).join('; '),
    issued: formatDate(csl.issued),
    containerTitle: str(csl['container-title']),
    publisher: str(csl.publisher),
    publisherPlace: str(csl['publisher-place']),
    volume: str(csl.volume),
    issue: str(csl.issue),
    page: str(csl.page),
    edition: str(csl.edition),
    doi: str(csl.DOI),
    isbn: str(csl.ISBN),
    url: str(csl.URL),
    accessed: formatDate(csl.accessed),
  };
}
