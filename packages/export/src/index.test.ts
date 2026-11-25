import { describe, expect, it } from 'vitest';
import { goldenInput } from './fixtures.test-helpers';
import * as api from './index';

describe('public API', () => {
  it('exports the exporters and helpers', () => {
    for (const name of [
      'exportMarkdown',
      'exportDocx',
      'exportPdf',
      'exportFile',
      'buildExportModel',
      'renderMarkdown',
      'buildDocxDocument',
      'renderPdf',
      'provenanceSummaryFromReport',
      'authorDateCitation',
      'numberedCitation',
      'defaultBibliographyEntry',
      'defaultQuoteAttribution',
      'defaultPdfFonts',
      'ExportError',
    ]) {
      expect(api[name as keyof typeof api], name).toBeTypeOf('function');
    }
  });

  it.each([
    ['markdown', 'text/markdown; charset=utf-8', 'the-salt-road.md', '# The Salt Road'],
    [
      'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'the-salt-road.docx',
      'PK',
    ],
    ['pdf', 'application/pdf', 'the-salt-road.pdf', '%PDF-'],
  ] as const)('exportFile(%s)', async (format, mimeType, filename, magic) => {
    const file = await api.exportFile(format, goldenInput(), {
      pdf: { creationDate: new Date(0) },
    });
    expect(file.mimeType).toBe(mimeType);
    expect(file.filename).toBe(filename);
    expect(new TextDecoder('latin1').decode(file.bytes.subarray(0, magic.length))).toBe(magic);
  });
});
