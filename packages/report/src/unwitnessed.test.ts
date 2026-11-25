import { loadFixture } from '@longhand/ledger/fixtures';
import type { Commit } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { computeReport } from './compute';
import { OfflineBuilder } from './test-helpers';
import { UNWITNESSED_LAG_MS, unwitnessedIntervals } from './unwitnessed';

/** A ledger with two offline stretches: one queued typing burst, then a second one later. */
function offlineLedger() {
  const b = new OfflineBuilder({ start: '2026-11-03T08:00:00.000Z' });
  b.createDocument('doc-o', 'Offline');
  b.type('doc-o', 'Online at first. ');
  b.wait(60_000);
  // The train enters a tunnel: ten minutes offline.
  b.goOffline('2026-11-03T08:15:00.000Z');
  b.type('doc-o', 'Written in the tunnel, queued in the browser until the connection came back. ');
  b.type('doc-o', 'A second batch, still offline. ');
  b.goOnline();
  b.type('doc-o', 'Back online. ');
  b.wait(5 * 60_000);
  b.goOffline('2026-11-03T09:00:00.000Z');
  b.type('doc-o', 'Offline again. ');
  b.goOnline();
  b.type('doc-o', 'The end.');
  return b;
}

const lag = (c: Commit) =>
  Date.parse(c.serverTime) -
  Date.parse(c.clientTime) -
  (c.type === 'TextEdited' ? c.payload.durationMs : 0);

describe('unwitnessed intervals', () => {
  it('finds nothing in an on-time ledger', () => {
    const f = loadFixture('novel');
    expect(unwitnessedIntervals(f.commits, { witnesses: f.witnesses })).toEqual([]);
  });

  it('groups commits queued offline into intervals', () => {
    const b = offlineLedger();
    const intervals = unwitnessedIntervals(b.commits);
    expect(intervals).toHaveLength(2);
    const late = b.commits.filter((c) => c.actor.kind === 'human' && lag(c) > UNWITNESSED_LAG_MS);
    expect(intervals.reduce((n, i) => n + i.commits, 0)).toBe(late.length);
    const [first, second] = intervals;
    expect(first!.reason).toBe('queued-offline');
    expect(first!.serverTime.startsWith('2026-11-03T08:15:00')).toBe(true);
    expect(first!.firstClientTime < first!.lastClientTime).toBe(true);
    expect(first!.lastClientTime < first!.serverTime).toBe(true);
    expect(first!.maxLagMs).toBeGreaterThan(UNWITNESSED_LAG_MS);
    expect(second!.serverTime.startsWith('2026-11-03T09:00:00')).toBe(true);
    expect(second!.fromSeq).toBeGreaterThan(first!.toSeq);
  });

  it('shows them in the report and the disclosure', () => {
    const b = offlineLedger();
    const r = computeReport(b.commits, { scope: 'project' });
    expect(r.unwitnessed).toHaveLength(2);
    expect(r.extensions.unwitnessedThresholdMs).toBe(60_000);
    expect(r.disclosure).toMatch(
      /2 intervals of writing \(\d+ commits\) reached the server late after being queued offline, so their timing rests on the device's clock\./,
    );
    const doc = computeReport(b.commits, { scope: { documentId: 'doc-o' } });
    expect(doc.unwitnessed).toEqual(r.unwitnessed);
  });

  it('reports commits that have no witness', () => {
    const f = loadFixture('plain-typing');
    const witnesses = f.witnesses.filter((w) => w.seq !== 4 && w.seq !== 5);
    const intervals = unwitnessedIntervals(f.commits, { witnesses });
    expect(intervals).toEqual([
      expect.objectContaining({ fromSeq: 4, toSeq: 5, reason: 'not-witnessed', commits: 2 }),
    ]);
    const r = computeReport(f.commits, { scope: 'project', witnesses });
    expect(r.disclosure).toContain('2 commits have no server witness.');
    // A witness for another hash does not count.
    const forged = f.witnesses.map((w) => (w.seq === 2 ? { ...w, hash: '0'.repeat(64) } : w));
    expect(unwitnessedIntervals(f.commits, { witnesses: forged })).toEqual([
      expect.objectContaining({ fromSeq: 2, toSeq: 2, reason: 'not-witnessed' }),
    ]);
  });

  it('does not count a slow-but-online commit', () => {
    const b = new OfflineBuilder({ start: '2026-11-03T08:00:00.000Z' });
    b.createDocument('doc-o', 'Offline');
    // 50 s of lag is still on time.
    b.goOffline(new Date(Date.parse(b.now()) + 50_000).toISOString());
    b.type('doc-o', 'Slow network.', { cadence: [10, 10] });
    b.goOnline();
    expect(unwitnessedIntervals(b.commits)).toEqual([]);
  });
});
