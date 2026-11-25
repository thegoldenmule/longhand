// Test support (not exported): ProjectState fragments for component tests.
import type { ClippingState, CslItem, SourceState, SurfacedSourceState } from '@longhand/schema';
import type { DraftContext } from '../drafts';

export const LECUN: CslItem = {
  id: 'src-lecun',
  type: 'article-journal',
  title: 'Deep learning',
  'container-title': 'Nature',
  author: [
    { family: 'LeCun', given: 'Yann' },
    { family: 'Bengio', given: 'Yoshua' },
    { family: 'Hinton', given: 'Geoffrey' },
  ],
  issued: { 'date-parts': [[2015, 5, 27]] },
  volume: '521',
  issue: '7553',
  page: '436-444',
  DOI: '10.1038/nature14539',
};

export const AUSTEN: CslItem = {
  id: 'src-austen',
  type: 'book',
  title: 'Pride and Prejudice',
  author: [{ family: 'Austen', given: 'Jane' }],
  issued: { 'date-parts': [[2003]] },
  publisher: 'Penguin Books',
};

export function source(csl: CslItem, extra: Partial<SourceState> = {}): SourceState {
  return {
    id: csl.id,
    csl,
    origin: { kind: 'manual', value: null },
    fromSurfacedId: null,
    candidateIndex: null,
    note: '',
    archived: false,
    addedSeq: 1,
    updatedSeq: 1,
    ...extra,
  };
}

export function sources(...list: SourceState[]): Record<string, SourceState> {
  return Object.fromEntries(list.map((s) => [s.id, s]));
}

export function clipping(extra: Partial<ClippingState> = {}): ClippingState {
  return {
    id: 'clip-1',
    sourceId: 'src-austen',
    text: 'It is a truth universally acknowledged,\nthat a single man in possession of a good fortune',
    locator: 'p. 1',
    note: null,
    savedSeq: 5,
    removed: false,
    ...extra,
  };
}

export function surfaced(extra: Partial<SurfacedSourceState> = {}): SurfacedSourceState {
  return {
    id: 'surf-1',
    feedbackSessionId: 'fs-1',
    seq: 9,
    createdAt: '2026-11-24T12:00:00.000Z',
    query: 'transformer attention',
    target: {
      kind: 'anchor',
      anchor: {
        documentId: 'doc1',
        sentenceId: 'p1.s1',
        quote: 'attention is enough',
        occurrence: 0,
      },
      from: 1,
      to: 20,
      readVersion: 3,
      version: 3,
    },
    range: { documentId: 'doc1', from: 1, to: 20 },
    candidates: [
      {
        csl: {
          id: 'doi:10.48550/arXiv.1706.03762',
          type: 'article',
          title: 'Attention Is All You Need',
          author: [{ family: 'Vaswani', given: 'Ashish' }],
          issued: { 'date-parts': [[2017]] },
          DOI: '10.48550/arXiv.1706.03762',
          source: 'Crossref',
        },
        provider: 'crossref',
        url: 'https://doi.org/10.48550/arXiv.1706.03762',
      },
      {
        csl: {
          id: 'openlibrary:/works/OL1W',
          type: 'book',
          title: 'Attention and Effort',
          source: 'Open Library',
        },
        provider: 'openlibrary',
        url: 'https://openlibrary.org/works/OL1W',
      },
    ],
    accepted: [],
    status: 'open',
    dismissal: null,
    ...extra,
  };
}

export function draftContext(): DraftContext {
  let n = 0;
  return {
    projectId: 'proj1',
    actor: { kind: 'human', id: 'user1' },
    deviceId: 'dev1',
    sessionId: 'sess1',
    now: () => new Date('2026-11-24T12:00:00.000Z'),
    newId: () => `id${++n}`,
  };
}
