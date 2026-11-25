/**
 * The metadata client the Sources panel uses: one object holding the injected
 * `fetch`, with a lookup per identifier kind and a `lookup` that classifies free
 * input first.
 */
import type { CslItem, SourceOrigin } from '@longhand/schema';
import { fetchDoi } from './crossref';
import { MetadataError, type HttpOptions } from './http';
import { classifyIdentifier, normalizeDoi, normalizeUrl } from './identifiers';
import { fetchIsbn } from './openlibrary';
import { fetchUrl, type FetchUrlOptions } from './page';

/** Where fetched metadata came from. Matches `SurfacedCandidate.provider`. */
export type MetadataProvider = 'crossref' | 'openlibrary' | 'web';

/** A fetched record, ready to preview and add. */
export interface MetadataResult {
  csl: CslItem;
  /** What to put in `SourceAdded.origin`. */
  origin: SourceOrigin;
  provider: MetadataProvider;
}

/** Fetches source metadata. Every method throws {@link MetadataError}. */
export interface MetadataClient {
  fetchDoi(doi: string): Promise<MetadataResult>;
  fetchIsbn(isbn: string): Promise<MetadataResult>;
  fetchUrl(url: string): Promise<MetadataResult>;
  /** Classifies `input` as a DOI, ISBN or URL and fetches it. */
  lookup(input: string): Promise<MetadataResult>;
}

/** Options for {@link createMetadataClient}. */
export interface MetadataClientOptions extends FetchUrlOptions {
  /**
   * A separate fetch for web pages. In a browser, cross-origin pages need a
   * server-side proxy while Crossref and Open Library allow CORS, so the app can
   * pass its proxy here and leave `fetch` as the global one.
   */
  pageFetch?: HttpOptions['fetch'];
}

/** Creates a {@link MetadataClient}. */
export function createMetadataClient(opts: MetadataClientOptions = {}): MetadataClient {
  const pageOpts: FetchUrlOptions = { ...opts, fetch: opts.pageFetch ?? opts.fetch };
  const client: MetadataClient = {
    async fetchDoi(doi) {
      const csl = await fetchDoi(doi, opts);
      return {
        csl,
        origin: { kind: 'doi', value: normalizeDoi(doi) ?? doi.trim() },
        provider: 'crossref',
      };
    },
    async fetchIsbn(isbn) {
      const csl = await fetchIsbn(isbn, opts);
      return {
        csl,
        origin: { kind: 'isbn', value: csl.ISBN ?? isbn.trim() },
        provider: 'openlibrary',
      };
    },
    async fetchUrl(url) {
      const csl = await fetchUrl(url, pageOpts);
      return {
        csl,
        origin: { kind: 'url', value: normalizeUrl(url) ?? url.trim() },
        provider: 'web',
      };
    },
    async lookup(input) {
      const id = classifyIdentifier(input);
      if (!id) {
        throw new MetadataError(
          'invalid-input',
          'Enter a DOI (10.…), an ISBN, or a web address, or add the source by hand.',
        );
      }
      if (id.kind === 'doi') return client.fetchDoi(id.value);
      if (id.kind === 'isbn') return client.fetchIsbn(id.value);
      return client.fetchUrl(id.value);
    },
  };
  return client;
}
