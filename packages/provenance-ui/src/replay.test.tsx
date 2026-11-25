import { documentNode, projectState, stateAtSeq } from '@longhand/ledger';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplayScrubber } from './react/ReplayScrubber';
import { provenanceDecorations } from './tint';
import { ReplayPlayer, type PlayerClock } from './replay/player';
import {
  commitEndMs,
  frameAtTime,
  frameIndexForSeq,
  playbackOffsets,
  replayFrames,
  replayMarkers,
} from './replay/timeline';
import { fixture, FIXTURE_NAMES } from './test/helpers';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

/** A manual clock: `advance(ms)` runs due timers in order. */
class FakeClock implements PlayerClock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
  pending(): number {
    return this.timers.length;
  }
}

describe('replay timeline', () => {
  it('frames: every commit for the project, the document’s own commits otherwise', () => {
    const { commits } = fixture('internal-paste');
    expect(replayFrames(commits, { scope: 'project' })).toEqual([0, ...commits.map((c) => c.seq)]);
    const docA = replayFrames(commits, { scope: 'document', documentId: 'doc-a' });
    expect(docA[0]).toBe(0);
    for (const seq of docA.slice(1))
      expect((commits[seq - 1]!.payload as { documentId?: string }).documentId).toBe('doc-a');
    expect(docA.length).toBeLessThan(commits.length);
  });

  it('frameIndexForSeq finds the last frame at or before a seq', () => {
    expect(frameIndexForSeq([0, 3, 7, 9], 0)).toBe(0);
    expect(frameIndexForSeq([0, 3, 7, 9], 6)).toBe(1);
    expect(frameIndexForSeq([0, 3, 7, 9], 7)).toBe(2);
    expect(frameIndexForSeq([0, 3, 7, 9], 100)).toBe(3);
  });

  it('offsets follow real inter-commit time and cap idle gaps', () => {
    const { commits } = fixture('novel');
    const frames = replayFrames(commits, { scope: 'project' });
    const offsets = playbackOffsets(commits, frames, { maxGapMs: 4000 });
    expect(offsets).toHaveLength(frames.length);
    for (let i = 2; i < frames.length; i++) {
      const gap = commitEndMs(commits[frames[i]! - 1]!) - commitEndMs(commits[frames[i - 1]! - 1]!);
      expect(offsets[i]! - offsets[i - 1]!).toBe(Math.min(4000, Math.max(0, gap)));
    }
    // The novel spans two days; capped playback is minutes, not days.
    const raw = commitEndMs(commits.at(-1)!) - commitEndMs(commits[0]!);
    expect(raw).toBeGreaterThan(24 * 3600 * 1000);
    expect(offsets.at(-1)!).toBeLessThan(4000 * frames.length);
  });

  it('frameAtTime picks the last frame reached', () => {
    const offsets = [0, 0, 1000, 1500, 5500];
    expect(frameAtTime(offsets, 0)).toBe(1);
    expect(frameAtTime(offsets, 999)).toBe(1);
    expect(frameAtTime(offsets, 1000)).toBe(2);
    expect(frameAtTime(offsets, 99999)).toBe(4);
  });

  it('markers: AI sessions, writing sessions, pastes and accepted proposals', () => {
    const head = fixture('proposals').fixture.expected.state;
    const markers = replayMarkers(head, { scope: 'project' });
    const ai = markers.filter((m) => m.kind === 'ai-session');
    expect(ai).toHaveLength(Object.keys(head.annotations.agentSessions).length);
    for (const m of ai) {
      const s = head.annotations.agentSessions[m.id]!;
      expect([m.fromSeq, m.toSeq]).toEqual([s.startedSeq, s.endedSeq]);
    }
    const accepted = Object.values(head.annotations.proposals).filter(
      (p) => p.status === 'accepted',
    );
    expect(
      markers
        .filter((m) => m.kind === 'proposal')
        .map((m) => m.fromSeq)
        .sort(),
    ).toEqual(accepted.map((p) => p.resolvedSeq).sort());
    expect(markers.filter((m) => m.kind === 'writing-session')).toHaveLength(
      head.writingSessions.length,
    );

    const pastes = replayMarkers(fixture('internal-paste').fixture.expected.state, {
      scope: 'document',
      documentId: 'doc-a',
    }).filter((m) => m.kind === 'paste');
    expect(pastes.map((m) => m.id).sort()).toEqual(['paste-0005', 'paste-0024']);
  });

  it('AI session markers end at ReviewFinished or the failure', () => {
    const { commits } = fixture('feedback-session');
    const head = fixture('feedback-session').fixture.expected.state;
    for (const m of replayMarkers(head, { scope: 'project' }).filter(
      (x) => x.kind === 'ai-session',
    )) {
      expect(commits[m.fromSeq - 1]!.type).toBe('FeedbackSessionStarted');
      expect(['ReviewFinished', 'FeedbackSessionFailed']).toContain(commits[m.toSeq - 1]!.type);
    }
  });
});

describe('ReplayPlayer', () => {
  it('plays at the chosen speed, compressing real timing', () => {
    const clock = new FakeClock();
    const frames: number[] = [];
    const player = new ReplayPlayer({
      offsets: [0, 1000, 1500, 5500],
      onFrame: (i) => frames.push(i),
      clock,
      speed: 4,
      minTickMs: 1,
    });
    player.play(0);
    clock.advance(249);
    expect(frames).toEqual([]);
    clock.advance(1); // 250 ms × 4 = 1000 ledger ms
    expect(frames).toEqual([1]);
    clock.advance(125); // 1500
    expect(frames).toEqual([1, 2]);
    player.setSpeed(64);
    clock.advance(62); // 4000 / 64 = 62.5
    expect(frames).toEqual([1, 2]);
    clock.advance(1);
    expect(frames).toEqual([1, 2, 3]);
    expect(player.playing).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it('1× plays in real time; pause stops; play at the end restarts', () => {
    const clock = new FakeClock();
    const frames: number[] = [];
    const playing: boolean[] = [];
    const player = new ReplayPlayer({
      offsets: [0, 2000, 2400],
      onFrame: (i) => frames.push(i),
      onPlayingChange: (p) => playing.push(p),
      clock,
      speed: 1,
    });
    player.play(0);
    clock.advance(1999);
    expect(frames).toEqual([]);
    clock.advance(1);
    expect(frames).toEqual([1]);
    player.pause();
    clock.advance(10_000);
    expect(frames).toEqual([1]);
    player.play();
    clock.advance(400);
    expect(frames).toEqual([1, 2]);
    player.play(); // at the end: restarts from the beginning
    expect(frames).toEqual([1, 2, 0]);
    expect(playing).toEqual([true, false, true, false, true]);
    player.dispose();
  });

  it('skips frames that arrive together instead of falling behind', () => {
    const clock = new FakeClock();
    const frames: number[] = [];
    const player = new ReplayPlayer({
      offsets: [0, 1, 2, 3, 4, 2000],
      onFrame: (i) => frames.push(i),
      clock,
      speed: 64,
      minTickMs: 16,
    });
    player.play(0);
    clock.advance(16);
    expect(frames).toEqual([4]);
    clock.advance(16);
    expect(frames).toEqual([4, 5]);
  });
});

describe('<ReplayScrubber>', () => {
  const text = () => screen.getByTestId('replay-doc').textContent;

  for (const name of FIXTURE_NAMES) {
    it(`${name}: scrubbing to seq N renders stateAtSeq text`, () => {
      const { commits, fixture: f } = fixture(name);
      const docs = Object.values(f.expected.state.documents);
      if (docs.length === 0) return;
      const documentId = docs[0]!.id;
      render(<ReplayScrubber commits={commits} documentId={documentId} defaultScope="project" />);
      const slider = screen.getByTestId('replay-slider') as HTMLInputElement;
      expect(slider.max).toBe(String(commits.length));
      // Every seq of the ledger.
      for (let seq = 0; seq <= commits.length; seq++) {
        fireEvent.change(slider, { target: { value: String(seq) } });
        const node = documentNode(stateAtSeq(commits, seq), documentId);
        if (node) expect(text()).toBe(node.textContent);
        else expect(screen.queryByTestId('replay-empty')).not.toBeNull();
        expect(screen.getByTestId('replay').getAttribute('data-seq')).toBe(String(seq));
      }
    });
  }

  it('starts at the head, and steps per document in document scope', () => {
    const { commits, fixture: f } = fixture('novel');
    render(<ReplayScrubber commits={commits} defaultDocumentId="doc-2" />);
    expect(text()).toBe(f.expected.documents['doc-2']!.text.replace(/\n/g, ''));
    const frames = replayFrames(commits, { scope: 'document', documentId: 'doc-2' });
    const slider = screen.getByTestId('replay-slider') as HTMLInputElement;
    expect(slider.max).toBe(String(frames.length - 1));
    fireEvent.change(slider, { target: { value: '2' } });
    expect(screen.getByTestId('replay').getAttribute('data-seq')).toBe(String(frames[2]));
    expect(screen.getByTestId('replay-status').textContent).toMatch(/^Edit 2 of /);
    // Switching documents keeps the seq.
    fireEvent.change(screen.getByTestId('replay-document'), { target: { value: 'doc-1' } });
    expect(Number(screen.getByTestId('replay').getAttribute('data-seq'))).toBeLessThanOrEqual(
      frames[2]!,
    );
    fireEvent.click(screen.getByTestId('replay-scope-project'));
    expect(slider.max).toBe(String(commits.length));
  });

  it('tints the replayed document on request', () => {
    const { commits } = fixture('research');
    render(<ReplayScrubber commits={commits} />);
    const doc = screen.getByTestId('replay-doc');
    expect(doc.querySelector('[data-prov]')).toBeNull();
    fireEvent.click(screen.getByTestId('replay-tint'));
    expect(doc.classList.contains('lh-prov-on')).toBe(true);
    const runs = projectState(stateAtSeq(commits, commits.length)).documents['doc-r']!.provenance;
    // One span per decoration; touching runs that look the same share one.
    expect(doc.querySelectorAll('[data-prov]').length).toBe(provenanceDecorations(runs).length);
    expect(provenanceDecorations(runs).length).toBeLessThan(runs.length);
    expect(doc.querySelectorAll('[data-prov="quoted"]').length).toBeGreaterThan(0);
    // Scrubbing keeps the tint, with the runs of that seq.
    fireEvent.change(screen.getByTestId('replay-slider'), { target: { value: '1' } });
    expect(doc.classList.contains('lh-prov-on')).toBe(true);
  });

  it('draws markers on the timeline', () => {
    const { commits } = fixture('suggestions');
    render(<ReplayScrubber commits={commits} defaultScope="project" />);
    expect(screen.getAllByTestId('marker-ai-session')).toHaveLength(2);
    expect(screen.getAllByTestId('marker-writing-session')).toHaveLength(1);
    // Clicking a marker jumps to it.
    fireEvent.click(screen.getAllByTestId('marker-ai-session')[0]!);
    expect(screen.getByTestId('replay').getAttribute('data-seq')).toBe('7');
    expect(screen.getByTestId('replay-status').textContent).toMatch(/AI review · opus/);
  });

  it('plays back with the chosen speed', () => {
    const clock = new FakeClock();
    const { commits } = fixture('plain-typing');
    render(<ReplayScrubber commits={commits} defaultSeq={0} defaultSpeed={64} clock={clock} />);
    const root = screen.getByTestId('replay');
    expect(root.getAttribute('data-seq')).toBe('0');
    fireEvent.click(screen.getByTestId('replay-play'));
    expect(root.getAttribute('data-playing')).toBe('true');
    act(() => clock.advance(60_000));
    expect(root.getAttribute('data-playing')).toBe('false');
    expect(root.getAttribute('data-seq')).toBe(
      String(replayFrames(commits, { scope: 'document', documentId: 'doc-pages' }).at(-1)),
    );
    // Scrubbing while playing pauses.
    fireEvent.click(screen.getByTestId('replay-play'));
    expect(root.getAttribute('data-seq')).toBe('0');
    fireEvent.change(screen.getByTestId('replay-slider'), { target: { value: '3' } });
    expect(root.getAttribute('data-playing')).toBe('false');
    expect(screen.getByTestId('replay-speed')).toHaveProperty('value', '64');
  });
});
