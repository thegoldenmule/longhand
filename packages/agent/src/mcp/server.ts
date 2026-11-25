/**
 * The annotation-tool MCP server. Exposes exactly `toolsForSession(kind)` with the
 * schema's descriptions and JSON Schemas, and routes every call through a
 * {@link ToolExecutor}. The CLI sees the tools as `mcp__longhand__<tool>`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, TOOL_JSON_SCHEMAS } from '@longhand/schema';
import type { ToolCallOutcome, ToolExecutor } from '../executor';

/** MCP server name. Tools appear to the CLI as `mcp__longhand__<tool>`. */
export const MCP_SERVER_NAME = 'longhand';

/** Prefix the CLI puts on this server's tool names. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** Formats an outcome as an MCP tool result. Errors use `isError` so the model retries. */
export function toCallToolResult(outcome: ToolCallOutcome): CallToolResult {
  const r = outcome.result;
  if (r.ok) return { content: [{ type: 'text', text: r.content }] };
  return {
    content: [{ type: 'text', text: `Rejected (${r.error.code}): ${r.error.message}` }],
    isError: true,
  };
}

/** Creates the MCP server for one session. `onCall` observes every outcome. */
export function createAnnotationMcpServer(
  executor: ToolExecutor,
  onCall?: (outcome: ToolCallOutcome) => void,
): Server {
  // The low-level Server is used on purpose: the tool schemas are plain JSON Schemas
  // from @longhand/schema, and validation errors must be ours, worded for the model.
  const server = new Server(
    { name: MCP_SERVER_NAME, version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Longhand annotation tools. None of them writes manuscript text; they record comments, questions, suggestions and proposals for the writer.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: executor.tools.map((name) => ({
      name,
      description: TOOLS[name].description,
      inputSchema: TOOL_JSON_SCHEMAS[name] as { type: 'object'; [k: string]: unknown },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const outcome = await executor.call(req.params.name, req.params.arguments ?? {});
    onCall?.(outcome);
    return toCallToolResult(outcome);
  });
  return server;
}
