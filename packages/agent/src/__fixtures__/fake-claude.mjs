// A stand-in for the `claude` CLI in adapter tests. Behaviour by FAKE_CLAUDE_MODE:
// - replay: print FAKE_CLAUDE_FIXTURE line by line (stream-json), then exit 0
// - hang:   print the fixture's first line, ignore SIGTERM, never exit
// - crash:  write to stderr and exit 3 without a result
// It records its argv and stdin to FAKE_CLAUDE_RECORD (JSON) when set.
import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE ?? 'replay';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', async () => {
  if (process.env.FAKE_CLAUDE_RECORD) {
    writeFileSync(
      process.env.FAKE_CLAUDE_RECORD,
      JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }),
    );
  }
  const lines = process.env.FAKE_CLAUDE_FIXTURE
    ? readFileSync(process.env.FAKE_CLAUDE_FIXTURE, 'utf8').split('\n').filter(Boolean)
    : [];
  if (mode === 'crash') {
    process.stderr.write('Error: something went wrong\n');
    process.exit(3);
  }
  if (mode === 'hang') {
    process.on('SIGTERM', () => undefined);
    process.stdout.write(`${lines[0] ?? '{}'}\n`);
    setInterval(() => undefined, 1000);
    return;
  }
  for (const line of lines) {
    // Split some lines across writes to exercise the incremental parser.
    const mid = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, mid));
    await new Promise((r) => setTimeout(r, 2));
    process.stdout.write(`${line.slice(mid)}\n`);
  }
  process.exit(0);
});
