import { describe, expect, it } from 'vitest';
import { GptStream, applyOp, stripCitations, type GptSignal } from './gpt-stream';

const CONV = '68d5f0e1-1234-4000-8000-000000000001';
const A1 = '68d5f0e1-1234-4000-8000-0000000000a1';

const ev = (data: unknown, event = 'delta') => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const typed = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const ENC = ev('"v1"', 'delta_encoding');
const DONE = 'data: [DONE]\n\n';

const msg = (o: {
  id?: string;
  role: string;
  recipient?: string;
  ct?: string;
  channel?: string | null;
  parts?: unknown[];
  status?: string;
  name?: string;
  meta?: Record<string, unknown>;
}) => ({
  message: {
    id: o.id ?? 'm-x',
    author: { role: o.role, ...(o.name ? { name: o.name } : {}) },
    content: { content_type: o.ct ?? 'text', parts: o.parts ?? [''] },
    status: o.status ?? 'in_progress',
    recipient: o.recipient ?? 'all',
    channel: o.channel === undefined ? null : o.channel,
    metadata: o.meta ?? {},
  },
  conversation_id: CONV,
  error: null,
});

const userEcho = ev({ p: '', o: 'add', v: msg({ role: 'user', parts: ['q'], status: 'finished_successfully' }), c: 0 });
const answerStart = (c = 1, extra: Parameters<typeof msg>[0] = { role: 'assistant' }) =>
  ev({ v: msg({ id: A1, channel: 'final', meta: { model_slug: 'gpt-5-6-thinking' }, ...extra }), c });
const finish = ev({ p: '', o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }, { p: '/message/end_turn', o: 'replace', v: true }] });
const COMPLETE = typed({ type: 'message_stream_complete', conversation_id: CONV });

function run(chunks: string[]) {
  const s = new GptStream();
  const sigs: GptSignal[] = [];
  for (const c of chunks) sigs.push(...s.push(c));
  sigs.push(...s.end());
  return { s, sigs, text: sigs.filter((x) => x.kind === 'text').map((x) => (x as { text: string }).text).join('') };
}

describe('GptStream: answer text (delta_encoding v1)', () => {
  it('forwards appends, bare-string carry-over and patch appends; complete needs all three markers', () => {
    const { s, sigs, text } = run([
      ENC,
      userEcho,
      typed({ type: 'input_message', conversation_id: CONV }),
      answerStart(),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'Hel' }),
      ev({ v: 'lo' }),
      ev({ p: '', o: 'patch', v: [{ p: '/message/content/parts/0', o: 'append', v: ' wor' }, { p: '/message/metadata', o: 'append', v: { x: 1 } }] }),
      ev({ v: 'ld' }), // after a patch: appends to the path the patch appended to
      finish,
      COMPLETE,
      DONE,
    ]);
    expect(text).toBe('Hello world');
    expect(sigs[0]).toEqual({ kind: 'conversation', id: CONV });
    expect(sigs.some((x) => x.kind === 'unknown')).toBe(false);
    expect(s.complete).toBe(true);
    expect(s.answerId).toBe(A1);
    expect(s.model).toBe('gpt-5-6-thinking');
  });

  it('is not complete without message_stream_complete, [DONE], or a finished answer', () => {
    const base = [ENC, userEcho, answerStart(), ev({ p: '/message/content/parts/0', o: 'append', v: 'x' })];
    expect(run([...base, finish, COMPLETE]).s.complete).toBe(false);
    expect(run([...base, finish, DONE]).s.complete).toBe(false);
    expect(run([...base, COMPLETE, DONE]).s.complete).toBe(false);
    expect(run([...base, finish, COMPLETE, DONE]).s.complete).toBe(true);
  });

  it('a later add omits p/o: a new message (its own text, on a new paragraph)', () => {
    const { text } = run([
      ENC,
      answerStart(1),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'First.' }),
      ev({ v: msg({ id: 'm-2', role: 'assistant', channel: 'final', meta: { message_type: 'next' } }), c: 2 }),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'Second.' }),
    ]);
    expect(text).toBe('First.\n\nSecond.');
  });

  it('strips citation markers, also when a marker is split across deltas', () => {
    const { text } = run([
      ENC,
      answerStart(),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'Python 3.14 citeturn0' }),
      ev({ v: 'search1 is out.' }),
      finish,
      COMPLETE,
      DONE,
    ]);
    expect(text).toBe('Python 3.14  is out.');
    expect(stripCitations('axybopen')).toBe('ab');
  });
});

describe('GptStream: hidden messages are never forwarded', () => {
  it('system, user echo, custom instructions, memory, reasoning, analysis/commentary text, hidden text', () => {
    const { text, sigs, s } = run([
      ENC,
      ev({ p: '', o: 'add', v: msg({ role: 'system', parts: ['SYSTEM SECRET'] }), c: 0 }),
      ev({ v: msg({ role: 'user', parts: ['ABOUT ME'], meta: { is_user_system_message: true } }), c: 1 }),
      ev({ v: msg({ role: 'user', parts: ['my question'] }), c: 2 }),
      ev({ v: msg({ role: 'assistant', ct: 'model_editable_context', parts: undefined }), c: 3 }),
      ev({ p: '/message/content/model_set_context', o: 'append', v: 'MEMORY SECRET' }),
      ev({ v: msg({ role: 'assistant', ct: 'thoughts', parts: undefined }), c: 4 }),
      ev({ v: msg({ role: 'assistant', ct: 'reasoning_recap', parts: ['Thought for 2s'] }), c: 5 }),
      ev({ v: msg({ role: 'assistant', channel: 'analysis', parts: ['ANALYSIS'] }), c: 6 }),
      ev({ v: msg({ role: 'assistant', channel: 'commentary', parts: ['COMMENTARY'] }), c: 7 }),
      ev({ v: msg({ role: 'assistant', channel: 'final', parts: ['HIDDEN'], meta: { is_visually_hidden_from_conversation: true } }), c: 8 }),
      answerStart(9),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'visible' }),
      finish,
      COMPLETE,
      DONE,
    ]);
    expect(text).toBe('visible');
    expect(sigs.some((x) => x.kind === 'unknown')).toBe(false);
    expect(s.complete).toBe(true);
  });
});

describe('GptStream: fails closed', () => {
  const cases: [string, string[]][] = [
    ['an unknown op', [ENC, answerStart(), ev({ p: '/message/content/parts/0', o: 'splice', v: 'x' })]],
    ['an unknown content type to all', [ENC, ev({ p: '', o: 'add', v: msg({ role: 'assistant', ct: 'multimodal_text' }), c: 1 })]],
    ['an unknown channel on answer text', [ENC, ev({ p: '', o: 'add', v: msg({ role: 'assistant', channel: 'broadcast' }), c: 1 })]],
    ['an unknown typed event', [ENC, typed({ type: 'tool_confirmation_required', conversation_id: CONV })]],
    ['an unknown SSE event name', [ENC, ev({ v: 'x' }, 'approval')]],
    ['non-JSON data', [ENC, 'event: delta\ndata: {nope\n\n']],
    ['another delta encoding', [ev('"v2"', 'delta_encoding')]],
    ['deltas before the encoding', [userEcho]],
    ['a bare string with nothing to append to', [ENC, ev({ v: 'x' })]],
    ['a rewritten answer (not a continuation of what was forwarded)', [ENC, answerStart(), ev({ p: '/message/content/parts/0', o: 'append', v: 'abc' }), ev({ p: '/message/content/parts/0', o: 'replace', v: 'xyz' })]],
    ['a prototype path', [ENC, answerStart(), ev({ p: '/__proto__/polluted', o: 'add', v: 1 })]],
    ['a changed conversation id', [ENC, answerStart(), typed({ type: 'message_stream_complete', conversation_id: '68d5f0e1-1234-4000-8000-000000000002' })]],
    ['a tool result for no call', [ENC, ev({ p: '', o: 'add', v: msg({ role: 'tool', name: 'web.run' }), c: 1 })]],
    ['an unknown role', [ENC, ev({ p: '', o: 'add', v: msg({ role: 'critic' }), c: 1 })]],
    ['a stream error', [ENC, ev({ p: '', o: 'add', v: { ...msg({ role: 'assistant' }), error: 'boom' }, c: 1 })]],
    ['data after [DONE]', [ENC, DONE, answerStart()]],
  ];
  for (const [name, chunks] of cases) {
    it(name, () => {
      const { sigs, s } = run(chunks);
      expect(sigs.some((x) => x.kind === 'unknown')).toBe(true);
      expect(s.complete).toBe(false);
    });
  }

  it('stops parsing after the first unknown (nothing more is forwarded)', () => {
    const { text } = run([ENC, answerStart(), ev({ p: '/message/content/parts/0', o: 'append', v: 'a' }), ev({ p: '/x', o: 'nope', v: 1 }), ev({ p: '/message/content/parts/0', o: 'append', v: 'b' })]);
    expect(text).toBe('a');
  });
});

/** api_tool.list_resources (c 1) and its result (c 2), listing link_abc123 as Google Drive and link_gm as Gmail. */
const LIST_RESOURCES = [
  ev({ p: '', o: 'add', v: msg({ id: 'lr', role: 'assistant', recipient: 'api_tool.list_resources', ct: 'code', parts: ['{}'], status: 'finished_successfully' }), c: 1 }),
  ev({
    p: '',
    o: 'add',
    v: msg({ role: 'tool', name: 'api_tool', parts: [JSON.stringify({ resources: [{ uri: '/Google Drive/link_abc123/search' }, { uri: '/Gmail/link_gm/search' }] })], status: 'finished_successfully' }),
    c: 2,
  }),
];

describe('GptStream: tool calls', () => {
  it('a read call (web.run) runs; its result settles it; the answer then completes', () => {
    const { sigs, s, text } = run([
      ENC,
      userEcho,
      ev({ v: msg({ id: 'call-1', role: 'assistant', recipient: 'web.run', ct: 'code', channel: 'commentary', parts: ['{"search_query":'] }), c: 1 }),
      ev({ p: '/message/content/parts/0', o: 'append', v: '[{"q":"python"}]}' }),
      ev({ p: '/message/status', o: 'replace', v: 'finished_successfully' }),
      ev({ v: msg({ role: 'tool', name: 'web.run', ct: 'tether_browsing_display', parts: undefined }), c: 2 }),
      answerStart(3),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'Found it.' }),
      finish,
      COMPLETE,
      DONE,
    ]);
    expect(sigs.find((x) => x.kind === 'tool')).toMatchObject({ kind: 'tool', msg: 1, info: { kind: 'read', label: 'Searching the web…' } });
    expect(sigs.some((x) => x.kind === 'tool_done' && x.msg === 1)).toBe(true);
    expect(text).toBe('Found it.');
    expect(s.complete).toBe(true);
  });

  it('answer text after a complete read call settles it even without a result message (web search results ride on the answer)', () => {
    const { sigs, s } = run([
      ENC,
      ev({ p: '', o: 'add', v: msg({ id: 'call-1', role: 'assistant', recipient: 'web', ct: 'code', status: 'finished_successfully' }), c: 1 }),
      answerStart(2),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'x' }),
      finish,
      COMPLETE,
      DONE,
    ]);
    expect(sigs.some((x) => x.kind === 'tool_done' && x.msg === 1)).toBe(true);
    expect(s.running()).toEqual([]);
    expect(s.complete).toBe(true);
  });

  it('a read call still being written is not settled by text, and a stream that ends with it running is not complete', () => {
    const { s } = run([
      ENC,
      ev({ p: '', o: 'add', v: msg({ id: 'call-1', role: 'assistant', recipient: 'web.run', ct: 'code' }), c: 1 }),
      answerStart(2),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'x' }),
      finish,
      COMPLETE,
      DONE,
    ]);
    expect(s.running()).toEqual([1]);
    expect(s.complete).toBe(false);
  });

  it('an action (bio) is reported at its start, with its id; nothing after it is parsed', () => {
    const { sigs, text } = run([
      ENC,
      ev({ p: '', o: 'add', v: msg({ id: 'call-bio', role: 'assistant', recipient: 'bio', ct: 'code', channel: 'commentary' }), c: 1 }),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'User likes X' }),
      answerStart(2),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'Saved.' }),
    ]);
    expect(sigs.filter((x) => x.kind === 'action')).toEqual([
      { kind: 'action', msg: 1, callId: 'call-bio', recipient: 'bio', info: expect.objectContaining({ kind: 'action', name: 'bio', connector: 'memory' }) },
    ]);
    expect(sigs.some((x) => x.kind === 'unknown')).toBe(false);
    expect(text).toBe('');
  });

  it('api_tool.call_tool waits for its whole body: a Drive search (on a link this turn listed) reads, a Gmail send is an action', () => {
    const drive = run([
      ENC,
      ...LIST_RESOURCES,
      ev({ p: '', o: 'add', v: msg({ id: 'c1', role: 'assistant', recipient: 'api_tool.call_tool', ct: 'code', parts: ['{"pa'] }), c: 3 }),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'th": "/Google Drive/link_abc123/search", "args": {"query": "arena"}' }),
      ev({ v: '}' }),
    ]);
    expect(drive.sigs.filter((x) => x.kind === 'tool' || x.kind === 'action').map((x) => (x.kind === 'tool' ? x.info.name : x.kind))).toEqual([
      'api_tool.list_resources',
      'Google Drive/search',
    ]);
    // the same read with no list_resources this turn: an action
    const unlisted = run([
      ENC,
      ev({ p: '', o: 'add', v: msg({ id: 'c1', role: 'assistant', recipient: 'api_tool.call_tool', ct: 'code', parts: ['{"path": "/Google Drive/link_abc123/search", "args": {}}'] }), c: 1 }),
    ]);
    expect(unlisted.sigs.find((x) => x.kind === 'action' || x.kind === 'tool')?.kind).toBe('action');
    const gmail = run([
      ENC,
      ev({ p: '', o: 'add', v: msg({ id: 'c1', role: 'assistant', recipient: 'api_tool.call_tool', ct: 'code', parts: [''] }), c: 1 }),
      ev({ p: '/message/content/parts/0', o: 'append', v: '{"path": "/Gmail/link_abc123/send_email", "args": {}}' }),
    ]);
    expect(gmail.sigs.find((x) => x.kind === 'action')).toMatchObject({ info: { kind: 'action', connector: 'Gmail' } });
  });

  it('a call whose app action never streams in is an action once the next message starts (or the stream ends)', () => {
    const next = run([
      ENC,
      ev({ p: '', o: 'add', v: msg({ id: 'c1', role: 'assistant', recipient: 'api_tool.call_tool', ct: 'code', parts: [''] }), c: 1 }),
      ev({ v: msg({ role: 'tool', name: 'api_tool' }), c: 2 }),
    ]);
    expect(next.sigs.some((x) => x.kind === 'action')).toBe(true);
    const ended = run([ENC, ev({ p: '', o: 'add', v: msg({ id: 'c1', role: 'assistant', recipient: 'api_tool.call_tool', ct: 'code', parts: [''] }), c: 1 })]);
    expect(ended.sigs.some((x) => x.kind === 'action')).toBe(true);
  });

  it('obfuscated or unknown recipients are actions (fail closed)', () => {
    for (const r of ['q7dr546', 'python', 'container.exec', 'local.continue_in_work', 'image_gen.text2im', 'automations', 'web.search', 'canmore.create_textdoc']) {
      const { sigs } = run([ENC, ev({ p: '', o: 'add', v: msg({ role: 'assistant', recipient: r, ct: 'code' }), c: 1 })]);
      expect(sigs.find((x) => x.kind === 'action' || x.kind === 'tool')?.kind, r).toBe('action');
    }
  });
});

describe('GptStream: connector calls are re-checked on every change (review findings)', () => {
  const callAdd = (body: string, c = 3) => ev({ p: '', o: 'add', v: msg({ id: 'm1', role: 'assistant', recipient: 'api_tool.call_tool', ct: 'code', parts: [body] }), c });

  // Review PoC (arena-review7/poc/tools.test.ts, "streaming"), must fail: the call was a read as soon
  // as its first path closed, and a second "path" streamed in later was never looked at.
  it('a second path after a read path is an action (PoC)', () => {
    const { sigs } = run([
      ENC,
      ...LIST_RESOURCES,
      callAdd(''),
      ev({ p: '/message/content/parts/0', o: 'append', v: '{"path": "/Gmail/link_gm/search", ' }),
      ev({ v: '"path": "/Gmail/link_gm/send_email", "args": {}}' }),
      ev({ p: '/message/status', o: 'replace', v: 'finished_successfully' }),
    ]);
    expect(sigs.some((x) => x.kind === 'tool' && x.info.name !== 'api_tool.list_resources')).toBe(false);
    expect(sigs.find((x) => x.kind === 'action')).toMatchObject({ kind: 'action', info: { kind: 'action' } });
  });

  it('a read whose body is replaced or extended afterwards becomes an action', () => {
    const replaced = run([
      ENC,
      ...LIST_RESOURCES,
      callAdd('{"path": "/Gmail/link_gm/search", "args": {}}'),
      ev({ p: '/message/content/parts/0', o: 'replace', v: '{"path": "/Gmail/link_gm/send_email", "args": {}}' }),
    ]);
    expect(replaced.sigs.filter((x) => x.kind === 'tool' || x.kind === 'action').map((x) => x.kind)).toEqual(['tool', 'tool', 'action']);
    const extended = run([ENC, ...LIST_RESOURCES, callAdd('{"path": "/Gmail/link_gm/search", "args": {}}'), ev({ p: '/message/content/parts/0', o: 'append', v: ' {"path": "/Gmail/link_gm/send_email"}' })]);
    expect(extended.sigs.some((x) => x.kind === 'action')).toBe(true);
    const same = run([ENC, ...LIST_RESOURCES, callAdd('{"path": "/Gmail/link_gm/search", "args": {}}'), ev({ p: '/message/status', o: 'replace', v: 'finished_successfully' })]);
    expect(same.sigs.some((x) => x.kind === 'action')).toBe(false);
  });
});

describe('GptStream: round-8 diff review', () => {
  it('a fullwidth api_tool.call_tool is an action at once (never a read that later re-checks miss)', () => {
    const { sigs } = run([
      ENC,
      ...LIST_RESOURCES,
      ev({ p: '', o: 'add', v: msg({ id: 'm1', role: 'assistant', recipient: 'ａｐｉ_tool.call_tool', ct: 'code', parts: ['{"path": "/Gmail/link_gm/search", "args": {}}'] }), c: 3 }),
      ev({ p: '/message/content/parts/0', o: 'replace', v: '{"path": "/Gmail/link_gm/send_email", "args": {}}' }),
    ]);
    expect(sigs.filter((x) => x.kind === 'tool' || x.kind === 'action').map((x) => x.kind)).toEqual(['tool', 'action']); // list_resources, then this
  });

  it('metadata and a recipient that arrive after the first add never unhold its text', () => {
    const bare = { message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress', metadata: {} }, conversation_id: CONV };
    const { sigs } = run([
      ENC,
      ev({ p: '', o: 'add', c: 1, v: bare }),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'PRIVATE' }),
      ev({ p: '/message/metadata', o: 'append', v: { message_type: 'next', model_slug: 'x' } }),
      ev({ p: '/message/channel', o: 'add', v: null }),
      ev({ p: '/message/recipient', o: 'add', v: 'all' }),
      ev({ p: '/message/metadata', o: 'append', v: { is_visually_hidden_from_conversation: true } }),
      finish,
    ]);
    expect(sigs.some((x) => x.kind === 'text')).toBe(false);
  });
});

describe('GptStream: an answer is forwarded only once it is known to be one (review findings)', () => {
  // Review PoC (arena-review7/poc/stream.test.ts), must fail: text went out before a later
  // is_visually_hidden_from_conversation flag.
  it('text of a message later marked hidden never goes out (PoC)', () => {
    const { sigs } = run([
      ENC,
      ev({ p: '', o: 'add', c: 0, v: { message: { id: 'a', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: [''] }, status: 'in_progress', metadata: {} }, conversation_id: CONV } }),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'SECRET-ish text' }),
      ev({ p: '/message/metadata', o: 'append', v: { is_visually_hidden_from_conversation: true } }),
    ]);
    expect(sigs.some((x) => x.kind === 'text')).toBe(false);
    expect(sigs.some((x) => x.kind === 'unknown')).toBe(false); // simply hidden
  });

  it('a message whose first add has no final metadata is held back whole until it completes', () => {
    const chunks = [
      ENC,
      ev({ p: '', o: 'add', c: 1, v: msg({ id: A1, role: 'assistant', channel: 'final', meta: {} }) }),
      ev({ p: '/message/content/parts/0', o: 'append', v: 'Hel' }),
      ev({ v: 'lo' }),
    ];
    expect(run(chunks).text).toBe('');
    const { text, s } = run([...chunks, finish, COMPLETE, DONE]);
    expect(text).toBe('Hello');
    expect(s.complete).toBe(true);
    expect([...s.seen]).toContain('answer:held');
  });

  it('a real answer (its add carries message_type / model_slug) streams as it arrives', () => {
    const s = new GptStream();
    s.push(ENC);
    s.push(answerStart());
    expect(s.push(ev({ p: '/message/content/parts/0', o: 'append', v: 'Hi' }))).toEqual([{ kind: 'text', text: 'Hi' }]);
  });

  it('is_user_system_message and any is_visually_hidden* flag hide an assistant message', () => {
    for (const meta of [{ is_user_system_message: true }, { is_visually_hidden: true }, { is_visually_hidden_from_conversation: 1 }, { model_slug: 'x', is_visually_hidden_from_conversation_v2: 'yes' }]) {
      const { text, sigs } = run([ENC, ev({ p: '', o: 'add', c: 1, v: msg({ role: 'assistant', channel: 'final', parts: ['PRIVATE'], meta }) }), finish]);
      expect(text, JSON.stringify(meta)).toBe('');
      expect(sigs.some((x) => x.kind === 'unknown')).toBe(false);
    }
    // a flag that arrives after text went out stops the answer
    const late = run([ENC, answerStart(), ev({ p: '/message/content/parts/0', o: 'append', v: 'a' }), ev({ p: '/message/metadata', o: 'append', v: { is_user_system_message: true } })]);
    expect(late.text).toBe('a');
    expect(late.sigs.some((x) => x.kind === 'unknown' && x.what === 'answer_hidden')).toBe(true);
  });

  it('an assistant message with no recipient yet is undecided: a late recipient makes it a call, never text', () => {
    const noRcpt = { message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress', channel: null, metadata: { message_type: 'next' } }, conversation_id: CONV };
    const call = run([ENC, ev({ p: '', o: 'add', c: 1, v: noRcpt }), ev({ p: '/message/content/parts/0', o: 'append', v: 'User likes X' }), ev({ p: '/message/recipient', o: 'add', v: 'bio' })]);
    expect(call.text).toBe('');
    expect(call.sigs.find((x) => x.kind === 'action')).toMatchObject({ recipient: 'bio' });
    // completing without one: chatgpt.com's default (all), forwarded then
    const plain = run([ENC, ev({ p: '', o: 'add', c: 1, v: noRcpt }), ev({ p: '/message/content/parts/0', o: 'append', v: 'Hi' }), finish, COMPLETE, DONE]);
    expect(plain.text).toBe('Hi');
    expect(plain.s.complete).toBe(true);
  });
});

describe('applyOp', () => {
  it('add / replace / append / truncate / remove / nested patch', () => {
    let r: unknown = { message: { content: { parts: ['ab'] }, metadata: { a: 1 } } };
    r = applyOp(r, '/message/content/parts/0', 'append', 'c');
    r = applyOp(r, '/message/metadata', 'append', { b: 2 });
    r = applyOp(r, '/message/status', 'add', 'x');
    r = applyOp(r, '/message/status', 'replace', 'y');
    r = applyOp(r, '/message/content/parts/0', 'truncate', 2);
    r = applyOp(r, '/message/metadata/a', 'remove', null);
    r = applyOp(r, '/message', 'patch', [{ p: '/end_turn', o: 'add', v: true }]);
    expect(r).toEqual({ message: { content: { parts: ['ab'] }, metadata: { b: 2 }, status: 'y', end_turn: true } });
    expect(() => applyOp(r, '/message/content/parts/0', 'append', { obj: 1 })).toThrow();
    expect(() => applyOp(r, 'message', 'add', 1)).toThrow();
    expect(() => applyOp(r, '/constructor/prototype/x', 'add', 1)).toThrow();
  });
});
