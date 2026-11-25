/** Ids and per-device facts the app stamps on human drafts. */

export function newId(): string {
  return crypto.randomUUID();
}

/** Random per browser install (the editor uses the same key). */
export function deviceId(): string {
  const key = 'longhand:deviceId';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = newId();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return newId();
  }
}

/** One editor session per page load. */
let pageSession: string | null = null;
export function editorSessionId(): string {
  pageSession ??= newId();
  return pageSession;
}
