'use client';
import { IconMoon, IconSun } from './icons';
import { useTheme } from './theme';

/** Light ↔ dark (the first click leaves "system"). */
export function ThemeToggle() {
  const [, setPref, resolved] = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="lh-icon-button"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      data-testid="theme-toggle"
      onClick={() => setPref(next)}
    >
      {resolved === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}
