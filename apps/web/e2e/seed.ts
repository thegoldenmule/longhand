/**
 * What the e2e stack seeds for its dev account. Every test shares the account's
 * editors (tests run in parallel), so tests ask this editor and never reset or
 * delete it. Its lenses are the two the mock reviewer reacts to: `structure`
 * (a paragraph move and a sentence move) and `word-choice` (a word-choice
 * suggestion).
 */
import type { EditorProfileInput } from '@longhand/schema';

export const E2E_ACCOUNT = 'e2e-account';

export const TEST_EDITOR: EditorProfileInput = {
  name: 'Iris',
  role: 'Test editor',
  brief: 'Structure and word choice, for the e2e mock reviewer. Moves first, then words.',
  lenses: ['structure', 'word-choice'],
  intensity: 'standard',
  questions: ['Does the order of events work?', 'Which word would you change first?'],
};
