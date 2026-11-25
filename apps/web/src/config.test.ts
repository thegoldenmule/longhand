import { describe, expect, it } from 'vitest';
import { configFromEnv } from './config';

describe('configFromEnv', () => {
  it('defaults to dev auth and the local ledger service', () => {
    expect(configFromEnv({})).toEqual({
      ledgerUrl: 'http://localhost:3200',
      authMode: 'dev',
      cognito: null,
    });
  });

  it('reads Cognito settings and derives the redirect URIs from WEB_ORIGIN', () => {
    const c = configFromEnv({
      AUTH_MODE: 'cognito',
      LEDGER_PUBLIC_URL: 'https://ledger.example/',
      WEB_ORIGIN: 'https://write.example',
      COGNITO_DOMAIN: 'https://auth.example/',
      COGNITO_CLIENT_ID: 'abc',
      COGNITO_TOKEN_USE: 'id',
    });
    expect(c).toEqual({
      ledgerUrl: 'https://ledger.example',
      authMode: 'cognito',
      cognito: {
        domain: 'auth.example',
        clientId: 'abc',
        redirectUri: 'https://write.example/auth/callback',
        logoutUri: 'https://write.example/',
        scopes: 'openid email profile',
        tokenUse: 'id',
      },
    });
  });
});
