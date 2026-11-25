/**
 * @longhand/agent — the AI editor's backend: context builder, system prompts,
 * the annotation-tool MCP server with validation and caps, annotation sinks,
 * model adapters (`claude -p` and a mock) and the session runner.
 *
 * Nothing in this package can emit a manuscript event. The only drafts it builds
 * are agent annotation events and the system `FeedbackSessionFailed`.
 */
export * from './drafts';
export * from './sink';
export * from './search';
export * from './snapshot';
export * from './format';
export * from './context';
export * from './executor';
export * from './writer-text';
export * from './relay';
export * from './runner';
export {
  SYSTEM_PROMPT_VERSION,
  systemPrompt,
  REVIEW_SYSTEM_PROMPT_V1,
  DISCUSS_SYSTEM_PROMPT_V1,
  REVIEW_SYSTEM_PROMPT_V2,
  DISCUSS_SYSTEM_PROMPT_V2,
  REVIEW_SYSTEM_PROMPT_V3,
  DISCUSS_SYSTEM_PROMPT_V3,
} from './prompts';
export {
  MCP_SERVER_NAME,
  MCP_TOOL_PREFIX,
  createAnnotationMcpServer,
  toCallToolResult,
} from './mcp/server';
export {
  TOOL_SERVER_ENTRY,
  mcpConfigJson,
  toolServerLaunch,
  type McpLaunch,
  type ToolServerConfig,
} from './mcp/config';
export * from './adapters/types';
export * from './adapters/stream-json';
export {
  ClaudeCliAdapter,
  ISOLATION_ARGS,
  buildClaudeArgs,
  defaultClaudeCommand,
  type ClaudeCliAdapterOptions,
} from './adapters/claude-cli';
export { MockModelAdapter, type MockScript, type MockStep } from './adapters/mock';
