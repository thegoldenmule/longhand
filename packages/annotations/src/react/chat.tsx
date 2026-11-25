/**
 * `<FeedbackChat>`: the feedback chat (F3). The writer picks an editor from a
 * dropdown and says anything; the editor replies in a scrolling conversation,
 * and leaves margin notes when the message calls for them (the reply links to
 * them). Context is automatic: the open document, or the selection as a quoted
 * chip, or the whole project. Discuss on a card opens the chat with that note
 * attached. Older reviews and Discuss threads stay readable in the history.
 *
 * Layout: the component fills its container's height. The messages scroll and
 * the composer stays pinned at the bottom.
 */
import type {
  ChatState,
  ChatWriterMessage,
  EditorProfile,
  FeedbackScope,
  ProjectState,
} from '@longhand/schema';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { AnnotationsController, AnnotationsSnapshot } from '../controller';
import {
  cardKindLabel,
  chatHistory,
  latestChat,
  replyParagraphs,
  scopeLabel,
  scopeQuote,
  waitingMessage,
  type Card,
  type ChatHistoryEntry,
} from '../model';
import type { ArrivedItem } from '../progress';
import { useAnnotationsSnapshot } from './hooks';

/** Props of {@link FeedbackChat}. */
export interface FeedbackChatProps {
  controller: AnnotationsController;
  /** The writer's editors, in roster order. `null` while they load. */
  editors: readonly EditorProfile[] | null;
  /**
   * The open manuscript document's title, or null when none is open (or a note
   * is): the chat then reads the whole project.
   */
  documentTitle: string | null;
  /** Where the writer manages their editors. */
  manageEditorsHref?: string;
  className?: string;
}

type View =
  | { kind: 'chat'; chatId: string | null }
  | { kind: 'review'; id: string }
  | { kind: 'discuss'; id: string };

/** A message sent but not folded yet (shown at once). */
interface Outgoing {
  chatId: string;
  messageId: string;
  text: string;
  editorName: string;
}

const ITEM_VERB: Readonly<Record<string, string>> = {
  CommentAdded: 'Left a note',
  QuestionAsked: 'Asked a question',
  MoveProposed: 'Proposed a move',
  CutProposed: 'Proposed a cut',
  SplitProposed: 'Proposed a paragraph break',
  MergeProposed: 'Proposed a paragraph join',
  CitationNeededFlagged: 'Flagged a claim',
  SourceSurfaced: 'Found possible sources',
  SourceSuggested: 'Matched a source',
};

/** "Left a note on ‘sideways’". */
export function arrivedLine(item: ArrivedItem): string {
  const verb =
    item.type === 'SuggestionProposed'
      ? `Suggested ${item.label === 'Word choice' ? 'a word' : item.label === 'Add a sentence' ? 'a sentence' : 'a rephrase'}`
      : (ITEM_VERB[item.type] ?? item.label);
  return item.quote ? `${verb} on “${item.quote}”` : verb;
}

/** The last focus request each controller's chat handled. */
const handledFocus = new WeakMap<AnnotationsController, number>();

function editorOption(e: EditorProfile): string {
  return e.role.trim() ? `${e.name} · ${e.role.trim()}` : e.name;
}

function clip(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function cardLabel(card: Card): string {
  return card.quote ? `${cardKindLabel(card)} · ${clip(card.quote, 40)}` : cardKindLabel(card);
}

/** The chat, filling its container. */
export function FeedbackChat(props: FeedbackChatProps): React.JSX.Element {
  const { controller, editors, documentTitle } = props;
  const snap = useAnnotationsSnapshot(controller);
  const state = snap.state;

  // --- Which conversation is shown ---------------------------------------
  const [view, setView] = useState<View | null>(null);
  const latest = latestChat(state);
  const current: View = view ?? { kind: 'chat', chatId: latest?.id ?? null };
  const chat: ChatState | null =
    current.kind === 'chat' && current.chatId
      ? (state?.annotations.chats[current.chatId] ?? null)
      : null;
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const shownOutgoing =
    outgoing &&
    current.kind === 'chat' &&
    current.chatId === outgoing.chatId &&
    !chat?.messages.some((m) => m.id === outgoing.messageId)
      ? outgoing
      : null;
  const waiting = waitingMessage(chat);
  const busy = waiting !== null || shownOutgoing !== null;

  // --- The editor --------------------------------------------------------
  const [editorId, setEditorId] = useState<string | null>(null);
  // The editor asked last in this chat, else in the latest chat (a new chat keeps it).
  const lastAsked = useMemo(() => {
    for (const c of [chat, latest]) {
      const msgs = c?.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (m.role === 'writer') return m.editor.id;
      }
    }
    return null;
  }, [chat, latest]);
  const editor =
    editors?.find((e) => e.id === editorId) ??
    editors?.find((e) => e.id === lastAsked) ??
    editors?.[0] ??
    null;

  // --- Composer and context ----------------------------------------------
  const [text, setText] = useState('');
  const [wholeProject, setWholeProject] = useState(false);
  const [aboutId, setAboutId] = useState<string | null>(null);
  const [dismissedSel, setDismissedSel] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const canDocument = documentTitle !== null && snap.documentId !== '';
  const sel = snap.selection;
  const selKey = sel ? `${sel.documentId}:${sel.from}-${sel.to}@${sel.version}` : null;
  const attachedSel =
    canDocument && sel && sel.documentId === snap.documentId && selKey !== dismissedSel
      ? sel
      : null;
  const aboutCard = aboutId ? (snap.cards.find((c) => c.id === aboutId) ?? null) : null;

  const scope: FeedbackScope = wholeProject
    ? { kind: 'project' }
    : attachedSel
      ? {
          kind: 'selection',
          documentId: attachedSel.documentId,
          from: attachedSel.from,
          to: attachedSel.to,
          version: attachedSel.version,
        }
      : canDocument
        ? { kind: 'document', documentId: snap.documentId }
        : { kind: 'project' };

  // A request from the header or a card: show the chat, attach the note, focus.
  const focusNonce = snap.chatFocus.nonce;
  useEffect(() => {
    // Handle each request once, even if the chat remounts (a tab switched away and back).
    if (focusNonce === 0 || handledFocus.get(controller) === focusNonce) return;
    handledFocus.set(controller, focusNonce);
    const f = controller.getSnapshot().chatFocus;
    setView((v) => (v && v.kind !== 'chat' ? null : v));
    setHistoryOpen(false);
    setDismissedSel(null);
    if (f.aboutId) setAboutId(f.aboutId);
    input.current?.focus();
  }, [focusNonce, controller]);

  // Auto-grow the composer.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // --- Scrolling -----------------------------------------------------------
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const progress = waiting?.feedbackSessionId
    ? snap.progress[waiting.feedbackSessionId]
    : undefined;
  const tick = `${current.kind}:${'chatId' in current ? current.chatId : current.id}:${chat?.messages.length ?? 0}:${shownOutgoing ? 1 : 0}:${progress?.arrived.length ?? 0}:${progress?.activity ?? ''}:${waiting?.status ?? ''}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [tick]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // --- Actions -------------------------------------------------------------
  const send = (body: string) => {
    if (!editor || !body.trim() || busy || current.kind !== 'chat') return;
    const r = controller.sendChat({
      chatId: current.chatId,
      text: body,
      editor,
      scope,
      aboutId,
    });
    if (!r) return;
    setView({ kind: 'chat', chatId: r.chatId });
    setOutgoing({ ...r, text: body.trim(), editorName: editor.name });
    setText('');
    setAboutId(null);
    if (selKey) setDismissedSel(selKey);
    stick.current = true;
  };
  const retry = (m: ChatWriterMessage) => {
    if (busy || !chat) return;
    const r = controller.sendChat({
      chatId: chat.id,
      text: m.text,
      editor: {
        ...m.editor,
        role: m.editor.role ?? '',
        lenses: m.lenses,
        intensity: m.intensity,
      },
      scope: m.scope,
      aboutId: m.aboutId,
    });
    if (r) setOutgoing({ ...r, text: m.text, editorName: m.editor.name });
    stick.current = true;
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(text);
    }
  };
  const newChat = () => {
    setView({ kind: 'chat', chatId: null });
    setHistoryOpen(false);
    setAboutId(null);
    stick.current = true;
    input.current?.focus();
  };
  const openEntry = (entry: ChatHistoryEntry) => {
    setView(entry.kind === 'chat' ? { kind: 'chat', chatId: entry.id } : entry);
    setHistoryOpen(false);
    stick.current = true;
  };

  const history = useMemo(() => chatHistory(state), [state]);
  const empty = current.kind === 'chat' && !chat && !shownOutgoing;

  return (
    <section
      className={`lh-ann lh-chat${props.className ? ` ${props.className}` : ''}`}
      aria-label="Feedback chat"
      data-testid="feedback-chat"
    >
      <header className="lh-chat-head">
        {editors === null ? (
          <span className="lh-chat-muted" role="status">
            Loading editors…
          </span>
        ) : editors.length === 0 ? (
          <span className="lh-chat-muted">
            No editors.{' '}
            {props.manageEditorsHref && <a href={props.manageEditorsHref}>Set one up</a>}
          </span>
        ) : (
          <select
            className="lh-chat-editor"
            aria-label="Editor"
            value={editor?.id ?? ''}
            onChange={(e) => setEditorId(e.target.value)}
          >
            {editors.map((e) => (
              <option key={e.id} value={e.id}>
                {editorOption(e)}
              </option>
            ))}
          </select>
        )}
        <span className="lh-chat-head-end">
          <button
            type="button"
            className="lh-btn lh-btn-quiet"
            aria-expanded={historyOpen}
            aria-controls="lh-chat-history"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            History
          </button>
          <button type="button" className="lh-btn lh-btn-quiet" onClick={newChat}>
            New chat
          </button>
        </span>
      </header>

      {historyOpen && (
        <nav className="lh-chat-history" id="lh-chat-history" aria-label="Chat history">
          {history.length === 0 ? (
            <p className="lh-chat-muted">Nothing yet.</p>
          ) : (
            <ul>
              {history.map((h) => {
                const on =
                  (h.kind === 'chat' && current.kind === 'chat' && current.chatId === h.id) ||
                  (h.kind !== 'chat' && current.kind === h.kind && current.id === h.id);
                return (
                  <li key={`${h.kind}:${h.id}`}>
                    <button
                      type="button"
                      className={`lh-chat-history-item${on ? ' is-on' : ''}`}
                      aria-current={on ? 'true' : undefined}
                      onClick={() => openEntry(h)}
                    >
                      <span className="lh-chat-history-title">{h.title}</span>
                      <span className="lh-chat-muted">
                        {h.kind === 'chat' ? 'Chat' : h.kind === 'review' ? 'Review' : 'Discuss'}
                        {h.createdAt ? ` · ${new Date(h.createdAt).toLocaleDateString()}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {props.manageEditorsHref && (
            <a className="lh-chat-manage" href={props.manageEditorsHref}>
              Manage editors
            </a>
          )}
        </nav>
      )}

      <div
        className="lh-chat-scroll"
        ref={scroller}
        onScroll={onScroll}
        data-testid="chat-messages"
        aria-live="polite"
      >
        {current.kind === 'review' && (
          <LegacyReview state={state} snap={snap} controller={controller} id={current.id} />
        )}
        {current.kind === 'discuss' && <LegacyThread state={state} snap={snap} id={current.id} />}
        {current.kind === 'chat' && (
          <ol className="lh-chat-messages">
            {chat?.messages.map((m) =>
              m.role === 'writer' ? (
                <li
                  key={m.id}
                  className="lh-chat-msg is-writer"
                  data-testid="chat-message"
                  data-role="writer"
                  data-status={m.status}
                >
                  <WriterBubble message={m} state={state} snap={snap} />
                  {m.status === 'failed' && (
                    <div className="lh-chat-failed" role="status" data-testid="chat-failed">
                      <span>
                        {m.editor.name} couldn’t reply
                        {failureOf(state, snap, m) ? ` (${failureOf(state, snap, m)})` : ''}.
                      </span>
                      {!busy && (
                        <button
                          type="button"
                          className="lh-btn lh-btn-quiet"
                          onClick={() => retry(m)}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ) : (
                <li
                  key={m.id}
                  className="lh-chat-msg is-editor"
                  data-testid="chat-message"
                  data-role="editor"
                >
                  <span className="lh-chat-who">{m.editor.name}</span>
                  <div className="lh-chat-body">
                    {replyParagraphs(m.body).map((lines, i) => (
                      <p key={i}>
                        {lines.map((l, j) => (
                          <span key={j}>
                            {j > 0 && <br />}
                            {l}
                          </span>
                        ))}
                      </p>
                    ))}
                  </div>
                  <NoteChips
                    ids={state?.annotations.agentSessions[m.feedbackSessionId]?.annotationIds ?? []}
                    snap={snap}
                    controller={controller}
                  />
                </li>
              ),
            )}
            {shownOutgoing && (
              <li
                className="lh-chat-msg is-writer is-sending"
                data-testid="chat-message"
                data-role="writer"
                data-status="sending"
              >
                <div className="lh-chat-bubble">{shownOutgoing.text}</div>
              </li>
            )}
            {(waiting || shownOutgoing) && (
              <li className="lh-chat-msg is-editor is-working" data-testid="chat-working">
                <div className="lh-chat-status" role="status">
                  <span>
                    {waiting?.editor.name ?? shownOutgoing?.editorName}{' '}
                    {progress?.arrived.some((a) => a.type !== 'ChatReplied')
                      ? 'is leaving notes'
                      : 'is reading'}
                    <span className="lh-dots" aria-hidden="true" />
                  </span>
                  {progress?.activity && <span className="lh-chat-muted">{progress.activity}</span>}
                </div>
                {progress && progress.arrived.length > 0 && (
                  <ul className="lh-chat-arrived">
                    {progress.arrived
                      .filter((a) => a.type !== 'ChatReplied')
                      .map((a) => (
                        <li key={a.seq}>{arrivedLine(a)}</li>
                      ))}
                  </ul>
                )}
              </li>
            )}
          </ol>
        )}
        {empty && editor && editor.questions.length > 0 && (
          <div className="lh-chat-starters" data-testid="chat-starters">
            {editor.questions.map((q) => (
              <button
                key={q}
                type="button"
                className="lh-chip lh-chat-starter"
                onClick={() => {
                  setText(q);
                  input.current?.focus();
                }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>

      {current.kind === 'chat' ? (
        <form className="lh-chat-composer" onSubmit={submit} data-testid="chat-composer">
          <div className="lh-chat-context">
            {aboutId && (
              <span className="lh-chat-attach" data-testid="chat-attach-note">
                <span>About: {aboutCard ? cardLabel(aboutCard) : 'a note'}</span>
                <button
                  type="button"
                  className="lh-chat-attach-x"
                  aria-label="Remove the note"
                  onClick={() => setAboutId(null)}
                >
                  ×
                </button>
              </span>
            )}
            {attachedSel && !wholeProject && (
              <span className="lh-chat-attach" data-testid="chat-attach-selection">
                <span>“{clip(attachedSel.text, 60)}”</span>
                <button
                  type="button"
                  className="lh-chat-attach-x"
                  aria-label="Remove the selection"
                  onClick={() => setDismissedSel(selKey)}
                >
                  ×
                </button>
              </span>
            )}
            <button
              type="button"
              className={`lh-chip lh-chat-scope${wholeProject ? ' is-on' : ''}`}
              aria-pressed={wholeProject}
              onClick={() => setWholeProject((w) => !w)}
            >
              Whole project
            </button>
          </div>
          <div className="lh-chat-input">
            <textarea
              ref={input}
              rows={1}
              value={text}
              aria-label={editor ? `Message ${editor.name}` : 'Message'}
              placeholder={editor ? `Ask ${editor.name}` : 'Ask'}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
            />
            {busy ? (
              <button
                type="button"
                className="lh-btn lh-chat-send"
                data-testid="chat-stop"
                disabled={!waiting?.feedbackSessionId || !controller.can('cancel')}
                onClick={() =>
                  waiting?.feedbackSessionId && controller.cancel(waiting.feedbackSessionId)
                }
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className="lh-btn lh-btn-primary lh-chat-send"
                disabled={!editor || !text.trim()}
              >
                Send
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="lh-chat-composer lh-chat-readonly">
          <span className="lh-chat-muted">Read only.</span>
          <button type="button" className="lh-btn lh-btn-quiet" onClick={() => setView(null)}>
            Back to chat
          </button>
        </div>
      )}
    </section>
  );
}

function failureOf(
  state: ProjectState | null,
  snap: AnnotationsSnapshot,
  m: ChatWriterMessage,
): string | null {
  if (!m.feedbackSessionId) return null;
  return (
    state?.annotations.agentSessions[m.feedbackSessionId]?.failureReason ??
    snap.progress[m.feedbackSessionId]?.failureReason ??
    null
  );
}

function WriterBubble(props: {
  message: ChatWriterMessage;
  state: ProjectState | null;
  snap: AnnotationsSnapshot;
}): React.JSX.Element {
  const { message: m, state, snap } = props;
  const quote = scopeQuote(state, m.scope, 80);
  const about = m.aboutId ? snap.cards.find((c) => c.id === m.aboutId) : undefined;
  return (
    <>
      <div className="lh-chat-bubble">{m.text}</div>
      {(m.aboutId || quote || m.scope.kind === 'project') && (
        <div className="lh-chat-context is-sent">
          {m.aboutId && (
            <span className="lh-chat-attach">About: {about ? cardLabel(about) : 'a note'}</span>
          )}
          {quote && <span className="lh-chat-attach">“{quote}”</span>}
          {m.scope.kind === 'project' && <span className="lh-chat-attach">Whole project</span>}
        </div>
      )}
    </>
  );
}

function NoteChips(props: {
  ids: readonly string[];
  snap: AnnotationsSnapshot;
  controller: AnnotationsController;
}): React.JSX.Element | null {
  const { ids, snap, controller } = props;
  if (ids.length === 0) return null;
  return (
    <ul className="lh-chat-notes" aria-label="Notes" data-testid="chat-reply-notes">
      {ids.map((id) => {
        const card = snap.cards.find((c) => c.id === id);
        return (
          <li key={id}>
            <button
              type="button"
              className="lh-chip lh-chat-note"
              disabled={!card}
              title={card ? 'Show this note' : 'A note in another document'}
              onClick={() => card && controller.focus(card.id, { scroll: true })}
            >
              {card ? cardLabel(card) : 'Note in another document'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function LegacyReview(props: {
  state: ProjectState | null;
  snap: AnnotationsSnapshot;
  controller: AnnotationsController;
  id: string;
}): React.JSX.Element | null {
  const { state, snap, controller, id } = props;
  const req = state?.annotations.feedbackRequests[id];
  if (!req) return null;
  const session = req.feedbackSessionId
    ? state?.annotations.agentSessions[req.feedbackSessionId]
    : undefined;
  const review = session?.review ?? null;
  return (
    <article className="lh-chat-legacy" data-testid="chat-legacy-review">
      <h3>{req.editor ? `Review by ${req.editor.name}` : 'Review'}</h3>
      <p className="lh-chat-muted">{scopeLabel(state, req)}</p>
      {req.ask && <div className="lh-chat-bubble is-quoted">{req.ask}</div>}
      {review ? (
        <div className="lh-chat-body">
          <p>{review.summary}</p>
          {review.strengths.length > 0 && (
            <>
              <h4>Strengths</h4>
              <ul>
                {review.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {review.topPriorities.length > 0 && (
            <>
              <h4>Top priorities</h4>
              <ol>
                {review.topPriorities.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </>
          )}
        </div>
      ) : (
        <p className="lh-chat-muted">
          {req.status === 'failed'
            ? `This review didn’t finish${session?.failureReason ? ` (${session.failureReason})` : ''}.`
            : 'No summary.'}
        </p>
      )}
      <NoteChips ids={session?.annotationIds ?? []} snap={snap} controller={controller} />
    </article>
  );
}

function LegacyThread(props: {
  state: ProjectState | null;
  snap: AnnotationsSnapshot;
  id: string;
}): React.JSX.Element | null {
  const { state, snap, id } = props;
  const thread = state?.annotations.discussions[id];
  if (!thread) return null;
  const card = snap.cards.find((c) => c.id === thread.targetId);
  return (
    <article className="lh-chat-legacy" data-testid="chat-legacy-thread">
      <h3>Discussion</h3>
      <p className="lh-chat-muted">About: {card ? cardLabel(card) : 'a note'}</p>
      <ol className="lh-chat-messages">
        {thread.messages.map((m, i) => (
          <li key={i} className={`lh-chat-msg ${m.role === 'writer' ? 'is-writer' : 'is-editor'}`}>
            {m.role === 'editor' && <span className="lh-chat-who">Editor</span>}
            {m.role === 'writer' ? (
              <div className="lh-chat-bubble">{m.body}</div>
            ) : (
              <div className="lh-chat-body">
                <p>{m.body}</p>
              </div>
            )}
          </li>
        ))}
      </ol>
    </article>
  );
}
