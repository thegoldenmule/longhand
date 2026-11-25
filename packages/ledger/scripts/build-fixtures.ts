/**
 * Regenerates the golden fixtures: `pnpm --filter @longhand/ledger fixtures`.
 *
 * Rebuilds every fixture from `fixtures/definitions.ts`, recomputes expected
 * outputs, and signs witnesses with the test key in
 * `fixtures/witness-test-key.json` (created on first run). Existing witnesses are
 * kept when their commit did not change, so regenerating an unchanged fixture
 * leaves its file byte-identical.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { derToPem, keyIdFromPublicKeyPem, pemToDer, type Witness } from '@longhand/schema';
import { signWitness, verifyChain, verifyWitnesses, webCryptoSigner } from '../src/chain';
import {
  EMBEDDED_WITNESSES_URL,
  FIXTURE_DEFINITIONS,
  TAMPER_DEFINITIONS,
  embeddedKey,
} from '../fixtures/definitions';
import { buildFixture, buildTampered, type FixtureFile } from '../fixtures/generate';

const dir = new URL('../fixtures/', import.meta.url);
const keyFile = new URL('witness-test-key.json', dir);

async function loadKey(): Promise<{
  publicKeyPem: string;
  privateKeyPkcs8Pem: string;
  keyId: string;
}> {
  if (existsSync(keyFile)) return JSON.parse(readFileSync(keyFile, 'utf8'));
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const publicKeyPem = derToPem(spki);
  const key = {
    note: 'TEST ONLY: signs the golden fixtures. Never use outside tests.',
    publicKeyPem,
    privateKeyPkcs8Pem: derToPem(pkcs8, 'PRIVATE KEY'),
    keyId: keyIdFromPublicKeyPem(publicKeyPem),
  };
  writeFileSync(keyFile, `${JSON.stringify(key, null, 2)}\n`);
  return key;
}

function write(url: URL, value: unknown): void {
  writeFileSync(url, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const key = await loadKey();
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(key.privateKeyPkcs8Pem) as Uint8Array<ArrayBuffer>,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signer = await webCryptoSigner(privateKey, key.publicKeyPem);
  const files: Record<string, FixtureFile> = {};
  for (const name of Object.keys(FIXTURE_DEFINITIONS)) {
    let built = buildFixture(name);
    // Sign embedded ChainHeadWitnessed subjects that have no valid signature yet, then rebuild.
    const embedded: Record<string, { signature: string; keyId: string }> = existsSync(
      EMBEDDED_WITNESSES_URL,
    )
      ? JSON.parse(readFileSync(EMBEDDED_WITNESSES_URL, 'utf8'))
      : {};
    let added = false;
    for (const c of built.commits) {
      if (c.type !== 'ChainHeadWitnessed') continue;
      const subject = {
        projectId: c.projectId,
        seq: c.payload.witnessedSeq,
        hash: c.payload.witnessedHash,
        serverTime: c.payload.serverTime,
      };
      if (c.payload.keyId === key.keyId && embedded[embeddedKey(subject)]) continue;
      const w = await signWitness(signer, subject);
      embedded[embeddedKey(subject)] = { signature: w.signature, keyId: w.keyId };
      added = true;
    }
    if (added) {
      write(EMBEDDED_WITNESSES_URL, embedded);
      built = buildFixture(name);
    }
    const url = new URL(`${name}.json`, dir);
    const old: Witness[] = existsSync(url)
      ? (JSON.parse(readFileSync(url, 'utf8')) as FixtureFile).witnesses
      : [];
    const witnesses: Witness[] = [];
    for (const c of built.commits) {
      const w = old.find(
        (x) =>
          x.seq === c.seq &&
          x.hash === c.hash &&
          x.serverTime === c.serverTime &&
          x.keyId === key.keyId,
      );
      witnesses.push(w ?? (await signWitness(signer, c)));
    }
    const file: FixtureFile = {
      ...built,
      witnesses,
      publicKeyPem: key.publicKeyPem,
      keyId: key.keyId,
    };
    const chain = verifyChain(file.commits);
    if (!chain.ok) throw new Error(`${name}: chain invalid: ${JSON.stringify(chain.problems)}`);
    const wv = await verifyWitnesses(file.commits, file.witnesses, file.publicKeyPem);
    if (!wv.ok) throw new Error(`${name}: witnesses invalid: ${JSON.stringify(wv.problems)}`);
    if (file.expected.issues.length > 0)
      throw new Error(`${name}: fold issues: ${JSON.stringify(file.expected.issues)}`);
    write(url, file);
    files[name] = file;
    console.log(`${name}: ${file.commits.length} commits`);
  }
  mkdirSync(new URL('tampered/', dir), { recursive: true });
  for (const [name, def] of Object.entries(TAMPER_DEFINITIONS)) {
    const t = await buildTampered(name, files[def.base]!);
    write(new URL(`tampered/${name}.json`, dir), t);
    console.log(
      `${name}: ${t.expected.chain.problems.map((p) => p.code).join(', ') || 'chain ok'}`,
    );
  }
}

void main();
