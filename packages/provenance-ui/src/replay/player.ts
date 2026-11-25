/**
 * Playback over replay frames. Wall time advances compressed ledger time at the
 * chosen speed (1× to 64×); the player shows the last frame whose offset has been
 * reached, so bursts of commits skip frames instead of falling behind.
 */
import { frameAtTime } from './timeline';

/** Playback speeds. */
export const REPLAY_SPEEDS = [1, 2, 4, 8, 16, 32, 64] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Time source and timers (injectable for tests). */
export interface PlayerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: PlayerClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ReplayPlayerOptions {
  /** Compressed ledger offsets per frame (`playbackOffsets`). */
  offsets: readonly number[];
  onFrame: (index: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  clock?: PlayerClock;
  speed?: ReplaySpeed;
  /** Shortest wait between ticks (ms of wall time). Default 16. */
  minTickMs?: number;
}

export class ReplayPlayer {
  private offsets: readonly number[];
  private readonly clock: PlayerClock;
  private readonly minTickMs: number;
  private readonly onFrame: (index: number) => void;
  private readonly onPlayingChange: ((playing: boolean) => void) | undefined;
  private timer: unknown = null;
  private baseWall = 0;
  private baseT = 0;
  private index = 0;
  private _speed: ReplaySpeed;
  private _playing = false;

  constructor(opts: ReplayPlayerOptions) {
    this.offsets = opts.offsets;
    this.clock = opts.clock ?? realClock;
    this.minTickMs = opts.minTickMs ?? 16;
    this.onFrame = opts.onFrame;
    this.onPlayingChange = opts.onPlayingChange;
    this._speed = opts.speed ?? 1;
  }

  get playing(): boolean {
    return this._playing;
  }

  get speed(): ReplaySpeed {
    return this._speed;
  }

  /** The frame the player last showed. */
  get current(): number {
    return this.index;
  }

  private get last(): number {
    return this.offsets.length - 1;
  }

  /** Starts playing from `fromIndex` (from the start when that is the last frame). */
  play(fromIndex: number = this.index): void {
    this.stopTimer();
    let i = Math.max(0, Math.min(this.last, fromIndex));
    if (i >= this.last) {
      i = 0;
      this.index = 0;
      this.onFrame(0);
    }
    this.index = i;
    this.baseT = this.offsets[i] ?? 0;
    this.baseWall = this.clock.now();
    this.setPlaying(true);
    this.schedule();
  }

  pause(): void {
    this.stopTimer();
    this.setPlaying(false);
  }

  /** Moves to a frame without playing (pauses when playing). */
  seek(index: number): void {
    const wasPlaying = this._playing;
    this.index = Math.max(0, Math.min(this.last, index));
    if (wasPlaying) this.pause();
  }

  setSpeed(speed: ReplaySpeed): void {
    if (speed === this._speed) return;
    if (this._playing) {
      // Keep the current ledger time; continue at the new rate.
      this.baseT = this.ledgerTime();
      this.baseWall = this.clock.now();
      this._speed = speed;
      this.stopTimer();
      this.schedule();
    } else this._speed = speed;
  }

  /** Replaces the offsets (scope or document changed). Pauses. */
  setOffsets(offsets: readonly number[]): void {
    this.pause();
    this.offsets = offsets;
    this.index = Math.min(this.index, this.last);
  }

  dispose(): void {
    this.stopTimer();
    this._playing = false;
  }

  private ledgerTime(): number {
    return this.baseT + (this.clock.now() - this.baseWall) * this._speed;
  }

  private schedule(): void {
    const next = this.offsets[this.index + 1];
    if (next === undefined) {
      this.pause();
      return;
    }
    const wait = Math.max(this.minTickMs, (next - this.ledgerTime()) / this._speed);
    this.timer = this.clock.setTimeout(() => this.tick(), wait);
  }

  private tick(): void {
    this.timer = null;
    if (!this._playing) return;
    const i = Math.max(this.index, frameAtTime(this.offsets, this.ledgerTime()));
    if (i !== this.index) {
      this.index = i;
      this.onFrame(i);
    }
    if (i >= this.last) {
      this.pause();
      return;
    }
    this.schedule();
  }

  private stopTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private setPlaying(p: boolean): void {
    if (p === this._playing) return;
    this._playing = p;
    this.onPlayingChange?.(p);
  }
}
