/**
 * Unwitnessed intervals (spec "Dropped connections").
 *
 * When the connection drops, the editor keeps working and queues commits in
 * IndexedDB with their client time; the server witnesses them only when they
 * arrive. For that stretch, the record's timing rests on the device's clock, not
 * on the server's, and the report says so plainly.
 *
 * A human commit counts as **queued offline** when it reached the server more
 * than {@link UNWITNESSED_LAG_MS} after the writer finished it:
 *
 *     lag = serverTime − (clientTime + durationMs)      (durationMs: TextEdited only)
 *
 * Why 60 seconds: an online editor flushes a batch about 2 s after the last
 * keystroke and the service appends it within a second or two, so a healthy
 * commit lags by a few seconds. Retries on a flaky network stay well under a
 * minute. A full minute of queued writing is a paragraph or more, which is worth
 * telling a reader about. A device clock that runs more than a minute *slow*
 * makes every commit look late; that errs toward under-claiming, which is the
 * direction the report is allowed to err in. A clock that runs fast hides lag,
 * which is why the report also prints the threshold.
 *
 * Only human commits are checked: they are the ones a browser queues. Agent and
 * system commits are created by the server itself.
 *
 * Queued commits group into one interval while no on-time human commit comes
 * between them and each was written before the interval's first commit reached
 * the server (it was in the same queue). Agent and system commits in between
 * (such as `SuggestionResolved`) do not break an interval.
 *
 * When witnesses are given, a run of consecutive commits with no matching
 * witness (same `seq` and `hash`) is also reported, as `not-witnessed`. This only
 * looks at which witnesses exist; the verifier checks their signatures.
 */
import type { Commit, Witness } from '@longhand/schema';

/** A human commit that reaches the server more than this long after it was written was queued offline. */
export const UNWITNESSED_LAG_MS = 60_000;

/** Why an interval is unwitnessed. */
export type UnwitnessedReason = 'queued-offline' | 'not-witnessed';

/** One unwitnessed interval, as it appears in `report.unwitnessed`. */
export interface UnwitnessedInterval {
  /** Seq of the first commit in the interval. */
  fromSeq: number;
  /** Seq of the last commit in the interval. */
  toSeq: number;
  /** Earliest client time among the interval's commits. */
  firstClientTime: string;
  /** Latest client time among the interval's commits. */
  lastClientTime: string;
  /** Server time of the interval's first commit: when the server first saw it. */
  serverTime: string;
  reason: UnwitnessedReason;
  /** Number of commits flagged in the interval (agent/system commits in between are not counted). */
  commits: number;
  /** Largest lag (see module docs) of a flagged commit, in ms; 0 or less means on time. */
  maxLagMs: number;
}

function lagMs(c: Commit): number {
  const duration = c.type === 'TextEdited' ? c.payload.durationMs : 0;
  return Date.parse(c.serverTime) - (Date.parse(c.clientTime) + duration);
}

interface Open {
  interval: UnwitnessedInterval;
  firstServerMs: number;
}

function extend(iv: UnwitnessedInterval, c: Commit, lag: number): void {
  iv.toSeq = c.seq;
  iv.commits += 1;
  if (c.clientTime < iv.firstClientTime) iv.firstClientTime = c.clientTime;
  if (c.clientTime > iv.lastClientTime) iv.lastClientTime = c.clientTime;
  if (lag > iv.maxLagMs) iv.maxLagMs = lag;
}

function start(c: Commit, reason: UnwitnessedReason, lag: number): UnwitnessedInterval {
  return {
    fromSeq: c.seq,
    toSeq: c.seq,
    firstClientTime: c.clientTime,
    lastClientTime: c.clientTime,
    serverTime: c.serverTime,
    reason,
    commits: 1,
    maxLagMs: lag,
  };
}

/** Human commits queued offline, grouped into intervals (see module docs). */
function queuedIntervals(commits: readonly Commit[], include: (c: Commit) => boolean) {
  const out: UnwitnessedInterval[] = [];
  let open: Open | null = null;
  for (const c of commits) {
    if (c.actor.kind !== 'human' || !include(c)) continue;
    const lag = lagMs(c);
    if (lag <= UNWITNESSED_LAG_MS) {
      open = null; // an on-time commit closes the interval
      continue;
    }
    if (open && Date.parse(c.clientTime) < open.firstServerMs) {
      extend(open.interval, c, lag);
    } else {
      const interval = start(c, 'queued-offline', lag);
      out.push(interval);
      open = { interval, firstServerMs: Date.parse(c.serverTime) };
    }
  }
  return out;
}

/** Runs of consecutive commits with no matching witness. */
function missingWitnessIntervals(commits: readonly Commit[], witnesses: readonly Witness[]) {
  const witnessed = new Set(witnesses.map((w) => `${w.seq}:${w.hash}`));
  const out: UnwitnessedInterval[] = [];
  let open: UnwitnessedInterval | null = null;
  let prevSeq = -1;
  for (const c of commits) {
    const missing = !witnessed.has(`${c.seq}:${c.hash}`);
    if (!missing) {
      open = null;
    } else {
      if (open && c.seq === prevSeq + 1) extend(open, c, lagMs(c));
      else out.push((open = start(c, 'not-witnessed', lagMs(c))));
      prevSeq = c.seq;
    }
  }
  return out;
}

/**
 * The unwitnessed intervals of a ledger, sorted by `fromSeq` (queued intervals
 * before not-witnessed ones at the same seq). `include` limits which human
 * commits are checked for queueing (a document report passes the commits about
 * its document); missing witnesses are always looked for across the whole ledger,
 * since a gap in the witnesses is a fact about the record, not about one document.
 */
export function unwitnessedIntervals(
  commits: readonly Commit[],
  opts: { witnesses?: readonly Witness[]; include?: (c: Commit) => boolean } = {},
): UnwitnessedInterval[] {
  const include = opts.include ?? (() => true);
  const out = queuedIntervals(commits, include);
  if (opts.witnesses) out.push(...missingWitnessIntervals(commits, opts.witnesses));
  const rank = (r: UnwitnessedReason) => (r === 'queued-offline' ? 0 : 1);
  return out.sort((a, b) => a.fromSeq - b.fromSeq || rank(a.reason) - rank(b.reason));
}
