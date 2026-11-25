/**
 * Bounds on agent tool arguments and per-session caps. Shared by the tool schemas,
 * the agent's validation, the event schemas and the UI.
 */
import type { Intensity } from './domain';

/** Argument bounds from the spec's tool catalog (characters unless the name says words). */
export const BOUNDS = {
  commentBodyMaxChars: 600,
  questionMaxChars: 300,
  wordChoiceAnchorMaxWords: 4,
  wordChoiceMinAlternatives: 1,
  wordChoiceMaxAlternatives: 3,
  wordChoiceAlternativeMaxWords: 4,
  rationaleMaxChars: 200,
  insertionMaxWords: 40,
  /** Hard character cap on an insertion sentence, on top of the word bound. */
  insertionMaxChars: 400,
  purposeMaxChars: 200,
  rephraseGuidanceMaxChars: 200,
  /** Rephrase guidance may not quote this many words or more that are not already in the anchored sentence. */
  rephraseMaxQuotedNewWords: 3,
  proposalRationaleMaxChars: 300,
  citationClaimMaxChars: 150,
  searchQueryMaxChars: 200,
  searchMaxCandidates: 5,
  reviewSummaryMaxChars: 1500,
  reviewItemMaxChars: 300,
  reviewMaxStrengths: 5,
  reviewMaxPriorities: 5,
  discussAnswerMaxChars: 1200,
  chatReplyMaxChars: 3000,
  readNotesMaxIds: 50,
} as const;

/** Per-intensity caps. `maxItems` counts every annotation-producing tool call. */
export interface IntensityCaps {
  /** All annotation-producing calls (comments, questions, suggestions, proposals, flags, source tools). */
  maxItems: number;
  /** `suggest_word_choice` + `suggest_insertion` + `suggest_rephrase`. */
  maxSuggestions: number;
  /** `suggest_insertion`. */
  maxInsertions: number;
  /** `propose_move` + `propose_cut` + `propose_split` + `propose_merge`. */
  maxProposals: number;
  /** `ask_question`. */
  maxQuestions: number;
  /** `search_sources`. */
  maxSearches: number;
}

/**
 * Per-session caps. The hard limits (15 suggestions, 3 insertions) apply at every
 * intensity; light touch is 5 items in total.
 */
export const CAPS = {
  maxSuggestionsPerSession: 15,
  maxInsertionsPerSession: 3,
  intensity: {
    light: {
      maxItems: 5,
      maxSuggestions: 5,
      maxInsertions: 1,
      maxProposals: 2,
      maxQuestions: 2,
      maxSearches: 2,
    },
    standard: {
      maxItems: 20,
      maxSuggestions: 10,
      maxInsertions: 2,
      maxProposals: 5,
      maxQuestions: 4,
      maxSearches: 4,
    },
    thorough: {
      maxItems: 40,
      maxSuggestions: 15,
      maxInsertions: 3,
      maxProposals: 10,
      maxQuestions: 6,
      maxSearches: 5,
    },
  } satisfies Record<Intensity, IntensityCaps>,
} as const;

/** The caps that apply to a session of the given intensity (intensity caps clipped to the hard limits). */
export function capsFor(intensity: Intensity): IntensityCaps {
  const c = CAPS.intensity[intensity];
  return {
    ...c,
    maxSuggestions: Math.min(c.maxSuggestions, CAPS.maxSuggestionsPerSession),
    maxInsertions: Math.min(c.maxInsertions, CAPS.maxInsertionsPerSession),
  };
}
