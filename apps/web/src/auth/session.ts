/**
 * The signed-in session. `AUTH_MODE=dev`: the ledger service signs in a fixed
 * dev user, so there is no token. `AUTH_MODE=cognito`: Hosted UI with code +
 * PKCE; tokens live in localStorage and are refreshed a minute before expiry.
 */
import { runtimeConfig, type CognitoConfig } from '../config';
import {
  authorizeUrl,
  codeChallenge,
  codeVerifier,
  exchangeCode,
  jwtClaims,
  logoutUrl,
  randomBytes,
  base64Url,
  refreshTokens,
  type TokenSet,
} from './pkce';

const TOKENS_KEY = 'longhand:auth:tokens';
const PENDING_KEY = 'longhand:auth:pending';
const SKEW_MS = 60_000;

function read<T>(storage: Storage | undefined, key: string): T | null {
  try {
    const v = storage?.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function write(storage: Storage | undefined, key: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode); the session then lasts one page.
  }
}

function cognito(): CognitoConfig {
  const c = runtimeConfig().cognito;
  if (!c) throw new Error('AUTH_MODE=cognito needs COGNITO_DOMAIN and COGNITO_CLIENT_ID');
  return c;
}

/** Starts the Hosted UI sign-in; `returnTo` is restored after the callback. */
export async function signIn(returnTo = location.pathname + location.search): Promise<void> {
  const cfg = cognito();
  const verifier = codeVerifier();
  const state = base64Url(randomBytes(24));
  write(sessionStorage, PENDING_KEY, { verifier, state, returnTo });
  location.assign(authorizeUrl(cfg, { challenge: await codeChallenge(verifier), state }));
}

/** Completes sign-in on `/auth/callback`; returns where to go next. */
export async function completeSignIn(search: string): Promise<string> {
  const cfg = cognito();
  const q = new URLSearchParams(search);
  const err = q.get('error_description') ?? q.get('error');
  if (err) throw new Error(err);
  const pending = read<{ verifier: string; state: string; returnTo: string }>(
    sessionStorage,
    PENDING_KEY,
  );
  write(sessionStorage, PENDING_KEY, null);
  const code = q.get('code');
  if (!pending || !code || q.get('state') !== pending.state) {
    throw new Error('This sign-in link is stale. Please sign in again.');
  }
  const tokens = await exchangeCode(cfg, code, pending.verifier);
  write(localStorage, TOKENS_KEY, tokens);
  return pending.returnTo.startsWith('/') ? pending.returnTo : '/';
}

let refreshing: Promise<TokenSet | null> | null = null;

/**
 * The bearer token for the ledger service: null in dev mode. In Cognito mode a
 * missing or unrefreshable session starts the sign-in redirect.
 */
export async function bearerToken(): Promise<string | null> {
  const cfg = runtimeConfig();
  if (cfg.authMode !== 'cognito' || !cfg.cognito) return null;
  let tokens = read<TokenSet>(localStorage, TOKENS_KEY);
  if (tokens && tokens.expiresAt - SKEW_MS < Date.now()) {
    const refresh = tokens.refreshToken;
    refreshing ??= (
      refresh ? refreshTokens(cfg.cognito, refresh).catch(() => null) : Promise.resolve(null)
    ).finally(() => {
      refreshing = null;
    });
    tokens = await refreshing;
    write(localStorage, TOKENS_KEY, tokens);
  }
  if (!tokens) {
    await signIn();
    return null;
  }
  return cfg.cognito.tokenUse === 'id' ? tokens.idToken : tokens.accessToken;
}

/** Who is signed in, for display. */
export function currentUser(): { name: string; email: string | null } | null {
  const cfg = runtimeConfig();
  if (cfg.authMode !== 'cognito') return { name: 'Dev writer', email: null };
  const tokens = read<TokenSet>(localStorage, TOKENS_KEY);
  if (!tokens) return null;
  const c = jwtClaims(tokens.idToken);
  const email = typeof c.email === 'string' ? c.email : null;
  const name =
    (typeof c.name === 'string' && c.name) ||
    email ||
    (typeof c['cognito:username'] === 'string' ? c['cognito:username'] : 'Writer');
  return { name, email };
}

/** True when a session exists (always in dev mode). */
export function isSignedIn(): boolean {
  const cfg = runtimeConfig();
  if (cfg.authMode !== 'cognito') return true;
  return read<TokenSet>(localStorage, TOKENS_KEY) !== null;
}

/** Signs out (Cognito: clears tokens and ends the Hosted UI session). */
export function signOut(): void {
  write(localStorage, TOKENS_KEY, null);
  const cfg = runtimeConfig();
  if (cfg.authMode === 'cognito' && cfg.cognito) location.assign(logoutUrl(cfg.cognito));
  else location.assign('/');
}

/** Called when the service answers 401: drop the tokens and sign in again. */
export function onAuthError(): void {
  const cfg = runtimeConfig();
  if (cfg.authMode !== 'cognito') return;
  write(localStorage, TOKENS_KEY, null);
  void signIn();
}
