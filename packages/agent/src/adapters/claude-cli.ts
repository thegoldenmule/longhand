/**
 * Runs the local Claude Code CLI headlessly with Longhand's annotation tools as
 * its only tools:
 *
 * ```
 * claude -p --output-format stream-json --verbose --tools "" --strict-mcp-config
 *   --mcp-config <file> --allowedTools "mcp__longhand__*" --no-session-persistence
 *   --system-prompt <prompt> --model <model>
 * ```
 *
 * The user message goes in on stdin (the variadic `--mcp-config` and
 * `--allowedTools` flags would swallow a positional prompt). Stdout is parsed as
 * stream-json and reported as {@link ModelEvent}s; a wall-clock timeout or abort
 * sends SIGTERM, then SIGKILL after a grace period.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MCP_TOOL_PREFIX } from '../mcp/server';
import { StreamJsonParser } from './stream-json';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRunInput,
  ModelRunResult,
  ModelUsage,
  ToolCallRecord,
} from './types';

/** Options for {@link ClaudeCliAdapter}. */
export interface ClaudeCliAdapterOptions {
  /** CLI executable (default: `$LONGHAND_CLAUDE_BIN`, else `~/.local/bin/claude` if present, else `claude` on PATH). */
  command?: string;
  /** Arguments placed before the CLI flags (e.g. a script path when `command` is `node`). */
  commandArgs?: string[];
  /** Extra flags appended after the required ones (e.g. `['--max-budget-usd', '2']`). */
  extraArgs?: string[];
  /** Environment for the CLI (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Time between SIGTERM and SIGKILL (default 5000 ms). */
  killGraceMs?: number;
  /** Sees every raw stdout line (for recording fixtures). */
  onRawLine?: (line: string) => void;
  /**
   * Skip the machine's user and local settings (hooks, plugins, permissions) by
   * passing `--setting-sources project`; the run's cwd is a private temp dir, so no
   * project settings exist either. Authentication is unaffected. Default true.
   */
  isolateSettings?: boolean;
}

/** Flags added when {@link ClaudeCliAdapterOptions.isolateSettings} is on. */
export const ISOLATION_ARGS: readonly string[] = ['--setting-sources', 'project'];

/** Default CLI location. */
export function defaultClaudeCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LONGHAND_CLAUDE_BIN) return env.LONGHAND_CLAUDE_BIN;
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

/** The exact CLI arguments for a run (the prompt goes on stdin). */
export function buildClaudeArgs(
  input: Pick<ModelRunInput, 'mcp' | 'systemPrompt' | 'model'>,
  extraArgs: readonly string[] = [],
): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    input.mcp.configPath,
    '--allowedTools',
    `${MCP_TOOL_PREFIX}*`,
    '--no-session-persistence',
    '--system-prompt',
    input.systemPrompt,
    '--model',
    input.model,
    ...extraArgs,
  ];
}

const STDERR_TAIL = 4000;

/** Spawns `claude -p` per session. */
export class ClaudeCliAdapter implements ModelAdapter {
  readonly name = 'claude-cli';
  constructor(private readonly options: ClaudeCliAdapterOptions = {}) {}

  run(input: ModelRunInput): Promise<ModelRunResult> {
    const o = this.options;
    const started = Date.now();
    const command = o.command ?? defaultClaudeCommand(o.env ?? process.env);
    const args = buildClaudeArgs(input, [
      ...(o.isolateSettings === false ? [] : ISOLATION_ARGS),
      ...(o.extraArgs ?? []),
    ]);
    const toolCalls: ToolCallRecord[] = [];
    const byId = new Map<string, ToolCallRecord>();
    let finalText: string | null = null;
    let usage: ModelUsage | null = null;
    let costUsd: number | null = null;
    let resultEvent: Extract<ModelEvent, { type: 'result' }> | null = null;
    let stderr = '';
    let forced: { status: 'timeout' | 'aborted' | 'error'; error: string } | null = null;

    return new Promise<ModelRunResult>((resolve) => {
      let settled = false;
      const child = spawn(command, [...(o.commandArgs ?? []), ...args], {
        cwd: input.cwd,
        env: o.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let killTimer: NodeJS.Timeout | null = null;
      const kill = (status: 'timeout' | 'aborted' | 'error', error: string) => {
        if (forced || settled) return;
        forced = { status, error };
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), o.killGraceMs ?? 5000);
        killTimer.unref();
      };
      const timer = setTimeout(
        () => kill('timeout', `model run exceeded ${input.timeoutMs} ms`),
        input.timeoutMs,
      );
      const onAbort = () => kill('aborted', 'model run aborted');
      if (input.signal?.aborted) onAbort();
      input.signal?.addEventListener('abort', onAbort, { once: true });

      const emit = (e: ModelEvent) => {
        switch (e.type) {
          case 'init': {
            const server = e.mcpServers.find((s) => s.name === 'longhand');
            if (server && server.status !== 'connected' && server.status !== 'pending') {
              kill('error', `annotation tool server status: ${server.status}`);
            }
            break;
          }
          case 'tool-call': {
            const rec: ToolCallRecord = { id: e.id, name: e.name, input: e.input, result: null };
            toolCalls.push(rec);
            byId.set(e.id, rec);
            break;
          }
          case 'tool-result': {
            const rec = byId.get(e.toolUseId);
            if (rec) rec.result = { isError: e.isError, text: e.text };
            break;
          }
          case 'result':
            resultEvent = e;
            finalText = e.text;
            usage = e.usage;
            costUsd = e.costUsd;
            break;
          default:
            break;
        }
        try {
          input.onEvent?.(e);
        } catch {
          // A progress listener must never break the run.
        }
      };

      const parser = new StreamJsonParser();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (o.onRawLine) for (const l of chunk.split('\n')) if (l.trim()) o.onRawLine(l);
        for (const e of parser.push(chunk)) emit(e);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL);
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input.prompt);

      const finish = (spawnError: string | null, code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        input.signal?.removeEventListener('abort', onAbort);
        for (const e of parser.end()) emit(e);
        const base = {
          finalText,
          toolCalls,
          usage,
          costUsd,
          durationMs: Date.now() - started,
          stderr: stderr.trim(),
        };
        const f = forced as { status: 'timeout' | 'aborted' | 'error'; error: string } | null;
        const r = resultEvent as Extract<ModelEvent, { type: 'result' }> | null;
        if (spawnError) {
          resolve({ ...base, status: 'error', error: spawnError });
        } else if (f) {
          resolve({ ...base, status: f.status, error: f.error });
        } else if (r && r.ok) {
          resolve({ ...base, status: 'completed', error: null });
        } else if (r) {
          const detail = [r.subtype, ...r.errors, r.text ?? ''].filter(Boolean).join(': ');
          resolve({ ...base, status: 'error', error: `model run failed (${detail})` });
        } else {
          const how = signal ? `signal ${signal}` : `code ${code}`;
          const tail = stderr.trim().split('\n').slice(-3).join(' | ');
          resolve({
            ...base,
            status: 'error',
            error: `claude exited with ${how} before a result${tail ? `: ${tail}` : ''}`,
          });
        }
      };
      child.on('error', (e) => finish(`could not run ${command}: ${e.message}`, null, null));
      child.on('close', (code, signal) => finish(null, code, signal));
    });
  }
}
