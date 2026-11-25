import type { LonghandClient, SessionEvent } from '@longhand/client';
import { foldCommits, projectState } from '@longhand/ledger';
import { loadFixture } from '@longhand/ledger/fixtures';
import type { Commit } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from './projectStore';

/** A client serving a fixture's commits, with a controllable live stream. */
function fakeClient(all: readonly Commit[], initial: number) {
  let served = initial;
  let push: ((c: Commit) => void) | null = null;
  const sessions: string[] = [];
  const sessionListeners = new Map<string, (e: SessionEvent) => void>();
  const client = {
    getCommits: async (_pid: string, after: number, limit: number) => ({
      headSeq: served,
      commits: all.slice(after, Math.min(served, after + limit)),
    }),
    subscribeProject: (_pid: string, listener: (c: Commit) => void) => {
      push = listener;
      return { close: () => (push = null), closed: false };
    },
    subscribeSession: (_pid: string, sid: string, listener: (e: SessionEvent) => void) => {
      sessions.push(sid);
      sessionListeners.set(sid, listener);
      return { close: () => undefined, closed: false };
    },
  } as unknown as LonghandClient;
  return {
    client,
    sessions,
    sessionListeners,
    deliver: (c: Commit) => {
      served = Math.max(served, c.seq);
      push?.(c);
    },
    serve: (n: number) => (served = n),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('ProjectStore', () => {
  const fixture = loadFixture('feedback-session');
  const commits = fixture.commits as Commit[];

  it('loads, folds through one Replay, and follows the live stream in order', async () => {
    const half = Math.floor(commits.length / 2);
    const f = fakeClient(commits, half);
    const store = new ProjectStore(f.client, fixture.commits[0]!.projectId);
    await store.start();
    let snap = store.getSnapshot();
    expect(snap.status).toBe('ready');
    expect(snap.headSeq).toBe(half);
    expect(snap.state).toEqual(projectState(foldCommits(commits.slice(0, half))));

    // In order, then a gap: the store fetches what it missed.
    f.deliver(commits[half]!);
    f.serve(half + 3);
    f.deliver(commits[half + 2]!);
    await tick();
    snap = store.getSnapshot();
    expect(snap.headSeq).toBe(half + 3);
    expect(snap.commits.map((c) => c.seq)).toEqual(commits.slice(0, half + 3).map((c) => c.seq));
    // Duplicates are ignored.
    f.deliver(commits[half]!);
    await tick();
    expect(store.getSnapshot().headSeq).toBe(half + 3);
    // The shared replay serves earlier states for the scrubber.
    expect(projectState(snap.replay.stateAt(half))).toEqual(
      projectState(foldCommits(commits.slice(0, half))),
    );
    for (const c of commits.slice(half + 3)) f.deliver(c);
    await tick();
    expect(store.getSnapshot().state).toEqual(fixture.expected.state);
    expect(store.has(commits[0]!.commitId)).toBe(true);
    store.dispose();
  });

  it('relays progress for agent sessions that start while it is open', async () => {
    const started = commits.findIndex((c) => c.type === 'FeedbackSessionStarted');
    const f = fakeClient(commits, started);
    const store = new ProjectStore(f.client, commits[0]!.projectId);
    const seen: SessionEvent[] = [];
    store.onProgress((e) => seen.push(e));
    await store.start();
    f.deliver(commits[started]!);
    await tick();
    const sid = (commits[started]!.payload as { feedbackSessionId: string }).feedbackSessionId;
    expect(f.sessions).toEqual([sid]);
    const event = { kind: 'started', feedbackSessionId: sid } as unknown as SessionEvent;
    f.sessionListeners.get(sid)!(event);
    expect(seen).toEqual([event]);
    store.dispose();
  });
});
