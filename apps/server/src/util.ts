/** Small shared helpers. */

/** A FIFO async mutex: `run` executes callbacks one at a time, in call order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(fn, fn);
    // Keep the chain alive whatever the outcome.
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Message of an unknown error. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolves after `ms`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Thrown when an invariant that must never break breaks. Never caught as a 4xx. */
export class InvariantViolation extends Error {
  constructor(message: string) {
    super(`INVARIANT VIOLATION: ${message}`);
    this.name = 'InvariantViolation';
  }
}

/** An error with an HTTP status and a stable code, rendered as `{ok:false, error:{code, message}}`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
