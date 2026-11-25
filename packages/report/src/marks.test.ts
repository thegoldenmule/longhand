import { LedgerBuilder } from '@longhand/ledger';
import { schema } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { computeReport } from './compute';

const HREF = 'https://example.com/these-words-are-in-the-href-and-must-never-count';

/** The same writing, with or without links and inline code added afterwards. */
function ledger(format: boolean): LedgerBuilder {
  const b = new LedgerBuilder({ seed: 31, start: '2026-11-02T09:00:00.000Z' });
  b.createDocument('d', 'Doc');
  b.type('d', 'The harbour log says little. ');
  b.pasteExternal('d', 'A borrowed line.');
  if (format) {
    const log = b.pos('d', { before: 'log' });
    b.format('d', (tr) => tr.addMark(log, log + 3, schema.marks.link!.create({ href: HREF })));
    const line = b.pos('d', { before: 'borrowed' });
    b.format('d', (tr) => tr.addMark(line, line + 8, schema.marks.code!.create()));
  }
  return b;
}

describe('reports over linked and code text', () => {
  it('count the same words and characters with or without links and code', () => {
    const plain = computeReport(ledger(false).commits, { scope: 'project' });
    const marked = computeReport(ledger(true).commits, { scope: 'project' });
    expect(marked.words).toEqual(plain.words);
    expect(marked.characters).toEqual(plain.characters);
    expect(marked.pastes).toEqual(plain.pastes);
    expect(marked.disclosure).toBe(plain.disclosure);
    // Formatting commits insert no characters: the session total is unchanged.
    const inserted = (r: typeof plain) =>
      r.sessions.list.reduce((n, s) => n + s.charactersInserted, 0);
    expect(inserted(marked)).toBe(inserted(plain));
    expect(JSON.stringify(marked)).not.toContain('these-words-are-in-the-href');
  });
});
