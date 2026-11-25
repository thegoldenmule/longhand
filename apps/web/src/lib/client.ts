/** The one `LonghandClient` per page, with the session's bearer token. */
import { LonghandClient } from '@longhand/client';
import { bearerToken } from '../auth/session';
import { runtimeConfig } from '../config';

let client: LonghandClient | null = null;

export function getClient(): LonghandClient {
  client ??= new LonghandClient({
    baseUrl: runtimeConfig().ledgerUrl,
    token: () => bearerToken(),
  });
  return client;
}
