/**
 * Cards for every annotation kind: comments, questions, suggestions (word choice,
 * insertion, rephrase), proposals (move, cut, split, merge), citation-needed
 * flags, surfaced sources and source suggestions. The same component draws a
 * margin card and a panel list item.
 */
import { LENS_LABELS, type CslItem, type DismissReason, type ProjectState } from '@longhand/schema';
import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { AnnotationsController, AnnotationsSnapshot } from '../controller';
import { GHOST_ATTR, ghostDescriptionId } from '../ghost';
import {
  AI_SURFACED_LABEL,
  DISMISS_REASON_LABELS,
  cardKindLabel,
  proposalTitle,
  threadFailure,
  threadFor,
  type Card,
  type CardOf,
} from '../model';
import { useAnnotationsSnapshot } from './hooks';

const REASONS: readonly DismissReason[] = ['not-my-voice', 'wrong', 'later'];

/** Ghost text on a card: decoration only, never selectable or copyable. */
export function GhostText(props: { text: string; className?: string }): React.JSX.Element {
  const attrs = { [GHOST_ATTR]: '' } as Record<string, string>;
  return (
    <span
      className={`lh-ghost${props.className ? ` ${props.className}` : ''}`}
      aria-hidden="true"
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      {...attrs}
    >
      {props.text}
    </span>
  );
}

/** The accessible description of a card (also referenced by its span in the editor). */
export function cardDescription(card: Card, state: ProjectState | null): string {
  const on = card.quote ? ` on “${card.quote.trim()}”` : '';
  switch (card.kind) {
    case 'comment':
      return `Comment${on} (${LENS_LABELS[card.data.category]}, ${card.data.severity}): ${card.data.body}`;
    case 'question':
      return `Question${on}: ${card.data.question}`;
    case 'suggestion': {
      const s = card.data;
      if (s.kind === 'word-choice')
        return `Word choice${on}. Suggested wording: ${s.alternatives.join('; or ')}. ${s.rationale}`;
      if (s.kind === 'insertion') return `Suggested sentence to add: ${s.sentence} ${s.purpose}`;
      return `Rephrase${on}: ${s.guidance}`;
    }
    case 'proposal':
      return `${proposalTitle(card.data, state)}. ${card.data.rationale}`;
    case 'citation-flag':
      return `Citation needed${on}: ${card.data.claim}. ${AI_SURFACED_LABEL}.`;
    case 'surfaced-source':
      return `Possible sources for “${card.data.query}”: ${card.data.candidates
        .map((c) => c.csl.title ?? 'Untitled')
        .join('; ')}. ${AI_SURFACED_LABEL}.`;
    case 'source-suggestion': {
      const title = state?.sources[card.data.sourceId]?.csl.title ?? card.data.sourceId;
      return `Source from your library${on}: ${title}. ${card.data.rationale}. ${AI_SURFACED_LABEL}.`;
    }
  }
}

/** Hidden descriptions for every card of a snapshot (referenced by `aria-describedby`). */
export function GhostDescriptions(props: { snapshot: AnnotationsSnapshot }): React.JSX.Element {
  const { snapshot } = props;
  return (
    <div hidden data-lh-ghost-desc="">
      {snapshot.cards.map((c) => (
        <span key={c.id} id={ghostDescriptionId(c.id)}>
          {cardDescription(c, snapshot.state)}
        </span>
      ))}
    </div>
  );
}

function authorsOf(csl: CslItem): string | null {
  const names = (csl.author ?? [])
    .map((a) => a.family ?? a.literal ?? a.given ?? '')
    .filter(Boolean);
  if (names.length === 0) return null;
  return names.length > 2 ? `${names[0]} et al.` : names.join(' and ');
}

function yearOf(csl: CslItem): string | null {
  const y = csl.issued?.['date-parts']?.[0]?.[0];
  return y === undefined ? null : String(y);
}

function DismissControl(props: {
  label: string;
  onChoose: (reason: DismissReason | null) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        className="lh-btn lh-btn-quiet"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {props.label}
      </button>
    );
  return (
    <div className="lh-reasons" role="group" aria-label={`${props.label}: why?`}>
      <span className="lh-reasons-q">Why?</span>
      {REASONS.map((r) => (
        <button
          key={r}
          type="button"
          className="lh-btn lh-btn-chip"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
            props.onChoose(r);
          }}
        >
          {DISMISS_REASON_LABELS[r]}
        </button>
      ))}
      <button
        type="button"
        className="lh-btn lh-btn-chip lh-btn-plain"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
          props.onChoose(null);
        }}
      >
        No reason
      </button>
      <button
        type="button"
        className="lh-btn lh-btn-quiet lh-btn-x"
        aria-label="Cancel"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
        }}
      >
        ×
      </button>
    </div>
  );
}

function DiscussThread(props: {
  controller: AnnotationsController;
  card: Card;
  state: ProjectState | null;
  composing: boolean;
  setComposing: (v: boolean) => void;
}): React.JSX.Element | null {
  const { controller, card, state, composing, setComposing } = props;
  const [text, setText] = useState('');
  const thread = threadFor(state, card.id);
  const failure =
    thread?.status === 'failed' ? (threadFailure(state, thread.id) ?? 'unknown') : null;
  const lastWriter = thread
    ? [...thread.messages].reverse().find((m) => m.role === 'writer')
    : null;
  if (!thread && !composing) return null;
  const send = (): void => {
    if (!text.trim()) return;
    if (controller.discuss(card.id, text)) {
      setText('');
      setComposing(false);
    }
  };
  return (
    <div className="lh-thread" onClick={(e) => e.stopPropagation()}>
      {thread && (
        <ol className="lh-thread-messages" aria-label="Discussion">
          {thread.messages.map((m) => (
            <li key={m.seq} className={`lh-msg lh-msg-${m.role}`} data-role={m.role}>
              <span className="lh-msg-who">{m.role === 'writer' ? 'You' : 'Editor'}</span>
              <p>{m.body}</p>
            </li>
          ))}
        </ol>
      )}
      {thread?.status === 'awaiting-editor' && (
        <p className="lh-thread-wait" role="status">
          The editor is replying
          <span className="lh-dots" aria-hidden="true" />
        </p>
      )}
      {failure && (
        <p className="lh-thread-failed" role="status">
          The editor couldn’t reply this time ({failure}).{' '}
          {lastWriter && (
            <button
              type="button"
              className="lh-btn lh-btn-link"
              onClick={() => controller.discuss(card.id, lastWriter.body)}
            >
              Try again
            </button>
          )}
        </p>
      )}
      {composing ? (
        <div className="lh-thread-compose">
          <textarea
            value={text}
            rows={2}
            maxLength={1000}
            aria-label="Ask the editor about this"
            placeholder="Ask the editor about this…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
              if (e.key === 'Escape') setComposing(false);
            }}
            autoFocus
          />
          <div className="lh-thread-actions">
            <button
              type="button"
              className="lh-btn lh-btn-quiet"
              onClick={() => setComposing(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="lh-btn lh-btn-primary"
              disabled={!text.trim()}
              onClick={send}
            >
              Ask
            </button>
          </div>
        </div>
      ) : (
        thread &&
        thread.status !== 'awaiting-editor' && (
          <button type="button" className="lh-btn lh-btn-link" onClick={() => setComposing(true)}>
            Reply
          </button>
        )
      )}
    </div>
  );
}

function SuggestionBody(props: {
  controller: AnnotationsController;
  card: CardOf<'suggestion'>;
  snapshot: AnnotationsSnapshot;
}): React.JSX.Element {
  const { controller, card, snapshot } = props;
  const s = card.data;
  const open = card.phase === 'open';
  if (s.kind === 'word-choice') {
    const preferred = snapshot.preferred[card.id] ?? 0;
    const tracing = snapshot.tracingId === card.id ? snapshot.trace : null;
    return (
      <>
        <div className="lh-alts" aria-label="Suggested wording (described above)">
          {s.alternatives.map((alt, i) => (
            <button
              key={i}
              type="button"
              className={`lh-alt${i === preferred ? ' is-on' : ''}${s.adoptedAlternative === i ? ' is-adopted' : ''}`}
              aria-label={`Alternative ${i + 1} of ${s.alternatives.length}`}
              aria-pressed={i === preferred}
              disabled={!open}
              onClick={(e) => {
                e.stopPropagation();
                controller.chooseAlternative(card.id, i);
              }}
            >
              <GhostText text={alt} />
            </button>
          ))}
        </div>
        <p className="lh-card-text">{s.rationale}</p>
        {tracing && !tracing.untouched && (
          <p className="lh-trace-status" role="status" data-testid="trace-status">
            {tracing.diverged
              ? 'Your own wording — it will count as adapted.'
              : `Retyping · ${tracing.matched} of ${tracing.ghost.length}`}
          </p>
        )}
      </>
    );
  }
  if (s.kind === 'insertion') {
    const tracing = snapshot.tracingId === card.id ? snapshot.trace : null;
    return (
      <>
        <p className="lh-card-ghost-line">
          <GhostText text={s.sentence} />
        </p>
        <p className="lh-card-text">{s.purpose}</p>
        {tracing && !tracing.untouched && (
          <p className="lh-trace-status" role="status" data-testid="trace-status">
            {tracing.diverged
              ? 'Your own wording — it will count as adapted.'
              : `Retyping · ${tracing.matched} of ${tracing.ghost.length}`}
          </p>
        )}
      </>
    );
  }
  return <p className="lh-card-text lh-card-guidance">{s.guidance}</p>;
}

function SurfacedBody(props: {
  controller: AnnotationsController;
  card: CardOf<'surfaced-source'>;
}): React.JSX.Element {
  const { controller, card } = props;
  const s = card.data;
  const canAdd = controller.can('add-source');
  return (
    <>
      <p className="lh-card-text">
        Searched for <q>{s.query}</q>
      </p>
      {s.candidates.length === 0 ? (
        <p className="lh-card-text lh-muted">Nothing came back.</p>
      ) : (
        <ul className="lh-candidates">
          {s.candidates.map((c, i) => {
            const added = s.accepted.find((a) => a.candidateIndex === i);
            const meta = [
              authorsOf(c.csl),
              yearOf(c.csl),
              c.csl['container-title'] ?? c.csl.publisher,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={i} className="lh-candidate">
                <span className="lh-candidate-title">{c.csl.title ?? 'Untitled'}</span>
                {meta && <span className="lh-candidate-meta">{meta}</span>}
                <span className="lh-candidate-meta">
                  via{' '}
                  {c.provider === 'openlibrary'
                    ? 'Open Library'
                    : c.provider === 'crossref'
                      ? 'Crossref'
                      : 'the web'}
                  {c.url && (
                    <>
                      {' · '}
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        onClick={(e) => e.stopPropagation()}
                      >
                        open
                      </a>
                    </>
                  )}
                </span>
                {added ? (
                  <span className="lh-candidate-added">Checked and added</span>
                ) : (
                  canAdd &&
                  card.phase === 'open' && (
                    <button
                      type="button"
                      className="lh-btn lh-btn-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        controller.addSource(card.id, i);
                      }}
                    >
                      Check and add
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function CardBody(props: {
  controller: AnnotationsController;
  card: Card;
  snapshot: AnnotationsSnapshot;
}): React.JSX.Element {
  const { controller, card, snapshot } = props;
  switch (card.kind) {
    case 'comment':
      return <p className="lh-card-text">{card.data.body}</p>;
    case 'question':
      return <p className="lh-card-text lh-card-question">{card.data.question}</p>;
    case 'suggestion':
      return <SuggestionBody controller={controller} card={card} snapshot={snapshot} />;
    case 'proposal':
      return (
        <>
          <p className="lh-card-title">{proposalTitle(card.data, snapshot.state)}</p>
          <p className="lh-card-text">{card.data.rationale}</p>
        </>
      );
    case 'citation-flag':
      return <p className="lh-card-text">{card.data.claim}</p>;
    case 'surfaced-source':
      return <SurfacedBody controller={controller} card={card} />;
    case 'source-suggestion': {
      const src = snapshot.state?.sources[card.data.sourceId];
      return (
        <>
          <p className="lh-card-title">{src?.csl.title ?? card.data.sourceId}</p>
          {src && (
            <p className="lh-candidate-meta">
              {[authorsOf(src.csl), yearOf(src.csl)].filter(Boolean).join(' · ')}
            </p>
          )}
          <p className="lh-card-text">{card.data.rationale}</p>
        </>
      );
    }
  }
}

function headMeta(card: Card): string | null {
  if (card.kind === 'comment') return `${LENS_LABELS[card.data.category]} · ${card.data.severity}`;
  return null;
}

/** Props of {@link AnnotationCard}. */
export interface AnnotationCardProps {
  controller: AnnotationsController;
  card: Card;
  /** `margin` beside the text, or `list` in the feedback panel. */
  variant?: 'margin' | 'list';
  snapshot?: AnnotationsSnapshot;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLElement>;
}

/** One annotation card. */
export function AnnotationCard(props: AnnotationCardProps): React.JSX.Element {
  const { controller, card, variant = 'margin' } = props;
  const live = useAnnotationsSnapshot(controller);
  const snapshot = props.snapshot ?? live;
  const [composing, setComposing] = useState(false);
  const open = card.phase === 'open';
  const active = snapshot.activeId === card.id;
  const tracing = snapshot.tracingId === card.id;
  const meta = headMeta(card);
  const onClick = (e: MouseEvent): void => {
    if ((e.target as Element).closest('button, a, textarea, input')) return;
    controller.focus(active && variant === 'margin' ? null : card.id);
  };
  const s = card.kind === 'suggestion' ? card.data : null;
  const traceable = open && s !== null && s.kind !== 'rephrase';
  return (
    <article
      ref={props.ref as React.Ref<HTMLElement>}
      className={[
        'lh-ann',
        'lh-card',
        `lh-card-${card.kind}`,
        `lh-card-${variant}`,
        `is-${card.phase}`,
        active ? 'is-active' : '',
        tracing ? 'is-tracing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={props.style}
      data-card-id={card.id}
      data-kind={card.kind}
      data-phase={card.phase}
      data-status={card.status}
      aria-label={`${cardKindLabel(card)}${card.quote ? ` on “${card.quote.trim()}”` : ''}`}
      aria-describedby={ghostDescriptionId(card.id)}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      onMouseEnter={() => controller.hover(card.id)}
      onMouseLeave={() => controller.hover(null)}
    >
      <header className="lh-card-head">
        <span className="lh-card-kind">{cardKindLabel(card)}</span>
        {meta && <span className="lh-card-meta">{meta}</span>}
        {card.outcome && (
          <span className={`lh-card-outcome lh-outcome-${card.status}`} data-testid="card-outcome">
            {card.outcome}
          </span>
        )}
      </header>
      {card.aiSurfaced && <p className="lh-badge">{AI_SURFACED_LABEL}</p>}
      {card.quote && card.kind !== 'surfaced-source' && (
        <p className="lh-card-quote">{card.quote.trim()}</p>
      )}
      <CardBody controller={controller} card={card} snapshot={snapshot} />
      {card.status === 'open' && (
        <footer className="lh-card-actions">
          {card.kind === 'proposal' && open && (
            <>
              <button
                type="button"
                className="lh-btn lh-btn-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  controller.accept(card.id);
                }}
              >
                Accept
              </button>
              <DismissControl label="Reject" onChoose={(r) => controller.reject(card.id, r)} />
            </>
          )}
          {traceable && !tracing && (
            <button
              type="button"
              className="lh-btn lh-btn-quiet"
              title="Put the caret on the text and retype it in your own hand"
              onClick={(e) => {
                e.stopPropagation();
                controller.startTrace(card.id);
              }}
            >
              Trace over
            </button>
          )}
          {(card.kind === 'citation-flag' || card.kind === 'source-suggestion') &&
            open &&
            controller.can('cite') && (
              <button
                type="button"
                className="lh-btn lh-btn-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  controller.cite(card.id);
                }}
              >
                Cite
              </button>
            )}
          {card.status === 'open' && !composing && (
            <button
              type="button"
              className="lh-btn lh-btn-quiet"
              onClick={(e) => {
                e.stopPropagation();
                setComposing(true);
              }}
            >
              Discuss
            </button>
          )}
          {card.kind !== 'proposal' && (
            <DismissControl label="Dismiss" onChoose={(r) => controller.dismiss(card.id, r)} />
          )}
        </footer>
      )}
      <DiscussThread
        controller={controller}
        card={card}
        state={snapshot.state}
        composing={composing}
        setComposing={setComposing}
      />
    </article>
  );
}
