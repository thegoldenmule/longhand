import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOLS, TOOL_JSON_SCHEMAS, toolsForSession } from '@longhand/schema';
import {
  InMemoryAnnotationSink,
  SessionRelay,
  StaticSourceSearch,
  buildReviewContext,
  mcpConfigJson,
  toolServerLaunch,
  type ToolServerConfig,
} from './index';
import { docRequest, makeState } from './fixtures.test-helpers';

type CallResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const textOf = (r: CallResult) => r.content.map((c) => c.text ?? '').join('\n');

describe('annotation MCP server over stdio', () => {
  const state = makeState();
  const ctx = buildReviewContext({
    state,
    request: docRequest({ intensity: 'light' }),
    feedbackSessionId: 'fs-mcp',
  });
  const sink = new InMemoryAnnotationSink();
  const search = new StaticSourceSearch([
    {
      csl: { id: 'c1', type: 'book', title: 'Rain', ISBN: '9781234567897' },
      provider: 'openlibrary',
      url: null,
    },
  ]);
  const relay = new SessionRelay({
    projectId: state.projectId,
    feedbackSessionId: 'fs-mcp',
    sessionKind: 'review',
    intensity: 'light',
    sink,
    search,
  });
  let dir = '';
  let client: Client;
  let configPath = '';

  beforeAll(async () => {
    const addr = await relay.start();
    dir = await mkdtemp(join(tmpdir(), 'longhand-mcp-test-'));
    configPath = join(dir, 'tool-server.json');
    const config: ToolServerConfig = {
      configVersion: 1,
      snapshot: ctx.snapshot,
      relay: addr,
      search: true,
    };
    await writeFile(configPath, JSON.stringify(config));
    const launch = toolServerLaunch(configPath);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({ command: launch.command, args: launch.args, stderr: 'ignore' }),
    );
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await relay.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('lists exactly the review tools with the schema JSON Schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(toolsForSession('review'));
    for (const t of tools) {
      const name = t.name as keyof typeof TOOLS;
      expect(t.description).toBe(TOOLS[name].description);
      expect(t.inputSchema).toEqual(TOOL_JSON_SCHEMAS[name]);
    }
    expect(tools.map((t) => t.name)).not.toContain('answer_discussion');
  });

  it('serves read tools from the snapshot', async () => {
    const r = (await client.callTool({
      name: 'read_document',
      arguments: { documentId: 'ch1' },
    })) as CallResult;
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('[p2.s1] The rain fell sideways.');
  });

  it('rejects an invalid call with a fixable message, then accepts the corrected retry', async () => {
    const bad = (await client.callTool({
      name: 'comment',
      arguments: {
        anchor: { documentId: 'ch1', sentenceId: 'p2.s1', quote: 'rain fell slantwise' },
        category: 'clarity',
        severity: 'minor',
        body: 'Unclear.',
      },
    })) as CallResult;
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^Rejected \(quote-not-found\): .*Copy it exactly/);
    expect(sink.drafts).toHaveLength(0);

    const good = (await client.callTool({
      name: 'comment',
      arguments: {
        anchor: { documentId: 'ch1', sentenceId: 'p2.s1', quote: 'rain fell sideways' },
        category: 'clarity',
        severity: 'minor',
        body: 'Unclear.',
      },
    })) as CallResult;
    expect(good.isError).toBeFalsy();
    expect(textOf(good)).toMatch(/^Recorded CommentAdded .*Left this session: 4 items/);
    expect(sink.drafts.map((d) => d.draft.type)).toEqual(['CommentAdded']);
    expect(relay.accepted).toHaveLength(1);
  });

  it('proxies search_sources to the injected SourceSearch through the relay', async () => {
    const r = (await client.callTool({
      name: 'search_sources',
      arguments: { query: 'rain and mood' },
    })) as CallResult;
    expect(r.isError).toBeFalsy();
    expect(search.queries).toEqual(['rain and mood']);
    const last = sink.drafts[sink.drafts.length - 1]!.draft;
    expect(last.type).toBe('SourceSurfaced');
    // The provider the search reported survives the relay.
    if (last.type === 'SourceSurfaced') {
      expect(last.payload.candidates.map((c) => c.provider)).toEqual(['openlibrary']);
    }
  });

  it('finish_review ends the session; later calls are refused', async () => {
    const fin = (await client.callTool({
      name: 'finish_review',
      arguments: { summary: 'Quiet and controlled.', strengths: ['Restraint'], topPriorities: [] },
    })) as CallResult;
    expect(fin.isError).toBeFalsy();
    expect(relay.finished).toBe(true);
    const after = (await client.callTool({
      name: 'ask_question',
      arguments: { question: 'One more?' },
    })) as CallResult;
    expect(after.isError).toBe(true);
    expect(textOf(after)).toMatch(/session-finished/);
    expect(sink.drafts.map((d) => d.draft.type)).toEqual([
      'CommentAdded',
      'SourceSurfaced',
      'ReviewFinished',
    ]);
  });

  it('writes a --mcp-config naming the longhand stdio server', () => {
    const cfg = JSON.parse(mcpConfigJson(toolServerLaunch(configPath))) as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(Object.keys(cfg.mcpServers)).toEqual(['longhand']);
    expect(cfg.mcpServers.longhand?.type).toBe('stdio');
    expect(cfg.mcpServers.longhand?.args).toContain(configPath);
  });
});
