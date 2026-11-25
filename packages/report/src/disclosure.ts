/**
 * The disclosure statement: a template over the report's numbers, never an LLM.
 *
 *     Written in 14 sessions over 9 days. 2,480 words: 97.8% typed directly;
 *     1.6% retyped from 11 AI word-choice suggestions; 0.6% pasted (2 external
 *     pastes). AI feedback was requested 3 times. AI proposed 3 paragraph moves;
 *     2 accepted.
 *
 * Rules:
 * - Only non-zero parts are mentioned; zero cases get their own plain sentence.
 * - Counts are pluralized ("1 session", "2 sessions").
 * - Word shares are tenths of a percent that sum to exactly 100%, with the share
 *   typed directly always rounded down ({@link allocateTenths}). A non-zero share
 *   never prints as 0% ("under 0.1%"), and a share that is not everything never
 *   prints as 100% ("over 99.9%").
 * - It never claims more than the data shows: it describes what the ledger
 *   recorded in Longhand, and mentions imports and unwitnessed intervals whenever
 *   there are any.
 */
import type { ProvenanceClass } from '@longhand/schema';
import { ASSISTED_KINDS, type AssistedKind, type Report } from './types';
import { allocateTenths, count, formatInt, joinList, percentLabel } from './format';

/** What the template reads: the report without its disclosure. */
export type DisclosureInput = Omit<Report, 'disclosure'>;

/** Word classes in the order the statement lists them (most trusted first). */
const LISTED_CLASSES: readonly ProvenanceClass[] = [
  'typed',
  'typed-from-suggestion',
  'quoted',
  'imported',
  'pasted-external',
];

/** Singular and plural nouns for the AI texts retyped words matched. */
const ASSISTED_NOUNS: Record<AssistedKind, [string, string]> = {
  'word-choice': ['word-choice suggestion', 'word-choice suggestions'],
  rephrase: ['rephrase hint', 'rephrase hints'],
  insertion: ['suggested sentence', 'suggested sentences'],
  comment: ['comment', 'comments'],
  question: ['question', 'questions'],
  proposal: ['proposal rationale', 'proposal rationales'],
  'citation-flag': ['citation flag', 'citation flags'],
  'surfaced-source': ['source search', 'source searches'],
  'source-suggestion': ['source suggestion', 'source suggestions'],
  discuss: ['Discuss answer', 'Discuss answers'],
  review: ['review summary', 'review summaries'],
};

function timeSentence(r: DisclosureInput): string {
  const { count: n, days } = r.sessions;
  if (n === 0) return 'No writing sessions were recorded in Longhand.';
  if (n === 1) return 'Written in 1 session.';
  if (days <= 1) return `Written in ${count(n, 'session')} on 1 day.`;
  return `Written in ${count(n, 'session')} over ${count(days, 'day')}.`;
}

function assistedPhrase(r: DisclosureInput): string {
  const kinds = ASSISTED_KINDS.filter((k) => r.extensions.assisted.byKind[k] > 0);
  if (kinds.length === 0) return 'retyped from AI suggestions';
  const parts = kinds.map((k) => {
    const [one, many] = ASSISTED_NOUNS[k];
    return count(r.extensions.assisted.byKind[k], one, many);
  });
  if (kinds.length === 1) return `retyped from ${parts[0]!.replace(/^(\S+) /, '$1 AI ')}`;
  return `retyped from AI text (${joinList(parts)})`;
}

function classPhrase(r: DisclosureInput, cls: ProvenanceClass, share: string): string {
  switch (cls) {
    case 'typed':
      return `${share} typed directly`;
    case 'typed-from-suggestion':
      return `${share} ${assistedPhrase(r)}`;
    case 'quoted': {
      const n = r.extensions.quoted.sources;
      return n > 0 ? `${share} quoted from ${count(n, 'source')}` : `${share} quoted`;
    }
    case 'imported':
      return `${share} imported (unverified)`;
    case 'pasted-external': {
      const n = r.pastes.external.count;
      return n > 0
        ? `${share} pasted (${count(n, 'external paste')})`
        : `${share} pasted or unverified`;
    }
    default:
      return `${share} ${cls}`;
  }
}

function wordsSentence(r: DisclosureInput): string {
  const total = r.words.total;
  if (total === 0)
    return r.scope.kind === 'document'
      ? 'The document has no words yet.'
      : 'The manuscript has no words yet.';
  const present = LISTED_CLASSES.filter((c) => r.words.byClass[c] > 0);
  // Allocate least trusted first, so rounding ties favour disclosure.
  const order = [...present].reverse();
  const tenths = allocateTenths(
    order.map((c) => r.words.byClass[c]),
    order.indexOf('typed'),
  );
  const share = new Map(order.map((c, i) => [c, tenths[i] as number]));
  const parts = present.map((c) =>
    classPhrase(r, c, percentLabel(share.get(c) ?? 0, r.words.byClass[c], total)),
  );
  return `${count(total, 'word')}: ${parts.join('; ')}.`;
}

function aiSentences(r: DisclosureInput): string[] {
  const out: string[] = [];
  const { ai, suggestions, proposals } = r;
  const anything =
    ai.feedbackRequests + ai.sessions.length + suggestions.total + proposals.total > 0;
  if (!anything) return ['No AI feedback was requested in Longhand.'];
  if (ai.feedbackRequests > 0) {
    const notes = [
      ai.comments > 0 ? count(ai.comments, 'comment') : null,
      ai.questions > 0 ? count(ai.questions, 'question') : null,
      ai.citationFlags > 0 ? count(ai.citationFlags, 'citation-needed flag') : null,
    ].filter((s): s is string => s !== null);
    const n = ai.feedbackRequests;
    const times = n === 1 ? 'once' : n === 2 ? 'twice' : count(n, 'time');
    out.push(
      notes.length > 0
        ? `AI feedback was requested ${times}; the editor left ${joinList(notes)}.`
        : `AI feedback was requested ${times}.`,
    );
  }
  if (suggestions.total > 0) {
    const o = suggestions.byOutcome;
    const parts = [
      o.adopted > 0 ? `${formatInt(o.adopted)} adopted` : null,
      o.adapted > 0 ? `${formatInt(o.adapted)} adapted` : null,
      o.dismissed > 0 ? `${formatInt(o.dismissed)} dismissed` : null,
      o.stale > 0 ? `${formatInt(o.stale)} stale` : null,
      o.open > 0 ? `${formatInt(o.open)} still open` : null,
    ].filter((s): s is string => s !== null);
    out.push(`AI made ${count(suggestions.total, 'wording suggestion')}: ${joinList(parts)}.`);
  }
  if (proposals.total > 0) {
    const m = r.extensions.proposals.moves;
    const k = proposals.byKind;
    const parts = [
      m.paragraph.proposed > 0 ? count(m.paragraph.proposed, 'paragraph move') : null,
      m.sentence.proposed > 0 ? count(m.sentence.proposed, 'sentence move') : null,
      m.section.proposed > 0 ? count(m.section.proposed, 'section move') : null,
      k.cut.proposed > 0 ? count(k.cut.proposed, 'cut') : null,
      k.split.proposed > 0 ? count(k.split.proposed, 'split') : null,
      k.merge.proposed > 0 ? count(k.merge.proposed, 'merge') : null,
    ].filter((s): s is string => s !== null);
    const accepted = k.move.accepted + k.cut.accepted + k.split.accepted + k.merge.accepted;
    out.push(
      `AI proposed ${joinList(parts)}; ${accepted === 0 ? 'none' : formatInt(accepted)} accepted.`,
    );
  }
  return out;
}

function importSentence(r: DisclosureInput): string | null {
  const { documents, words } = r.imports;
  if (documents === 0) return null;
  const what =
    documents === 1
      ? '1 document was imported from an existing draft'
      : `${formatInt(documents)} documents were imported from existing drafts`;
  return `${what} (${count(words, 'word')} at import); Longhand cannot verify who wrote imported text.`;
}

function unwitnessedSentences(r: DisclosureInput): string[] {
  const out: string[] = [];
  const queued = r.unwitnessed.filter((u) => u.reason === 'queued-offline');
  const missing = r.unwitnessed.filter((u) => u.reason !== 'queued-offline');
  if (queued.length > 0) {
    const commits = queued.reduce((n, u) => n + u.commits, 0);
    const intervals = count(queued.length, 'interval');
    out.push(
      `${intervals} of writing (${count(commits, 'commit')}) reached the server late after being queued offline, so ${queued.length === 1 ? 'its' : 'their'} timing rests on the device's clock.`,
    );
  }
  if (missing.length > 0) {
    const commits = missing.reduce((n, u) => n + u.commits, 0);
    out.push(`${count(commits, 'commit')} ${commits === 1 ? 'has' : 'have'} no server witness.`);
  }
  return out;
}

/** The disclosure statement for a report (see module docs). */
export function disclosureStatement(r: DisclosureInput): string {
  return [
    timeSentence(r),
    wordsSentence(r),
    ...aiSentences(r),
    importSentence(r),
    ...unwitnessedSentences(r),
  ]
    .filter((s): s is string => s !== null)
    .join(' ');
}
