import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusLine } from './StatusLine';

afterEach(cleanup);

const base = { counts: null, save: null, queued: 0, live: true } as const;

describe('StatusLine typewriter switch', () => {
  it('shows the current setting and flips it', () => {
    const onTypewriter = vi.fn<(on: boolean) => void>();
    const { rerender } = render(
      <StatusLine {...base} typewriter={false} onTypewriter={onTypewriter} />,
    );
    const sw = screen.getByRole('switch', { name: 'Typewriter' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onTypewriter).toHaveBeenCalledExactlyOnceWith(true);

    rerender(<StatusLine {...base} typewriter onTypewriter={onTypewriter} />);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(onTypewriter).toHaveBeenLastCalledWith(false);
  });

  it('is hidden outside the writing view', () => {
    render(<StatusLine {...base} typewriter={null} onTypewriter={() => {}} />);
    expect(screen.queryByRole('switch', { name: 'Typewriter' })).toBeNull();
  });
});
