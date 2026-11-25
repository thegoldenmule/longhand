/** Workspace keyboard shortcuts (the editor owns its own formatting keys). */
import { useEffect } from 'react';

export interface Shortcut {
  /** e.g. `Mod-\\`, `Mod-Shift-\\`, `Mod-Alt-KeyP`, `Escape`. */
  keys: string;
  label: string;
  run: () => void;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function matches(e: KeyboardEvent, keys: string): boolean {
  const parts = keys.split('-');
  const key = parts.pop() as string;
  const want = new Set(parts);
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  if (want.has('Mod') !== mod) return false;
  if (want.has('Alt') !== e.altKey) return false;
  if (want.has('Shift') !== e.shiftKey) return false;
  if (
    key.startsWith('Key') ||
    key.startsWith('Digit') ||
    key === 'Backslash' ||
    key === 'Period' ||
    key === 'Slash'
  )
    return e.code === key;
  return e.key === key;
}

/** Pretty label: ⌘⌥P on a Mac, Ctrl+Alt+P elsewhere. */
export function keyLabel(keys: string): string {
  const parts = keys.split('-');
  const key = (parts.pop() as string)
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace('Backslash', '\\')
    .replace('Period', '.')
    .replace('Slash', '/')
    .replace('Escape', 'Esc');
  const mac = isMac();
  const map: Record<string, string> = mac
    ? { Mod: '⌘', Alt: '⌥', Shift: '⇧' }
    : { Mod: 'Ctrl+', Alt: 'Alt+', Shift: 'Shift+' };
  return parts.map((p) => map[p] ?? p).join('') + key;
}

export function useShortcuts(shortcuts: readonly Shortcut[]): void {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      for (const s of shortcuts) {
        if (matches(e, s.keys)) {
          e.preventDefault();
          s.run();
          return;
        }
      }
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [shortcuts]);
}
