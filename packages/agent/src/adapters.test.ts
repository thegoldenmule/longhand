import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ClaudeCliAdapter,
  ISOLATION_ARGS,
  StreamJsonParser,
  buildClaudeArgs,
  parseStreamJson,
  type ModelEvent,
  type ModelRunInput,
} from './index';

const fixture = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
const CLEAN = fixture('claude-stream.ndjson');
const RETRY = fixture('claude-stream-retry.ndjson');
const FAKE = fixture('fake-claude.mjs');

describe('stream-json parser on recorded CLI output', () => {
  it('parses a clean recorded run: init, tool calls, results, final message, usage', () => {
    const events = parseStreamJson(readFileSync(CLEAN, 'utf8'));
    expect(events.filter((e) => e.type === 'parse-error')).toEqual([]);
    const init = events.find((e) => e.type === 'init');
    expect(init).toMatchObject({ mcpServers: [{ name: 'longhand', status: 'connected' }] });
    if (init?.type === 'init') {
      expect(init.tools.length).toBeGreaterThan(0);
      expect(init.tools.every((t) => t.startsWith('mcp__longhand__'))).toBe(true);
    }
    const calls = events.filter((e) => e.type === 'tool-call');
    const results = events.filter((e) => e.type === 'tool-result');
    expect(calls.length).toBeGreaterThan(0);
    expect(results).toHaveLength(calls.length);
    expect(calls.every((c) => c.type === 'tool-call' && c.name.startsWith('mcp__longhand__'))).toBe(
      true,
    );
    const last = calls[calls.length - 1];
    expect(last?.type === 'tool-call' && last.name).toBe('mcp__longhand__finish_review');
    const result = events[events.length - 1];
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(result.ok).toBe(true);
      expect(result.subtype).toBe('success');
      expect(result.usage?.outputTokens).toBeGreaterThan(0);
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.text).toBeTruthy();
    }
  });

  it('parses a recorded run with a rejected call, hook events and a rate-limit event', () => {
    const events = parseStreamJson(readFileSync(RETRY, 'utf8'));
    const errored = events.filter((e) => e.type === 'tool-result' && e.isError);
    expect(errored).toHaveLength(1);
    expect(errored[0]?.type === 'tool-result' && errored[0].text).toMatch(/No such tool available/);
    expect(events.filter((e) => e.type === 'other').length).toBeGreaterThanOrEqual(3);
    expect(events.filter((e) => e.type === 'parse-error')).toEqual([]);
  });

  it('is incremental across arbitrary chunk boundaries', () => {
    const text = readFileSync(CLEAN, 'utf8');
    const whole = parseStreamJson(text);
    const p = new StreamJsonParser();
    const chunked: ModelEvent[] = [];
    for (let i = 0; i < text.length; i += 37) chunked.push(...p.push(text.slice(i, i + 37)));
    chunked.push(...p.end());
    expect(chunked).toEqual(whole);
  });

  it('reports bad lines and maps error results', () => {
    const events = parseStreamJson(
      'not json\n[1]\n{"type":"result","subtype":"error_max_turns","is_error":true,"errors":["too long"]}\n',
    );
    expect(events.map((e) => e.type)).toEqual(['parse-error', 'parse-error', 'result']);
    expect(events[2]).toMatchObject({
      ok: false,
      subtype: 'error_max_turns',
      errors: ['too long'],
    });
  });
});

describe('ClaudeCliAdapter', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'longhand-cli-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const input = (over: Partial<ModelRunInput> = {}): ModelRunInput => ({
    sessionKind: 'review',
    model: 'sonnet',
    systemPrompt: 'SYSTEM PROMPT',
    prompt: 'USER PROMPT\nwith lines',
    mcp: { launch: { command: 'node', args: [] }, configPath: '/tmp/x/mcp.json' },
    allowedTools: ['mcp__longhand__comment'],
    cwd: dir,
    timeoutMs: 20_000,
    ...over,
  });

  it('builds exactly the BUILD.md flags', () => {
    expect(buildClaudeArgs(input())).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '/tmp/x/mcp.json',
      '--allowedTools',
      'mcp__longhand__*',
      '--no-session-persistence',
      '--system-prompt',
      'SYSTEM PROMPT',
      '--model',
      'sonnet',
    ]);
  });

  const adapter = (mode: string, fixtureFile = CLEAN, extra: Record<string, string> = {}) => {
    const record = join(dir, `record-${mode}-${Math.random().toString(36).slice(2)}.json`);
    return {
      record,
      adapter: new ClaudeCliAdapter({
        command: process.execPath,
        commandArgs: [FAKE],
        env: {
          ...process.env,
          FAKE_CLAUDE_MODE: mode,
          FAKE_CLAUDE_FIXTURE: fixtureFile,
          FAKE_CLAUDE_RECORD: record,
          ...extra,
        },
        killGraceMs: 200,
      }),
    };
  };

  it('spawns with the flags, sends the prompt on stdin, streams events and collects tool calls', async () => {
    const { adapter: a, record } = adapter('replay');
    const seen: ModelEvent[] = [];
    const r = await a.run(input({ onEvent: (e) => seen.push(e) }));
    expect(r.status).toBe('completed');
    expect(r.error).toBeNull();
    expect(r.toolCalls.length).toBeGreaterThan(0);
    expect(r.toolCalls.every((c) => c.result !== null)).toBe(true);
    expect(r.usage?.outputTokens).toBeGreaterThan(0);
    expect(r.finalText).toBeTruthy();
    expect(seen.map((e) => e.type)).toContain('tool-call');
    const rec = JSON.parse(await readFile(record, 'utf8')) as {
      argv: string[];
      stdin: string;
      cwd: string;
    };
    expect(rec.argv).toEqual([...buildClaudeArgs(input()), ...ISOLATION_ARGS]);
    expect(rec.stdin).toBe('USER PROMPT\nwith lines');
  });

  it('can turn settings isolation off and append extra args', async () => {
    const record = join(dir, 'record-noiso.json');
    const a = new ClaudeCliAdapter({
      command: process.execPath,
      commandArgs: [FAKE],
      env: { ...process.env, FAKE_CLAUDE_FIXTURE: CLEAN, FAKE_CLAUDE_RECORD: record },
      isolateSettings: false,
      extraArgs: ['--max-budget-usd', '1'],
    });
    await a.run(input());
    const rec = JSON.parse(await readFile(record, 'utf8')) as { argv: string[] };
    expect(rec.argv).toEqual([...buildClaudeArgs(input()), '--max-budget-usd', '1']);
  });

  it('kills a run that exceeds the wall-clock timeout (SIGTERM, then SIGKILL)', async () => {
    const { adapter: a } = adapter('hang');
    const started = Date.now();
    const r = await a.run(input({ timeoutMs: 500 }));
    expect(r.status).toBe('timeout');
    expect(r.error).toMatch(/exceeded 500 ms/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('aborts on signal', async () => {
    const { adapter: a } = adapter('hang');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await a.run(input({ signal: ac.signal }));
    expect(r.status).toBe('aborted');
  });

  it('reports a crash with stderr', async () => {
    const { adapter: a } = adapter('crash');
    const r = await a.run(input());
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/code 3 .*something went wrong/);
  });

  it('reports a missing executable', async () => {
    const a = new ClaudeCliAdapter({ command: join(dir, 'no-such-claude') });
    const r = await a.run(input());
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/could not run/);
  });

  it('kills the run when the annotation tool server failed to start', async () => {
    const failed = join(dir, 'failed.ndjson');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      failed,
      `${JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'longhand', status: 'failed' }] })}\n`,
    );
    const { adapter: a } = adapter('hang', failed);
    const r = await a.run(input());
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/tool server status: failed/);
  });
});
