/**
 * The span inspector's model: what one character's history says, built from the
 * ledger's `spanHistory` plus the folded `ProjectState`, in words a writer (or a
 * reader of their report) can check. Pure; the popover renders it.
 */
import {
  commitInfo,
  documentNode,
  projectState,
  spanHistory,
  type LedgerState,
  type SpanHistory,
} from '@longhand/ledger';
import type {
  AnnotationsState,
  ImportInfo,
  InputMethod,
  MatchedKind,
  PasteState,
  ProjectState,
  ProvenanceRun,
  SuggestionState,
  WritingSession,
} from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import {
  CLASS_META,
  INPUT_METHOD_LABEL,
  MATCHED_KIND_LABEL,
  type TintClass,
} from './classes';
import { excerpt } from './format';

/** A paste that put (or copied) this text, with its size. */
export interface InspectorPaste {
  id: string;
  seq: number;
  origin: PasteState['origin'];
  via: PasteState['via'];
  characters: number;
  words: number;
  verifiedInternal: boolean;
}

/** One relocation of the span. */
export interface InspectorMove {
  seq: number;
  kind: SpanHistory['moves'][number]['kind'];
  /** "Moved by accepting a proposal (move paragraph)". */
  label: string;
  clientTime: string;
  proposal: { id: string; kind: string; unit: string | null } | null;
  /** For internal pastes: the paste and its size. */
  paste: InspectorPaste | null;
}

/** The AI text a `typed-from-suggestion` span matched. */
export interface InspectorMatch {
  id: string;
  kind: MatchedKind;
  /** "a margin comment". */
  kindLabel: string;
  group: keyof AnnotationsState;
  /** A short excerpt of the matched AI text, when it can be found. */
  text: string | null;
  /** The annotation's status (suggestions: adopted, adapted…), when it has one. */
  status: string | null;
}

/** A suggestion that was open in the document when the text was typed. */
export interface InspectorVisibleSuggestion {
  id: string;
  kind: SuggestionState['kind'];
  kindLabel: string;
  status: SuggestionState['status'];
  seq: number;
  text: string | null;
}

/** Everything the inspector shows for one character. */
export interface InspectorModel {
  documentId: string;
  /** Ledger position inspected. */
  pos: number;
  run: ProvenanceRun;
  class: TintClass;
  classLabel: string;
  classDescription: string;
  /** Text of the whole run (the maximal span with this provenance), trimmed. */
  spanText: string;
  origin: {
    seq: number;
    type: string;
    /** When the input happened (client time). */
    clientTime: string;
    /** When the server witnessed it. */
    serverTime: string;
    editorSessionId: string;
    deviceId: string;
  };
  /** What the origin commit did, as a verb phrase ("Typed", "Imported", "Accepted a proposal"). */
  action: string;
  /** Writing session of the origin commit (1-based `number`), if any. */
  session: (WritingSession & { number: number; total: number }) | null;
  /** Input methods recorded in the origin commit. */
  methods: InputMethod[] | null;
  /** The methods in words ("typed on the keyboard"), or null. */
  methodText: string | null;
  /** Why the class differs from what the input method claimed, when it does. */
  note: string | null;
  matched: InspectorMatch | null;
  visibleSuggestions: InspectorVisibleSuggestion[];
  moves: InspectorMove[];
  /** Pastes that put this text in the ledger (for pasted text). */
  pastes: InspectorPaste[];
  imported: ImportInfo | null;
  /** For quoted text: the source it is tied to. */
  source: { id: string; title: string | null; locator: string | null } | null;
}

const SUGGESTION_KIND_LABEL: Record<SuggestionState['kind'], string> = {
  'word-choice': 'word choice',
  insertion: 'insertion',
  rephrase: 'rephrase hint',
};

function suggestionText(s: SuggestionState): string {
  if (s.kind === 'word-choice') return s.alternatives.join(' / ');
  if (s.kind === 'insertion') return s.sentence;
  return s.guidance;
}

/** The AI text of a matched annotation, or null. */
function matchedText(ann: AnnotationsState, kind: MatchedKind, id: string): {
  text: string | null;
  status: string | null;
} {
  switch (kind) {
    case 'suggestion':
    case 'insertion': {
      const s = ann.suggestions[id];
      return s ? { text: suggestionText(s), status: s.status } : { text: null, status: null };
    }
    case 'comment': {
      const c = ann.comments[id];
      return { text: c?.body ?? null, status: c?.status ?? null };
    }
    case 'question': {
      const q = ann.questions[id];
      return { text: q?.question ?? null, status: q?.status ?? null };
    }
    case 'proposal': {
      const p = ann.proposals[id];
      return { text: p?.rationale ?? null, status: p?.status ?? null };
    }
    case 'citation-flag': {
      const f = ann.citationFlags[id];
      return { text: f?.claim ?? null, status: f?.status ?? null };
    }
    case 'surfaced-source': {
      const s = ann.surfacedSources[id];
      return { text: s?.query ?? null, status: s?.status ?? null };
    }
    case 'source-suggestion': {
      const s = ann.sourceSuggestions[id];
      return { text: s?.rationale ?? null, status: s?.status ?? null };
    }
    case 'discuss': {
      const t = ann.discussions[id];
      const answer = t ? [...t.messages].reverse().find((m) => m.role === 'editor') : undefined;
      return { text: answer?.body ?? null, status: t?.status ?? null };
    }
    case 'review': {
      const s = ann.agentSessions[id];
      return { text: s?.review?.summary ?? null, status: s?.status ?? null };
    }
  }
}

function pasteOf(p: PasteState): InspectorPaste {
  return {
    id: p.id,
    seq: p.seq,
    origin: p.origin,
    via: p.via,
    characters: p.characters,
    words: p.words,
    verifiedInternal: p.verifiedInternal,
  };
}

function pastesInsertedBy(ps: ProjectState, seq: number): InspectorPaste[] {
  return Object.values(ps.pastes)
    .filter((p) => p.insertedSeq === seq)
    .sort((a, b) => a.seq - b.seq)
    .map(pasteOf);
}

function actionOf(type: string, methods: InputMethod[] | null): string {
  switch (type) {
    case 'DocumentImported':
      return 'Imported';
    case 'ProposalAccepted':
      return 'Added when a proposal was accepted';
    case 'TextEdited':
      if (methods?.length === 1) {
        const m = methods[0] as InputMethod;
        if (m === 'typed' || m === 'ime' || m === 'autocorrect') return 'Typed';
        if (m === 'pasted-external' || m === 'pasted-internal') return 'Pasted';
        if (m === 'drop-internal') return 'Dropped';
        if (m === 'history') return 'Restored by undo or redo';
        if (m === 'citation') return 'Cited';
        if (m === 'clipping') return 'Placed from a clipping';
      }
      return 'Entered';
    default:
      return 'Entered';
  }
}

/** Explains a class the input method did not claim (the fold downgrades, never upgrades). */
function noteFor(cls: TintClass, type: string, methods: InputMethod[] | null): string | null {
  const m = new Set(methods ?? []);
  if (type === 'ProposalAccepted')
    return 'A joining space the ledger inserted when the writer accepted a proposal. It carries no words.';
  if (cls === 'pasted-external') {
    if (m.has('history') && !m.has('pasted-external'))
      return 'Restored by undo or redo. Text that cannot be matched to the writer’s own deleted words counts as pasted.';
    if (m.has('clipping') && !m.has('pasted-external'))
      return 'Placed as a clipping, but it did not match the saved clipping text, so it counts as pasted.';
    if (m.has('citation') && !m.has('pasted-external'))
      return 'Inserted as a citation, but it could not be verified, so it counts as pasted.';
    if (m.has('pasted-internal') && !m.has('pasted-external'))
      return 'Pasted from inside the project, but the copied text could not be verified, so it counts as pasted.';
    if (m.has('drop-internal') && !m.has('pasted-external'))
      return 'Dropped, but the dropped text could not be matched to what was dragged, so it counts as pasted.';
    if ([...m].some((x) => x === 'typed' || x === 'ime' || x === 'autocorrect') && m.size === 1)
      return 'Its characters have no verified origin, so it counts as pasted.';
  }
  if (cls === 'typed-from-suggestion')
    return 'Typed by the writer while matching AI text was showing. Counts as the writer’s own, disclosed as AI-assisted.';
  if (cls === 'imported') return 'Part of an imported draft. The ledger cannot say who wrote it.';
  if (cls === 'quoted') return 'Quoted from a library source. Not counted as authored.';
  return null;
}

/** The node (citation) or ancestor (quote block) that ties quoted text to a source. */
function sourceRef(doc: PMNode, pos: number): { sourceId: string; locator: string | null } | null {
  const node = doc.nodeAt(pos);
  if (node?.type.name === 'citation')
    return { sourceId: node.attrs.sourceId as string, locator: node.attrs.locator as string | null };
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d);
    if (n.type.name === 'quote_block')
      return { sourceId: n.attrs.sourceId as string, locator: n.attrs.locator as string | null };
  }
  return null;
}

function textOf(doc: PMNode, from: number, to: number): string {
  return doc.textBetween(from, to, '\n', (n) => (n.type.name === 'citation' ? '[cite]' : ''));
}

function methodText(methods: InputMethod[] | null): string | null {
  if (!methods || methods.length === 0) return null;
  const parts = methods.map((m) => INPUT_METHOD_LABEL[m]);
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) as string}`;
}

/**
 * The inspector model for the character at ledger position `pos` of `documentId`
 * in `state`, or null when there is no text there.
 */
export function inspectSpan(
  state: LedgerState,
  documentId: string,
  pos: number,
): InspectorModel | null {
  const h = spanHistory(state, documentId, pos);
  if (!h) return null;
  const ps = projectState(state);
  const doc = documentNode(state, documentId);
  const docState = ps.documents[documentId];
  const cls = (h.run.class === 'pasted-internal' ? 'pasted-external' : h.run.class) as TintClass;
  const meta = CLASS_META[cls];

  const sessionIndex = h.origin.writingSessionIndex;
  const ws = sessionIndex === null ? undefined : ps.writingSessions[sessionIndex];
  const session = ws ? { ...ws, number: ws.index + 1, total: ps.writingSessions.length } : null;

  let matched: InspectorMatch | null = null;
  if (h.matched && h.run.matchedKind) {
    const t = matchedText(ps.annotations, h.run.matchedKind, h.matched.id);
    matched = {
      id: h.matched.id,
      kind: h.run.matchedKind,
      kindLabel: MATCHED_KIND_LABEL[h.run.matchedKind],
      group: h.matched.group,
      text: t.text === null ? null : excerpt(t.text, 140),
      status: t.status,
    };
  }

  const visibleSuggestions = h.visibleSuggestions.map((v) => {
    const s = ps.annotations.suggestions[v.id];
    return {
      id: v.id,
      kind: v.kind,
      kindLabel: SUGGESTION_KIND_LABEL[v.kind],
      status: v.status,
      seq: v.seq,
      text: s ? excerpt(suggestionText(s), 100) : null,
    };
  });

  const moves: InspectorMove[] = h.moves.map((m) => {
    let proposal: InspectorMove['proposal'] = null;
    if (m.proposalId) {
      const p = ps.annotations.proposals[m.proposalId];
      proposal = {
        id: m.proposalId,
        kind: p?.kind ?? 'move',
        unit: p?.kind === 'move' ? p.span.unit : null,
      };
    }
    const paste = m.kind === 'paste' ? (pastesInsertedBy(ps, m.seq)[0] ?? null) : null;
    const label =
      m.kind === 'move'
        ? `Moved by accepting a proposal${proposal ? ` (${proposal.kind}${proposal.unit ? ` ${proposal.unit}` : ''})` : ''}`
        : m.kind === 'paste'
          ? 'Copied and pasted within the project'
          : m.kind === 'drop'
            ? 'Dragged and dropped within the document'
            : 'Relocated';
    return { seq: m.seq, kind: m.kind, label, clientTime: m.clientTime, proposal, paste };
  });

  let source: InspectorModel['source'] = null;
  if (cls === 'quoted' && doc) {
    const ref = sourceRef(doc, pos);
    if (ref) {
      const src = ps.sources[ref.sourceId];
      source = { id: ref.sourceId, title: src?.csl.title ?? null, locator: ref.locator };
    }
  }

  const info = commitInfo(state, h.origin.seq);
  return {
    documentId,
    pos,
    run: h.run,
    class: cls,
    classLabel: meta.label,
    classDescription: meta.description,
    spanText: doc ? excerpt(textOf(doc, h.run.from, h.run.to), 160) : '',
    origin: {
      seq: h.origin.seq,
      type: h.origin.type,
      clientTime: h.origin.clientTime,
      serverTime: h.origin.serverTime,
      editorSessionId: h.origin.editorSessionId,
      deviceId: h.origin.deviceId,
    },
    action: actionOf(h.origin.type, h.origin.methods ?? info?.methods ?? null),
    session,
    methods: h.origin.methods,
    methodText: methodText(h.origin.methods),
    note: noteFor(cls, h.origin.type, h.origin.methods),
    matched,
    visibleSuggestions,
    moves,
    pastes: cls === 'pasted-external' ? pastesInsertedBy(ps, h.origin.seq) : [],
    imported: cls === 'imported' ? (docState?.imported ?? null) : null,
    source,
  };
}
