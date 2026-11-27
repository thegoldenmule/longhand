import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TitleField } from './TitleField';

afterEach(cleanup);

function setup(value = 'Essay') {
  const onCommit = vi.fn<(t: string) => void>();
  const onDone = vi.fn<() => void>();
  const view = render(
    <TitleField value={value} label="Title" onCommit={onCommit} onDone={onDone} />,
  );
  const input = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement;
  return { onCommit, onDone, input, view };
}

describe('TitleField', () => {
  it('commits on Enter and hands the caret back', () => {
    const { onCommit, onDone, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'The Storm' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('The Storm');
    expect(onDone).toHaveBeenCalledOnce();
    // The blur that follows commits nothing more.
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('commits on blur', () => {
    const { onCommit, onDone, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '  The Storm ' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('The Storm');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reverts on Escape without committing', () => {
    const { onCommit, onDone, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Something else' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('Essay');
    expect(onDone).toHaveBeenCalledOnce();
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits a blank title as Untitled', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Untitled');
  });

  it('commits nothing when the title is unchanged', () => {
    const { onCommit, onDone, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: ' Essay ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('selects all of Untitled on focus, and nothing else', () => {
    const untitled = setup('Untitled');
    fireEvent.focus(untitled.input);
    expect([untitled.input.selectionStart, untitled.input.selectionEnd]).toEqual([0, 8]);
    expect(untitled.input.className).toContain('is-untitled');
    cleanup();
    const named = setup('Essay');
    named.input.setSelectionRange(5, 5);
    fireEvent.focus(named.input);
    expect([named.input.selectionStart, named.input.selectionEnd]).toEqual([5, 5]);
    expect(named.input.className).not.toContain('is-untitled');
  });

  it('follows the value when not focused, and keeps the draft while focused', () => {
    const onCommit = vi.fn<(t: string) => void>();
    const { rerender } = render(<TitleField value="Essay" label="Title" onCommit={onCommit} />);
    const input = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement;
    rerender(<TitleField value="The Storm" label="Title" onCommit={onCommit} />);
    expect(input.value).toBe('The Storm');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Typing' } });
    rerender(<TitleField value="Elsewhere" label="Title" onCommit={onCommit} />);
    expect(input.value).toBe('Typing');
    fireEvent.blur(input);
    rerender(<TitleField value="Typing" label="Title" onCommit={onCommit} />);
    expect(input.value).toBe('Typing');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Typing');
  });
});
