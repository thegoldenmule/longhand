/**
 * Cognito JWT verification against a locally signed JWKS (no network), and
 * account scoping of every route.
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CognitoAuthenticator, DevAuthenticator, bearerToken } from '../src/auth';
import { startTestServer, type TestServer } from '../src/testing';
import { DB, api } from './helpers';

const REGION = 'us-east-1';
const POOL = 'us-east-1_TestPool';
const CLIENT = 'test-client-id';
const ISS = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;

function b64url(x: Buffer | string): string {
  return Buffer.from(x).toString('base64url');
}

function makeIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-kid-1';
  const jwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, string>),
    kid,
    alg: 'RS256',
    use: 'sig',
  };
  const sign = (claims: Record<string, unknown>, key: KeyObject = privateKey, headerKid = kid) => {
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: headerKid, typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(
      JSON.stringify({
        iss: ISS,
        client_id: CLIENT,
        token_use: 'access',
        iat: now,
        exp: now + 3600,
        ...claims,
      }),
    );
    const s = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
    return `${header}.${payload}.${b64url(s)}`;
  };
  return { jwks: { keys: [jwk] }, sign };
}

function cognito(jwks: { keys: unknown[] }) {
  const { auth, verifier } = CognitoAuthenticator.create({ userPoolId: POOL, clientId: CLIENT });
  (verifier as unknown as { cacheJwks(j: unknown): void }).cacheJwks(jwks);
  return auth;
}

describe('CognitoAuthenticator', () => {
  const issuer = makeIssuer();
  const auth = cognito(issuer.jwks);

  it('accepts a valid access token: accountId = sub, or custom:accountId', async () => {
    expect(await auth.authenticate(issuer.sign({ sub: 'user-1' }))).toEqual({
      accountId: 'user-1',
      actorId: 'user-1',
    });
    expect(
      await auth.authenticate(issuer.sign({ sub: 'user-1', 'custom:accountId': 'acct-9' })),
    ).toEqual({
      accountId: 'acct-9',
      actorId: 'user-1',
    });
  });

  it('refuses missing, expired, wrong-issuer, wrong-client, wrong-use and forged tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const bad = [
      null,
      'not-a-jwt',
      issuer.sign({ sub: 'u', exp: now - 10 }),
      issuer.sign({ sub: 'u', iss: 'https://evil.example.com/pool' }),
      issuer.sign({ sub: 'u', client_id: 'someone-else' }),
      issuer.sign({ sub: 'u', token_use: 'id' }),
      issuer.sign({ sub: 'u' }, other),
    ];
    for (const token of bad) {
      await expect(auth.authenticate(token)).rejects.toMatchObject({
        status: 401,
        code: 'unauthorized',
      });
    }
  });

  it('extracts bearer tokens from a header or the access_token query', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer  abc ')).toBe('abc');
    expect(bearerToken(null, 'q')).toBe('q');
    expect(bearerToken('Basic x')).toBeNull();
  });
});

describe.skipIf(!DB())('account scoping over HTTP (cognito mode)', () => {
  const issuer = makeIssuer();
  let t: TestServer;
  const a = issuer.sign({ sub: 'alice' });
  const b = issuer.sign({ sub: 'bob' });
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  beforeAll(async () => {
    t = await startTestServer({ auth: cognito(issuer.jwks) });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('needs a token, and scopes every project route by account', async () => {
    expect((await api(t, 'GET', '/v1/projects')).status).toBe(401);
    expect((await api(t, 'GET', '/.well-known/longhand-witness-key')).status).toBe(200);
    const created = await api<{ projectId: string }>(
      t,
      'POST',
      '/v1/projects',
      { title: 'Alice’s' },
      as(a),
    );
    expect(created.status).toBe(201);
    const P = created.body.projectId;
    const mine = await api<{ projects: Array<{ projectId: string; accountId: string }> }>(
      t,
      'GET',
      '/v1/projects',
      undefined,
      as(a),
    );
    expect(mine.body.projects.map((p) => p.projectId)).toEqual([P]);
    expect(mine.body.projects[0]!.accountId).toBe('alice');
    const theirs = await api<{ projects: unknown[] }>(t, 'GET', '/v1/projects', undefined, as(b));
    expect(theirs.body.projects).toEqual([]);
    for (const path of [
      `/v1/projects/${P}`,
      `/v1/projects/${P}/state`,
      `/v1/projects/${P}/bundle`,
      `/v1/projects/${P}/export?format=md`,
    ]) {
      expect((await api(t, 'GET', path, undefined, as(b))).status, path).toBe(404);
      expect((await api(t, 'GET', path, undefined, as(a))).status, path).toBe(200);
    }
    // Bob cannot write to it, even with Alice's actor id.
    const draft = {
      commitId: 'x1',
      projectId: P,
      clientTime: new Date().toISOString(),
      actor: { kind: 'human', id: 'alice' },
      deviceId: 'd',
      sessionId: 's',
      schemaVersion: 1,
      type: 'DocumentCreated',
      payload: { documentId: 'doc-1', kind: 'manuscript', title: 'One', parentId: null, index: 0 },
    };
    expect((await api(t, 'POST', `/v1/projects/${P}/commits`, draft, as(b))).status).toBe(404);
    expect((await api(t, 'POST', `/v1/projects/${P}/commits`, draft, as(a))).status).toBe(200);
    // A project id another account already uses cannot be taken.
    const steal = await api(t, 'POST', '/v1/projects', { title: 'Mine now', projectId: P }, as(b));
    expect(steal.status).toBe(409);
    // EventSource-style auth through the query string.
    expect((await api(t, 'GET', `/v1/projects?access_token=${a}`)).status).toBe(200);
  });

  it('dev mode signs in a fixed principal', async () => {
    expect(await new DevAuthenticator().authenticate()).toEqual({
      accountId: 'dev-account',
      actorId: 'dev-writer',
    });
  });
});
