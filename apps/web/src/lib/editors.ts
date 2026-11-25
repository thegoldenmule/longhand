'use client';
/**
 * The account's named editors, loaded from the ledger service. They are
 * account-wide, so a workspace reloads them when the window regains focus (the
 * writer may have edited them on `/editors` in another tab).
 */
import type { EditorProfile } from '@longhand/schema';
import { useCallback, useEffect, useState } from 'react';
import { getClient } from './client';

/** Where the writer manages their editors; `back` returns to a project. */
export function editorsHref(projectId?: string): string {
  return projectId ? `/editors?back=${encodeURIComponent(`/p/${projectId}`)}` : '/editors';
}

export interface EditorsState {
  /** `null` while loading (or after a failure). */
  editors: EditorProfile[] | null;
  error: string | null;
  reload: () => void;
}

export function useEditors(): EditorsState {
  const [editors, setEditors] = useState<EditorProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    getClient()
      .listEditors()
      .then(
        (list) => {
          setEditors(list);
          setError(null);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      );
  }, []);
  useEffect(() => {
    reload();
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    window.addEventListener('focus', reload);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', reload);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);
  return { editors, error, reload };
}
