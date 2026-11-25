/**
 * A scripted model for tests. It starts the real annotation-tool server exactly
 * as the CLI would (stdio, from the run's MCP launch), lists its tools, and
 * replays a script of tool calls, invalid ones included, so retries, caps and the
 * whole relay path are exercised without a live model.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_TOOL_PREFIX } from '../mcp/server';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRunInput,
  ModelRunResult,
  ToolCallRecord,
} from './types';

/** One scripted step. Tool names are bare (`comment`); the mock adds the MCP prefix in events. */
export type MockStep =
  | { tool: string; input: unknown }
  | { text: string }
  /** End the run as a model error. */
  | { fail: string }
  /** Never finish (until the timeout or abort). */
  | { hang: true }
  | { delayMs: number };

/** A script, or a function of the run input (to read ids from the prompt). */
export type MockScript = readonly MockStep[] | ((input: ModelRunInput) => readonly MockStep[]);

/** Replays {@link MockScript}s. Records every run's input and the tools it saw. */
export class MockModelAdapter implements ModelAdapter {
  readonly name = 'mock';
  readonly runs: ModelRunInput[] = [];
  /** Tool names the server listed, per run (bare names). */
  readonly listedTools: string[][] = [];

  constructor(private readonly script: MockScript) {}

  async run(input: ModelRunInput): Promise<ModelRunResult> {
    this.runs.push(input);
    const started = Date.now();
    // A signal aborted before the run starts never fires 'abort' again: stop now,
    // without starting the tool server.
    if (input.signal?.aborted) {
      return {
        status: 'aborted',
        error: 'model run aborted',
        toolCalls: [],
        usage: null,
        costUsd: null,
        durationMs: 0,
        stderr: '',
        finalText: null,
      };
    }
    const toolCalls: ToolCallRecord[] = [];
    const emit = (e: ModelEvent) => input.onEvent?.(e);
    let stderr = '';
    const transport = new StdioClientTransport({
      command: input.mcp.launch.command,
      args: input.mcp.launch.args,
      env: { ...(process.env as Record<string, string>), ...(input.mcp.launch.env ?? {}) },
      cwd: input.cwd,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-4000);
    });
    const client = new Client({ name: 'longhand-mock-model', version: '1.0.0' });

    let stop: (r: { status: 'timeout' | 'aborted'; error: string }) => void = () => undefined;
    const stopped = new Promise<{ status: 'timeout' | 'aborted'; error: string }>((r) => {
      stop = r;
    });
    const timer = setTimeout(
      () => stop({ status: 'timeout', error: `model run exceeded ${input.timeoutMs} ms` }),
      input.timeoutMs,
    );
    const onAbort = () => stop({ status: 'aborted', error: 'model run aborted' });
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const base = () => ({
      toolCalls,
      usage: null,
      costUsd: null,
      durationMs: Date.now() - started,
      stderr: stderr.trim(),
    });

    const play = async (): Promise<ModelRunResult> => {
      await client.connect(transport);
      const listed = (await client.listTools()).tools.map((t) => t.name);
      this.listedTools.push(listed);
      emit({
        type: 'init',
        sessionId: null,
        model: input.model,
        tools: listed.map((n) => `${MCP_TOOL_PREFIX}${n}`),
        mcpServers: [{ name: 'longhand', status: 'connected' }],
      });
      const steps = typeof this.script === 'function' ? this.script(input) : this.script;
      let n = 0;
      let lastText: string | null = null;
      for (const step of steps) {
        if ('hang' in step) {
          await new Promise(() => undefined);
          continue;
        }
        if ('delayMs' in step) {
          await new Promise((r) => setTimeout(r, step.delayMs));
          continue;
        }
        if ('fail' in step) {
          emit({
            type: 'result',
            ok: false,
            subtype: 'error_during_execution',
            text: null,
            usage: null,
            costUsd: null,
            durationMs: Date.now() - started,
            numTurns: n,
            errors: [step.fail],
          });
          return {
            ...base(),
            status: 'error',
            error: `model run failed (${step.fail})`,
            finalText: null,
          };
        }
        if ('text' in step) {
          lastText = step.text;
          emit({ type: 'text', text: step.text });
          continue;
        }
        const id = `mock_${++n}`;
        const name = `${MCP_TOOL_PREFIX}${step.tool}`;
        const rec: ToolCallRecord = { id, name, input: step.input, result: null };
        toolCalls.push(rec);
        emit({ type: 'tool-call', id, name, input: step.input });
        const res = await client.callTool({
          name: step.tool,
          arguments: step.input as Record<string, unknown>,
        });
        const content = Array.isArray(res.content) ? res.content : [];
        const text = content
          .map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : ''))
          .join('\n');
        rec.result = { isError: res.isError === true, text };
        emit({ type: 'tool-result', toolUseId: id, isError: res.isError === true, text });
      }
      emit({
        type: 'result',
        ok: true,
        subtype: 'success',
        text: lastText,
        usage: null,
        costUsd: null,
        durationMs: Date.now() - started,
        numTurns: n,
        errors: [],
      });
      return { ...base(), status: 'completed', error: null, finalText: lastText };
    };

    try {
      const outcome = await Promise.race([
        play().catch((e: unknown): ModelRunResult => ({
          ...base(),
          status: 'error',
          error: `mock model failed: ${e instanceof Error ? e.message : String(e)}`,
          finalText: null,
        })),
        stopped.then((s): ModelRunResult => ({ ...base(), ...s, finalText: null })),
      ]);
      return outcome;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      await client.close().catch(() => undefined);
    }
  }
}
