import { describe, expect, it } from 'vitest';
import { textHash } from './hash';
import { LIMITS, PAGE_SOURCE, parseMode, type ConvState } from './protocol';
import {
  RateLimiter,
  chapterKeyFor,
  parseArenaHistory,
  parsePageMessage,
  trimHistory,
  validateAskRequest,
  validateConvState,
  validateGptRelayAsk,
  validateProjectRef,
  validateRelayAsk,
  validateStreamEvent,
} from './validate';

const ID = '0f8c6b1e-4a52-4d8e-9f1a-2b3c4d5e6f70';
const ask = (over: Record<string, unknown> = {}) => ({
  source: PAGE_SOURCE,
  type: 'ask',
  id: ID,
  prompt: 'What does einsum do?',
  context: '# ctx',
  ...over,
});

describe('parsePageMessage (MAIN world → bridge)', () => {
  it('accepts a well-formed ask and returns a fresh copy (trimmed prompt)', () => {
    const msg = ask({ prompt: '  hi  ' });
    const r = parsePageMessage(msg);
    expect(r).toEqual({ kind: 'ask', msg: { id: ID, prompt: 'hi', context: '# ctx', model: 'my-claude' } });
    if (r.kind === 'ask') expect(r.msg).not.toBe(msg);
  });

  it('carries which of our models ARENA asked for (absent: Claude, as older builds sent); anything else is refused', () => {
    expect(parsePageMessage(ask({ model: 'my-chatgpt' }))).toMatchObject({ kind: 'ask', msg: { model: 'my-chatgpt' } });
    expect(parsePageMessage(ask({ model: 'my-claude' }))).toMatchObject({ kind: 'ask', msg: { model: 'my-claude' } });
    expect(parsePageMessage(ask({ model: 'gpt-4.1-mini' }))).toMatchObject({ kind: 'invalid' });
    expect(parsePageMessage(ask({ model: 42 }))).toMatchObject({ kind: 'invalid' });
  });

  it('treats a missing / null context as empty', () => {
    expect(parsePageMessage(ask({ context: undefined }))).toMatchObject({ kind: 'ask', msg: { context: '' } });
    expect(parsePageMessage(ask({ context: null }))).toMatchObject({ kind: 'ask', msg: { context: '' } });
  });

  it('ignores anything without our source tag (other page messages, WXT, ARENA)', () => {
    for (const x of [null, undefined, 'ask', 42, [], {}, { type: 'ask' }, { source: 'arena-ask:bridge', type: 'delta' }, ask({ source: 'x' })]) {
      expect(parsePageMessage(x)).toEqual({ kind: 'ignore' });
    }
  });

  it('parses a cancel (id only; anything extra is ignored)', () => {
    expect(parsePageMessage({ source: PAGE_SOURCE, type: 'cancel', id: ID })).toEqual({ kind: 'cancel', id: ID });
    expect(parsePageMessage({ source: PAGE_SOURCE, type: 'cancel', id: ID, prompt: 'x' })).toEqual({ kind: 'ignore' });
    expect(parsePageMessage({ source: PAGE_SOURCE, type: 'cancel', id: 'bad' })).toMatchObject({ kind: 'invalid', id: null });
  });

  it('rejects unknown verbs, extra fields and bad ids', () => {
    expect(parsePageMessage(ask({ type: 'reset' }))).toMatchObject({ kind: 'invalid', id: ID });
    expect(parsePageMessage(ask({ type: 'fetch', url: 'https://claude.ai/api/organizations' }))).toMatchObject({
      kind: 'invalid',
    });
    expect(parsePageMessage(ask({ org: 'x' }))).toMatchObject({ kind: 'invalid', id: ID });
    expect(parsePageMessage(ask({ __proto__: { evil: 1 }, extra: 1 }))).toMatchObject({ kind: 'invalid' });
    expect(parsePageMessage(ask({ id: 'short' }))).toMatchObject({ kind: 'invalid', id: null });
    expect(parsePageMessage(ask({ id: '<script>alert(1)</script>xxxxxx' }))).toMatchObject({ kind: 'invalid', id: null });
    expect(parsePageMessage(ask({ id: 12345678 }))).toMatchObject({ kind: 'invalid', id: null });
  });

  it('rejects non-string / empty prompts and non-string contexts', () => {
    expect(parsePageMessage(ask({ prompt: 42 }))).toMatchObject({ kind: 'invalid', code: 'invalid' });
    expect(parsePageMessage(ask({ prompt: { toString: () => 'x' } }))).toMatchObject({ kind: 'invalid' });
    expect(parsePageMessage(ask({ prompt: '   ' }))).toMatchObject({ kind: 'invalid' });
    expect(parsePageMessage(ask({ context: ['a'] }))).toMatchObject({ kind: 'invalid' });
  });

  it('enforces size caps (prompt ≤ 20k, context ≤ 1.5M chars) with a clear message', () => {
    expect(parsePageMessage(ask({ prompt: 'x'.repeat(LIMITS.promptChars) }))).toMatchObject({ kind: 'ask' });
    const p = parsePageMessage(ask({ prompt: 'x'.repeat(LIMITS.promptChars + 1) }));
    expect(p).toMatchObject({ kind: 'invalid', code: 'too_large', id: ID });
    expect(p.kind === 'invalid' && p.message).toMatch(/20,000/);
    expect(parsePageMessage(ask({ context: 'c'.repeat(LIMITS.contextChars) }))).toMatchObject({ kind: 'ask' });
    const c = parsePageMessage(ask({ context: 'c'.repeat(LIMITS.contextChars + 1) }));
    expect(c).toMatchObject({ kind: 'invalid', code: 'too_large' });
    expect(c.kind === 'invalid' && c.message).toMatch(/fewer sections/);
  });
});

describe('RateLimiter', () => {
  it('allows `max` per window, then refuses until old hits expire', () => {
    const rl = new RateLimiter(20, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) expect(rl.allow(t0 + i)).toBe(true);
    expect(rl.allow(t0 + 100)).toBe(false);
    expect(rl.allow(t0 + 59_999)).toBe(false);
    expect(rl.allow(t0 + 60_000)).toBe(true); // the first hit aged out
    expect(rl.allow(t0 + 60_000)).toBe(false); // the second (t0+1) hasn't yet
    expect(rl.allow(t0 + 60_001)).toBe(true);
    expect(rl.allow(t0 + 60_001)).toBe(false);
  });
});

describe('parseArenaHistory', () => {
  const hist = (...m: [string, string][]) => JSON.stringify(m.map(([role, content]) => ({ role, content })));

  it('drops the current question ARENA already saved and anchors on the first message', () => {
    const r = parseArenaHistory(hist(['user', 'Q1'], ['assistant', 'A1'], ['user', 'Q2']), 'Q2');
    expect(r.priorCount).toBe(2);
    expect(r.history).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
    ]);
    expect(r.anchor).toBe(textHash('Q1'));
  });

  it('a brand-new ARENA thread has no prior messages and anchors on the question', () => {
    const r = parseArenaHistory(hist(['user', 'first question']), 'first question');
    expect(r).toEqual({ history: [], priorCount: 0, anchor: textHash('first question') });
  });

  it('unreadable history → unknown (priorCount -1, history null)', () => {
    for (const raw of [null, 'not json', '{"a":1}']) {
      const r = parseArenaHistory(raw, 'q');
      expect(r.priorCount).toBe(-1);
      expect(r.history).toBeNull();
    }
  });

  it('skips malformed entries', () => {
    const raw = JSON.stringify([{ role: 'user', content: 'Q1' }, { role: 'system', content: 'x' }, { role: 'user' }, 5, { role: 'user', content: 'Q2' }]);
    expect(parseArenaHistory(raw, 'Q2').history).toEqual([{ role: 'user', content: 'Q1' }]);
  });

  it('trims long histories from the front within the budget', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const t = trimHistory(many as never);
    expect(t).toHaveLength(LIMITS.historyMessages);
    expect(t[t.length - 1].content).toBe('m499');
    // each message is capped at messageChars; the total at historyChars (most recent kept)
    const big = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: String(i).repeat(LIMITS.messageChars + 10) }));
    const tb = trimHistory(big as never);
    expect(tb).toHaveLength(Math.floor(LIMITS.historyChars / LIMITS.messageChars));
    expect(tb.every((m) => m.content.length === LIMITS.messageChars)).toBe(true);
    expect(tb[tb.length - 1].content[0]).toBe('5');
  });
});

describe('chapterKeyFor', () => {
  it('uses safe ARENA ids as-is, "static" off-chapter, and hashes anything odd', () => {
    expect(chapterKeyFor('chapter1_transformer_interp')).toBe('chapter1_transformer_interp');
    expect(chapterKeyFor(null)).toBe('static');
    expect(chapterKeyFor('../../etc')).toMatch(/^h-[0-9a-f]{28}$/);
  });
});

const goodAsk = () => ({
  type: 'ask',
  provider: 'claude',
  chapterKey: 'chapter0_fundamentals',
  chapterTitle: 'Fundamentals',
  prompt: 'q',
  context: '',
  history: [{ role: 'user', content: 'Q1' }],
  priorCount: 3,
  anchor: textHash('Q1'),
});

describe('validateAskRequest (bridge → background)', () => {
  it('accepts a good request', () => {
    expect(validateAskRequest(goodAsk())).toEqual(goodAsk());
  });
  it('rejects bad shapes', () => {
    const bad: Record<string, unknown>[] = [
      { provider: 'gemini' },
      { provider: undefined },
      { chapterKey: '../x' },
      { prompt: '' },
      { prompt: 'x'.repeat(LIMITS.promptChars + 1) },
      { context: 'x'.repeat(LIMITS.contextChars + 1) },
      { priorCount: 1.5 },
      { priorCount: 0 }, // history longer than priorCount
      { history: null }, // null history requires priorCount -1
      { history: [{ role: 'system', content: 'x' }] },
      { anchor: 'nope' },
      { extra: true },
    ];
    for (const b of bad) expect(validateAskRequest({ ...goodAsk(), ...b })).toBeNull();
    expect(validateAskRequest({ ...goodAsk(), history: null, priorCount: -1 })).not.toBeNull();
  });
});

const state = (over: Partial<ConvState> = {}): ConvState => ({
  v: 1,
  orgTag: '0123456789abcdef',
  convUuid: '11111111-2222-4333-8444-555555555555',
  parent: '019e954f-0000-7000-8000-000000000000',
  anchor: textHash('Q1'),
  arenaLen: 2,
  ctxHash: 'a'.repeat(64),
  filed: true,
  name: 'ARENA · Fundamentals',
  updatedAt: 1,
  ...over,
});

describe('validateConvState / validateRelayAsk', () => {
  it('round-trips valid state and rejects tampered state', () => {
    expect(validateConvState(state())).toEqual(state());
    expect(validateConvState(state({ ctxHash: null }))).not.toBeNull();
    expect(validateConvState({ ...state(), convUuid: 'x' })).toBeNull();
    expect(validateConvState({ ...state(), orgTag: 'org-uuid-in-clear' })).toBeNull();
    expect(validateConvState({ ...state(), v: 2 })).toBeNull();
  });

  it('relay asks carry a validated state or null', () => {
    const { provider: _p, ...rest } = { ...goodAsk(), mode: 'locked' };
    expect(validateRelayAsk({ ...rest, state: state() })).toMatchObject({ type: 'ask', state: state(), project: null });
    expect(validateRelayAsk({ ...rest, state: null })).toMatchObject({ state: null });
    expect(validateRelayAsk({ ...rest, state: { ...state(), convUuid: 'nope' } })).toBeNull();
    expect(validateRelayAsk({ ...rest, verb: 'list_conversations' })).toBeNull();
  });

  it('relay asks carry a validated project ref or null', () => {
    const { provider: _p, ...rest } = { ...goodAsk(), mode: 'locked' };
    const project = { orgTag: '0123456789abcdef', uuid: '0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e' };
    expect(validateRelayAsk({ ...rest, state: null, project })).toMatchObject({ project });
    expect(validateRelayAsk({ ...rest, state: null, project: { ...project, uuid: 'x' } })).toBeNull();
    expect(validateProjectRef({ ...project, orgTag: 'an-org-id-in-clear' })).toBeNull();
    expect(validateProjectRef({ ...project, extra: 1 })).toEqual(project); // copied, extras dropped
  });

  it('relay asks carry the pinned org (full mode) as a uuid or null', () => {
    const { provider: _p, ...rest } = { ...goodAsk(), mode: 'full' };
    const org = '12121212-3434-4565-8787-909090909090';
    expect(validateRelayAsk({ ...rest, state: null })).toMatchObject({ pinnedOrg: null });
    expect(validateRelayAsk({ ...rest, state: null, pinnedOrg: org })).toMatchObject({ pinnedOrg: org });
    for (const pinnedOrg of ['nope', 1, {}]) expect(validateRelayAsk({ ...rest, state: null, pinnedOrg }), JSON.stringify(pinnedOrg)).toBeNull();
  });

  it('relay asks carry `typed`: distinct indexes of user messages in the history; the page or bridge can\'t mark one itself', () => {
    const { provider: _p, ...rest } = { ...goodAsk(), mode: 'full', history: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }] };
    expect(validateRelayAsk({ ...rest, state: null })).toMatchObject({ typed: [] });
    expect(validateRelayAsk({ ...rest, state: null, typed: [0, 2] })).toMatchObject({ typed: [0, 2] });
    for (const typed of [[1], [3], [-1], [0, 0], ['0'], [0.5], 'all', null]) expect(validateRelayAsk({ ...rest, state: null, typed }), JSON.stringify(typed)).toBeNull();
    expect(validateRelayAsk({ ...rest, history: null, priorCount: -1, state: null, typed: [0] })).toBeNull();
    // a `typed` flag on a history entry (from the bridge or the page) is dropped
    const flagged = validateRelayAsk({ ...rest, state: null, history: [{ role: 'user', content: 'Q1', typed: true }] });
    expect(flagged!.history![0]).toEqual({ role: 'user', content: 'Q1' });
    expect(validateAskRequest({ ...goodAsk(), history: [{ role: 'user', content: 'Q1', typed: true }] })!.history![0]).toEqual({ role: 'user', content: 'Q1' });
  });

  it('relay asks carry the mode: exactly "full" or "locked"', () => {
    const { provider: _p, ...rest } = goodAsk();
    expect(validateRelayAsk({ ...rest, mode: 'full', state: null })).toMatchObject({ mode: 'full' });
    expect(validateRelayAsk({ ...rest, mode: 'locked', state: null })).toMatchObject({ mode: 'locked' });
    for (const mode of [undefined, null, 'FULL', 'open', 1]) expect(validateRelayAsk({ ...rest, mode, state: null }), String(mode)).toBeNull();
  });

  it('conversation state may say it is a full-mode conversation (absent: locked)', () => {
    expect(validateConvState(state({ mode: 'full' }))).toEqual(state({ mode: 'full' }));
    expect(validateConvState(state())).not.toHaveProperty('mode');
    expect(validateConvState({ ...state(), mode: 'locked' })).toBeNull();
    expect(validateConvState({ ...state(), mode: true })).toBeNull();
  });

  it('parseMode: absent → full (the default); "locked" → locked; anything else fails closed to locked', () => {
    expect(parseMode(undefined)).toBe('full');
    expect(parseMode(null)).toBe('locked'); // unexpected, not absent
    expect(parseMode('full')).toBe('full');
    expect(parseMode('locked')).toBe('locked');
    for (const v of ['Full', 'open', '', 0, true, {}, null]) expect(parseMode(v), JSON.stringify(v)).toBe('locked');
  });

  it('relay asks carry at most 3 validated cleanup project refs', () => {
    const { provider: _p, ...rest } = { ...goodAsk(), mode: 'locked' };
    const project = { orgTag: '0123456789abcdef', uuid: '0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e' };
    expect(validateRelayAsk({ ...rest, state: null })).toMatchObject({ cleanup: [] });
    expect(validateRelayAsk({ ...rest, state: null, cleanup: [project] })).toMatchObject({ cleanup: [project] });
    expect(validateRelayAsk({ ...rest, state: null, cleanup: [project, project, project, project] })).toBeNull();
    expect(validateRelayAsk({ ...rest, state: null, cleanup: [{ ...project, uuid: 'x' }] })).toBeNull();
    expect(validateRelayAsk({ ...rest, state: null, cleanup: 'all' })).toBeNull();
  });
});

describe('validateStreamEvent', () => {
  it('passes known events and strips conversation state unless allowed', () => {
    expect(validateStreamEvent({ type: 'delta', text: 'x' }, false)).toEqual({ type: 'delta', text: 'x' });
    expect(validateStreamEvent({ type: 'progress', junk: 1 }, false)).toEqual({ type: 'progress' });
    expect(validateStreamEvent({ type: 'error', code: 'timeout', message: 'm' }, false)).toMatchObject({ code: 'timeout' });
    const done = { type: 'done', convUuid: state().convUuid, util5h: 0.2, util7d: null, via: 'offscreenFrame', state: state() };
    expect(validateStreamEvent(done, false)).toEqual({ type: 'done', convUuid: state().convUuid, util5h: 0.2, util7d: null, via: 'offscreenFrame' });
    expect(validateStreamEvent(done, true)).toMatchObject({ state: state() });
    expect(validateStreamEvent({ ...done, via: 'carrier-pigeon' }, false)).not.toHaveProperty('via');
    expect(validateStreamEvent({ type: 'error', code: 'logged_out', message: 'm' }, false)).toEqual({
      type: 'error',
      code: 'logged_out',
      message: 'm',
    });
  });
  it('started / project / hello nonce', () => {
    const conv = state().convUuid;
    expect(validateStreamEvent({ type: 'started', convUuid: conv }, true)).toEqual({ type: 'started', convUuid: conv });
    expect(validateStreamEvent({ type: 'started', convUuid: conv }, false)).toBeNull(); // never to the bridge
    expect(validateStreamEvent({ type: 'started', convUuid: 'x' }, true)).toBeNull();
    const project = { orgTag: '0123456789abcdef', uuid: '0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e' };
    const done = { type: 'done', convUuid: conv, util5h: null, util7d: null, project };
    expect(validateStreamEvent(done, true)).toMatchObject({ project });
    expect(validateStreamEvent(done, false)).not.toHaveProperty('project');
    expect(validateStreamEvent({ type: 'error', code: 'unsafe', message: 'm', project }, true)).toMatchObject({ code: 'unsafe', project });
    const started = { type: 'started', convUuid: conv, project, created: project, cleaned: [project.uuid] };
    expect(validateStreamEvent(started, true)).toEqual(started);
    expect(validateStreamEvent({ ...started, cleaned: ['x'], created: { uuid: 'y' } }, true)).toEqual({ type: 'started', convUuid: conv, project });
    expect(validateStreamEvent({ type: 'error', code: 'unsafe', message: 'm', created: project, cleaned: [project.uuid] }, true)).toMatchObject({
      created: project,
      cleaned: [project.uuid],
    });
    expect(validateStreamEvent({ type: 'error', code: 'unsafe', message: 'm', created: project }, false)).not.toHaveProperty('created');
    expect(validateStreamEvent({ type: 'hello', v: 1, nonce: 'abcdef12-3456' }, false)).toEqual({ type: 'hello', v: 1, nonce: 'abcdef12-3456' });
    expect(validateStreamEvent({ type: 'hello', v: 1, nonce: '<bad>' }, false)).toBeNull();
  });

  it('full mode: status lines, the started org tag, the handoff flag (relay side only)', () => {
    const conv = state().convUuid;
    expect(validateStreamEvent({ type: 'status', text: 'Searching past chats…', extra: 1 }, false)).toEqual({ type: 'status', text: 'Searching past chats…' });
    for (const text of ['', 'x'.repeat(101), 'a\nb', 'a\u0000b', 'a\u2028b', 5, null]) {
      expect(validateStreamEvent({ type: 'status', text }, true), JSON.stringify(text)).toBeNull();
    }
    expect(validateStreamEvent({ type: 'started', convUuid: conv, orgTag: '0123456789abcdef' }, true)).toEqual({ type: 'started', convUuid: conv, orgTag: '0123456789abcdef' });
    expect(validateStreamEvent({ type: 'started', convUuid: conv, orgTag: 'an-org-id' }, true)).toEqual({ type: 'started', convUuid: conv });
    const done = { type: 'done', convUuid: conv, util5h: null, util7d: null, handoff: 'action' };
    expect(validateStreamEvent(done, true)).toMatchObject({ handoff: 'action' });
    expect(validateStreamEvent(done, false)).not.toHaveProperty('handoff');
    expect(validateStreamEvent({ ...done, handoff: 'pwn' }, true)).not.toHaveProperty('handoff');
  });

  it('rejects unknown types, codes and bad fields', () => {
    for (const x of [
      null,
      { type: 'eval', code: '1' },
      { type: 'delta', text: 5 },
      { type: 'error', code: 'pwned', message: 'm' },
      { type: 'done', convUuid: 'x', util5h: null, util7d: null },
      { type: 'done', convUuid: state().convUuid, util5h: '5', util7d: null },
    ]) {
      expect(validateStreamEvent(x, true)).toBeNull();
    }
  });
});

describe('My ChatGPT messages', () => {
  const gptAsk = (over: Record<string, unknown> = {}) => ({
    ...goodAsk(),
    provider: 'chatgpt',
    mode: 'full',
    typed: [0],
    state: state({ mode: 'full' }),
    pinnedTag: '0123456789abcdef',
    model: null,
    patch: { drop: ['local_function_names'] },
    hops: 0,
    doNotRemember: true,
    ...over,
  });

  it('the bridge may ask either provider', () => {
    expect(validateAskRequest({ ...goodAsk(), provider: 'chatgpt' })).toMatchObject({ provider: 'chatgpt' });
  });

  it('background → ChatGPT relay: full mode, its own state, a valid patch, bounded hops', () => {
    expect(validateGptRelayAsk(gptAsk())).toMatchObject({ provider: 'chatgpt', mode: 'full', typed: [0], hops: 0, doNotRemember: true, patch: { drop: ['local_function_names'] } });
    expect(validateGptRelayAsk(gptAsk({ state: null, pinnedTag: null, model: 'gpt-5-6-thinking', dryRun: true }))).toMatchObject({ dryRun: true, model: 'gpt-5-6-thinking' });
    for (const bad of [
      { mode: 'locked' },
      { provider: 'claude' },
      { state: state() }, // a locked (Claude) conversation state is never continued here
      { pinnedTag: 'acct-1' },
      { model: 'GPT 5' },
      { patch: { drop: ['messages'] } },
      { hops: 3 },
      { hops: -1 },
      { typed: [5] },
      { dryRun: false },
      { doNotRemember: undefined },
      { org: 'x' },
    ]) {
      expect(validateGptRelayAsk(gptAsk(bad)), JSON.stringify(bad)).toBeNull();
    }
    // and the Claude relay never takes a ChatGPT ask
    expect(validateRelayAsk(gptAsk())).toBeNull();
  });

  it('relay events: navigating and pin only on the relay side; the model rides on done', () => {
    expect(validateStreamEvent({ type: 'navigating' }, true)).toEqual({ type: 'navigating' });
    expect(validateStreamEvent({ type: 'navigating' }, false)).toBeNull();
    expect(validateStreamEvent({ type: 'started', convUuid: state().convUuid, orgTag: '0123456789abcdef', pin: true }, true)).toMatchObject({ pin: true });
    expect(validateStreamEvent({ type: 'done', convUuid: state().convUuid, util5h: null, util7d: null, model: 'gpt-5-6-thinking' }, false)).toMatchObject({ model: 'gpt-5-6-thinking' });
    expect(validateStreamEvent({ type: 'done', convUuid: state().convUuid, util5h: null, util7d: null, model: '<img>' }, false)).not.toHaveProperty('model');
  });
});
