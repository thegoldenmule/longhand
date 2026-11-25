/**
 * `pnpm dev:setup` — prepares local development state under `.dev/` (gitignored).
 *
 * Generates the ECDSA P-256 witness key pair used by the ledger service to sign
 * `(projectId, seq, hash, serverTime)` for every commit:
 *   .dev/witness-key.pem  PKCS#8 private key
 *   .dev/witness-pub.pem  SPKI public key (published to verifiers)
 *
 * Existing keys are never overwritten: rotating the key invalidates nothing already
 * witnessed, but doing it by accident would confuse local verification.
 */
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const devDir = join(root, '.dev');
const keyPath = join(devDir, 'witness-key.pem');
const pubPath = join(devDir, 'witness-pub.pem');

mkdirSync(devDir, { recursive: true });

if (existsSync(keyPath) && existsSync(pubPath)) {
  console.log(`witness key pair already present in ${devDir}`);
} else {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  writeFileSync(pubPath, publicKey, { mode: 0o644 });
  console.log(`generated witness key pair in ${devDir}`);
}

// keyId = lowercase hex SHA-256 of the SPKI DER public key (see packages/schema `keyIdFromSpkiDer`).
const spkiDer = createPublicKey(readFileSync(pubPath, 'utf8')).export({
  type: 'spki',
  format: 'der',
});
console.log(`witness keyId: ${createHash('sha256').update(spkiDer).digest('hex')}`);

if (!existsSync(join(root, '.env'))) {
  console.log('tip: cp .env.example .env');
}
