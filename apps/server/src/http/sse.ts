/**
 * Server-sent events with an ordered in-memory queue: `setup` registers its
 * listeners synchronously and pushes into `send`, and the loop writes events in
 * the order they were pushed, with a comment heartbeat every 15 s.
 */
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

/** One outgoing event. */
export interface OutEvent {
  event: string;
  data: unknown;
  id?: string;
}

/** Pushes an event; `end` closes the stream after the queued events. */
export interface Sender {
  send(e: OutEvent): void;
  end(): void;
}

const HEARTBEAT_MS = 15_000;

/** Streams events produced by `setup` until the client goes away or `end` is called. */
export function sse(
  c: Context,
  setup: (out: Sender) => () => void,
  opts: { retryMs?: number } = {},
): Response {
  return streamSSE(c, async (stream) => {
    const queue: OutEvent[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const poke = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const teardown = setup({
      send: (e) => {
        queue.push(e);
        poke();
      },
      end: () => {
        ended = true;
        poke();
      },
    });
    stream.onAbort(() => {
      ended = true;
      poke();
    });
    try {
      await stream.writeSSE({ event: 'ready', data: '{}', retry: opts.retryMs ?? 1000 });
      while (!stream.aborted) {
        while (queue.length > 0 && !stream.aborted) {
          const e = queue.shift() as OutEvent;
          await stream.writeSSE({
            event: e.event,
            data: JSON.stringify(e.data),
            ...(e.id ? { id: e.id } : {}),
          });
        }
        if (ended) break;
        let timer: NodeJS.Timeout | null = null;
        const heartbeat = await new Promise<boolean>((resolve) => {
          wake = () => resolve(false);
          timer = setTimeout(() => resolve(true), HEARTBEAT_MS);
        });
        if (timer) clearTimeout(timer);
        if (heartbeat && !stream.aborted) await stream.write(': heartbeat\n\n');
      }
    } finally {
      teardown();
    }
  });
}
