import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CognitoConfig } from '../config';
import {
  authorizeUrl,
  base64Url,
  codeChallenge,
  codeVerifier,
  exchangeCode,
  jwtClaims,
  logoutUrl,
  refreshTokens,
} from './pkce';

const cfg: CognitoConfig = {
  domain: 'longhand.auth.eu-west-1.amazoncognito.com',
  clientId: 'client-123',
  redirectUri: 'https://app.example/auth/callback',
  logoutUri: 'https://app.example/',
  scopes: 'openid email profile',
  tokenUse: 'access',
};

describe('PKCE', () => {
  it('makes RFC 7636 verifiers and S256 challenges', async () => {
    const v = codeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const expected = createHash('sha256').update(v).digest('base64url');
    expect(await codeChallenge(v)).toBe(expected);
    // RFC 7636 appendix B.
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(base64Url(new Uint8Array([251, 255, 191]))).toBe('-_-_');
  });

  it('builds the Hosted UI authorize and logout URLs', () => {
    const u = new URL(authorizeUrl(cfg, { challenge: 'abc', state: 'st' }));
    expect(u.origin).toBe(`https://${cfg.domain}`);
    expect(u.pathname).toBe('/oauth2/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-123',
      redirect_uri: cfg.redirectUri,
      scope: 'openid email profile',
      state: 'st',
      code_challenge_method: 'S256',
      code_challenge: 'abc',
    });
    const out = new URL(logoutUrl(cfg));
    expect(out.pathname).toBe('/logout');
    expect(out.searchParams.get('logout_uri')).toBe('https://app.example/');
  });

  it('exchanges the code with the verifier and keeps the refresh token on refresh', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      return new Response(
        JSON.stringify({
          access_token: `a-${body.get('grant_type')}`,
          id_token: 'id',
          ...(body.get('grant_type') === 'authorization_code' ? { refresh_token: 'r1' } : {}),
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200 },
      );
    });
    const t = await exchangeCode(cfg, 'the-code', 'the-verifier', fetchImpl, () => 1000);
    expect(t).toEqual({
      accessToken: 'a-authorization_code',
      idToken: 'id',
      refreshToken: 'r1',
      expiresAt: 1000 + 3_600_000,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://${cfg.domain}/oauth2/token`);
    expect(Object.fromEntries(new URLSearchParams(init!.body as string))).toEqual({
      client_id: 'client-123',
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: cfg.redirectUri,
      code_verifier: 'the-verifier',
    });
    const r = await refreshTokens(cfg, 'r1', fetchImpl, () => 5);
    expect(r.refreshToken).toBe('r1');
    expect(r.accessToken).toBe('a-refresh_token');
  });

  it('rejects a failed token exchange', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 400 }));
    await expect(exchangeCode(cfg, 'c', 'v', fetchImpl)).rejects.toThrow(/400/);
  });

  it('reads JWT claims for display', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'w@example.com', name: 'Wén' })).toString(
      'base64url',
    );
    expect(jwtClaims(`x.${payload}.y`)).toEqual({ email: 'w@example.com', name: 'Wén' });
    expect(jwtClaims('garbage')).toEqual({});
  });
});
