/**
 * Witness signers. Every commit is witnessed by an ECDSA P-256 / SHA-256 signature
 * over `canonicalize({projectId, seq, hash, serverTime})`, encoded as base64 of the
 * 64-byte IEEE P1363 `r‖s` form (see `@longhand/schema` `witnessMessage`).
 *
 * - {@link DevFileSigner}: a PKCS#8 PEM on disk (`.dev/witness-key.pem`, created by
 *   `pnpm dev:setup`). Local development and tests.
 * - {@link KmsSigner}: an AWS KMS asymmetric `ECC_NIST_P256` key. The private key
 *   never leaves KMS; KMS returns DER signatures, converted to P1363 here.
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GetPublicKeyCommand, SignCommand, type KMSClient } from '@aws-sdk/client-kms';
import type { WitnessSigner } from '@longhand/schema';

/** The service's signer interface: the schema's `WitnessSigner`. */
export type Signer = WitnessSigner;

/** `keyId` = lowercase hex SHA-256 of the SPKI DER public key. */
export function keyIdFromSpkiDer(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

/** SPKI DER → PEM. */
export function spkiDerToPem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/** Signs with a PKCS#8 private key held in memory (read from a PEM file). */
export class DevFileSigner implements Signer {
  readonly keyId: string;
  readonly publicKeyPem: string;
  private readonly key: ReturnType<typeof createPrivateKey>;

  constructor(privateKeyPem: string) {
    this.key = createPrivateKey(privateKeyPem);
    if (
      this.key.asymmetricKeyType !== 'ec' ||
      this.key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) {
      throw new Error('witness key must be an EC P-256 private key');
    }
    const pub = createPublicKey(this.key);
    const der = pub.export({ type: 'spki', format: 'der' });
    this.publicKeyPem = pub.export({ type: 'spki', format: 'pem' }).toString();
    this.keyId = keyIdFromSpkiDer(der);
  }

  /** Reads `.dev/witness-key.pem` (or another path). */
  static fromFile(path: string): DevFileSigner {
    let pem: string;
    try {
      pem = readFileSync(path, 'utf8');
    } catch (e) {
      throw new Error(
        `cannot read the witness key at ${path} (${(e as Error).message}); run \`pnpm dev:setup\``,
        { cause: e },
      );
    }
    return new DevFileSigner(pem);
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      nodeSign('sha256', message, { key: this.key, dsaEncoding: 'ieee-p1363' }),
    );
  }
}

// ---------------------------------------------------------------------------
// DER → P1363
// ---------------------------------------------------------------------------

function readDerLength(der: Uint8Array, at: number): { length: number; next: number } {
  const first = der[at];
  if (first === undefined) throw new Error('DER signature truncated');
  if (first < 0x80) return { length: first, next: at + 1 };
  const n = first & 0x7f;
  if (n === 0 || n > 2) throw new Error('unsupported DER length');
  let length = 0;
  for (let i = 0; i < n; i++) {
    const b = der[at + 1 + i];
    if (b === undefined) throw new Error('DER signature truncated');
    length = (length << 8) | b;
  }
  return { length, next: at + 1 + n };
}

function readDerInteger(der: Uint8Array, at: number): { value: Uint8Array; next: number } {
  if (der[at] !== 0x02) throw new Error('DER signature: expected INTEGER');
  const { length, next } = readDerLength(der, at + 1);
  const end = next + length;
  if (end > der.length) throw new Error('DER signature truncated');
  return { value: der.subarray(next, end), next: end };
}

/** Left-pads (or strips leading zero bytes from) a big-endian integer to `size` bytes. */
function fixedWidth(value: Uint8Array, size: number): Uint8Array {
  let v = value;
  while (v.length > size && v[0] === 0) v = v.subarray(1);
  if (v.length > size) throw new Error('DER signature integer too large');
  const out = new Uint8Array(size);
  out.set(v, size - v.length);
  return out;
}

/**
 * Converts an ASN.1 DER ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`, what
 * KMS returns) to IEEE P1363 `r‖s` (`size` bytes each; 32 for P-256).
 */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array {
  if (der[0] !== 0x30) throw new Error('DER signature: expected SEQUENCE');
  const { length, next } = readDerLength(der, 1);
  if (next + length !== der.length) throw new Error('DER signature: bad sequence length');
  const r = readDerInteger(der, next);
  const s = readDerInteger(der, r.next);
  if (s.next !== der.length) throw new Error('DER signature: trailing bytes');
  const out = new Uint8Array(size * 2);
  out.set(fixedWidth(r.value, size), 0);
  out.set(fixedWidth(s.value, size), size);
  return out;
}

// ---------------------------------------------------------------------------
// KMS
// ---------------------------------------------------------------------------

/** The KMS calls {@link KmsSigner} makes (a `KMSClient` satisfies it; tests mock it). */
export type KmsLike = Pick<KMSClient, 'send'>;

/** Signs with an AWS KMS `ECC_NIST_P256` key (`SIGN_VERIFY`), algorithm `ECDSA_SHA_256`. */
export class KmsSigner implements Signer {
  private constructor(
    private readonly client: KmsLike,
    private readonly kmsKeyId: string,
    readonly publicKeyPem: string,
    readonly keyId: string,
  ) {}

  /** Fetches the public key once and checks the key spec. */
  static async create(client: KmsLike, kmsKeyId: string): Promise<KmsSigner> {
    const res = await client.send(new GetPublicKeyCommand({ KeyId: kmsKeyId }));
    const spec = res.KeySpec ?? res.CustomerMasterKeySpec;
    if (spec !== 'ECC_NIST_P256') {
      throw new Error(`KMS key ${kmsKeyId} has spec ${spec ?? 'unknown'}; expected ECC_NIST_P256`);
    }
    if (res.KeyUsage && res.KeyUsage !== 'SIGN_VERIFY') {
      throw new Error(`KMS key ${kmsKeyId} has usage ${res.KeyUsage}; expected SIGN_VERIFY`);
    }
    if (!res.PublicKey) throw new Error(`KMS returned no public key for ${kmsKeyId}`);
    const der = new Uint8Array(res.PublicKey);
    return new KmsSigner(client, kmsKeyId, spkiDerToPem(der), keyIdFromSpkiDer(der));
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    const res = await this.client.send(
      new SignCommand({
        KeyId: this.kmsKeyId,
        Message: message,
        MessageType: 'RAW',
        SigningAlgorithm: 'ECDSA_SHA_256',
      }),
    );
    if (!res.Signature) throw new Error('KMS returned no signature');
    return derToP1363(new Uint8Array(res.Signature));
  }
}
