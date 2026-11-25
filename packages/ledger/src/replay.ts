/**
 * Replay: the state at any seq (with periodic snapshots so scrubbing a long ledger
 * is fast), and the span inspector's history of one position.
 */
import {
  SESSION_GAP_MS,
  type AnnotationsState,
  type Commit,
  type InputMethod,
  type MatchedKind,
  type ProvenanceRun,
  type SuggestionState,
} from '@longhand/schema';
import { applyCommit, emptyState } from './fold';
import { projectState } from './project';
import { pvecGet, pvecToArray } from './pvec';
import { provAt } from './prov';
import { internal, type LedgerState } from './state';

/** Default number of commits between replay snapshots. */
export const DEFAULT_SNAPSHOT_EVERY = 64;

/**
 * Folds a ledger lazily and keeps a snapshot every `snapshotEvery` commits, so
 * `stateAt(seq)` costs at most `snapshotEvery - 1` commit folds once the ledger has
 * been folded that far. States are immutable and structurally shared, so snapshots
 * are cheap.
 */
export class Replay {
  readonly commits: readonly Commit[];
  readonly snapshotEvery: number;
  private readonly snapshots: LedgerState[] = [emptyState()];
  private latest: LedgerState = this.snapshots[0] as LedgerState;
  private latestSeq = 0;

  constructor(commits: readonly Commit[], opts: { snapshotEvery?: number } = {}) {
    this.commits = commits;
    this.snapshotEvery = Math.max(1, opts.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY);
  }

  /** Number of commits. */
  get length(): number {
    return this.commits.length;
  }

  private advanceTo(seq: number): void {
    while (this.latestSeq < seq) {
      this.latest = applyCommit(this.latest, this.commits[this.latestSeq] as Commit);
      this.latestSeq += 1;
      if (this.latestSeq % this.snapshotEvery === 0)
        this.snapshots[this.latestSeq / this.snapshotEvery] = this.latest;
    }
  }

  /** The state after commit `seq` (0 = before any commit). */
  stateAt(seq: number): LedgerState {
    if (!Number.isInteger(seq) || seq < 0 || seq > this.commits.length) {
      throw new RangeError(`seq ${seq} is outside 0…${this.commits.length}`);
    }
    if (seq === this.latestSeq) return this.latest;
    if (seq > this.latestSeq) {
      this.advanceTo(seq);
      return this.latest;
    }
    const k = Math.floor(seq / this.snapshotEvery);
    let s = this.snapshots[k] as LedgerState;
    for (let i = k * this.snapshotEvery; i < seq; i++)
      s = applyCommit(s, this.commits[i] as Commit);
    return s;
  }

  /** The state after the last commit. */
  head(): LedgerState {
    return this.stateAt(this.commits.length);
  }
}

const replays = new WeakMap<readonly Commit[], Replay>();

/**
 * The state after commit `seq` of `commits` (0 = empty). Repeated calls on the same
 * array reuse a cached {@link Replay} with snapshots.
 */
export function stateAtSeq(commits: readonly Commit[], seq: number): LedgerState {
  let r = replays.get(commits);
  if (!r) {
    r = new Replay(commits);
    replays.set(commits, r);
  }
  return r.stateAt(seq);
}

/** A commit that relocated or duplicated a span. */
export interface SpanMove {
  seq: number;
  kind: 'move' | 'paste' | 'drop' | 'other';
  proposalId: string | null;
  clientTime: string;
  serverTime: string;
}

/** What the span inspector shows for one position. */
export interface SpanHistory {
  documentId: string;
  pos: number;
  run: ProvenanceRun;
  origin: {
    seq: number;
    type: string;
    clientTime: string;
    serverTime: string;
    /** Editor session (page load) that produced it. */
    editorSessionId: string;
    deviceId: string;
    /** Input methods used in that commit. */
    methods: InputMethod[] | null;
    /** Writing session containing the origin commit, if any. */
    writingSessionIndex: number | null;
  };
  /**
   * The annotation a `typed-from-suggestion` run matched: its id and the
   * `ProjectState.annotations` collection it lives in (from the run's `matchedKind`).
   */
  matched: { id: string; group: keyof AnnotationsState } | null;
  /** Suggestions open in this document when the text was typed. */
  visibleSuggestions: Array<{
    id: string;
    kind: SuggestionState['kind'];
    status: SuggestionState['status'];
    seq: number;
  }>;
  moves: SpanMove[];
}

/** The `ProjectState.annotations` collection each matched kind lives in. */
const MATCHED_GROUP: Readonly<Record<MatchedKind, keyof AnnotationsState>> = {
  suggestion: 'suggestions',
  insertion: 'suggestions',
  comment: 'comments',
  question: 'questions',
  proposal: 'proposals',
  'citation-flag': 'citationFlags',
  'surfaced-source': 'surfacedSources',
  'source-suggestion': 'sourceSuggestions',
  discuss: 'discussions',
  review: 'agentSessions',
  chat: 'chats',
};

/** The history of the unit at `pos` (see {@link SpanHistory}), or null if there is none. */
export function spanHistory(
  state: LedgerState,
  documentId: string,
  pos: number,
): SpanHistory | null {
  const s = internal(state);
  const d = s.docs[documentId];
  if (!d) return null;
  const p = provAt(d.runs, pos);
  if (!p) return null;
  const pub = projectState(state);
  const run = pub.documents[documentId]?.provenance.find((r) => r.from <= pos && pos < r.to);
  if (!run) return null;
  const info = pvecGet(s.commits, p.originSeq - 1);
  if (!info) return null;
  let sessionIndex: number | null = null;
  {
    let idx = -1;
    let prevMs: number | null = null;
    for (const e of pvecToArray(s.msEntries)) {
      if (prevMs === null || e.timeMs - prevMs >= SESSION_GAP_MS) idx += 1;
      prevMs = e.timeMs;
      if (e.seq === p.originSeq) {
        sessionIndex = idx;
        break;
      }
    }
  }
  let matched: SpanHistory['matched'] = null;
  if (p.suggestionId !== undefined && p.matchedKind !== undefined) {
    matched = { id: p.suggestionId, group: MATCHED_GROUP[p.matchedKind] };
  }
  const visible = Object.values(pub.annotations.suggestions)
    .filter((sg) => {
      const doc = sg.kind === 'insertion' ? sg.documentId : sg.anchor.documentId;
      if (doc !== documentId || sg.seq >= p.originSeq) return false;
      return sg.resolvedSeq === null || sg.resolvedSeq >= p.originSeq;
    })
    .sort((a, b) => a.seq - b.seq)
    .map((sg) => ({ id: sg.id, kind: sg.kind, status: sg.status, seq: sg.seq }));
  const moves: SpanMove[] = (p.moves ?? []).map((seq) => {
    const m = pvecGet(s.commits, seq - 1);
    const kind: SpanMove['kind'] =
      m?.type === 'ProposalAccepted'
        ? 'move'
        : m?.methods?.includes('pasted-internal')
          ? 'paste'
          : m?.methods?.includes('drop-internal')
            ? 'drop'
            : 'other';
    return {
      seq,
      kind,
      proposalId: m?.proposalId ?? null,
      clientTime: m?.clientTime ?? '',
      serverTime: m?.serverTime ?? '',
    };
  });
  return {
    documentId,
    pos,
    run,
    origin: {
      seq: info.seq,
      type: info.type,
      clientTime: info.clientTime,
      serverTime: info.serverTime,
      editorSessionId: info.sessionId,
      deviceId: info.deviceId,
      methods: info.methods,
      writingSessionIndex: sessionIndex,
    },
    matched,
    visibleSuggestions: visible,
    moves,
  };
}
