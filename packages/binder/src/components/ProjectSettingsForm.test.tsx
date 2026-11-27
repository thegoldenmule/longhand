import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '@longhand/schema';
import { ProjectSettingsForm } from './ProjectSettingsForm';
import type { BinderDraft } from '../drafts';

afterEach(cleanup);

const base: ProjectSettings = { title: 'My Novel', ...DEFAULT_PROJECT_SETTINGS };

function setup(initial: ProjectSettings = base, showTitle?: boolean) {
  const spy = vi.fn<(d: BinderDraft) => void>();
  function Harness() {
    const [settings, setSettings] = useState(initial);
    return (
      <ProjectSettingsForm
        settings={settings}
        {...(showTitle === undefined ? {} : { showTitle })}
        onDraft={(d) => {
          spy(d);
          if (d.type === 'ProjectSettingsChanged')
            setSettings((s) => ({ ...s, ...d.payload.patch }));
        }}
      />
    );
  }
  render(<Harness />);
  return { spy, user: userEvent.setup() };
}

describe('ProjectSettingsForm', () => {
  it('renders the context fields with their values', () => {
    setup({ ...base, genre: 'mystery', dailyWordGoal: 750 });
    expect(screen.getByRole('form', { name: 'Project' })).toBeTruthy();
    expect((screen.getByLabelText('Project title') as HTMLInputElement).value).toBe('My Novel');
    expect((screen.getByLabelText('Genre') as HTMLInputElement).value).toBe('mystery');
    expect((screen.getByLabelText('Daily word goal') as HTMLInputElement).value).toBe('750');
    expect(screen.getByLabelText('Style notes').tagName).toBe('TEXTAREA');
    expect((screen.getByLabelText('Citation style') as HTMLSelectElement).value).toBe('apa');
  });

  it('commits a field on blur with a patch of just that field', async () => {
    const { spy, user } = setup();
    await user.type(screen.getByLabelText('Genre'), 'literary fiction');
    expect(spy).not.toHaveBeenCalled();
    await user.tab();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith({
      type: 'ProjectSettingsChanged',
      payload: { patch: { genre: 'literary fiction' } },
    });
  });

  it('commits one-line fields on Enter and multi-line fields on blur', async () => {
    const { spy, user } = setup();
    await user.type(screen.getByLabelText('Audience'), 'Adult readers{Enter}');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'ProjectSettingsChanged',
      payload: { patch: { audience: 'Adult readers' } },
    });
    await user.click(screen.getByLabelText('Style notes'));
    await user.keyboard('Past tense.{Enter}Close third.');
    await user.tab();
    expect(spy).toHaveBeenLastCalledWith({
      type: 'ProjectSettingsChanged',
      payload: { patch: { styleNotes: 'Past tense.\nClose third.' } },
    });
    await user.type(screen.getByLabelText('Goals'), 'Finish a draft');
    await user.tab();
    expect(spy).toHaveBeenLastCalledWith({
      type: 'ProjectSettingsChanged',
      payload: { patch: { goals: 'Finish a draft' } },
    });
  });

  it('sets and clears the daily goal, rejecting bad numbers', async () => {
    const { spy, user } = setup();
    const goal = screen.getByLabelText('Daily word goal');
    await user.type(goal, '12x');
    await user.tab();
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/whole number/);
    expect(goal.getAttribute('aria-invalid')).toBe('true');
    await user.clear(goal);
    await user.type(goal, '500');
    await user.tab();
    expect(spy).toHaveBeenLastCalledWith({
      type: 'ProjectSettingsChanged',
      payload: { patch: { dailyWordGoal: 500 } },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    await user.clear(goal);
    await user.tab();
    expect(spy).toHaveBeenLastCalledWith({
      type: 'ProjectSettingsChanged',
      payload: { patch: { dailyWordGoal: null } },
    });
  });

  it('refuses a blank title and emits nothing for unchanged values', async () => {
    const { spy, user } = setup();
    const title = screen.getByLabelText('Project title');
    await user.clear(title);
    await user.tab();
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/empty/);
    await user.click(title);
    await user.keyboard('{Escape}');
    expect((title as HTMLInputElement).value).toBe('My Novel');
    await user.click(screen.getByLabelText('Genre'));
    await user.tab();
    expect(spy).not.toHaveBeenCalled();
  });

  it('changes the citation style', async () => {
    const { spy, user } = setup();
    await user.selectOptions(screen.getByLabelText('Citation style'), 'MLA');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'ProjectSettingsChanged',
      payload: { patch: { citationStyle: 'modern-language-association' } },
    });
  });

  it('leaves the title out with showTitle false', async () => {
    const { spy, user } = setup(base, false);
    expect(screen.queryByLabelText('Project title')).toBeNull();
    expect(screen.queryByDisplayValue('My Novel')).toBeNull();
    await user.type(screen.getByLabelText('Genre'), 'essay');
    await user.tab();
    expect(spy).toHaveBeenLastCalledWith({
      type: 'ProjectSettingsChanged',
      payload: { patch: { genre: 'essay' } },
    });
  });
});
