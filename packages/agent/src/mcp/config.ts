/**
 * The tool server's launch config, and how to launch it.
 *
 * The runner writes a {@link ToolServerConfig} to a private temp file and points
 * the CLI's `--mcp-config` at a `longhand` stdio server whose command runs
 * `main.ts` under `tsx` with `--config <file>`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SessionSnapshot } from '../snapshot';
import { MCP_SERVER_NAME } from './server';

/** Everything the tool server process needs. */
export interface ToolServerConfig {
  configVersion: 1;
  snapshot: SessionSnapshot;
  /** The runner's loopback relay (events + search). */
  relay: { baseUrl: string; token: string };
  /** Whether `search_sources` can reach a `SourceSearch`. */
  search: boolean;
}

/** How to start the tool server process. */
export interface McpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Path of the stdio entry point. */
export const TOOL_SERVER_ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url));

/** The command that runs the tool server with a config file (Node + the tsx loader). */
export function toolServerLaunch(configPath: string): McpLaunch {
  const require = createRequire(import.meta.url);
  const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
  return {
    command: process.execPath,
    args: ['--import', tsxLoader, TOOL_SERVER_ENTRY, '--config', configPath],
  };
}

/** The JSON for `claude --mcp-config`: one stdio server named `longhand`. */
export function mcpConfigJson(launch: McpLaunch): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'stdio',
          command: launch.command,
          args: launch.args,
          env: launch.env ?? {},
        },
      },
    },
    null,
    2,
  );
}
