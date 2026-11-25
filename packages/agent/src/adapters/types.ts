/** Model adapter interface shared by the `claude` CLI adapter and the mock. */
import type { AgentSessionKind } from '@longhand/schema';
import type { McpLaunch } from '../mcp/config';

/** Token usage reported by the model run. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** A normalized event from a model run (parsed from stream-json, or produced by the mock). */
export type ModelEvent =
  | {
      type: 'init';
      sessionId: string | null;
      model: string | null;
      tools: string[];
      mcpServers: Array<{ name: string; status: string }>;
    }
  | { type: 'text'; text: string }
  | { type: 'thinking' }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; toolUseId: string; isError: boolean; text: string }
  | {
      type: 'result';
      ok: boolean;
      subtype: string;
      text: string | null;
      usage: ModelUsage | null;
      costUsd: number | null;
      durationMs: number | null;
      numTurns: number | null;
      errors: string[];
    }
  | { type: 'other'; raw: Record<string, unknown> }
  | { type: 'parse-error'; line: string; message: string };

/** One tool call and what came back. */
export interface ToolCallRecord {
  id: string;
  /** As the model named it (`mcp__longhand__comment` for the CLI, bare for the mock). */
  name: string;
  input: unknown;
  result: { isError: boolean; text: string } | null;
}

/** What an adapter is asked to run. */
export interface ModelRunInput {
  sessionKind: AgentSessionKind;
  model: string;
  systemPrompt: string;
  /** The user message. */
  prompt: string;
  /** How to start the annotation-tool MCP server, and the `--mcp-config` file describing it. */
  mcp: { launch: McpLaunch; configPath: string };
  /** Full tool names the model may call (`mcp__longhand__*`). */
  allowedTools: string[];
  /** Working directory for the model process (a private temp dir). */
  cwd: string;
  /** Wall-clock limit; the adapter kills the run when it passes. */
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: ModelEvent) => void;
}

/** How a model run ended. */
export interface ModelRunResult {
  status: 'completed' | 'error' | 'timeout' | 'aborted';
  /** Set when status is not `completed`. */
  error: string | null;
  finalText: string | null;
  toolCalls: ToolCallRecord[];
  usage: ModelUsage | null;
  costUsd: number | null;
  durationMs: number;
  /** Last lines of the model process's stderr, if any. */
  stderr: string;
}

/** Runs one model session against the annotation-tool server. */
export interface ModelAdapter {
  readonly name: string;
  run(input: ModelRunInput): Promise<ModelRunResult>;
}
