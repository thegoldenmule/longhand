import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalHash, canonicalize, sha256Hex } from './canonical';

// Vectors from RFC 8785 and its reference test data
// (github.com/cyberphone/json-canonicalization, testdata/input + testdata/output).
describe('canonicalize — RFC 8785 vectors', () => {
  it('arrays.json', () => {
    const input = JSON.parse('[56, {"d": true, "10": null, "1": [ ]}]');
    expect(canonicalize(input)).toBe('[56,{"1":[],"10":null,"d":true}]');
  });

  it('structures.json', () => {
    const input = JSON.parse(
      '{"1": {"f": {"f": "hi","F": 5} ,"\\n": 56.0}, "10": { }, "": "empty", "a": { }, "111": [ {"e": "yes","E": "no" } ], "A": { }}',
    );
    expect(canonicalize(input)).toBe(
      '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}',
    );
  });

  it('values.json (RFC 8785 §3.2.2 sample)', () => {
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], ' +
        '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", ' +
        '"literals": [null, true, false]}',
    );
    expect(canonicalize(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });

  it('unicode.json (no normalization)', () => {
    const input = JSON.parse(String.raw`{"Unnormalized Unicode":"Å"}`);
    expect(canonicalize(input)).toBe('{"Unnormalized Unicode":"Å"}');
  });

  it('weird.json (property sorting by UTF-16 code units, RFC 8785 §3.2.3)', () => {
    const input = JSON.parse(
      String.raw`{"€": "Euro Sign", "\r": "Carriage Return", "\u000a": "Newline", "1": "One", "\u0080": "Control\u007f", "😂": "Smiley", "ö": "Latin Small Letter O With Diaeresis", "דּ": "Hebrew Letter Dalet With Dagesh", "</script>": "Browser Challenge"}`,
    );
    expect(canonicalize(input)).toBe(
      '{"\\n":"Newline","\\r":"Carriage Return","1":"One","</script>":"Browser Challenge","\u0080":"Control\u007f","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😂":"Smiley","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  // RFC 8785 Appendix B: IEEE 754 bit patterns and their canonical form.
  const numberVectors: Array<[string, string]> = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];
  it.each(numberVectors)('number %s → %s', (bits, expected) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(`0x${bits}`));
    expect(canonicalize(view.getFloat64(0))).toBe(expected);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ a: Number.NEGATIVE_INFINITY })).toThrow(CanonicalJsonError);
  });
});

describe('canonicalize — Longhand rules', () => {
  it('omits undefined object properties but rejects undefined array items', () => {
    expect(canonicalize({ b: 1, a: undefined })).toBe('{"b":1}');
    expect(() => canonicalize([1, undefined])).toThrow(CanonicalJsonError);
  });

  it('rejects non-JSON values', () => {
    expect(() => canonicalize(1n)).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalize(new Date(0))).toThrow(CanonicalJsonError);
    expect(() => canonicalize(new Map())).toThrow(CanonicalJsonError);
  });

  it('rejects cycles but allows shared references', () => {
    const shared = { x: 1 };
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(CanonicalJsonError);
  });

  it('is independent of key insertion order', () => {
    expect(canonicalize({ z: [1, { y: 2, x: 1 }], a: 'b' })).toBe(
      canonicalize({ a: 'b', z: [1, { x: 1, y: 2 }] }),
    );
  });

  it('escapes lone surrogates instead of throwing', () => {
    expect(canonicalize('\ud800')).toBe('"\\ud800"');
  });

  it('accepts null-prototype objects', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 2;
    o.a = 1;
    expect(canonicalize(o)).toBe('{"a":1,"b":2}');
  });
});

describe('sha256Hex', () => {
  it('matches FIPS 180-2 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha256Hex('abc'));
  });

  it('UTF-8 encodes strings', () => {
    expect(sha256Hex('€')).toBe(sha256Hex(new Uint8Array([0xe2, 0x82, 0xac])));
  });

  it('canonicalHash hashes the canonical form', () => {
    expect(canonicalHash({ b: 1, a: 2 })).toBe(sha256Hex('{"a":2,"b":1}'));
  });
});
