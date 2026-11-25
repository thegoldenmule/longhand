/** Light / dark / system, kept in localStorage and on `<html data-theme>`. */
import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'longhand:theme';

function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  const dark = pref === 'dark' || (pref === 'system' && systemDark());
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.themePref = pref;
}

export function useTheme(): [ThemePref, (p: ThemePref) => void, 'light' | 'dark'] {
  const [pref, setPref] = useState<ThemePref>(() => {
    if (typeof document === 'undefined') return 'system';
    return (document.documentElement.dataset.themePref as ThemePref | undefined) ?? 'system';
  });
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
      ? 'dark'
      : 'light',
  );
  useEffect(() => {
    applyTheme(pref);
    setResolved(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    if (pref !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => {
      applyTheme('system');
      setResolved(mq.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [pref]);
  return [
    pref,
    (p) => {
      try {
        localStorage.setItem(KEY, p);
      } catch {
        // per-page only
      }
      setPref(p);
    },
    resolved,
  ];
}
