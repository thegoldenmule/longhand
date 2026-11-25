/** Test helpers (Node only): bundles from fixtures, and re-signing a doctored ledger. */
import { signWitness, webCryptoSigner } from '@longhand/ledger';
import { loadFixture, loadFixtureWitnessKey, loadTamperedFixture } from '@longhand/ledger/fixtures';
import { buildBundle } from '@longhand/report';
import {
  computeCommitHash,
  derToPem,
  pemToDer,
  type Commit,
  type VerificationBundle,
  type Witness,
} from '@longhand/schema';

/** A bundle built from a golden fixture with its test witness key. */
export function fixtureBundle(
  name: string,
  scope: Parameters<typeof buildBundle>[0]['scope'] = 'project',
): VerificationBundle {
  const f = loadFixture(name);
  return buildBundle({
    commits: f.commits,
    witnesses: f.witnesses,
    publicKeyPem: f.publicKeyPem,
    keyId: f.keyId,
    scope,
  });
}

/** A bundle around a tampered fixture: its commits and witnesses, the untampered report. */
export function tamperedBundle(name: string): VerificationBundle {
  const t = loadTamperedFixture(name);
  const honest = fixtureBundle(t.base);
  return {
    ...honest,
    commits: t.commits as Commit[],
    witnesses: t.witnesses,
    publicKeyPem: t.publicKeyPem,
    keyId: t.keyId,
  };
}

/** A copy of a value through JSON (what reading a bundle file gives). */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Re-hashes a ledger from `fromIndex` on and re-signs every witness with the
 * fixture key: what a server with the key could do. The chain and witnesses
 * then verify, so only the re-fold or the report can catch the change.
 */
export async function rechainAndResign(commits: Commit[], fromIndex: number): Promise<Witness[]> {
  for (let i = fromIndex; i < commits.length; i++) {
    const c = commits[i]!;
    if (i > 0) c.prevHash = commits[i - 1]!.hash;
    c.hash = computeCommitHash(c);
  }
  const key = loadFixtureWitnessKey();
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(key.privateKeyPkcs8Pem) as Uint8Array<ArrayBuffer>,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signer = await webCryptoSigner(privateKey, key.publicKeyPem);
  return Promise.all(commits.map((c) => signWitness(signer, c)));
}

/** A fresh P-256 public key (SPKI PEM) that signed nothing. */
export async function otherPublicKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return derToPem(spki);
}
