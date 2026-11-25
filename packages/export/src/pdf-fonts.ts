/**
 * Default PDF fonts: EB Garamond (SIL Open Font License 1.1), embedded from the
 * `@expo-google-fonts/eb-garamond` npm package's full TTF files. Node-only: it
 * reads the font files from `node_modules`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Font bytes, an `ArrayBuffer`, or a path to a TTF/OTF file. */
export type PdfFontSource = Uint8Array | ArrayBuffer | string;

/** The four faces the PDF renderer uses. */
export interface PdfFontSet {
  regular: PdfFontSource;
  italic: PdfFontSource;
  bold: PdfFontSource;
  boldItalic: PdfFontSource;
}

const FILES = {
  regular: '400Regular/EBGaramond_400Regular.ttf',
  italic: '400Regular_Italic/EBGaramond_400Regular_Italic.ttf',
  bold: '600SemiBold/EBGaramond_600SemiBold.ttf',
  boldItalic: '600SemiBold_Italic/EBGaramond_600SemiBold_Italic.ttf',
} as const;

let cached: PdfFontSet | null = null;

/** Loads EB Garamond regular, italic, semibold and semibold italic (cached after the first call). */
export function defaultPdfFonts(): PdfFontSet {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const load = (file: string): Uint8Array =>
    new Uint8Array(readFileSync(require.resolve(`@expo-google-fonts/eb-garamond/${file}`)));
  cached = {
    regular: load(FILES.regular),
    italic: load(FILES.italic),
    bold: load(FILES.bold),
    boldItalic: load(FILES.boldItalic),
  };
  return cached;
}
