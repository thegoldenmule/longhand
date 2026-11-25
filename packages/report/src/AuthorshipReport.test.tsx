// @vitest-environment jsdom
import { FIXTURE_NAMES, type FixtureFile } from '@longhand/ledger/fixtures';
import { PROVES_TABLE } from '@longhand/schema';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorshipReport } from './AuthorshipReport';
import { computeReport } from './compute';
import { OfflineBuilder } from './test-helpers';

afterEach(cleanup);

// jsdom replaces `URL`, so the fixture loader's file URLs do not work here: read by path.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../ledger/fixtures');
const loadFixture = (name: string): FixtureFile =>
  JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')) as FixtureFile;
const reportOf = (name: string) => computeReport(loadFixture(name).commits, { scope: 'project' });

describe('<AuthorshipReport>', () => {
  it.each(FIXTURE_NAMES)('renders the %s report', (name) => {
    const report = reportOf(name);
    const { container } = render(<AuthorshipReport report={report} />);
    expect(container.querySelector('.lh-report-disclosure-text')!.textContent).toBe(
      report.disclosure,
    );
    // The proves table is printed verbatim.
    const cells = [...container.querySelectorAll('.lh-report-proves tbody td')].map(
      (td) => td.textContent,
    );
    for (const line of [...PROVES_TABLE.proves, ...PROVES_TABLE.doesNotProve])
      expect(cells).toContain(line);
  });

  it('shows words by origin with the disclosure’s shares', () => {
    const report = reportOf('suggestions');
    render(<AuthorshipReport report={report} />);
    const bar = screen.getByRole('img', { name: /Words by origin/ });
    expect(bar.getAttribute('aria-label')).toContain('Typed 73.1%');
    expect(bar.getAttribute('aria-label')).toContain('Typed from a suggestion 26.9%');
    expect(screen.getByRole('heading', { name: 'AI activity' })).toBeTruthy();
    expect(screen.getByText('Wording suggestions by outcome')).toBeTruthy();
  });

  it('lists AI sessions with model and prompt version', () => {
    render(<AuthorshipReport report={reportOf('feedback-session')} />);
    expect(screen.getByRole('table', { name: 'AI sessions' })).toBeTruthy();
    expect(screen.getAllByText('opus').length).toBeGreaterThan(0);
  });

  it('copies the disclosure statement', async () => {
    const report = reportOf('novel');
    const copyText = vi.fn(() => Promise.resolve());
    render(<AuthorshipReport report={report} copyText={copyText} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(copyText).toHaveBeenCalledWith(report.disclosure);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says so when copying fails', async () => {
    const copyText = vi.fn(() => Promise.reject(new Error('denied')));
    render(<AuthorshipReport report={reportOf('novel')} copyText={copyText} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(screen.getByText(/Could not copy/)).toBeTruthy();
  });

  it('shows unwitnessed intervals plainly', () => {
    const b = new OfflineBuilder();
    b.createDocument('d', 'Draft');
    b.goOffline(new Date(Date.parse(b.now()) + 600_000).toISOString());
    b.type('d', 'Queued while offline.');
    b.goOnline();
    const { container } = render(
      <AuthorshipReport report={computeReport(b.commits, { scope: 'project' })} />,
    );
    const rows = container.querySelectorAll('.lh-report-unwitnessed tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Queued offline');
  });

  it('says there are none when everything was on time', () => {
    render(<AuthorshipReport report={reportOf('plain-typing')} />);
    expect(screen.getByText(/reached the server within 1 minute of being written/)).toBeTruthy();
  });
});
