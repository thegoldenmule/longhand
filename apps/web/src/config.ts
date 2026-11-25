/**
 * Runtime configuration. The root layout (a server component) reads the
 * environment at request time and inlines it as `window.__LONGHAND__`, so one
 * build runs against any ledger service and auth setup.
 */

/** Cognito Hosted UI settings (`AUTH_MODE=cognito`). */
export interface CognitoConfig {
  /** Hosted UI domain, e.g. `longhand.auth.eu-west-1.amazoncognito.com` (no scheme). */
  domain: string;
  /** App client id (a public client: no secret, PKCE). */
  clientId: string;
  /** Where Cognito sends the code back: `<origin>/auth/callback`. */
  redirectUri: string;
  /** Where Cognito sends the browser after sign-out: `<origin>/`. */
  logoutUri: string;
  /** OAuth scopes, space separated. */
  scopes: string;
  /** Which token the ledger service verifies: `access` (default) or `id`. */
  tokenUse: 'access' | 'id';
}

/** What the browser needs to know. */
export interface RuntimeConfig {
  /** Ledger service origin, e.g. `http://localhost:3200`. */
  ledgerUrl: string;
  authMode: 'dev' | 'cognito';
  cognito: CognitoConfig | null;
}

declare global {
  interface Window {
    __LONGHAND__?: RuntimeConfig;
  }
}

/** Builds the runtime config from an environment (server side). */
export function configFromEnv(env: Record<string, string | undefined>): RuntimeConfig {
  const authMode = env.AUTH_MODE === 'cognito' ? 'cognito' : 'dev';
  const webOrigin = (env.WEB_ORIGIN || `http://localhost:${env.WEB_PORT || 3100}`).replace(
    /\/+$/,
    '',
  );
  const cognito: CognitoConfig | null =
    authMode === 'cognito'
      ? {
          domain: (env.COGNITO_DOMAIN ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
          clientId: env.COGNITO_CLIENT_ID ?? '',
          redirectUri: env.COGNITO_REDIRECT_URI || `${webOrigin}/auth/callback`,
          logoutUri: env.COGNITO_LOGOUT_URI || `${webOrigin}/`,
          scopes: env.COGNITO_SCOPES || 'openid email profile',
          tokenUse: env.COGNITO_TOKEN_USE === 'id' ? 'id' : 'access',
        }
      : null;
  return {
    ledgerUrl: (env.LEDGER_PUBLIC_URL || env.LEDGER_URL || 'http://localhost:3200').replace(
      /\/+$/,
      '',
    ),
    authMode,
    cognito,
  };
}

/** The runtime config in the browser. */
export function runtimeConfig(): RuntimeConfig {
  if (typeof window !== 'undefined' && window.__LONGHAND__) return window.__LONGHAND__;
  return configFromEnv({});
}
