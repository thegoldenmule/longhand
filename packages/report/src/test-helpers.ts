/**
 * Test helpers (Node only): prettier-formatted JSON for committed snapshots, and
 * a ledger builder that can go offline.
 */
import { LedgerBuilder } from '@longhand/ledger';
import type { CommitDraft, Commit } from '@longhand/schema';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

/** JSON formatted the way the repo's prettier formats `.json` files, so snapshots pass `format:check`. */
export async function prettyJson(value: unknown, file: string): Promise<string> {
  const path = fileURLToPath(new URL(file, import.meta.url));
  const config = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(JSON.stringify(value), { ...config, filepath: path });
}

/**
 * A `LedgerBuilder` whose browser can lose its connection. While offline, human
 * commits queue and reach the server at `reconnectAt` (like the editor's
 * IndexedDB queue); agent and system commits are unaffected.
 */
export class OfflineBuilder extends LedgerBuilder {
  private reconnectAt: number | undefined;

  /** Everything the writer does until `reconnectAt` (ISO) is queued. */
  goOffline(reconnectAt: string): this {
    this.reconnectAt = Date.parse(reconnectAt);
    return this;
  }

  /** Back online; the clock moves past the reconnect time. */
  goOnline(): this {
    if (this.reconnectAt !== undefined) {
      const ahead = this.reconnectAt - Date.parse(this.now());
      if (ahead > 0) this.wait(ahead + 1000);
    }
    this.reconnectAt = undefined;
    return this;
  }

  override append(draft: CommitDraft, serverDelayMs = 250): Commit {
    // Called from the base constructor too, before this class's fields exist.
    const at = this.reconnectAt;
    if (typeof at === 'number' && draft.actor.kind === 'human') {
      return super.append(draft, Math.max(serverDelayMs, at - Date.parse(draft.clientTime)));
    }
    return super.append(draft, serverDelayMs);
  }
}
