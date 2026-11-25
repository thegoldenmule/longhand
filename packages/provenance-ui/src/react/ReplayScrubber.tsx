/**
 * `<ReplayScrubber>`: a timeline over the ledger that redraws a document at any
 * seq in a read-only ProseMirror view, using `Replay` snapshots so scrubbing
 * stays fast. Plays back at 1× to 64× with real inter-commit timing (long idle
 * gaps capped), shows AI sessions, writing sessions, pastes and accepted
 * proposals as markers, and can tint the replayed text. Works only from the
 * commit array it is given; it makes no network calls.
 */
import {
  documentNode,
  documentProvenance,
  projectState,
  Replay,
  type LedgerState,
} from '@longhand/ledger';
import { schema, type Commit, type DocumentState, type ProvenanceRun } from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { formatTime as defaultFormatTime, type TimeFormatter } from '../format';
import { REPLAY_SPEEDS, ReplayPlayer, type PlayerClock, type ReplaySpeed } from '../replay/player';
import {
  DEFAULT_MAX_GAP_MS,
  describeCommit,
  frameIndexForSeq,
  playbackOffsets,
  replayFrames,
  replayMarkers,
  type ReplayMarker,
  type ReplayScope,
} from '../replay/timeline';
import { createProvenanceTint, staticTintHost } from '../tint';

export interface ReplayScrubberProps {
  /** The project's commits in ledger order (seq 1…n), supplied by the host. */
  commits: readonly Commit[];
  /** A shared `Replay` over the same commits (optional; one is made otherwise). */
  replay?: Replay;
  /** Snapshot interval for the `Replay` this component makes (default 64). */
  snapshotEvery?: number;
  /** The document to draw (controlled). */
  documentId?: string;
  /** Initial document when uncontrolled (default: the first manuscript document). */
  defaultDocumentId?: string;
  onDocumentChange?: (documentId: string) => void;
  /** Timeline scope: commits touching the document, or the whole project. Default `document`. */
  defaultScope?: ReplayScope;
  /** Initial seq (default: the head). */
  defaultSeq?: number;
  onSeqChange?: (seq: number, state: LedgerState) => void;
  defaultSpeed?: ReplaySpeed;
  /** Tint the replayed document initially (default false). */
  defaultTint?: boolean;
  /** Cap on one idle gap during playback, in ledger ms (default 4000). */
  maxGapMs?: number;
  formatTime?: TimeFormatter;
  /** Clock for playback (tests). */
  clock?: PlayerClock;
  className?: string;
}

function orderedDocuments(docs: Record<string, DocumentState>): DocumentState[] {
  return Object.values(docs).sort(
    (a, b) =>
      (a.kind === 'manuscript' ? 0 : 1) - (b.kind === 'manuscript' ? 0 : 1) ||
      a.createdSeq - b.createdSeq,
  );
}

interface ReplayDocumentProps {
  doc: PMNode | null;
  runs: readonly ProvenanceRun[];
  tinted: boolean;
  label: string;
}

/** A read-only ProseMirror view of one document state. */
function ReplayDocument(props: ReplayDocumentProps): ReactElement {
  const { doc, runs, tinted, label } = props;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const tint = useMemo(() => createProvenanceTint({ name: 'replay', inspectOnClick: false }), []);

  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const view = new EditorView(mount, {
      state: EditorState.create({ schema, plugins: [...tint.plugins] }),
      editable: () => false,
      attributes: {
        class: 'lh-manuscript lh-replay__manuscript',
        'aria-label': label,
        'aria-readonly': 'true',
        'data-testid': 'replay-doc',
      },
    });
    viewRef.current = view;
    const detach = tint.attach(staticTintHost(view));
    return () => {
      detach();
      view.destroy();
      viewRef.current = null;
    };
    // The label is updated through setProps below.
  }, [tint]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = doc ?? schema.topNodeType.createAndFill();
    if (next && next !== view.state.doc)
      view.updateState(EditorState.create({ doc: next, plugins: [...tint.plugins] }));
    tint.setRuns(doc ? runs : []);
  }, [doc, runs, tint]);

  useLayoutEffect(() => tint.setEnabled(tinted), [tinted, tint]);

  useLayoutEffect(() => {
    viewRef.current?.setProps({
      attributes: {
        class: 'lh-manuscript lh-replay__manuscript',
        'aria-label': label,
        'aria-readonly': 'true',
        'data-testid': 'replay-doc',
      },
    });
  }, [label]);

  return (
    <div className="lh-editor lh-replay__doc">
      <div ref={mountRef} />
      {!doc && (
        <p className="lh-replay__empty" data-testid="replay-empty">
          This document does not exist yet at this point in the ledger.
        </p>
      )}
    </div>
  );
}

const LANES: Array<{ kind: ReplayMarker['kind'][]; label: string; key: string }> = [
  { key: 'ai', kind: ['ai-session'], label: 'AI' },
  { key: 'writing', kind: ['writing-session'], label: 'Writing' },
  { key: 'events', kind: ['paste', 'proposal'], label: 'Events' },
];

/** The replay timeline and read-only document. */
export function ReplayScrubber(props: ReplayScrubberProps): ReactElement {
  const { commits } = props;
  const fmt = props.formatTime ?? defaultFormatTime;
  const ids = { doc: useId(), speed: useId(), slider: useId(), status: useId() };

  const replay = useMemo(
    () =>
      props.replay ??
      new Replay(commits, props.snapshotEvery ? { snapshotEvery: props.snapshotEvery } : {}),
    [commits, props.replay, props.snapshotEvery],
  );
  const head = useMemo(() => projectState(replay.head()), [replay]);
  const documents = useMemo(() => orderedDocuments(head.documents), [head]);

  const [ownDoc, setOwnDoc] = useState<string | null>(props.defaultDocumentId ?? null);
  const documentId = props.documentId ?? ownDoc ?? documents[0]?.id ?? null;
  const [scope, setScope] = useState<ReplayScope>(props.defaultScope ?? 'document');
  const [seq, setSeq] = useState<number>(
    Math.max(0, Math.min(commits.length, props.defaultSeq ?? commits.length)),
  );
  const [speed, setSpeed] = useState<ReplaySpeed>(props.defaultSpeed ?? 8);
  const [playing, setPlaying] = useState(false);
  const [tinted, setTinted] = useState(props.defaultTint ?? false);

  const frames = useMemo(
    () => replayFrames(commits, { scope, documentId }),
    [commits, scope, documentId],
  );
  const offsets = useMemo(
    () => playbackOffsets(commits, frames, { maxGapMs: props.maxGapMs ?? DEFAULT_MAX_GAP_MS }),
    [commits, frames, props.maxGapMs],
  );
  const markers = useMemo(
    () => replayMarkers(head, { scope, documentId }),
    [head, scope, documentId],
  );

  const index = frameIndexForSeq(frames, seq);
  const shownSeq = frames[index] ?? 0;
  const state = useMemo(() => replay.stateAt(shownSeq), [replay, shownSeq]);
  const doc = documentId ? (documentNode(state, documentId) ?? null) : null;
  const runs = useMemo(
    () => (documentId ? (documentProvenance(state, documentId) ?? []) : []),
    [state, documentId],
  );

  // Playback.
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const playerRef = useRef<ReplayPlayer | null>(null);
  if (!playerRef.current) {
    playerRef.current = new ReplayPlayer({
      offsets,
      speed,
      onFrame: (i) => setSeq(framesRef.current[i] ?? 0),
      onPlayingChange: setPlaying,
      ...(props.clock ? { clock: props.clock } : {}),
    });
  }
  const player = playerRef.current;
  useEffect(() => player.setOffsets(offsets), [player, offsets]);
  useEffect(() => player.setSpeed(speed), [player, speed]);
  useEffect(() => () => player.dispose(), [player]);

  const onSeqChange = props.onSeqChange;
  useEffect(() => {
    onSeqChange?.(shownSeq, state);
  }, [shownSeq, state, onSeqChange]);

  const chooseDocument = (id: string): void => {
    if (props.documentId === undefined) setOwnDoc(id);
    props.onDocumentChange?.(id);
  };

  const scrubTo = (i: number): void => {
    player.seek(i);
    setSeq(frames[i] ?? 0);
  };

  const togglePlay = (): void => {
    if (player.playing) player.pause();
    else player.play(index);
  };

  const last = frames.length - 1;
  const frac = (i: number): number => (last <= 0 ? 0 : i / last);
  const commit = shownSeq > 0 ? commits[shownSeq - 1] : undefined;
  const activeAi = markers.find(
    (m) => m.kind === 'ai-session' && m.fromSeq <= shownSeq && shownSeq <= m.toSeq,
  );
  const unit = scope === 'document' ? 'Edit' : 'Commit';
  const position = index === 0 ? 'Start' : `${unit} ${index} of ${last}`;
  const summary = commit
    ? `${describeCommit(commit)} · ${fmt(commit.clientTime, { seconds: true })}`
    : 'Before the first commit';
  const docTitle = documents.find((d) => d.id === documentId)?.title ?? 'Document';

  return (
    <section
      className={`lh-replay${props.className ? ` ${props.className}` : ''}`}
      aria-label="Replay"
      data-testid="replay"
      data-seq={shownSeq}
      data-playing={playing ? 'true' : 'false'}
    >
      <div className="lh-replay__toolbar">
        <label className="lh-replay__field">
          <span>Document</span>
          <select
            id={ids.doc}
            value={documentId ?? ''}
            onChange={(e) => chooseDocument(e.target.value)}
            data-testid="replay-document"
          >
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
                {d.kind === 'note' ? ' (note)' : ''}
                {d.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="lh-replay__scope">
          <legend>Timeline</legend>
          {(['document', 'project'] as const).map((s) => (
            <label key={s} className="lh-replay__seg">
              <input
                type="radio"
                name={`${ids.slider}-scope`}
                value={s}
                checked={scope === s}
                onChange={() => setScope(s)}
                data-testid={`replay-scope-${s}`}
              />
              <span>{s === 'document' ? 'This document' : 'Whole project'}</span>
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          role="switch"
          aria-checked={tinted}
          className="lh-prov-switch"
          onClick={() => setTinted((t) => !t)}
          data-testid="replay-tint"
        >
          <span className="lh-prov-switch__track" aria-hidden="true">
            <span className="lh-prov-switch__thumb" />
          </span>
          <span className="lh-prov-switch__label">Tint</span>
        </button>
      </div>

      <div className="lh-replay__transport">
        <button
          type="button"
          className="lh-replay__play"
          onClick={togglePlay}
          aria-label={playing ? 'Pause replay' : 'Play replay'}
          data-testid="replay-play"
          disabled={last <= 0}
        >
          <span
            aria-hidden="true"
            className={`lh-replay__icon lh-replay__icon--${playing ? 'pause' : 'play'}`}
          />
        </button>
        <label className="lh-replay__field lh-replay__speed">
          <span>Speed</span>
          <select
            id={ids.speed}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value) as ReplaySpeed)}
            data-testid="replay-speed"
          >
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <p
          className="lh-replay__status"
          id={ids.status}
          aria-live="polite"
          data-testid="replay-status"
        >
          <span className="lh-replay__pos">{position}</span>
          <span className="lh-replay__what">{summary}</span>
          {activeAi && <span className="lh-replay__ai">{activeAi.label}</span>}
        </p>
      </div>

      <div className="lh-replay__timeline">
        {LANES.map((lane) => (
          <div key={lane.key} className="lh-replay__lane" data-lane={lane.key}>
            <span className="lh-replay__lane-label" aria-hidden="true">
              {lane.label}
            </span>
            <div className="lh-replay__track" aria-hidden="true">
              {markers
                .filter((m) => lane.kind.includes(m.kind))
                .map((m) => {
                  const a = frameIndexForSeq(frames, m.fromSeq);
                  const b = frameIndexForSeq(frames, m.toSeq);
                  const isBand = m.kind === 'ai-session' || m.kind === 'writing-session';
                  return (
                    <button
                      key={`${m.kind}-${m.id}`}
                      type="button"
                      tabIndex={-1}
                      className={`lh-replay__marker lh-replay__marker--${m.kind}${isBand ? ' lh-replay__marker--band' : ''}`}
                      style={
                        isBand
                          ? { left: `${frac(a) * 100}%`, width: `${(frac(b) - frac(a)) * 100}%` }
                          : { left: `${frac(b) * 100}%` }
                      }
                      title={m.label}
                      data-testid={`marker-${m.kind}`}
                      data-from-seq={m.fromSeq}
                      data-to-seq={m.toSeq}
                      onClick={() => scrubTo(isBand ? a : b)}
                    />
                  );
                })}
            </div>
          </div>
        ))}
        <div className="lh-replay__lane lh-replay__lane--slider">
          <label className="lh-replay__lane-label" htmlFor={ids.slider}>
            Seq
          </label>
          <input
            id={ids.slider}
            className="lh-replay__slider"
            type="range"
            min={0}
            max={Math.max(0, last)}
            step={1}
            value={index}
            onChange={(e) => scrubTo(Number(e.target.value))}
            aria-valuetext={`${position}. ${summary}`}
            aria-describedby={ids.status}
            data-testid="replay-slider"
            style={{ '--lh-replay-progress': `${frac(index) * 100}%` } as CSSProperties}
          />
        </div>
        <ul className="lh-replay__key" aria-label="Marker key">
          <li>
            <span className="lh-replay__swatch lh-replay__marker--ai-session" aria-hidden="true" />
            AI session
          </li>
          <li>
            <span
              className="lh-replay__swatch lh-replay__marker--writing-session"
              aria-hidden="true"
            />
            Writing session
          </li>
          <li>
            <span
              className="lh-replay__swatch lh-replay__swatch--point lh-replay__marker--paste"
              aria-hidden="true"
            />
            Paste
          </li>
          <li>
            <span
              className="lh-replay__swatch lh-replay__swatch--point lh-replay__marker--proposal"
              aria-hidden="true"
            />
            Accepted proposal
          </li>
        </ul>
      </div>

      <ReplayDocument
        doc={doc}
        runs={runs}
        tinted={tinted}
        label={`${docTitle} at seq ${shownSeq}`}
      />
    </section>
  );
}
