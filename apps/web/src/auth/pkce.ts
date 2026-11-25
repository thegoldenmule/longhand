/**
 * OAuth 2.0 authorization code flow with PKCE (RFC 7636) against the Cognito
 * Hosted UI. Pure helpers plus the token-endpoint calls; storage and redirects
 * live in `session.ts`.
 */
import type { CognitoConfig } from '../config';

/** base64url without padding. */
export function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A random code verifier: 64 random bytes → 86 characters (RFC 7636 allows 43–128). */
export function codeVerifier(random: (n: number) => Uint8Array = randomBytes): string {
  return base64Url(random(64));
}

/** `code_challenge = base64url(SHA-256(verifier))` (method S256). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** The Hosted UI authorize URL. */
export function authorizeUrl(
  cfg: CognitoConfig,
  args: { challenge: string; state: string },
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state: args.state,
    code_challenge_method: 'S256',
    code_challenge: args.challenge,
  });
  return `https://${cfg.domain}/oauth2/authorize?${q.toString()}`;
}

/** The Hosted UI logout URL. */
export function logoutUrl(cfg: CognitoConfig): string {
  const q = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.logoutUri });
  return `https://${cfg.domain}/logout?${q.toString()}`;
}

/** Tokens as kept in the browser. */
export interface TokenSet {
  accessToken: string;
  idToken: string;
  refreshToken: string | null;
  /** ms since the epoch. */
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

async function tokenRequest(
  cfg: CognitoConfig,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  now: () => number,
  previousRefresh: string | null,
): Promise<TokenSet> {
  const res = await fetchImpl(`https://${cfg.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...body }).toString(),
  });
  if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
  const t = (await res.json()) as TokenResponse;
  return {
    accessToken: t.access_token,
    idToken: t.id_token,
    refreshToken: t.refresh_token ?? previousRefresh,
    expiresAt: now() + t.expires_in * 1000,
  };
}

/** Exchanges an authorization code (with its verifier) for tokens. */
export function exchangeCode(
  cfg: CognitoConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<TokenSet> {
  return tokenRequest(
    cfg,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
    },
    fetchImpl,
    now,
    null,
  );
}

/** Refreshes tokens (Cognito keeps the refresh token unless it rotates it). */
export function refreshTokens(
  cfg: CognitoConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<TokenSet> {
  return tokenRequest(
    cfg,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    fetchImpl,
    now,
    refreshToken,
  );
}

/** Claims of a JWT, unverified (display only: the ledger service verifies tokens). */
export function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json))) as Record<string, unknown>;
  } catch {
    return {};
  }
}
