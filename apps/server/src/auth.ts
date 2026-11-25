/**
 * Authentication. Every public route is scoped by the authenticated `accountId`;
 * human drafts must carry the authenticated `actorId` (`validateDraft` checks it).
 *
 * - `AUTH_MODE=dev`: a fixed dev account and user, no external calls.
 * - `AUTH_MODE=cognito`: `Authorization: Bearer <JWT>` (or `?access_token=` for
 *   EventSource, which cannot send headers) verified with `aws-jwt-verify`.
 *   `accountId` is the `custom:accountId` claim when present, else `sub`;
 *   `actorId` is `sub`.
 */
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { HttpError } from './util';

/** The authenticated principal. */
export interface Principal {
  accountId: string;
  /** Human actor id for drafts. */
  actorId: string;
}

/** Authenticates a request from its bearer token (null when absent). */
export interface Authenticator {
  readonly mode: 'dev' | 'cognito';
  authenticate(token: string | null): Promise<Principal>;
}

/** The fixed dev principal. */
export class DevAuthenticator implements Authenticator {
  readonly mode = 'dev' as const;
  constructor(
    private readonly principal: Principal = { accountId: 'dev-account', actorId: 'dev-writer' },
  ) {}
  async authenticate(): Promise<Principal> {
    return this.principal;
  }
}

/** The part of a verifier {@link CognitoAuthenticator} uses (a `CognitoJwtVerifier` satisfies it). */
export interface JwtVerifierLike {
  verify(token: string): Promise<Record<string, unknown>>;
}

/** Cognito JWTs. */
export class CognitoAuthenticator implements Authenticator {
  readonly mode = 'cognito' as const;

  constructor(private readonly verifier: JwtVerifierLike) {}

  /** A verifier for a user pool (`tokenUse` defaults to `access`). */
  static create(opts: { userPoolId: string; clientId: string; tokenUse?: 'id' | 'access' }): {
    auth: CognitoAuthenticator;
    verifier: ReturnType<typeof CognitoJwtVerifier.create>;
  } {
    const verifier = CognitoJwtVerifier.create({
      userPoolId: opts.userPoolId,
      clientId: opts.clientId,
      tokenUse: opts.tokenUse ?? 'access',
    });
    return {
      auth: new CognitoAuthenticator(verifier as unknown as JwtVerifierLike),
      verifier,
    };
  }

  async authenticate(token: string | null): Promise<Principal> {
    if (!token) throw new HttpError(401, 'unauthorized', 'Sign in first (missing bearer token).');
    let payload: Record<string, unknown>;
    try {
      payload = await this.verifier.verify(token);
    } catch (e) {
      throw new HttpError(401, 'unauthorized', `Invalid token: ${(e as Error).message}`);
    }
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new HttpError(401, 'unauthorized', 'The token has no subject.');
    }
    const custom = payload['custom:accountId'];
    return { accountId: typeof custom === 'string' && custom ? custom : sub, actorId: sub };
  }
}

/** Extracts a bearer token from an Authorization header value or a query parameter. */
export function bearerToken(
  header: string | null | undefined,
  query?: string | null,
): string | null {
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return (m[1] as string).trim();
  }
  return query ? query : null;
}
