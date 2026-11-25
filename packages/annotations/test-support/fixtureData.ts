/**
 * The golden fixtures this package tests against, imported as JSON so the same
 * module works in Vitest (jsdom) and in the browser demo. (`loadFixture` from
 * `@longhand/ledger/fixtures` works under jsdom too, but reads from disk, so the
 * demo cannot use it; `fixtureData.test.ts` checks the two agree.)
 */
import type { Commit, ProjectState } from '@longhand/schema';
import discuss from '../../ledger/fixtures/discuss.json';
import feedbackSession from '../../ledger/fixtures/feedback-session.json';
import proposals from '../../ledger/fixtures/proposals.json';
import research from '../../ledger/fixtures/research.json';
import suggestions from '../../ledger/fixtures/suggestions.json';

/** The annotation fixtures. */
export const ANNOTATION_FIXTURES = [
  'feedback-session',
  'suggestions',
  'proposals',
  'discuss',
  'research',
] as const;

/** A fixture name. */
export type AnnotationFixture = (typeof ANNOTATION_FIXTURES)[number];

interface FixtureJson {
  commits: unknown[];
  expected: { state: unknown };
}

const DATA: Record<AnnotationFixture, FixtureJson> = {
  'feedback-session': feedbackSession as unknown as FixtureJson,
  suggestions: suggestions as unknown as FixtureJson,
  proposals: proposals as unknown as FixtureJson,
  discuss: discuss as unknown as FixtureJson,
  research: research as unknown as FixtureJson,
};

/** A fixture's commits. */
export function fixtureCommits(name: AnnotationFixture): Commit[] {
  return structuredClone(DATA[name].commits) as Commit[];
}

/** A fixture's expected final state. */
export function fixtureState(name: AnnotationFixture): ProjectState {
  return structuredClone(DATA[name].expected.state) as ProjectState;
}

/** True for a known fixture name. */
export function isAnnotationFixture(name: string): name is AnnotationFixture {
  return (ANNOTATION_FIXTURES as readonly string[]).includes(name);
}
