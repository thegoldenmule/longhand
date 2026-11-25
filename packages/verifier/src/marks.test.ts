import { LedgerBuilder } from '@longhand/ledger';
import { loadFixtureWitnessKey } from '@longhand/ledger/fixtures';
import { buildBundle } from '@longhand/report';
import { keyIdFromPublicKeyPem, schema } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { clone, rechainAndResign } from './test-helpers';
import { verifyBundle } from './verify';

describe('verifyBundle over links and inline code', () => {
  it('re-folds a ledger with link and code marks and passes every check', async () => {
    const b = new LedgerBuilder({ seed: 41 });
    b.createDocument('d', 'Doc');
    b.type('d', 'See the archive and run make.');
    const at = b.pos('d', { before: 'the archive' });
    const href = 'https://example.org/archive';
    b.format('d', (tr) =>
      tr.addMark(at, at + 'the archive'.length, schema.marks.link!.create({ href })),
    );
    const make = b.pos('d', { before: 'make' });
    b.format('d', (tr) => tr.addMark(make, make + 4, schema.marks.code!.create()));
    const commits = clone(b.commits);
    const witnesses = await rechainAndResign(commits, 0);
    const key = loadFixtureWitnessKey();
    const bundle = buildBundle({
      commits,
      witnesses,
      publicKeyPem: key.publicKeyPem,
      keyId: keyIdFromPublicKeyPem(key.publicKeyPem),
      scope: 'project',
    });
    const r = await verifyBundle(clone(bundle));
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ['schema', 'pass'],
      ['key', 'pass'],
      ['chain', 'pass'],
      ['witnesses', 'pass'],
      ['fold', 'pass'],
      ['report', 'pass'],
    ]);
    expect(r.report?.words.total).toBe(6);
  });
});
