import { describe, expect, it } from 'vitest';
import { SseParser, interpretSse, isToolSignal, utilizationPercent, type SseEvent, type SseSignal } from './sse';

const ev = (type: string, obj: unknown) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
const textDelta = (text: string, index = 0) =>
  ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });

/** Feed `input` split at every position in `cuts` and collect all signals. */
function run(chunks: string[]): SseSignal[] {
  const p = new SseParser();
  const events: SseEvent[] = [];
  for (const c of chunks) events.push(...p.push(c));
  events.push(...p.flush());
  return events.flatMap(interpretSse);
}
const texts = (s: SseSignal[]) => s.filter((x) => x.kind === 'text').map((x) => (x as { text: string }).text).join('');

const STREAM =
  ev('message_start', { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } }) +
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret plan' } }) +
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) +
  textDelta('Hello, ', 1) +
  textDelta('wörld 🎉 ', 1) +
  textDelta('— done.', 1) +
  ev('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'x' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":' } }) +
  ev('message_limit', {
    type: 'message_limit',
    message_limit: {
      type: 'within_limit',
      windows: { '5h': { status: 'within_limit', utilization: 0.23, resets_at: 1790000000 }, '7d': { utilization: 0.41 } },
    },
  }) +
  ev('message_stop', { type: 'message_stop' });

describe('SseParser + interpretSse', () => {
  it('extracts text deltas; thinking is ignored; a tool call is flagged (M2)', () => {
    const s = run([STREAM]);
    expect(texts(s)).toBe('Hello, wörld 🎉 — done.');
    expect(JSON.stringify(s)).not.toContain('secret plan');
    expect(s.some((x) => x.kind === 'stop')).toBe(true);
    expect(s.filter(isToolSignal)).toEqual([
      { kind: 'tool', index: 2, id: null, name: 'x', rawName: 'x', connector: null, marked: false, standard: true, type: 'tool_use' },
      { kind: 'tool_input', index: 2 }, // its input_json_delta
    ]);
    // every block is accounted for by index (never its content)
    expect(s.filter((x) => x.kind === 'block')).toEqual([
      { kind: 'block', index: 0, type: 'thinking' },
      { kind: 'block', index: 1, type: 'text' },
    ]);
    expect(s.filter((x) => x.kind === 'block_stop')).toEqual([{ kind: 'block_stop', index: 0 }]);
    expect(s.filter((x) => x.kind === 'delta')).toEqual([{ kind: 'delta', index: 0, type: 'thinking_delta' }]);
    expect(s.find((x) => x.kind === 'text')).toEqual({ kind: 'text', text: 'Hello, ', index: 1 });
  });

  it('flags every kind of tool block, and stop_reason tool_use', () => {
    const tools = (block: object) =>
      run([ev('content_block_start', { type: 'content_block_start', index: 3, content_block: block })]).filter(isToolSignal);
    expect(tools({ type: 'tool_use', id: 'toolu_9', name: 'list_mcp_resources', input: {} })).toEqual([
      { kind: 'tool', index: 3, id: 'toolu_9', name: 'list_mcp_resources', rawName: 'list_mcp_resources', connector: null, marked: false, standard: true, type: 'tool_use' },
    ]);
    expect(tools({ type: 'server_tool_use', name: 'web_search' })).toMatchObject([{ kind: 'tool', standard: true }]);
    expect(tools({ type: 'mcp_tool_use', name: 'srv:gmail/search <x>' })).toEqual([
      { kind: 'tool', index: 3, id: null, name: 'srvgmailsearchx', rawName: 'srv:gmail/search <x>', connector: null, marked: true, standard: true, type: 'mcp_tool_use' },
    ]);
    // claude.ai labels its own tools (live shape): a label, not a connector marker
    expect(tools({ type: 'tool_use', name: 'conversation_search', integration_name: 'Search Past Conversations', integration_icon_url: 'https://x/y.png', icon_name: 'memory', message: 'Looking…' })).toMatchObject([
      { kind: 'tool', name: 'conversation_search', rawName: 'conversation_search', connector: 'Search Past Conversations', marked: false },
    ]);
    // an odd label is still a label (only whitespace-only counts as none)
    expect(tools({ type: 'tool_use', name: 'create_file', integration_name: '\u200b' })).toMatchObject([{ connector: '\u200b' }]);
    expect(tools({ type: 'tool_use', name: 'web_search', integration_name: '   ' })).toMatchObject([{ connector: null }]);
    expect(tools({ type: 'tool_use', name: 'create_event', mcp_server_url: 'https://mcp.example' })).toMatchObject([{ marked: true }]);
    expect(tools({ type: 'tool_result', tool_use_id: 'toolu_9', content: [] })).toEqual([
      { kind: 'tool_result', index: 3, toolUseId: 'toolu_9', name: 'tool_result', rawName: 'tool_result', standard: true, type: 'tool_result' },
    ]);
    expect(tools({ type: 'web_search_tool_result' })).toMatchObject([{ kind: 'tool_result', toolUseId: null, standard: true }]);
    expect(tools({ type: 'text', text: '' })).toHaveLength(0);
    expect(tools({ type: 'thinking', thinking: '' })).toHaveLength(0);
    const md = run([ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })]);
    expect(md).toEqual([{ kind: 'tool_stop' }]);
    expect(run([ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })])).toEqual([]);
  });

  // Ported from the round-6 review's PoC (sse.mts): shapes that used to yield nothing now say so.
  it('review PoC: unknown or non-standard tool shapes are reported, never dropped', () => {
    const one = (o: object) => run([ev(String((o as { type: string }).type), o)]);
    expect(one({ type: 'content_block_start', index: 1, content_block: { type: 'mcp_call', name: 'send_email' } })).toMatchObject([{ kind: 'tool', standard: false, type: 'mcp_call', rawName: 'send_email' }]);
    expect(one({ type: 'content_block_start', index: 1, content_block: { type: 'function_call', name: 'send_email' } })).toMatchObject([{ kind: 'tool', standard: false }]);
    expect(one({ type: 'content_block_start', index: 1, content_block: { type: 'function_call_result' } })).toMatchObject([{ kind: 'tool_result', standard: false }]);
    expect(one({ type: 'content_block_start', index: 1, content_block: { type: 'knowledge', name: 'x' } })).toEqual([{ kind: 'unknown', type: 'knowledge' }]);
    expect(one({ type: 'content_block_start', index: 1, content_block: {} })).toEqual([{ kind: 'unknown', type: 'untyped' }]);
    expect(one({ type: 'message_start', message: { content: [{ type: 'tool_use', name: 'send_email' }] } })).toEqual([{ kind: 'unknown', type: 'message_start_content' }]);
    expect(one({ type: 'message_start', message: { content: [] } })).toEqual([]);
    expect(one({ type: 'content_block_delta', index: 1, delta: { type: 'tool_input_delta', partial: '{}' } })).toEqual([{ kind: 'delta', index: 1, type: 'tool_input_delta' }]);
  });

  it('isKeepAlive: pings and empty events are not progress', async () => {
    const { isKeepAlive } = await import('./sse');
    expect(isKeepAlive({ event: 'ping', data: '{"type":"ping"}' })).toBe(true);
    expect(isKeepAlive({ event: 'message', data: '{"type": "ping"}' })).toBe(true);
    expect(isKeepAlive({ event: 'message', data: '' })).toBe(true);
    expect(isKeepAlive({ event: 'content_block_delta', data: '{"type":"content_block_delta","delta":{"type":"thinking_delta"}}' })).toBe(false);
  });

  it('is independent of chunk boundaries (split at every single character)', () => {
    const whole = run([STREAM]);
    expect(run([...STREAM])).toEqual(whole);
  });

  it('handles chunks split inside \\r\\n and CRLF / CR line endings', () => {
    const crlf = STREAM.replace(/\n/g, '\r\n');
    expect(texts(run([crlf]))).toBe('Hello, wörld 🎉 — done.');
    const parts: string[] = [];
    for (let i = 0; i < crlf.length; i += 7) parts.push(crlf.slice(i, i + 7));
    expect(texts(run(parts))).toBe('Hello, wörld 🎉 — done.');
    const cr = STREAM.replace(/\n/g, '\r');
    expect(texts(run([cr]))).toBe('Hello, wörld 🎉 — done.');
  });

  it('tolerates trailing spaces, missing space after "data:", and comments', () => {
    const s = run([
      ': keep-alive comment\n',
      'event: content_block_delta   \n',
      'data:{"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}   \n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"b "}}\t \n\n',
    ]);
    expect(texts(s)).toBe('ab ');
  });

  it('keeps meaningful spaces inside text deltas', () => {
    expect(texts(run([textDelta('  indented\n'), textDelta(' x ')]))).toBe('  indented\n x ');
  });

  it('flushes a final event with no trailing blank line / newline', () => {
    const s = run(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"tail"}}']);
    expect(texts(s)).toBe('tail');
  });

  it('parses several JSON objects on separate data lines of one event', () => {
    const s = run([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"1"}}\n' +
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"2"}}\n\n',
    ]);
    expect(texts(s)).toBe('12');
  });

  it('ignores garbage, [DONE] and unknown event types', () => {
    const s = run(['data: not json\n\n', 'data: [DONE]\n\n', ev('ping', { type: 'ping' })]);
    expect(s).toEqual([]);
  });

  it('reads message_limit windows (5h / 7d utilization, exceeded flag, reset time)', () => {
    const s = run([STREAM]).filter((x) => x.kind === 'limit');
    expect(s).toEqual([{ kind: 'limit', util5h: 0.23, util7d: 0.41, exceeded: false, resetsAt: 1790000000 }]);
    const ex = run([
      ev('message_limit', { type: 'message_limit', message_limit: { type: 'exceeded_limit', resetsAt: 1790001234, windows: {} } }),
    ]);
    expect(ex).toEqual([{ kind: 'limit', util5h: null, util7d: null, exceeded: true, resetsAt: 1790001234 }]);
  });

  it('surfaces SSE error events', () => {
    const s = run([ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })]);
    expect(s).toEqual([{ kind: 'error', errorType: 'overloaded_error', message: 'Overloaded' }]);
  });

  it('supports the legacy "completion" shape', () => {
    expect(texts(run([ev('completion', { type: 'completion', completion: 'old' })]))).toBe('old');
  });
});

describe('utilizationPercent', () => {
  it('treats 0..1 as a fraction and larger values as a percentage', () => {
    expect(utilizationPercent(0.234)).toBe(23);
    expect(utilizationPercent(0)).toBe(0);
    expect(utilizationPercent(1)).toBe(100);
    expect(utilizationPercent(57)).toBe(57);
    expect(utilizationPercent(null)).toBeNull();
    expect(utilizationPercent(-1)).toBeNull();
    expect(utilizationPercent(Number.NaN)).toBeNull();
  });
});
