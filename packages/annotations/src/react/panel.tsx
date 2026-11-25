/**
 * `<FeedbackPanel>`: the writer's side of a review (F3). Review sessions with a
 * live "reviewing…" state that streams items in, the summary when a review
 * finishes, calm failures with a retry, questions for the writer, and the open
 * cards grouped by kind with filters.
 *
 * Nothing shows until the writer asks: with no request in the ledger the panel
 * only offers the request form.
 */
import { LENS_LABELS } from '@longhand/schema';
import { useMemo, useState } from 'react';
import type { AnnotationsController } from '../controller';
import {
  CARD_GROUPS,
  CARD_GROUP_LABELS,
  cardKindLabel,
  filterCards,
  groupCards,
  scopeLabel,
  type Card,
  type CardGroup,
  type ReviewView,
} from '../model';
import type { SessionProgress } from '../progress';
import { AnnotationCard } from './cards';
import { FeedbackRequestForm, INTENSITY_OPTIONS } from './form';
import { useAnnotationsSnapshot } from './hooks';

/** Props of {@link FeedbackPanel}. */
export interface FeedbackPanelProps {
  controller: AnnotationsController;
  /** Title of the current document, for the form's scope label. */
  documentTitle?: string;
  /** Show the request form open at first. Default: open when nothing has been requested yet. */
  formOpen?: boolean;
  className?: string;
}

function ReviewSession(props: {
  controller: AnnotationsController;
  review: ReviewView;
  cards: readonly Card[];
  progress: SessionProgress | undefined;
}): React.JSX.Element {
  const { controller, review, cards, progress } = props;
  const snap = useAnnotationsSnapshot(controller);
  const req = review.request;
  const intensity =
    INTENSITY_OPTIONS.find((o) => o.value === req.intensity)?.label ?? req.intensity;
  const byId = new Map(cards.map((c) => [c.id, c]));
  const live = review.phase === 'reviewing' || review.phase === 'waiting';
  // Items from the ledger, plus any the live stream announced first.
  const ids = [...review.annotationIds];
  for (const a of progress?.arrived ?? []) if (a.id && !ids.includes(a.id)) ids.push(a.id);
  const items = ids.map((id) => ({
    id,
    card: byId.get(id) ?? null,
    label: progress?.arrived.find((a) => a.id === id)?.label ?? null,
  }));
  const failed = review.phase === 'failed' || progress?.state === 'failed';
  const failureReason = review.failureReason ?? progress?.failureReason ?? null;
  const summary = review.session?.review ?? null;
  return (
    <article
      className={`lh-review is-${failed ? 'failed' : review.phase}`}
      data-testid="review-session"
      data-request-id={review.requestId}
      data-phase={failed ? 'failed' : review.phase}
    >
      <header className="lh-review-head">
        <span className="lh-review-scope">{scopeLabel(snap.state, req)}</span>
        <span className="lh-review-meta">
          {req.lenses.map((l) => LENS_LABELS[l]).join(', ')} · {intensity}
        </span>
        {req.ask && <p className="lh-review-ask">“{req.ask}”</p>}
      </header>
      {live && !failed && (
        <div className="lh-review-live" role="status" aria-live="polite">
          <span className="lh-review-state">
            {review.phase === 'waiting' ? 'Waiting for the editor' : 'Reviewing'}
            <span className="lh-dots" aria-hidden="true" />
          </span>
          {progress?.activity && <span className="lh-review-activity">{progress.activity}</span>}
        </div>
      )}
      {failed && (
        <div className="lh-review-failed" role="status">
          <p>
            This review didn’t finish{failureReason ? ` (${failureReason})` : ''}. Nothing in your
            text changed.
          </p>
          <button
            type="button"
            className="lh-btn lh-btn-quiet"
            onClick={() => controller.retryReview(review.requestId)}
          >
            Try again
          </button>
        </div>
      )}
      {summary && (
        <div className="lh-review-summary" data-testid="review-summary">
          <h4>Overall</h4>
          <p>{summary.summary}</p>
          {summary.strengths.length > 0 && (
            <>
              <h4>Strengths</h4>
              <ul>
                {summary.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {summary.topPriorities.length > 0 && (
            <>
              <h4>Top priorities</h4>
              <ol>
                {summary.topPriorities.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
      {items.length > 0 && (
        <details className="lh-review-items" open={live}>
          <summary>
            {items.length} {items.length === 1 ? 'note' : 'notes'}
            {live ? ' so far' : ''}
          </summary>
          <ul>
            {items.map(({ id, card, label }) => (
              <li key={id}>
                <button
                  type="button"
                  className="lh-btn lh-btn-link"
                  disabled={!card}
                  onClick={() => card && controller.focus(card.id)}
                >
                  {card ? cardKindLabel(card) : (label ?? 'Item')}
                  {card?.quote && <span className="lh-muted"> · {card.quote.trim()}</span>}
                  {card?.outcome && <span className="lh-muted"> · {card.outcome}</span>}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

type PhaseFilter = 'open' | 'resolved' | 'all';

/** The feedback panel. */
export function FeedbackPanel(props: FeedbackPanelProps): React.JSX.Element {
  const { controller } = props;
  const snap = useAnnotationsSnapshot(controller);
  const asked = snap.reviews.length > 0;
  const [formOpen, setFormOpen] = useState<boolean | null>(props.formOpen ?? null);
  const showForm = formOpen ?? !asked;
  const [groups, setGroups] = useState<CardGroup[]>([]);
  const [phase, setPhase] = useState<PhaseFilter>('open');

  const questions = useMemo(
    () => snap.cards.filter((c) => c.kind === 'question' && c.status === 'open'),
    [snap.cards],
  );
  const notQuestions = useMemo(() => snap.cards.filter((c) => c.kind !== 'question'), [snap.cards]);
  const filtered = filterCards(notQuestions, { groups, phase });
  const grouped = groupCards(filtered);
  const counts = new Map<CardGroup, number>();
  for (const c of filterCards(notQuestions, { phase }))
    counts.set(c.group, (counts.get(c.group) ?? 0) + 1);

  return (
    <section
      className={`lh-ann lh-panel${props.className ? ` ${props.className}` : ''}`}
      aria-label="Feedback"
      data-testid="feedback-panel"
    >
      <header className="lh-panel-head">
        <h2>Feedback</h2>
        {!showForm && (
          <button type="button" className="lh-btn lh-btn-quiet" onClick={() => setFormOpen(true)}>
            Ask for feedback
          </button>
        )}
      </header>

      {showForm && (
        <FeedbackRequestForm
          documentId={snap.documentId}
          {...(props.documentTitle ? { documentTitle: props.documentTitle } : {})}
          selection={snap.selection}
          onRequest={(event) => {
            if (controller.requestFeedback(event.payload)) setFormOpen(false);
          }}
          {...(asked ? { onCancel: () => setFormOpen(false) } : {})}
        />
      )}

      {!asked && (
        <p className="lh-panel-empty">
          The editor speaks only when you ask. Choose what to look at and it will read, comment and
          propose — it never writes in your text.
        </p>
      )}

      {snap.reviews.length > 0 && (
        <div className="lh-panel-section">
          <h3>Reviews</h3>
          {snap.reviews.map((r) => (
            <ReviewSession
              key={r.requestId}
              controller={controller}
              review={r}
              cards={snap.cards}
              progress={r.session ? snap.progress[r.session.id] : undefined}
            />
          ))}
        </div>
      )}

      {questions.length > 0 && (
        <div className="lh-panel-section" data-testid="panel-questions">
          <h3>Questions for you</h3>
          {questions.map((q) => (
            <AnnotationCard
              key={q.id}
              controller={controller}
              card={q}
              snapshot={snap}
              variant="list"
            />
          ))}
        </div>
      )}

      {notQuestions.length > 0 && (
        <div className="lh-panel-section" data-testid="panel-cards">
          <h3>Notes</h3>
          <div className="lh-filters" role="toolbar" aria-label="Filter notes">
            <button
              type="button"
              className={`lh-chip${groups.length === 0 ? ' is-on' : ''}`}
              aria-pressed={groups.length === 0}
              onClick={() => setGroups([])}
            >
              All
            </button>
            {CARD_GROUPS.filter((g) => g !== 'questions').map((g) => (
              <button
                key={g}
                type="button"
                className={`lh-chip${groups.includes(g) ? ' is-on' : ''}`}
                aria-pressed={groups.includes(g)}
                onClick={() =>
                  setGroups((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]))
                }
              >
                {CARD_GROUP_LABELS[g]}
                <span className="lh-chip-count">{counts.get(g) ?? 0}</span>
              </button>
            ))}
            <span className="lh-filters-sep" aria-hidden="true" />
            {(['open', 'resolved', 'all'] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`lh-chip${phase === p ? ' is-on' : ''}`}
                aria-pressed={phase === p}
                onClick={() => setPhase(p)}
              >
                {p === 'open' ? 'Open' : p === 'resolved' ? 'Resolved' : 'Everything'}
              </button>
            ))}
          </div>
          {grouped.length === 0 && (
            <p className="lh-muted lh-panel-none">
              {phase === 'open' ? 'Nothing open.' : 'Nothing here.'}
            </p>
          )}
          {grouped.map(({ group, cards }) => (
            <div key={group} className="lh-group" data-group={group}>
              <h4>
                {CARD_GROUP_LABELS[group]} <span className="lh-muted">{cards.length}</span>
              </h4>
              {cards.map((c) => (
                <AnnotationCard
                  key={c.id}
                  controller={controller}
                  card={c}
                  snapshot={snap}
                  variant="list"
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
