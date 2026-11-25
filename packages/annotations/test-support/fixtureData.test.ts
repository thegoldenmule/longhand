// @longhand/ledger/fixtures loads from disk under jsdom too (jsdom replaces the
// global URL), and the JSON this package imports for the browser demo is the same.
import {
  loadFixture,
  loadFixtureWitnessKey,
  loadTamperedFixture,
  TAMPERED_FIXTURE_NAMES,
} from '@longhand/ledger/fixtures';
import { describe, expect, it } from 'vitest';
import { ANNOTATION_FIXTURES, fixtureCommits, fixtureState } from './fixtureData';

describe('fixture data under jsdom', () => {
  it('loadFixture works and matches the imported JSON', () => {
    expect(typeof window).toBe('object');
    for (const name of ANNOTATION_FIXTURES) {
      const f = loadFixture(name);
      expect(fixtureCommits(name)).toEqual(f.commits);
      expect(fixtureState(name)).toEqual(f.expected.state);
    }
    expect(loadTamperedFixture(TAMPERED_FIXTURE_NAMES[0]!).commits.length).toBeGreaterThan(0);
    expect(loadFixtureWitnessKey().keyId).toMatch(/^[0-9a-f]{64}$/);
  });
});
