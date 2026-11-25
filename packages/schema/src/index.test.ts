import { describe, expect, it } from 'vitest';
import * as api from './index';

describe('public API', () => {
  it('exports the core contracts', () => {
    for (const name of [
      'canonicalize',
      'sha256Hex',
      'schema',
      'segment',
      'segmentDoc',
      'resolveAnchor',
      'countWords',
      'splitSentences',
      'EVENTS',
      'ACTOR_PERMISSIONS',
      'MANUSCRIPT_EVENT_TYPES',
      'canActorEmit',
      'CommitSchema',
      'computeCommitHash',
      'GENESIS_PREV_HASH',
      'SCHEMA_VERSION',
      'witnessMessage',
      'TOOLS',
      'TOOL_JSON_SCHEMAS',
      'CAPS',
      'BOUNDS',
      'ProvenanceRunSchema',
      'VerificationBundleSchema',
      'PROVES_TABLE',
      'SESSION_GAP_MS',
      'INPUT_METHOD_META',
      'provenanceSummaryFromReport',
      'MatchedKindSchema',
      'DECLARABLE_INPUT_METHODS',
      'normalizeHref',
      'isAllowedHref',
      'pastedLinkHref',
    ]) {
      expect(api, name).toHaveProperty(name);
    }
    expect(api.INPUT_METHOD_META).toBe('longhand/input-method');
  });
});
