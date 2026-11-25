'use client';
/** Project settings (what the editor reads) and this device's writing preferences. */
import { ProjectSettingsForm, type BinderDraft } from '@longhand/binder';
import type { EditorSettings } from '@longhand/editor';
import { STYLES } from '@longhand/research';
import type { ProjectSettings } from '@longhand/schema';
import { useTheme, type ThemePref } from '../ui/theme';

export function SettingsPane(props: {
  editorsHref: string;
  settings: ProjectSettings;
  onDraft: (d: BinderDraft) => void;
  prefs: EditorSettings;
  onPrefs: (p: Partial<EditorSettings>) => void;
}) {
  const [theme, setTheme] = useTheme();
  const p = props.prefs;
  return (
    <div className="ws-settings" data-testid="settings-pane">
      <section className="ws-prefs" aria-label="Writing">
        <h3>Writing</h3>
        <label className="ws-pref">
          <input
            type="checkbox"
            checked={p.typewriter}
            onChange={(e) => props.onPrefs({ typewriter: e.target.checked })}
          />
          Typewriter scrolling
        </label>
        <label className="ws-pref ws-pref-range">
          <span>Caret line</span>
          <input
            type="range"
            min={33}
            max={60}
            step={1}
            value={Math.round(p.caretRatio * 100)}
            disabled={!p.typewriter}
            onChange={(e) => props.onPrefs({ caretRatio: Number(e.target.value) / 100 })}
          />
          <span className="ws-muted">{Math.round(p.caretRatio * 100)}%</span>
        </label>
        <label className="ws-pref ws-pref-range">
          <span>Focus</span>
          <select
            value={p.focusMode}
            onChange={(e) =>
              props.onPrefs({ focusMode: e.target.value as EditorSettings['focusMode'] })
            }
          >
            <option value="off">Off</option>
            <option value="sentence">Sentence</option>
            <option value="paragraph">Paragraph</option>
          </select>
        </label>
        <label className="ws-pref ws-pref-range">
          <span>Theme</span>
          <select value={theme} onChange={(e) => setTheme(e.target.value as ThemePref)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>
      <section className="ws-prefs ws-editors-link" aria-label="Editors">
        <h3>Editors</h3>
        <p className="ws-muted">
          Your named editors are shared by every project.{' '}
          <a className="lh-link-quiet" href={props.editorsHref}>
            Manage editors
          </a>
        </p>
      </section>
      <ProjectSettingsForm
        settings={props.settings}
        onDraft={props.onDraft}
        citationStyles={STYLES.map((s) => ({ id: s.id, label: s.label }))}
        heading="Project"
      />
    </div>
  );
}
