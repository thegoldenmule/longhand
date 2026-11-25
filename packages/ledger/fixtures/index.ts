/**
 * Golden fixtures for every lane: hand-built ledgers (valid hashes and witnesses)
 * with their expected fold outputs, plus tampered copies with the expected
 * verification failures. Node only (reads JSON from disk); import the JSON files
 * directly in other environments.
 *
 * ```ts
 * import { loadFixture, FIXTURE_NAMES } from '@longhand/ledger/fixtures';
 * const f = loadFixture('suggestions');
 * f.commits; f.witnesses; f.publicKeyPem; f.expected.state; f.expected.documents['doc-s'].wordsByClass;
 * ```
 *
 * To make your own ledgers in tests, use `LedgerBuilder` from `@longhand/ledger`.
 */
import { readFileSync } from 'node:fs';
import { FIXTURE_DEFINITIONS, TAMPER_DEFINITIONS } from './definitions';
import type { FixtureFile, TamperedFixtureFile } from './generate';

export type { ExpectedDocument, ExpectedOutputs, FixtureFile, TamperedFixtureFile } from './generate';
export { LedgerBuilder } from '../src/builder';

/** Names of the golden fixtures. */
export const FIXTURE_NAMES: readonly string[] = Object.freeze(Object.keys(FIXTURE_DEFINITIONS));

/** Names of the tampered fixtures. */
export const TAMPERED_FIXTURE_NAMES: readonly string[] = Object.freeze(Object.keys(TAMPER_DEFINITIONS));

const dir = new URL('./', import.meta.url);

/** Path (URL) of a fixture file. */
export function fixtureUrl(name: string): URL {
  if (FIXTURE_DEFINITIONS[name]) return new URL(`${name}.json`, dir);
  if (TAMPER_DEFINITIONS[name]) return new URL(`tampered/${name}.json`, dir);
  throw new Error(`no fixture named ${name}`);
}

/** Loads a golden fixture (parsed JSON). */
export function loadFixture(name: string): FixtureFile {
  if (!FIXTURE_DEFINITIONS[name]) throw new Error(`no fixture named ${name}`);
  return JSON.parse(readFileSync(fixtureUrl(name), 'utf8')) as FixtureFile;
}

/** Loads a tampered fixture (parsed JSON; its commits are deliberately invalid). */
export function loadTamperedFixture(name: string): TamperedFixtureFile {
  if (!TAMPER_DEFINITIONS[name]) throw new Error(`no tampered fixture named ${name}`);
  return JSON.parse(readFileSync(fixtureUrl(name), 'utf8')) as TamperedFixtureFile;
}

/** The test-only witness key the fixtures are signed with. Never use it outside tests. */
export function loadFixtureWitnessKey(): { publicKeyPem: string; privateKeyPkcs8Pem: string; keyId: string } {
  return JSON.parse(readFileSync(new URL('witness-test-key.json', dir), 'utf8')) as {
    publicKeyPem: string;
    privateKeyPkcs8Pem: string;
    keyId: string;
  };
}
