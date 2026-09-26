/**
 * Incremental Server-Sent Events parser for claude.ai's completion stream, plus an interpreter for
 * the events it carries: Anthropic Messages streaming events (`content_block_delta` / `text_delta`,
 * `message_stop`, `error`) and claude.ai's own `message_limit` (usage windows).
 *
 * Chunks may split anywhere (mid-line, mid-`\r\n`, mid-JSON); the parser buffers until a full line.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];

  /** Feed a decoded text chunk; returns the events completed by it. */
  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    this.buf += chunk;
    for (;;) {
      const n = this.buf.indexOf('\n');
      const r = this.buf.indexOf('\r');
      let end: number;
      let skip = 1;
      if (r >= 0 && (n < 0 || r < n)) {
        if (r === this.buf.length - 1) break; // a "\r\n" may be split across chunks: wait
        end = r;
        if (this.buf[r + 1] === '\n') skip = 2;
      } else if (n >= 0) {
        end = n;
      } else {
        break;
      }
      const line = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + skip);
      this.line(line, out);
    }
    return out;
  }

  /** End of stream: process a trailing unterminated line and dispatch any pending event. */
  flush(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) {
      const rest = this.buf.replace(/\r$/, '');
      this.buf = '';
      if (rest) this.line(rest, out);
    }
    this.dispatch(out);
    return out;
  }

  private dispatch(out: SseEvent[]) {
    if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n') });
    this.event = '';
    this.data = [];
  }

  private line(line: string, out: SseEvent[]) {
    if (line === '') return this.dispatch(out);
    if (line.startsWith(':')) return; // comment / keep-alive
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value.trim();
    else if (field === 'data') this.data.push(value);
    // id / retry / unknown fields are irrelevant here
  }
}

export type SseSignal =
  /** Answer text (a `text_delta`); `index` = its content block. */
  | { kind: 'text'; text: string; index: number | null }
  | {
      kind: 'limit';
      util5h: number | null;
      util7d: number | null;
      exceeded: boolean;
      resetsAt: number | null;
    }
  | { kind: 'error'; errorType: string; message: string }
  | { kind: 'stop' }
  /**
   * Claude started a tool call: a content block whose type says "tool" (or call / function / mcp) and
   * isn't a result. `standard`: one of the known tool-use block types (TOOL_USE_TYPES); full mode
   * treats any other as unknown. `id` = the block's tool_use id; `name` is id-free (for logs);
   * `rawName` (≤ 200 chars) is for classifying it (lib/tools.ts); `connector` / `marked`: what the
   * block says about a connector (a present label is kept even when it's odd, never dropped).
   */
  | {
      kind: 'tool';
      index: number | null;
      id: string | null;
      name: string;
      rawName: string;
      connector: string | null;
      marked: boolean;
      standard: boolean;
      type: string;
    }
  /** A tool call's input streaming in (input_json_delta) for block `index`. */
  | { kind: 'tool_input'; index: number | null }
  /** A tool's result (`*tool_result` content block): the call `toolUseId` finished. */
  | { kind: 'tool_result'; index: number | null; toolUseId: string | null; name: string; rawName: string; standard: boolean; type: string }
  /** The model's message ended asking for a tool (`stop_reason: "tool_use"`). */
  | { kind: 'tool_stop' }
  /** A known non-tool content block started (text, thinking). */
  | { kind: 'block'; index: number | null; type: string }
  /** A content block ended. */
  | { kind: 'block_stop'; index: number | null }
  /** Any other delta (thinking, signature, citations, or a type this code doesn't know). */
  | { kind: 'delta'; index: number | null; type: string }
  /** Content this code doesn't know: an unknown content block type, or content in message_start. */
  | { kind: 'unknown'; type: string };

/** Any of the tool signals (locked mode stops the answer at the first one). */
export const isToolSignal = (s: SseSignal): s is Extract<SseSignal, { kind: 'tool' | 'tool_input' | 'tool_result' | 'tool_stop' }> =>
  s.kind === 'tool' || s.kind === 'tool_input' || s.kind === 'tool_result' || s.kind === 'tool_stop';

/** Parse an event's data as JSON. Tolerates several JSON objects on separate data lines. */
function parseData(data: string): unknown[] {
  const s = data.trim();
  if (!s || s === '[DONE]') return [];
  try {
    return [JSON.parse(s)];
  } catch {
    const out: unknown[] = [];
    for (const part of s.split('\n')) {
      try {
        out.push(JSON.parse(part));
      } catch {
        /* not JSON: ignore */
      }
    }
    return out;
  }
}

/** Content blocks that are (part of) a tool call or its result (locked mode stops at any of them). */
const TOOL_BLOCK_RE = /tool|mcp|function|call/i;
/** …of which these are results: tool_result, web_search_tool_result, mcp_tool_result, … */
const TOOL_RESULT_RE = /result/i;
/** The tool-use block types full mode classifies; any other tool-ish block is unknown there. */
export const TOOL_USE_TYPES: ReadonlySet<string> = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use']);
/** Result block types full mode matches to their call. */
const STANDARD_RESULT_RE = /^[a-z_]*tool_result$/;
/** Non-tool content blocks an answer is made of. Anything else is unknown (full mode stops there). */
export const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set(['text', 'thinking', 'redacted_thinking']);
/** A tool name for the log: id-free characters only, capped. */
const toolName = (x: unknown, fallback: string) =>
  (typeof x === 'string' && x ? x : fallback).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'tool';
/** A block type for the log. */
const typeName = (t: string) => t.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'block';
const indexOf = (d: Record<string, unknown>) => (typeof d.index === 'number' && Number.isInteger(d.index) ? d.index : null);
/**
 * Fields a claude.ai tool_use block may name its integration in. claude.ai labels its own tools too
 * (live 2026-09-25: conversation_search → "Search Past Conversations", tool_search → "Tool Search"),
 * so a label alone doesn't say "connector"; lib/tools.ts knows the built-in labels.
 */
const CONNECTOR_FIELDS = ['integration_name', 'mcp_server_name', 'server_name', 'server_label', 'connector_name'] as const;
/** Fields whose presence says "an MCP server's tool". */
const CONNECTOR_MARKERS = ['mcp_server_name', 'mcp_server_url', 'server_name', 'server_label', 'server_url', 'connector_name'] as const;

/**
 * An SSE keep-alive (`event: ping` / `{"type":"ping"}`, sent while claude.ai waits, e.g. on a stuck
 * tool call): not a sign that the answer is progressing.
 */
export function isKeepAlive(ev: SseEvent): boolean {
  if (ev.event === 'ping') return true;
  const s = ev.data.trim();
  if (!s) return true;
  const d = parseData(s);
  return d.length > 0 && d.every((x) => obj(x)?.type === 'ping');
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const obj = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

/**
 * What an SSE event means for us: text deltas, usage, errors, the end, tool calls (a tool call's
 * start, its input streaming in, its result, `stop_reason: "tool_use"`), and enough about every
 * other content block (its start, its deltas, its end, or that it is unknown) to track tool calls
 * by block index and fail closed on shapes this code doesn't know. Never any block's content.
 */
export function interpretSse(ev: SseEvent): SseSignal[] {
  const out: SseSignal[] = [];
  for (const raw of parseData(ev.data)) {
    const d = obj(raw);
    if (!d) continue;
    const type = typeof d.type === 'string' ? d.type : ev.event;
    if (type === 'content_block_delta') {
      const delta = obj(d.delta);
      const dt = typeof delta?.type === 'string' ? delta.type : '';
      if (dt === 'text_delta') {
        if (typeof delta?.text === 'string' && delta.text) out.push({ kind: 'text', text: delta.text, index: indexOf(d) });
      } else if (dt === 'input_json_delta') {
        out.push({ kind: 'tool_input', index: indexOf(d) });
      } else {
        out.push({ kind: 'delta', index: indexOf(d), type: typeName(dt || 'delta') });
      }
    } else if (type === 'content_block_start') {
      const cb = obj(d.content_block);
      const t = typeof cb?.type === 'string' ? cb.type : '';
      const index = indexOf(d);
      const str = (k: string) => (typeof cb?.[k] === 'string' ? (cb[k] as string) : '');
      const rawName = (str('name') || t).slice(0, 200);
      if (TOOL_BLOCK_RE.test(t)) {
        if (TOOL_RESULT_RE.test(t)) {
          out.push({
            kind: 'tool_result',
            index,
            toolUseId: str('tool_use_id') || null,
            name: toolName(cb?.name, t),
            rawName,
            standard: STANDARD_RESULT_RE.test(t),
            type: typeName(t),
          });
        } else {
          // A label is kept as given (trimmed): one that is only whitespace carries nothing, but an
          // odd one (symbols, zero-width characters) is still a label, never read as "no label".
          const connector = CONNECTOR_FIELDS.map((k) => str(k).trim()).find(Boolean) || null;
          out.push({
            kind: 'tool',
            index,
            id: str('id') || null,
            name: toolName(cb?.name, t),
            rawName,
            connector: connector ? connector.slice(0, 80) : null,
            marked: /mcp/i.test(t) || CONNECTOR_MARKERS.some((k) => !!str(k).trim()),
            standard: TOOL_USE_TYPES.has(t),
            type: typeName(t),
          });
        }
      } else if (KNOWN_BLOCK_TYPES.has(t)) {
        out.push({ kind: 'block', index, type: t });
      } else {
        out.push({ kind: 'unknown', type: typeName(t || 'untyped') });
      }
    } else if (type === 'content_block_stop') {
      out.push({ kind: 'block_stop', index: indexOf(d) });
    } else if (type === 'message_start') {
      // An answer's message starts empty; content here would skip the block events above.
      const content = obj(d.message)?.content;
      if (Array.isArray(content) && content.length) out.push({ kind: 'unknown', type: 'message_start_content' });
    } else if (type === 'message_delta') {
      if (obj(d.delta)?.stop_reason === 'tool_use') out.push({ kind: 'tool_stop' });
    } else if (type === 'completion') {
      // legacy (non-"messages" rendering mode) shape
      if (typeof d.completion === 'string' && d.completion) out.push({ kind: 'text', text: d.completion, index: null });
    } else if (type === 'message_limit') {
      const ml = obj(d.message_limit);
      if (!ml) continue;
      const windows = obj(ml.windows);
      const w5 = obj(windows?.['5h']);
      const w7 = obj(windows?.['7d']);
      out.push({
        kind: 'limit',
        util5h: num(w5?.utilization),
        util7d: num(w7?.utilization),
        exceeded: ml.type === 'exceeded_limit',
        resetsAt: num(ml.resetsAt) ?? num(w5?.resets_at),
      });
    } else if (type === 'error') {
      const e = obj(d.error);
      out.push({
        kind: 'error',
        errorType: typeof e?.type === 'string' ? e.type : 'error',
        message: typeof e?.message === 'string' ? e.message : '',
      });
    } else if (type === 'message_stop') {
      out.push({ kind: 'stop' });
    }
  }
  return out;
}

/**
 * Utilization as a whole percent. claude.ai reports it as a 0–1 fraction; values above 1 are
 * treated as already being a percentage (defensive, in case the format changes).
 */
export function utilizationPercent(u: number | null | undefined): number | null {
  if (typeof u !== 'number' || !Number.isFinite(u) || u < 0) return null;
  return Math.round(u <= 1 ? u * 100 : u);
}
