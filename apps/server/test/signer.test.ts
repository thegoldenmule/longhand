import { generateKeyPairSync, sign as nodeSign, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { describe, expect, it } from 'vitest';
import { signWitness } from '@longhand/ledger';
import { keyIdFromPublicKeyPem, verifyWitnessSignature } from '@longhand/schema';
import { DevFileSigner, KmsSigner, derToP1363, type KmsLike } from '../src/signer';

const subject = {
  projectId: 'proj-1',
  seq: 7,
  hash: 'a'.repeat(64),
  serverTime: '2026-11-24T10:00:00.000Z',
};

function keyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

describe('DevFileSigner', () => {
  it('reads a PEM file and produces witnesses that verify (P1363, keyId of the SPKI)', async () => {
    const { privateKey, publicKey } = keyPair();
    const dir = mkdtempSync(join(tmpdir(), 'lh-signer-'));
    const path = join(dir, 'witness-key.pem');
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const signer = DevFileSigner.fromFile(path);
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(signer.publicKeyPem).toBe(pem);
    expect(signer.keyId).toBe(await keyIdFromPublicKeyPem(pem));
    const w = await signWitness(signer, subject);
    expect(Buffer.from(w.signature, 'base64')).toHaveLength(64);
    expect(await verifyWitnessSignature(w, pem)).toBe(true);
    expect(await verifyWitnessSignature({ ...w, seq: 8 }, pem)).toBe(false);
  });

  it('explains a missing key file', () => {
    expect(() => DevFileSigner.fromFile('/nonexistent/witness-key.pem')).toThrow(/pnpm dev:setup/);
  });

  it('refuses a non-P-256 key', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    expect(
      () => new DevFileSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    ).toThrow(/P-256/);
  });
});

describe('derToP1363', () => {
  it('matches Node’s own P1363 output for many signatures (leading-zero and high-bit integers)', () => {
    const { privateKey, publicKey } = keyPair();
    for (let i = 0; i < 200; i++) {
      const msg = Buffer.from(`message ${i}`);
      const der = nodeSign('sha256', msg, { key: privateKey, dsaEncoding: 'der' });
      const p1363 = derToP1363(new Uint8Array(der));
      expect(p1363).toHaveLength(64);
      expect(verify('sha256', msg, { key: publicKey, dsaEncoding: 'ieee-p1363' }, p1363)).toBe(
        true,
      );
    }
  });

  it('handles short integers and rejects malformed input', () => {
    // r = 1, s = 0x80 (needs a 0x00 pad byte in DER)
    const der = Uint8Array.from([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x02, 0x00, 0x80]);
    const out = derToP1363(der);
    expect(out[31]).toBe(1);
    expect(out[63]).toBe(0x80);
    expect(out.slice(0, 31).every((b) => b === 0)).toBe(true);
    expect(() => derToP1363(Uint8Array.from([0x31, 0x00]))).toThrow();
    expect(() => derToP1363(Uint8Array.from([0x30, 0x05, 0x02, 0x01, 0x01]))).toThrow();
  });
});

describe('KmsSigner (mocked KMS client)', () => {
  function mockKms(opts: { keySpec?: string } = {}) {
    const { privateKey, publicKey } = keyPair();
    const calls: unknown[] = [];
    const client: KmsLike = {
      send: (async (cmd: unknown) => {
        calls.push(cmd);
        if (cmd instanceof GetPublicKeyCommand) {
          return {
            KeyId: cmd.input.KeyId,
            KeySpec: opts.keySpec ?? 'ECC_NIST_P256',
            KeyUsage: 'SIGN_VERIFY',
            PublicKey: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
          };
        }
        if (cmd instanceof SignCommand) {
          expect(cmd.input.SigningAlgorithm).toBe('ECDSA_SHA_256');
          expect(cmd.input.MessageType).toBe('RAW');
          const der = nodeSign('sha256', Buffer.from(cmd.input.Message as Uint8Array), {
            key: privateKey,
            dsaEncoding: 'der',
          });
          return {
            Signature: new Uint8Array(der),
            KeyId: cmd.input.KeyId,
            SigningAlgorithm: 'ECDSA_SHA_256',
          };
        }
        throw new Error('unexpected command');
      }) as KmsLike['send'],
    };
    return { client, publicKey, calls };
  }

  it('signs through KMS and converts DER to P1363; the witness verifies with WebCrypto', async () => {
    const { client, publicKey, calls } = mockKms();
    const signer = await KmsSigner.create(client, 'alias/longhand-witness');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(signer.publicKeyPem).toBe(pem);
    expect(signer.keyId).toBe(await keyIdFromPublicKeyPem(pem));
    for (let i = 0; i < 20; i++) {
      const w = await signWitness(signer, { ...subject, seq: i + 1 });
      expect(await verifyWitnessSignature(w, signer.publicKeyPem)).toBe(true);
    }
    expect(calls.filter((c) => c instanceof GetPublicKeyCommand)).toHaveLength(1);
  });

  it('refuses a key that is not ECC_NIST_P256', async () => {
    const { client } = mockKms({ keySpec: 'RSA_2048' });
    await expect(KmsSigner.create(client, 'k')).rejects.toThrow(/ECC_NIST_P256/);
  });
});
