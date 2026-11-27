'use client';
/**
 * A title you edit where you read it: a plain input that looks like text. Enter
 * or blur commits, Escape reverts, and both Enter and Escape hand the caret back
 * (`onDone`). A blank title commits as Untitled. Nothing is committed unless the
 * title changed.
 */
import { TEXT_LIMITS } from '@longhand/schema';
import { UNTITLED, titleOrUntitled } from '@longhand/binder';
import { useRef, useState } from 'react';

export function TitleField(props: {
  value: string;
  label: string;
  testId?: string;
  className?: string;
  onCommit: (title: string) => void;
  onDone?: () => void;
}) {
  const { value, label, testId, className, onCommit, onDone } = props;
  // The text being edited while focused; null means "show `value`".
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraft = (next: string | null) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const shown = draft ?? value;

  const commit = () => {
    const raw = draftRef.current;
    if (raw === null) return;
    setDraft(null);
    const next = titleOrUntitled(raw);
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="text"
      className={`ws-title-field${shown === UNTITLED ? ' is-untitled' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      data-testid={testId}
      value={shown}
      size={Math.max(shown.length, 8)}
      maxLength={TEXT_LIMITS.titleMaxChars}
      spellCheck
      autoComplete="off"
      onFocus={(e) => {
        setDraft(value);
        if (value === UNTITLED) e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          onDone?.();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setDraft(null);
          onDone?.();
        }
      }}
    />
  );
}
