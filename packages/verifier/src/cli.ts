/**
 * `longhand-verify <bundle.json> [--json] [--key-id <hex>]`
 *
 * Exit codes: 0 verified, 1 not verified, 2 usage error or unreadable file.
 */
import { readFile } from 'node:fs/promises';
import { formatResult } from './format';
import { verifyBundle } from './verify';

export const USAGE = `Usage: longhand-verify <bundle.json> [--json] [--key-id <hex>]

Checks a Longhand verification bundle: the bundle format, the witness key, the
hash chain, every witness signature, a full re-fold of the ledger, and that the
report recomputed from the ledger matches the bundled one.

  --json          print the result as JSON (the recomputed report included)
  --key-id <hex>  the witness key id you trust (as Longhand publishes it)
  -h, --help      show this help

Exit codes: 0 verified, 1 not verified, 2 usage error or unreadable file.
`;

/** Exit codes. */
export const EXIT = { verified: 0, notVerified: 1, usage: 2 } as const;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  readFile: (path: string) => Promise<string>;
}

/** Runs the CLI with `argv` (without the node and script paths). Returns the exit code. */
export async function main(
  argv: readonly string[],
  io: Io = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    readFile: (p) => readFile(p, 'utf8'),
  },
): Promise<number> {
  let json = false;
  let keyId: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') {
      io.out(USAGE);
      return EXIT.verified;
    } else if (a === '--key-id') {
      keyId = argv[++i];
      if (!keyId || !/^[0-9a-fA-F]{64}$/.test(keyId)) {
        io.err(`longhand-verify: --key-id needs a 64-character hex key id\n\n${USAGE}`);
        return EXIT.usage;
      }
    } else if (a.startsWith('-')) {
      io.err(`longhand-verify: unknown option ${a}\n\n${USAGE}`);
      return EXIT.usage;
    } else files.push(a);
  }
  if (files.length !== 1) {
    io.err(USAGE);
    return EXIT.usage;
  }
  const file = files[0]!;
  let text: string;
  try {
    text = await io.readFile(file);
  } catch (e) {
    io.err(`longhand-verify: cannot read ${file}: ${(e as Error).message}\n`);
    return EXIT.usage;
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(text);
  } catch (e) {
    io.err(`longhand-verify: ${file} is not JSON: ${(e as Error).message}\n`);
    return EXIT.usage;
  }
  const result = await verifyBundle(bundle, keyId ? { expectedKeyId: keyId } : {});
  io.out(json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(result, file));
  return result.ok ? EXIT.verified : EXIT.notVerified;
}
