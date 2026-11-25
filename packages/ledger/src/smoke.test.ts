import { checkProvenanceRuns, docFromJSON } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { LedgerBuilder } from './builder';
import { foldIssues } from './project';

function check(b: LedgerBuilder) {
  for (const d of Object.values(b.project.documents)) {
    expect(checkProvenanceRuns(docFromJSON(d.content), d.provenance), d.id).toBeNull();
  }
  expect(foldIssues(b.state)).toEqual([]);
}

describe('smoke', () => {
  it('types, pastes, copies, undoes', () => {
    const b = new LedgerBuilder({ title: 'Smoke' });
    b.createDocument('d1', 'Chapter 1');
    b.type('d1', 'The rain fell sideways. ');
    b.pasteExternal('d1', 'A pasted line.');
    const end = b.pos('d1');
    b.type('d1', ' More typing here.');
    const copy = b.copy('d1', 1, 9);
    b.pasteInternal('d1', copy);
    b.undo();
    b.redo();
    check(b);
    const d = b.project.documents.d1!;
    expect(d.provenance.map((r) => r.class)).toContain('pasted-external');
    expect(end).toBeGreaterThan(0);
  });
});
