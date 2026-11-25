// Typings for citeproc-shim.js: the parts of citeproc-js this package uses (the
// `citeproc` npm package ships no types). Consumers resolve these types from the
// sibling .d.ts, so no ambient module declaration is needed.
export interface CiteprocSys {
  retrieveLocale(lang: string): string;
  retrieveItem(id: string): unknown;
}

export interface CiteprocCitationItem {
  id: string;
  locator?: string;
  label?: string;
  prefix?: string;
  suffix?: string;
  'suppress-author'?: boolean;
}

export interface CiteprocBibliographyParams {
  bibstart: string;
  bibend: string;
  entry_ids: string[][];
  hangingindent?: number;
  'second-field-align'?: string | false;
  linespacing?: number;
  entryspacing?: number;
}

export declare class Engine {
  constructor(sys: CiteprocSys, style: string, lang?: string, forceLang?: boolean);
  setOutputFormat(format: 'html' | 'text' | 'rtf'): void;
  updateItems(ids: string[]): void;
  makeCitationCluster(items: CiteprocCitationItem[]): string;
  makeBibliography(): [CiteprocBibliographyParams, string[]] | false;
  opt: { development_extensions: Record<string, boolean> };
}

declare const CSL: { Engine: typeof Engine };
export default CSL;
