/** Entry point of the bundled `longhand-verify` executable. */
import { main } from './cli';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`longhand-verify: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exitCode = 2;
  },
);
