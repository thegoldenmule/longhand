/**
 * Writes the example bundles in `examples/` from the ledger's golden fixtures
 * (signed with the test-only fixture key):
 *
 * - `novel.bundle.json` verifies;
 * - `novel-doctored-report.bundle.json` has one number changed in its report;
 * - `tampered-edited.bundle.json` has a commit edited after it was witnessed.
 *
 *     pnpm --filter @longhand/verifier examples
 *
 * A test fails when the files are stale.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import prettier from 'prettier';
import { clone, fixtureBundle, tamperedBundle } from '../src/test-helpers';

const dir = fileURLToPath(new URL('../examples/', import.meta.url));

/** The example bundles, by file name. */
export function exampleBundles(): Record<string, unknown> {
  const good = fixtureBundle('novel');
  const doctored = clone(good);
  doctored.report.words.byClass.typed += 3;
  return {
    'novel.bundle.json': good,
    'novel-doctored-report.bundle.json': doctored,
    'tampered-edited.bundle.json': tamperedBundle('tampered-edited'),
  };
}

/** A bundle as the repo's prettier formats JSON. */
export async function exampleText(name: string, bundle: unknown): Promise<string> {
  const filepath = `${dir}${name}`;
  const config = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(JSON.stringify(bundle), { ...config, filepath });
}

export const EXAMPLES_DIR = dir;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [name, bundle] of Object.entries(exampleBundles())) {
    await writeFile(`${dir}${name}`, await exampleText(name, bundle));
    process.stdout.write(`wrote examples/${name}\n`);
  }
}
