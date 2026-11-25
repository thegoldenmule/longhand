/**
 * Runs one real light-touch review through the local `claude` CLI and records its
 * stream-json output as a test fixture (sanitized: no local paths, no lists of the
 * machine's plugins, skills or agents).
 *
 *   pnpm --filter @longhand/agent exec tsx scripts/record-stream-fixture.ts [out.ndjson]
 *
 * Costs one real model call (sonnet).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ClaudeCliAdapter, InMemoryAnnotationSink, runFeedbackSession } from '../src/index';
import { LIVE_PARAGRAPH_REQUEST, liveParagraphState } from '../src/live-fixture';

const out =
  process.argv[2] ??
  fileURLToPath(new URL('../src/__fixtures__/claude-stream.ndjson', import.meta.url));

const raw: string[] = [];
const sink = new InMemoryAnnotationSink();
const outcome = await runFeedbackSession({
  state: liveParagraphState(),
  request: LIVE_PARAGRAPH_REQUEST,
  sink,
  adapter: new ClaudeCliAdapter({ onRawLine: (l) => raw.push(l) }),
  model: 'sonnet',
  timeoutMs: 5 * 60_000,
});

const KEEP_INIT = [
  'type',
  'subtype',
  'session_id',
  'model',
  'tools',
  'mcp_servers',
  'permissionMode',
  'uuid',
];
const lines = raw.map((line) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }
  if (msg.type === 'system' && msg.subtype === 'init') {
    msg = Object.fromEntries(Object.entries(msg).filter(([k]) => KEEP_INIT.includes(k)));
    msg.cwd = '/tmp/longhand-session';
  }
  if (msg.type === 'rate_limit_event') msg.rate_limit_info = { status: 'allowed' };
  delete msg.credential_expires_at;
  return JSON.stringify(msg).replace(/\/(Users|home)\/[^/"\\]+/g, '/home/user');
});
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(
  JSON.stringify(
    {
      status: outcome.status,
      reason: outcome.reason,
      rejectedCalls: outcome.rejectedCalls,
      drafts: sink.drafts.map((d) => d.draft.type),
      usage: outcome.run?.usage,
      costUsd: outcome.run?.costUsd,
      durationMs: outcome.run?.durationMs,
      stderr: outcome.run?.stderr.slice(-500),
      out,
    },
    null,
    2,
  ),
);
