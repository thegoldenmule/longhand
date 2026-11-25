/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) and SHA-256 helpers.
 *
 * Isomorphic: no Node-only APIs. Hashes are lowercase hex SHA-256 over the UTF-8
 * bytes of the canonical JSON text.
 *
 * Two documented deviations from a strict reading of RFC 8785, both chosen so that
 * a writer's commit can never become un-hashable:
 * - Object properties whose value is `undefined` are omitted (as `JSON.stringify`
 *   does), so `{a: undefined}` and `{}` canonicalize identically. `undefined` inside
 *   an array is an error.
 * - Lone UTF-16 surrogates are escaped as `\udXXX` (ES2019 well-formed
 *   `JSON.stringify`) instead of being rejected.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** A JSON value as accepted by {@link canonicalize}. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

/** Thrown when a value cannot be represented in canonical JSON (NaN, Infinity, bigint, functions, cycles, class instances…). */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Serializes `value` as RFC 8785 canonical JSON: no whitespace, object keys sorted by
 * UTF-16 code units, numbers in ECMAScript `Number#toString` form, strings escaped
 * exactly as `JSON.stringify` does.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number: ${value}`);
      // ES Number#toString is exactly the JCS number serialization; -0 becomes "0".
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`unsupported type: ${typeof value}`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError('cyclic structure');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        const item: unknown = obj[i];
        if (item === undefined) throw new CanonicalJsonError(`undefined at array index ${i}`);
        parts.push(serialize(item, seen));
      }
      return `[${parts.join(',')}]`;
    }
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(`not a plain object: ${obj.constructor?.name ?? 'unknown'}`);
    }
    const record = obj as Record<string, unknown>;
    // Default sort compares UTF-16 code units, which is what RFC 8785 §3.2.3 requires.
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = record[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serialize(v, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

const encoder = new TextEncoder();

/** UTF-8 encodes a string (isomorphic replacement for `Buffer.from(s, 'utf8')`). */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Lowercase hex SHA-256 of a string (UTF-8 encoded) or of raw bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8(data) : data));
}

/** `sha256Hex(canonicalize(value))` — the content hash used across Longhand. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** Matches a lowercase hex SHA-256 digest. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
