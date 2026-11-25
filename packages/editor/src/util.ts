/** Small runtime helpers shared by the editor modules. */

/** A new random UUID (fits `IdSchema`). */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

declare const process: { env: Record<string, string | undefined> };

/**
 * True unless the bundler replaced `process.env.NODE_ENV` with `"production"`.
 * Browsers without a `process` global count as development.
 */
export function isProduction(): boolean {
  try {
    return process.env.NODE_ENV === 'production';
  } catch {
    return false;
  }
}

/** `Date#toISOString()` of an epoch-ms time. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A listener set with `emit` and `on`. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch (err) {
        console.error('[longhand/editor] listener failed', err);
      }
    }
  }
  get size(): number {
    return this.listeners.size;
  }
}
