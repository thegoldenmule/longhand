/**
 * Stdio entry point of the annotation-tool MCP server:
 * `node --import tsx main.ts --config <file>`.
 *
 * Reads the session config, validates calls against its snapshot and sends
 * accepted drafts to the runner's relay. Stdout carries the MCP protocol only;
 * diagnostics go to stderr. Exits when stdin closes.
 */
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ToolExecutor } from '../executor';
import { RelaySourceSearch } from '../relay';
import { HttpAnnotationSink } from '../sink';
import type { ToolServerConfig } from './config';
import { createAnnotationMcpServer } from './server';

function configPath(argv: readonly string[]): string {
  const i = argv.indexOf('--config');
  const p = i >= 0 ? argv[i + 1] : undefined;
  if (!p) throw new Error('usage: main.ts --config <file>');
  return p;
}

async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(configPath(process.argv), 'utf8')) as ToolServerConfig;
  if (config.configVersion !== 1) throw new Error('unsupported tool server config');
  const { snapshot, relay } = config;
  const sink = new HttpAnnotationSink({
    baseUrl: relay.baseUrl,
    feedbackSessionId: snapshot.feedbackSessionId,
    token: relay.token,
  });
  const search = config.search
    ? new RelaySourceSearch(relay.baseUrl, snapshot.feedbackSessionId, relay.token)
    : null;
  const executor = new ToolExecutor({ snapshot, sink, search });
  const server = createAnnotationMcpServer(executor, (o) => {
    const status = o.result.ok ? 'ok' : `rejected ${o.result.error.code}`;
    process.stderr.write(`[longhand-mcp] ${o.tool}: ${status}\n`);
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => process.exit(0);
  process.stdin.on('end', () => process.exit(0));
  await server.connect(transport);
}

main().catch((e: unknown) => {
  process.stderr.write(`[longhand-mcp] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
