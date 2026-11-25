/**
 * A server-sent events client over `fetch` (browsers and Node). Unlike
 * `EventSource` it can send an `Authorization` header. It reconnects with
 * exponential backoff and jitter, and re-sends the last event id as
 * `Last-Event-ID`; callers that track their own resume point pass `url` as a
 * function so each reconnect asks from the right place.
 */

/** One received event. */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Backoff between reconnects. */
export interface Backoff {
  initialMs: number;
  maxMs: number;
}

/** Options for {@link subscribeSse}. */
export interface SseOptions {
  /** The URL, or a function giving it per (re)connect. */
  url: string | (() => string);
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  onEvent: (e: SseEvent) => void;
  /** Called when a connection is established (the server's `ready` event). */
  onOpen?: () => void;
  /** Called when a connection fails or drops; `willRetry` is false after `close()` or a 4xx. */
  onError?: (error: unknown, info: { willRetry: boolean; status?: number }) => void;
  fetch?: typeof fetch;
  backoff?: Partial<Backoff>;
  /** Stop on these HTTP statuses instead of retrying (default: 400, 401, 403, 404). */
  fatalStatuses?: number[];
}

/** A running subscription. */
export interface SseSubscription {
  close(): void;
  readonly closed: boolean;
}

function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  let id: string | undefined;
  for (const raw of block.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0 && event === 'message') return null;
  return { event, data: data.join('\n'), ...(id !== undefined ? { id } : {}) };
}

/** Subscribes to an SSE endpoint until `close()`. */
export function subscribeSse(opts: SseOptions): SseSubscription {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const backoff: Backoff = { initialMs: 500, maxMs: 30_000, ...opts.backoff };
  const fatal = new Set(opts.fatalStatuses ?? [400, 401, 403, 404]);
  let closed = false;
  let controller: AbortController | null = null;
  let lastEventId: string | undefined;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (closed) return;
    const base = Math.min(backoff.maxMs, backoff.initialMs * 2 ** attempt);
    attempt += 1;
    const delay = base / 2 + Math.random() * (base / 2);
    timer = setTimeout(() => void connect(), delay);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    controller = new AbortController();
    let status: number | undefined;
    try {
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        ...(opts.headers ? await opts.headers() : {}),
        ...(lastEventId !== undefined ? { 'last-event-id': lastEventId } : {}),
      };
      const url = typeof opts.url === 'function' ? opts.url() : opts.url;
      const res = await doFetch(url, { headers, signal: controller.signal, cache: 'no-store' });
      status = res.status;
      if (!res.ok || !res.body) {
        const err = new Error(`SSE ${url}: HTTP ${res.status}`);
        if (fatal.has(res.status)) {
          closed = true;
          opts.onError?.(err, { willRetry: false, status });
          return;
        }
        throw err;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const e = parseBlock(block);
          if (!e) continue;
          if (e.id !== undefined) lastEventId = e.id;
          if (e.event === 'ready') {
            attempt = 0;
            opts.onOpen?.();
            continue;
          }
          if (!closed) opts.onEvent(e);
        }
      }
      if (!closed) {
        opts.onError?.(new Error('SSE stream ended'), { willRetry: true });
        schedule();
      }
    } catch (e) {
      if (closed) return;
      opts.onError?.(e, { willRetry: true, ...(status !== undefined ? { status } : {}) });
      schedule();
    }
  };

  void connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    },
    get closed() {
      return closed;
    },
  };
}
