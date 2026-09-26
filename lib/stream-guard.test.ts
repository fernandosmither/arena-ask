import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeError, ToolHandoff, streamCompletion, type CompletionOpts } from './claude';

/**
 * Full mode's stream guard (streamCompletion, toolPolicy 'guard'): tool calls tracked per content
 * block, fail closed on shapes it can't account for. The first four cases are ported from the
 * round-6 review's PoC (stall.test.ts); each of them used to end in an answer (or no stall).
 */

type Step = { at: number; data?: object; ping?: boolean };

function sseStream(steps: Step[], closeAfter = true): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const timers: ReturnType<typeof setTimeout>[] = [];
  return new ReadableStream({
    start(c) {
      const last = Math.max(0, ...steps.map((s) => s.at));
      if (closeAfter) timers.push(setTimeout(() => { try { c.close(); } catch { /* cancelled */ } }, last + 30));
      for (const s of steps) {
        timers.push(
          setTimeout(() => {
            try {
              c.enqueue(enc.encode(s.ping ? 'event: ping\ndata: {"type":"ping"}\n\n' : `event: x\ndata: ${JSON.stringify(s.data)}\n\n`));
            } catch {
              /* cancelled */
            }
          }, s.at),
        );
      }
    },
    cancel() {
      timers.forEach(clearTimeout);
    },
  });
}

const start = (i: number, name: string, extra: object = {}) => ({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name, input: {}, ...extra } });
const stop = (i: number) => ({ type: 'content_block_stop', index: i });
const result = (i: number, forIndex: number | null, t = 'tool_result') => ({
  type: 'content_block_start',
  index: i,
  content_block: { type: t, ...(forIndex === null ? {} : { tool_use_id: `toolu_${forIndex}` }), content: [] },
});
const textBlock = (i: number) => ({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
const text = (i: number, t: string) => ({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } });
const input = (i: number) => ({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: '{' } });
const thinking = (i: number) => ({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: 'hm' } });
const msgStop = { type: 'message_stop' };
const pings = (from: number, n: number, every = 20): Step[] => Array.from({ length: n }, (_, k) => ({ at: from + k * every, ping: true }));

function mockFetch(steps: Step[], closeAfter = true) {
  vi.stubGlobal('fetch', async () => new Response(sseStream(steps, closeAfter), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
}
const base: CompletionOpts = { org: 'o', convUuid: 'c', prompt: 'p', parentUuid: 'x', model: 'm', assistantUuid: 'a', onText: () => {}, toolPolicy: 'guard', stallMs: 100, deadlineMs: 2000, toolDeadlineMs: 3000 };
const runGuard = (over: Partial<CompletionOpts> = {}) => streamCompletion({ ...base, ...over }).catch((e: unknown) => e);

afterEach(() => vi.unstubAllGlobals());

describe('review PoCs: the stream guard fails closed', () => {
  it('parallel reads: A\'s result settles only A; B, stuck, is handed off as a stall', async () => {
    mockFetch([{ at: 0, data: start(1, 'web_search') }, { at: 5, data: stop(1) }, { at: 10, data: start(2, 'conversation_search') }, { at: 15, data: stop(2) }, { at: 30, data: result(3, 1, 'web_search_tool_result') }, ...pings(60, 30)]);
    const e = await runGuard();
    expect(e).toBeInstanceOf(ToolHandoff);
    expect(e).toMatchObject({ reason: 'stall', tool: { name: 'conversation_search' }, call: { id: 'toolu_2', rawName: 'conversation_search' } });
  });

  it('a single stuck read: stall handoff (control)', async () => {
    mockFetch([{ at: 0, data: start(1, 'conversation_search') }, ...pings(20, 30)]);
    expect(await runGuard()).toMatchObject({ reason: 'stall', tool: { name: 'conversation_search' } });
  });

  it('an unknown block type carrying a tool call is stopped, never answered', async () => {
    mockFetch([{ at: 0, data: { type: 'content_block_start', index: 1, content_block: { type: 'mcp_call', name: 'send_email' } } }, { at: 10, data: textBlock(2) }, { at: 20, data: text(2, 'sent!') }, { at: 30, data: msgStop }]);
    const e = await runGuard();
    expect(e).toBeInstanceOf(ToolHandoff);
    expect(e).toMatchObject({ reason: 'unknown', tool: { name: 'mcp_call' } });
    expect((e as ToolHandoff).partial.text).toBe('');
  });

  it('an action after text mid-answer: handoff (control)', async () => {
    mockFetch([{ at: 0, data: text(0, 'hi') }, { at: 10, data: start(1, 'memory_user_edits') }, ...pings(20, 5)]);
    expect(await runGuard()).toMatchObject({ reason: 'action', tool: { kind: 'action' }, call: { id: 'toolu_1' } });
  });
});

describe('stream guard: calls are tracked by block and id', () => {
  it('results match their own call; parallel reads that both finish end in an answer', async () => {
    const texts: string[] = [];
    mockFetch([
      { at: 0, data: start(1, 'web_search') }, { at: 1, data: input(1) }, { at: 2, data: stop(1) },
      { at: 3, data: start(2, 'conversation_search') }, { at: 4, data: stop(2) },
      { at: 10, data: result(3, 2) }, { at: 12, data: result(4, 1, 'web_search_tool_result') },
      { at: 14, data: textBlock(5) }, { at: 15, data: text(5, 'ok') }, { at: 16, data: msgStop },
    ]);
    const r = await runGuard({ onText: (t) => texts.push(t) });
    expect(r).toMatchObject({ text: 'ok' });
    expect(texts).toEqual(['ok']);
  });

  it('a result for no running call (a result-only stream) is not an answer', async () => {
    mockFetch([{ at: 0, data: result(2, 7) }, { at: 5, data: textBlock(3) }, { at: 6, data: text(3, 'deleted') }, { at: 7, data: msgStop }]);
    expect(await runGuard()).toMatchObject({ reason: 'unknown', tool: { name: 'tool_result' } });
    // …nor one naming another call's id while a call runs
    mockFetch([{ at: 0, data: start(1, 'web_search') }, { at: 5, data: result(2, 9) }, { at: 10, data: msgStop }]);
    expect(await runGuard()).toMatchObject({ reason: 'unknown' });
  });

  it('input for a call that never started is not accepted', async () => {
    mockFetch([{ at: 0, data: input(4) }, { at: 5, data: msgStop }]);
    expect(await runGuard()).toMatchObject({ reason: 'unknown', tool: { name: 'tool_input' } });
  });

  it('a result without an id settles the only running call, but is ambiguous with two', async () => {
    mockFetch([{ at: 0, data: start(1, 'web_search') }, { at: 5, data: result(2, null, 'web_search_tool_result') }, { at: 8, data: textBlock(3) }, { at: 9, data: text(3, 'x') }, { at: 10, data: msgStop }]);
    expect(await runGuard()).toMatchObject({ text: 'x' });
    mockFetch([{ at: 0, data: start(1, 'web_search') }, { at: 1, data: start(2, 'web_search') }, { at: 5, data: result(3, null, 'web_search_tool_result') }, { at: 10, data: msgStop }]);
    expect(await runGuard()).toMatchObject({ reason: 'unknown', tool: { name: 'tool_result' } });
  });

  it('two calls claiming one block (or one id) is refused', async () => {
    mockFetch([{ at: 0, data: start(1, 'web_search') }, { at: 1, data: start(1, 'conversation_search') }, { at: 10, data: msgStop }]);
    expect(await runGuard()).toMatchObject({ reason: 'unknown', tool: { name: 'duplicate_tool_call' } });
  });

  it('text does not settle a call whose block is still open: the stream ending leaves it waiting', async () => {
    mockFetch([{ at: 0, data: start(1, 'web_search') }, { at: 5, data: textBlock(2) }, { at: 6, data: text(2, 'x') }, { at: 10, data: msgStop }]);
    expect(await runGuard()).toMatchObject({ reason: 'waiting', tool: { name: 'web_search' } });
  });

  it('text after a closed call means Claude has its result (the fallback when no result block is streamed)', async () => {
    mockFetch([{ at: 0, data: start(1, 'web_search') }, { at: 2, data: stop(1) }, { at: 20, data: textBlock(2) }, { at: 21, data: text(2, 'found it') }, { at: 22, data: msgStop }]);
    expect(await runGuard()).toMatchObject({ text: 'found it' });
  });

  it("other blocks' events (thinking, text) and pings don't keep a stuck call alive", async () => {
    const other: Step[] = Array.from({ length: 30 }, (_, k) => ({ at: 20 + k * 15, data: k % 2 ? thinking(5) : { type: 'message_limit', message_limit: { type: 'within_limit', windows: {} } } }));
    mockFetch([{ at: 0, data: start(1, 'conversation_search') }, { at: 5, data: stop(1) }, ...other, ...pings(20, 30)]);
    const t0 = Date.now();
    const e = await runGuard();
    expect(e).toMatchObject({ reason: 'stall', tool: { name: 'conversation_search' } });
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("the call's own progress (its input, its block's end) keeps it alive", async () => {
    mockFetch([
      { at: 0, data: start(1, 'web_search') }, { at: 70, data: input(1) }, { at: 140, data: input(1) }, { at: 210, data: stop(1) },
      { at: 280, data: result(2, 1, 'web_search_tool_result') }, { at: 285, data: textBlock(3) }, { at: 286, data: text(3, 'ok') }, { at: 290, data: msgStop },
    ]);
    expect(await runGuard()).toMatchObject({ text: 'ok' });
  });

  it('unknown content (a new block type, content in message_start, a tool-ish delta, text inside a tool call) is handed off', async () => {
    for (const [label, steps] of [
      ['block', [{ at: 0, data: { type: 'content_block_start', index: 1, content_block: { type: 'knowledge' } } }]],
      ['function_call', [{ at: 0, data: { type: 'content_block_start', index: 1, content_block: { type: 'function_call', name: 'web_search' } } }]],
      ['message_start', [{ at: 0, data: { type: 'message_start', message: { content: [{ type: 'tool_use', name: 'send_email' }] } } }]],
      ['tool delta', [{ at: 0, data: { type: 'content_block_delta', index: 4, delta: { type: 'tool_input_delta' } } }]],
      ['text in tool_use', [{ at: 0, data: start(1, 'web_search') }, { at: 1, data: text(1, 'x') }]],
    ] as [string, Step[]][]) {
      mockFetch([...steps, { at: 20, data: msgStop }]);
      expect(await runGuard(), label).toMatchObject({ reason: 'unknown' });
    }
  });

  it("a tool result's own text is never answer text", async () => {
    const texts: string[] = [];
    mockFetch([{ at: 0, data: start(1, 'web_search') }, { at: 1, data: stop(1) }, { at: 2, data: result(2, 1, 'web_search_tool_result') }, { at: 3, data: text(2, 'RESULT TEXT') }, { at: 4, data: textBlock(3) }, { at: 5, data: text(3, 'answer') }, { at: 6, data: msgStop }]);
    expect(await runGuard({ onText: (t) => texts.push(t) })).toMatchObject({ text: 'answer' });
    expect(texts.join('')).not.toContain('RESULT');
  });

  it('locked mode is unchanged: any tool signal ends the answer; unknown blocks are ignored', async () => {
    mockFetch([{ at: 0, data: start(1, 'web_search') }]);
    const e = await runGuard({ toolPolicy: 'block' });
    expect(e).toBeInstanceOf(ClaudeError);
    expect(e).toMatchObject({ code: 'tool_blocked' });
    expect(e).not.toBeInstanceOf(ToolHandoff);
    mockFetch([{ at: 0, data: { type: 'content_block_start', index: 1, content_block: { type: 'knowledge' } } }, { at: 2, data: text(0, 'hi') }, { at: 4, data: msgStop }]);
    expect(await runGuard({ toolPolicy: 'block' })).toMatchObject({ text: 'hi' });
  });
});
