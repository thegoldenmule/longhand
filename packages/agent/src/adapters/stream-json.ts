/**
 * Parser for `claude -p --output-format stream-json --verbose`: newline-delimited
 * JSON messages (`system`/`init`, `assistant`, `user` tool results, `result`).
 * Tolerant: unknown message types become `other`, bad lines become `parse-error`.
 */
import type { ModelEvent, ModelUsage } from './types';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function usageOf(u: unknown): ModelUsage | null {
  if (!isObj(u)) return null;
  return {
    inputTokens: num(u.input_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
    cacheReadInputTokens: num(u.cache_read_input_tokens) ?? 0,
    cacheCreationInputTokens: num(u.cache_creation_input_tokens) ?? 0,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Maps one parsed stream-json message to zero or more events. */
export function eventsFromMessage(msg: Json): ModelEvent[] {
  switch (msg.type) {
    case 'system': {
      if (msg.subtype !== 'init') return [{ type: 'other', raw: msg }];
      const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
      return [
        {
          type: 'init',
          sessionId: str(msg.session_id),
          model: str(msg.model),
          tools: Array.isArray(msg.tools)
            ? msg.tools.filter((t): t is string => typeof t === 'string')
            : [],
          mcpServers: servers.filter(isObj).map((s) => ({
            name: str(s.name) ?? '',
            status: str(s.status) ?? 'unknown',
          })),
        },
      ];
    }
    case 'assistant': {
      const content =
        isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      const out: ModelEvent[] = [];
      for (const block of content) {
        if (!isObj(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          out.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          out.push({
            type: 'tool-call',
            id: str(block.id) ?? '',
            name: str(block.name) ?? '',
            input: block.input ?? {},
          });
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          out.push({ type: 'thinking' });
        }
      }
      return out;
    }
    case 'user': {
      const content =
        isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      const out: ModelEvent[] = [];
      for (const block of content) {
        if (!isObj(block) || block.type !== 'tool_result') continue;
        out.push({
          type: 'tool-result',
          toolUseId: str(block.tool_use_id) ?? '',
          isError: block.is_error === true,
          text: toolResultText(block.content),
        });
      }
      return out;
    }
    case 'result': {
      const errors = Array.isArray(msg.errors)
        ? msg.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
        : [];
      return [
        {
          type: 'result',
          ok: msg.is_error !== true && msg.subtype === 'success',
          subtype: str(msg.subtype) ?? 'unknown',
          text: str(msg.result),
          usage: usageOf(msg.usage),
          costUsd: num(msg.total_cost_usd),
          durationMs: num(msg.duration_ms),
          numTurns: num(msg.num_turns),
          errors,
        },
      ];
    }
    default:
      return [{ type: 'other', raw: msg }];
  }
}

/** Incremental NDJSON parser: feed chunks, get events. */
export class StreamJsonParser {
  private buffer = '';

  /** Feeds a chunk of stdout; returns events for every complete line. */
  push(chunk: string): ModelEvent[] {
    this.buffer += chunk;
    const out: ModelEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      out.push(...parseLine(line));
    }
    return out;
  }

  /** Flushes a trailing line without a newline. */
  end(): ModelEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    return parseLine(rest);
  }
}

function parseLine(line: string): ModelEvent[] {
  const t = line.trim();
  if (!t) return [];
  let msg: unknown;
  try {
    msg = JSON.parse(t);
  } catch (e) {
    return [
      {
        type: 'parse-error',
        line: t.slice(0, 500),
        message: e instanceof Error ? e.message : String(e),
      },
    ];
  }
  if (!isObj(msg))
    return [{ type: 'parse-error', line: t.slice(0, 500), message: 'not a JSON object' }];
  return eventsFromMessage(msg);
}

/** Parses a whole recorded stream. */
export function parseStreamJson(text: string): ModelEvent[] {
  const p = new StreamJsonParser();
  return [...p.push(text), ...p.end()];
}
