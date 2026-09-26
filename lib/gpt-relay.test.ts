import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountTagFor } from './gpt-guard';
import type { GptSession } from './gpt-account';
import { GPT_NO_MEMORY_UNCONFIRMED, appNavigate, plainChat, runGptAsk, sendButton, setDoNotRemember, toolResultIn, type GptRelayEnv, type PageLink } from './gpt-relay';
import type { FromPage } from './gpt-channel';
import type { GptRelayAsk, StreamEvent } from './protocol';

const CONV = '68d5f0e1-1234-4000-8000-000000000001';
const SESSION: GptSession = { accessToken: 'tok', accountId: 'acct-1', planType: 'pro', structure: 'personal' };
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('toolResultIn (what the stopped turn shows)', () => {
  const conv = (callStatus: string, child?: { role: string }) => ({
    current_node: child ? 'r' : 'c',
    mapping: {
      u: { message: { id: 'u', author: { role: 'user' } }, children: ['c'] },
      c: { message: { id: 'call-1', author: { role: 'assistant' }, recipient: 'bio', status: callStatus }, parent: 'u', children: child ? ['r'] : [] },
      ...(child ? { r: { message: { id: 'r', author: { role: child.role } }, parent: 'c', children: [] } } : {}),
    },
  });

  // Review PoC (arena-review7/poc/readback.test.ts), must fail: a call missing from the readback
  // counted as "none", i.e. "stopped before it ran".
  it('a call missing from the readback is unknown ("may have run"), not "none" (PoC)', () => {
    expect(toolResultIn({ mapping: {} }, 'call-123')).toBe('unknown');
    expect(toolResultIn({ mapping: { x: { message: { id: 'x', author: { role: 'user' } } } }, current_node: 'x' }, 'call-123')).toBe('unknown');
  });

  it('a node that only has the id as its key, a call with no status, or a gap under it: unknown (Astra round-8)', () => {
    expect(toolResultIn({ mapping: { call: { message: null, children: [] } } }, 'call')).toBe('unknown');
    const noStatus = conv('in_progress');
    delete (noStatus.mapping.c.message as { status?: string }).status;
    expect(toolResultIn(noStatus, 'call-1')).toBe('unknown');
    const gap = conv('in_progress');
    gap.mapping.c.children = ['missing'];
    expect(toolResultIn(gap, 'call-1')).toBe('unknown');
    const user = conv('in_progress');
    (user.mapping.c.message.author as { role: string }).role = 'user';
    expect(toolResultIn(user, 'call-1')).toBe('unknown');
  });

  it('no call id to look it up by, or no readable chat: unknown', () => {
    expect(toolResultIn(conv('in_progress'), null)).toBe('unknown');
    expect(toolResultIn(null, 'call-1')).toBe('unknown');
    expect(toolResultIn({}, 'call-1')).toBe('unknown');
  });

  it('a result under the call: result; the call there, unfinished, nothing after it: none; the call finished: unknown', () => {
    expect(toolResultIn(conv('finished_successfully', { role: 'tool' }), 'call-1')).toBe('result');
    expect(toolResultIn(conv('in_progress'), 'call-1')).toBe('none');
    expect(toolResultIn(conv('finished_partial_completion'), 'call-1')).toBe('none');
    // chatgpt.com runs a call once it is complete: a finished call with no result yet may have run
    expect(toolResultIn(conv('finished_successfully'), 'call-1')).toBe('unknown');
  });
});

describe('plainChat (a chat is continued only if it reads back as a plain personal chat)', () => {
  const good = { conversation_id: CONV, is_archived: false, is_temporary_chat: false, mapping: {}, current_node: 'x', gizmo_id: null, gizmo_type: null, conversation_template_id: null, is_do_not_remember: false, title: 't' };
  it('accepts a plain chat that says so explicitly', () => {
    expect(plainChat(good, CONV)).toBe(true);
  });
  it.each([
    ['any 200 object', {}],
    ['another chat', { ...good, conversation_id: '68d5f0e1-1234-4000-8000-000000000002' }],
    ['archived', { ...good, is_archived: true }],
    ['no is_archived', (({ is_archived: _a, ...r }) => r)(good)],
    ['a GPT', { ...good, gizmo_id: 'g-abc' }],
    ['a project', { ...good, gizmo_id: 'g-p-abc', gizmo_type: 'snorlax' }],
    ['a project (by id)', { ...good, project_id: 'p1' }],
    ['a template', { ...good, conversation_template_id: 'g-p-1' }],
    ['a workspace', { ...good, workspace_id: 'w' }],
    ['temporary', { ...good, is_temporary_chat: true }],
    ['read-only', { ...good, is_read_only: true }],
    ['no mapping', { ...good, mapping: null }],
    // Astra round-8: fields that would say "project" or "GPT" missing from the answer prove nothing
    ['no gizmo_id', (({ gizmo_id: _g, ...r }) => r)(good)],
    ['no gizmo_type', (({ gizmo_type: _g, ...r }) => r)(good)],
    ['no conversation_template_id', (({ conversation_template_id: _g, ...r }) => r)(good)],
    ['no is_temporary_chat', (({ is_temporary_chat: _g, ...r }) => r)(good)],
  ])('refuses %s', (_n, c) => {
    expect(plainChat(c, CONV)).toBe(false);
  });
});

describe('setDoNotRemember (retried until the read-back confirms; failed vs slow)', () => {
  function server(o: { patch: (n: number) => number | 'hang'; stored: (n: number) => boolean }) {
    let patches = 0;
    let reads = 0;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (init?.method === 'PATCH') {
          const st = o.patch(patches++);
          if (st === 'hang') return new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('t', 'TimeoutError'))));
          return json({ success: st === 200 }, st);
        }
        return json({ conversation_id: CONV, is_do_not_remember: o.stored(reads++) });
      }),
    );
    return calls;
  }
  const fast = { totalMs: 2_000, perTryMs: 200, backoffMs: [0, 10, 20, 40] };

  it("QA-1: a new chat's first PATCH is lost (not stored yet): retried until confirmed", async () => {
    const calls = server({ patch: (n) => (n < 2 ? 404 : 200), stored: () => true });
    expect(await setDoNotRemember(CONV, SESSION, new AbortController().signal, fast)).toBe('on');
    expect(calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(3);
  });

  it('PATCH accepted but the chat reads back without it: retried, then failed:still_off', async () => {
    server({ patch: () => 200, stored: () => false });
    expect(await setDoNotRemember(CONV, SESSION, new AbortController().signal, { ...fast, totalMs: 300 })).toBe('failed:still_off');
  });

  it('refused (403): failed; never answered: slow (bounded)', async () => {
    server({ patch: () => 403, stored: () => false });
    expect(await setDoNotRemember(CONV, SESSION, new AbortController().signal, { ...fast, totalMs: 300 })).toBe('failed:patch_403');
    server({ patch: () => 'hang', stored: () => false });
    const t0 = Date.now();
    expect(await setDoNotRemember(CONV, SESSION, new AbortController().signal, { ...fast, totalMs: 500 })).toBe('slow:timeout');
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it('on: false clears the flag the same way: cleared once it reads back off; failed:still_on if it stays', async () => {
    const calls = server({ patch: () => 200, stored: () => false });
    expect(await setDoNotRemember(CONV, SESSION, new AbortController().signal, { ...fast, on: false })).toBe('cleared');
    expect(calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(1);
    server({ patch: () => 200, stored: () => true });
    expect(await setDoNotRemember(CONV, SESSION, new AbortController().signal, { ...fast, totalMs: 300, on: false })).toBe('failed:still_on');
  });

  it('stops when the question is aborted', async () => {
    server({ patch: () => 'hang', stored: () => false });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    expect(await setDoNotRemember(CONV, SESSION, ac.signal, { totalMs: 10_000, perTryMs: 5_000 })).toBe('slow:aborted');
  });
});

describe("runGptAsk: with \"don't remember\" on, never a turn in a chat it isn't confirmed on", () => {
  let events: StreamEvent[];
  let fetches: string[];
  let navigated: string[];
  let patchBodies: unknown[];
  beforeEach(() => {
    events = [];
    fetches = [];
    navigated = [];
    patchBodies = [];
  });
  const env = (): GptRelayEnv => ({
    link: { ready: async () => ({ t: 'ready', mode: 'frame', active: true }), on: () => () => {}, send: () => {}, arm: async () => true, checker: null } as unknown as PageLink,
    served: () => null,
    noteServed: () => {},
    navigate: (p) => navigated.push(p),
  });
  async function ask(o: { doNotRemember: boolean; chat: Record<string, unknown>; patch: number; signal?: AbortSignal; stored?: boolean }) {
    const tag = await accountTagFor('acct-1');
    const chatNow = { ...o.chat };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        fetches.push(`${init?.method ?? 'GET'} ${url.replace(CONV, '<c>')}`);
        if (url === '/api/auth/session') return json({ user: {}, accessToken: 'tok', account: { id: 'acct-1', planType: 'pro', structure: 'personal' } });
        if (url.startsWith('/backend-api/accounts/check')) return json({ accounts: { 'acct-1': { account: { account_id: 'acct-1', structure: 'personal', plan_type: 'pro', workspace_type: null, organization_id: null } } } });
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body));
          patchBodies.push(body);
          if (o.stored && o.patch === 200) Object.assign(chatNow, body); // the server keeps it
          return json({}, o.patch);
        }
        return json(chatNow);
      }),
    );
    const req: GptRelayAsk = {
      type: 'ask',
      provider: 'chatgpt',
      mode: 'full',
      chapterKey: 'chapter0',
      chapterTitle: 'Ch',
      prompt: 'Q2',
      context: '',
      history: [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
      ],
      priorCount: 2,
      anchor: 'a'.repeat(64),
      typed: [0],
      state: { v: 1, orgTag: tag, convUuid: CONV, parent: '68d5f0e1-1234-4000-8000-0000000000a1', anchor: 'a'.repeat(64), arenaLen: 2, ctxHash: null, filed: false, name: 'ARENA · Ch', updatedAt: 1, mode: 'full' },
      pinnedTag: tag,
      model: null,
      patch: {},
      hops: 0,
      doNotRemember: o.doNotRemember,
    };
    await runGptAsk(req, (e) => events.push(e), o.signal ?? new AbortController().signal, env());
  }
  const chat = { conversation_id: CONV, is_archived: false, is_temporary_chat: false, mapping: {}, current_node: 'x', gizmo_id: null, gizmo_type: null, conversation_template_id: null, is_do_not_remember: false };

  it('the PATCH fails: the question is not sent (error, no navigation, nothing typed)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let settled = false;
    const done = ask({ doNotRemember: true, chat, patch: 403 }).finally(() => (settled = true));
    for (let i = 0; i < 2_000 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(50);
      await new Promise((r) => setImmediate(r)); // real I/O (the digest) gets its turn
    }
    await done;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'unsafe', message: GPT_NO_MEMORY_UNCONFIRMED });
    expect((events[0] as { diag?: string }).diag).toMatch(/^gpt:nomem:failed:patch_403/);
    expect(navigated).toEqual([]);
    expect(fetches.filter((f) => f.startsWith('PATCH')).length).toBeGreaterThan(1); // retried
  });

  it('already "don\'t remember": no PATCH; off (the default): no PATCH either', async () => {
    // (each goes on to the page, which isn't there: stopped after the checks)
    const quick = () => AbortSignal.timeout(300);
    await ask({ doNotRemember: true, chat: { ...chat, is_do_not_remember: true }, patch: 500, signal: quick() });
    expect(fetches.some((f) => f.startsWith('PATCH'))).toBe(false);
    events = [];
    fetches = [];
    await ask({ doNotRemember: false, chat, patch: 500, signal: quick() });
    expect(fetches.some((f) => f.startsWith('PATCH'))).toBe(false);
    expect(events.some((e) => e.type === 'error' && e.message === GPT_NO_MEMORY_UNCONFIRMED)).toBe(false);
  });

  it('turned off again: a chat still marked is unmarked (PATCH false, read back) before its turn', async () => {
    const quick = () => AbortSignal.timeout(300);
    await ask({ doNotRemember: false, chat: { ...chat, is_do_not_remember: true }, patch: 200, stored: true, signal: quick() });
    expect(patchBodies).toEqual([{ is_do_not_remember: false }]); // confirmed on the first read-back
    const firstPatch = fetches.findIndex((f) => f.startsWith('PATCH'));
    expect(fetches[firstPatch + 1]).toBe('GET /backend-api/conversation/<c>'); // read back
    expect(events.some((e) => e.type === 'error' && e.message === GPT_NO_MEMORY_UNCONFIRMED)).toBe(false);
  });

  it("turned off, and chatgpt.com won't unmark it: the question still goes (the stricter state), never re-marked", async () => {
    const quick = () => AbortSignal.timeout(300);
    await ask({ doNotRemember: false, chat: { ...chat, is_do_not_remember: true }, patch: 403, signal: quick() });
    expect(patchBodies.length).toBeGreaterThan(0);
    expect(patchBodies.every((b) => JSON.stringify(b) === '{"is_do_not_remember":false}')).toBe(true);
    expect(events.some((e) => e.type === 'error' && (e.message === GPT_NO_MEMORY_UNCONFIRMED || e.code === 'unsafe'))).toBe(false);
  });
});

describe('sendButton (only the composer form\'s own Send)', () => {
  it('a submit button elsewhere in the page (earlier in document order) is never picked', () => {
    document.body.innerHTML = `
      <div role="dialog"><form><button type="submit" id="other">Switch account</button></form></div>
      <form id="composer"><div class="ProseMirror" contenteditable="true"></div><button type="submit" id="send">Send</button></form>`;
    expect(sendButton()?.id).toBe('send');
  });
  it('no usable Send in the composer form: null (never a fallback elsewhere)', () => {
    document.body.innerHTML = `
      <form><button type="submit" id="other">Confirm</button></form>
      <form><div class="ProseMirror" contenteditable="true"></div><button type="submit" disabled>Send</button><button aria-label="Stop streaming" type="submit">Stop</button></form>`;
    expect(sendButton()).toBeNull();
    document.body.innerHTML = `<form><button type="submit">Confirm</button></form>`;
    expect(sendButton()).toBeNull();
  });
});

describe("appNavigate (the app's own router, no page load)", () => {
  it('pushes the route, fires popstate, and waits until the app has rendered it', async () => {
    document.body.innerHTML = `<form><div class="ProseMirror" contenteditable="true"></div></form><main id="m"></main>`;
    const seen: string[] = [];
    const onPop = () => {
      seen.push(location.pathname);
      // a router: renders the chat a little later
      setTimeout(() => {
        document.getElementById('m')!.innerHTML = location.pathname === '/' ? '' : '<div data-turn-key="1"></div>';
      }, 50);
    };
    window.addEventListener('popstate', onPop);
    try {
      expect(await appNavigate(`/c/${CONV}`, new AbortController().signal, 2_000)).toBe(true);
      expect(location.pathname).toBe(`/c/${CONV}`);
      expect(seen).toEqual([`/c/${CONV}`]);
      // another chat: through a new chat first (the old chat's turns can't pass for the new one's)
      const other = '68d5f0e1-1234-4000-8000-000000000002';
      expect(await appNavigate(`/c/${other}`, new AbortController().signal, 2_000)).toBe(true);
      expect(seen).toEqual([`/c/${CONV}`, '/', `/c/${other}`]);
      // a router that never renders it: false (the caller reloads the page instead)
      window.removeEventListener('popstate', onPop);
      expect(await appNavigate(`/c/${CONV}`, new AbortController().signal, 300)).toBe(false);
    } finally {
      window.removeEventListener('popstate', onPop);
      history.replaceState(null, '', '/');
    }
  });
});

describe('runGptAsk end to end (a jsdom page, a fake MAIN world)', () => {
  const ENC = 'event: delta_encoding\ndata: "v1"\n\n';
  const ev = (d: unknown) => `event: delta\ndata: ${JSON.stringify(d)}\n\n`;
  class FakeLink {
    listeners = new Set<(m: FromPage) => void>();
    checker: PageLink['checker'] = null;
    sent: unknown[] = [];
    req = '';
    async ready() {
      return { t: 'ready' as const, mode: 'frame' as const, active: true };
    }
    on(fn: (m: FromPage) => void) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    send(c: unknown) {
      this.sent.push(c);
    }
    async arm(req: string) {
      this.req = req;
      return true;
    }
    emit(m: FromPage) {
      for (const fn of [...this.listeners]) fn(m);
    }
  }
  let composer: HTMLElement;
  let origExec: typeof document.execCommand;
  beforeEach(() => {
    history.replaceState(null, '', '/');
    document.body.innerHTML = `<main></main><form><div class="ProseMirror" contenteditable="true"></div><button type="button" data-testid="send-button">Send</button></form>`;
    composer = document.querySelector('.ProseMirror')!;
    origExec = document.execCommand;
    document.execCommand = ((cmd: string, _ui?: boolean, text?: string) => {
      if (cmd === 'insertText') composer.textContent = (composer.textContent ?? '') + (text ?? '');
      if (cmd === 'delete') composer.textContent = '';
      return true;
    }) as typeof document.execCommand;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/session') return json({ user: {}, accessToken: 'tok', account: { id: 'acct-1', planType: 'pro', structure: 'personal' } });
        if (url.startsWith('/backend-api/accounts/check')) return json({ accounts: { 'acct-1': { account: { account_id: 'acct-1', structure: 'personal', plan_type: 'pro', workspace_type: null, organization_id: null } } } });
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    document.execCommand = origExec;
  });
  const req = (): GptRelayAsk => ({
    type: 'ask',
    provider: 'chatgpt',
    mode: 'full',
    chapterKey: 'chapter0',
    chapterTitle: 'Ch',
    prompt: 'What is einsum?',
    context: '',
    history: [],
    priorCount: 0,
    anchor: 'a'.repeat(64),
    typed: [],
    state: null,
    pinnedTag: null,
    model: null,
    patch: { drop: ['local_function_names'] },
    hops: 0,
    doNotRemember: false,
  });
  /** The page's own conversation request for what is in the composer now. */
  const pageBody = () => JSON.stringify({ action: 'next', local_function_names: ['x'], messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [composer.textContent] }, metadata: {} }] });

  // Astra round-8 diff review: a cancel while the check was still hashing let the verdict say "send".
  it('cancelled while the check runs: the verdict is "no", and the MAIN world is disarmed at once', async () => {
    const link = new FakeLink();
    const ac = new AbortController();
    let verdict: Promise<unknown> | null = null;
    document.querySelector('button')!.addEventListener('click', () => {
      verdict = link.checker!({ t: 'check', req: link.req, id: 1, body: pageBody(), account: 'acct-1' });
      ac.abort(); // ARENA cancelled, right then
    });
    const events: StreamEvent[] = [];
    await runGptAsk(req(), (e) => events.push(e), ac.signal, { link: link as unknown as PageLink, served: () => null, noteServed: () => {}, navigate: () => {} });
    expect(verdict).not.toBeNull();
    expect(await verdict).toEqual({ ok: false, why: 'ended' });
    expect(link.sent).toContainEqual({ t: 'disarm' });
    expect(events.filter((e) => e.type === 'done' || e.type === 'delta')).toEqual([]);
  });

  it('the checked request goes out, the answer streams, the new chat is known at once', async () => {
    const link = new FakeLink();
    let verdict: unknown = null;
    document.querySelector('button')!.addEventListener('click', async () => {
      verdict = await link.checker!({ t: 'check', req: link.req, id: 1, body: pageBody(), account: 'acct-1' });
      const r = link.req;
      for (const chunk of [
        ENC,
        ev({ p: '', o: 'add', c: 0, v: { message: { id: 'u', author: { role: 'user' }, recipient: 'all', channel: null, content: { content_type: 'text', parts: ['q'] }, status: 'finished_successfully', metadata: {} }, conversation_id: CONV } }),
        ev({ p: '', o: 'add', c: 1, v: { message: { id: '68d5f0e1-1234-4000-8000-0000000000a1', author: { role: 'assistant' }, recipient: 'all', channel: 'final', content: { content_type: 'text', parts: [''] }, status: 'in_progress', metadata: { message_type: 'next', model_slug: 'gpt-x' } }, conversation_id: CONV } }),
        ev({ p: '/message/content/parts/0', o: 'append', v: 'einsum sums.' }),
        ev({ p: '', o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] }),
        `data: ${JSON.stringify({ type: 'message_stream_complete', conversation_id: CONV })}\n\n`,
        'data: [DONE]\n\n',
      ])
        link.emit({ t: 'sse', req: r, chunk });
      link.emit({ t: 'sse-end', req: r });
    });
    const events: StreamEvent[] = [];
    await runGptAsk(req(), (e) => events.push(e), new AbortController().signal, { link: link as unknown as PageLink, served: () => null, noteServed: () => {}, navigate: () => {} });
    expect(verdict).toMatchObject({ ok: true });
    expect(JSON.parse((verdict as { body: string }).body)).not.toHaveProperty('local_function_names');
    const started = events.find((e) => e.type === 'started') as Extract<StreamEvent, { type: 'started' }>;
    expect(started).toMatchObject({ convUuid: CONV, pin: true });
    expect(started.state).toMatchObject({ convUuid: CONV, mode: 'full' });
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('einsum sums.');
    const done = events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>;
    expect(done).toMatchObject({ convUuid: CONV, model: 'gpt-x' });
    expect(done.diag).toMatch(/^gpt:sent:-local_function_names:page:as_is:nomem:off:/);
  });
});
