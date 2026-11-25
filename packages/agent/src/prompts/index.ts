/**
 * The current system prompts. Add a new `vN.ts` and bump the version to change
 * them; keep the old files, since past sessions record the version they used.
 */
import type { AgentSessionKind } from '@longhand/schema';
import { DISCUSS_SYSTEM_PROMPT_V1, REVIEW_SYSTEM_PROMPT_V1 } from './v1';
import { DISCUSS_SYSTEM_PROMPT_V2, REVIEW_SYSTEM_PROMPT_V2 } from './v2';
import { DISCUSS_SYSTEM_PROMPT_V3, REVIEW_SYSTEM_PROMPT_V3 } from './v3';

/** Version of the system prompts in use. */
export const SYSTEM_PROMPT_VERSION = 'v3';

/** The system prompt for a session kind. */
export function systemPrompt(kind: AgentSessionKind): string {
  return kind === 'review' ? REVIEW_SYSTEM_PROMPT_V3 : DISCUSS_SYSTEM_PROMPT_V3;
}

export {
  DISCUSS_SYSTEM_PROMPT_V1,
  DISCUSS_SYSTEM_PROMPT_V2,
  DISCUSS_SYSTEM_PROMPT_V3,
  REVIEW_SYSTEM_PROMPT_V1,
  REVIEW_SYSTEM_PROMPT_V2,
  REVIEW_SYSTEM_PROMPT_V3,
};
