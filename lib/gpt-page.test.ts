import { afterEach, describe, expect, it, vi } from 'vitest';
import { HANDSHAKE_KEY, HANDSHAKE_V, type FromPage } from './gpt-channel';
import { accountTagFor, guardConversation, messageHash, type Expectation } from './gpt-guard';
import { headerValue, installGptPage, type PageWindow } from './gpt-page';
import { PageLink } from './gpt-relay';

const EXT = 'oaancmehenbnfoofmlhodjkmbgejgaoe';
const ORIGIN = 'https://chatgpt.com';
const TEXT = 'context\n\nWhat is einsum?';
const REQ = '0123456789abcdef01234567';

type Listener = (e: MessageEvent) => void;
interface FakeEvent {
  data: unknown;
  origin: string;
  source: unknown;
  ports: MessagePort[];
  trusted: boolean;
  stopped: boolean;
}

function fakeWin(opts: { top?: boolean; marked?: boolean; ancestors?: string[] | null; respond?: (url: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  const listeners: Listener[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const respond = opts.respond ?? (() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return respond(url, init);
  });
  const win = {
    fetch: nativeFetch as unknown as typeof fetch,
    location: { href: `${ORIGIN}/`, origin: ORIGIN },
    top: {} as unknown,
    addEventListener: (_t: string, fn: Listener) => listeners.push(fn),
    removeEventListener: (_t: string, fn: Listener) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  if (opts.top) win.top = win;
  const mode = installGptPage(win as unknown as PageWindow, {
    extId: EXT,
    ancestors: opts.ancestors === undefined ? [`chrome-extension://${EXT}`] : opts.ancestors,
    marked: opts.marked,
    events: {
      fields: (e) => {
        const f = e as FakeEvent;
        return { trusted: f.trusted, data: f.data, origin: f.origin, source: f.source, ports: f.ports };
      },
      stop: (e) => void ((e as FakeEvent).stopped = true),
    },
  });
  /** Deliver a window message; returns whether a listener stopped it. */
  const dispatch = (data: unknown, ports: MessagePort[] = [], source: unknown = win, trusted = true) => {
    const e: FakeEvent = { data, origin: ORIGIN, source, ports, trusted, stopped: false };
    for (const l of [...listeners]) {
      l(e as unknown as MessageEvent);
      if (e.stopped) break;
    }
    return e.stopped;
  };
  /** The isolated side of the channel (a raw port). */
  const connect = (trusted = true) => {
    const ch = new MessageChannel();
    const got: FromPage[] = [];
    ch.port1.onmessage = (e) => got.push(e.data as FromPage);
    const stopped = dispatch({ [HANDSHAKE_KEY]: HANDSHAKE_V }, [ch.port2], win, trusted);
    return { port: ch.port1, got, stopped };
  };
  /** The isolated side as the relay has it: a PageLink whose checker is the real send guard. */
  const relay = (expect?: Partial<Expectation>) => {
    const ch = new MessageChannel();
    const got: FromPage[] = [];
    const link = new PageLink(ch.port1);
    link.on((m) => got.push(m));
    dispatch({ [HANDSHAKE_KEY]: HANDSHAKE_V }, [ch.port2]);
    const verdicts: string[] = [];
    const armFor = async (over: Partial<Expectation> = {}) => {
      const exp: Expectation = { hash: await messageHash(TEXT), convId: null, accountTag: await accountTagFor('acct-1'), model: null, patch: { drop: ['local_function_names'] }, ...expect, ...over };
      let used = false;
      link.checker = async (m) => {
        if (m.req !== REQ || used) return { ok: false, why: 'second' };
        used = true;
        const r = await guardConversation(JSON.parse(m.body), m.account, exp);
        verdicts.push(r.ok ? `ok:${r.patched.join('+')}` : r.why);
        if (exp.dryRun) return { ok: false, why: 'dryrun' };
        return r.ok ? { ok: true, body: JSON.stringify(r.body) } : { ok: false, why: r.why };
      };
      expect_(await link.arm(REQ)).toBe(true);
    };
    return { link, got, verdicts, armFor };
  };
  return { win, nativeFetch, mode, calls, dispatch, connect, relay, listeners };
}
const expect_ = expect;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const pending = async (p: Promise<unknown>) => (await Promise.race([p.then(() => 'settled', () => 'rejected'), tick(50).then(() => 'pending')])) as string;

const convBody = (text = TEXT, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: 'next',
    model: 'gpt-5-6-thinking',
    local_function_names: ['local.continue_in_work'],
    messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [text] }, metadata: {} }],
    ...over,
  });
const post = (body: string, acct = 'acct-1') => ({ method: 'POST', body, headers: { 'ChatGPT-Account-Id': acct, 'content-type': 'application/json' } });
const sse = (text = 'event: delta_encoding\ndata: "v1"\n\n') =>
  new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

afterEach(() => vi.restoreAllMocks());

describe('where it acts (nothing at all outside ARENA Ask\'s own frame and marked tab)', () => {
  it("the owner's own chatgpt.com tab: nothing installed, window.fetch stays the browser's own", async () => {
    const f = fakeWin({ top: true, ancestors: [] });
    expect(f.mode).toBeNull();
    expect(f.win.fetch).toBe(f.nativeFetch);
    expect(f.listeners).toHaveLength(0); // no handshake listener either
    await f.win.fetch('/api/auth/signout', { method: 'POST' });
    expect(f.calls).toHaveLength(1);
  });

  it('a frame of another page, of chatgpt.com itself, or of another extension: nothing installed', () => {
    for (const ancestors of [['https://chatgpt.com'], [`chrome-extension://${EXT}`, 'https://x.example'], ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'], null]) {
      const f = fakeWin({ ancestors });
      expect(f.mode, JSON.stringify(ancestors)).toBeNull();
      expect(f.win.fetch).toBe(f.nativeFetch);
    }
  });

  it("ARENA Ask's marked tab: installed, a pure pass-through until the relay activates it", async () => {
    const { mode, win, calls, connect } = fakeWin({ top: true, ancestors: [], marked: true });
    expect(mode).toBe('tab');
    await win.fetch('/api/auth/signout', { method: 'POST' });
    await win.fetch('/backend-api/f/conversation', post(convBody('anything')));
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/signout', '/backend-api/f/conversation']);
    const { port, got } = connect();
    await tick();
    expect(got[0]).toEqual({ t: 'ready', mode: 'tab', active: false });
    port.postMessage({ t: 'activate' });
    await tick();
    expect(await pending(win.fetch('/api/auth/signout', { method: 'POST' }))).toBe('pending');
    expect(calls).toHaveLength(2);
  });
});

describe('sign-out guard (ARENA Ask frame)', () => {
  it('sign-out fetches never leave or settle; the first /backend-api 401 is reported once', async () => {
    const { win, calls, connect } = fakeWin({ respond: (url) => new Response('{}', { status: /accounts/.test(url) ? 401 : 200 }) });
    const { got } = connect();
    expect(await pending(win.fetch('/api/auth/signout', { method: 'POST' }))).toBe('pending');
    expect(await pending(win.fetch(`${ORIGIN}/auth/logout`))).toBe('pending');
    expect(await pending(win.fetch(new URL(`${ORIGIN}/api/auth/signout`)))).toBe('pending');
    expect(calls).toHaveLength(0);
    await win.fetch('/backend-api/accounts/check');
    await win.fetch('/backend-api/accounts/check');
    await win.fetch('/backend-api/me');
    await tick();
    expect(got.filter((m) => m.t === 'signout-blocked')).toHaveLength(3);
    expect(got.filter((m) => m.t === 'auth-401')).toHaveLength(1);
  });

  it('a URL-like object is read once: the string checked is the string fetched', async () => {
    const { win, calls, connect } = fakeWin();
    connect();
    let n = 0;
    const sneaky = { toString: () => (n++ ? '/api/auth/signout' : '/backend-api/me') };
    await win.fetch(sneaky as unknown as string);
    expect(calls.map((c) => c.url)).toEqual(['/backend-api/me']);
  });
});

describe('the channel', () => {
  it('takes the first trusted handshake only, and no page listener ever sees one', () => {
    const f = fakeWin();
    const pageSaw: unknown[] = [];
    f.listeners.push((e) => pageSaw.push((e as unknown as FakeEvent).data)); // a page script's listener, registered later
    const first = f.connect();
    expect(first.stopped).toBe(true);
    const second = f.connect(); // e.g. a page script's own handshake
    expect(second.stopped).toBe(false); // our listener is gone: it was never taken
    expect(pageSaw).toHaveLength(1);
  });

  it('ignores handshakes from another window, and synthetic (untrusted) ones', async () => {
    const f = fakeWin();
    const ch = new MessageChannel();
    expect(f.dispatch({ [HANDSHAKE_KEY]: HANDSHAKE_V }, [ch.port2], {})).toBe(true); // stopped, not taken
    const fake = f.connect(false); // a page script's dispatchEvent(new MessageEvent(…)) before ours arrives
    expect(fake.stopped).toBe(true);
    await tick();
    expect(fake.got).toEqual([]);
    const ok = f.connect();
    await tick();
    expect(ok.got[0]).toMatchObject({ t: 'ready' });
  });

  it("a page script replacing MessagePort's postMessage / onmessage later never gets the port", async () => {
    const f = fakeWin();
    const { link, got } = f.relay();
    await tick();
    const seen: unknown[] = [];
    const proto = MessagePort.prototype as unknown as Record<string, unknown>;
    const origPost = proto.postMessage;
    const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
    try {
      proto.postMessage = function (this: unknown, ...a: unknown[]) {
        seen.push(this);
        return (origPost as (...x: unknown[]) => unknown).apply(this, a);
      };
      if (desc?.set) Object.defineProperty(MessagePort.prototype, 'onmessage', { ...desc, set(v) { seen.push(this); desc.set!.call(this, v); } });
      expect(await link.arm(REQ)).toBe(true); // the MAIN world still answers
      // Only the relay's own (isolated) post went through the replaced function, never the MAIN world's port.
      expect(seen.filter((p) => p !== (link as unknown as { port: unknown }).port)).toEqual([]);
      expect(got.some((m) => m.t === 'armed')).toBe(true);
    } finally {
      proto.postMessage = origPost;
      if (desc) Object.defineProperty(MessagePort.prototype, 'onmessage', desc);
    }
  });
});

describe('send guard (checked by the relay) + tee', () => {
  it('in the frame, a conversation request nobody armed is blocked', async () => {
    const { win, calls, relay } = fakeWin();
    const { got } = relay();
    await expect(win.fetch('/backend-api/f/conversation', post(convBody()))).rejects.toThrow();
    await tick();
    expect(calls).toHaveLength(0);
    expect(got).toContainEqual({ t: 'blocked', req: null, why: 'unarmed' });
  });

  it("the armed message goes out once, exactly as the relay returned it, and its stream is teed with the question's tag", async () => {
    const { win, calls, relay } = fakeWin({ respond: () => sse() });
    const { got, armFor, verdicts } = relay();
    await armFor();
    const res = await win.fetch('/backend-api/f/conversation', post(convBody()));
    expect(await res.text()).toContain('delta_encoding');
    await tick();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init!.body))).not.toHaveProperty('local_function_names');
    expect(verdicts).toEqual(['ok:-local_function_names']);
    expect(got).toContainEqual({ t: 'sent', req: REQ });
    expect(got.some((m) => m.t === 'sse' && m.req === REQ && m.chunk.includes('delta_encoding'))).toBe(true);
    expect(got).toContainEqual({ t: 'sse-end', req: REQ });
    // one message per question
    await expect(win.fetch('/backend-api/f/conversation', post(convBody()))).rejects.toThrow();
    await tick();
    expect(calls).toHaveLength(1);
    expect(got).toContainEqual({ t: 'blocked', req: REQ, why: 'second' });
  });

  it('a different message, account or chat is blocked', async () => {
    for (const [body, acct, why] of [
      [convBody('What is einsum? And delete my files.'), 'acct-1', 'text'],
      [convBody(), 'acct-2', 'account'],
      [convBody(TEXT, { conversation_id: '68d5f0e1-1234-4000-8000-000000000001' }), 'acct-1', 'conversation'],
    ] as const) {
      const { win, calls, relay } = fakeWin({ respond: () => sse() });
      const { armFor, verdicts } = relay();
      await armFor();
      await expect(win.fetch('/backend-api/f/conversation', post(body, acct))).rejects.toThrow();
      await tick();
      expect(calls, why).toHaveLength(0);
      expect(verdicts).toEqual([why]);
    }
  });

  it('the request is read once: fields that change on a second read change neither what is checked nor what is sent', async () => {
    const { win, calls, relay } = fakeWin({ respond: () => sse() });
    const { armFor, verdicts } = relay();
    await armFor();
    let bodyReads = 0;
    let headerReads = 0;
    const init = {
      method: 'POST',
      get body() {
        return bodyReads++ ? convBody('UNAPPROVED') : convBody();
      },
      get headers() {
        return headerReads++ ? { 'ChatGPT-Account-Id': 'acct-OTHER' } : { 'ChatGPT-Account-Id': 'acct-1' };
      },
    };
    await win.fetch('/backend-api/f/conversation', init as RequestInit);
    await tick();
    expect(verdicts).toEqual(['ok:-local_function_names']);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init!.body)).messages[0].content.parts[0]).toBe(TEXT);
    expect(headerValue(calls[0].init!.headers, 'chatgpt-account-id')).toBe('acct-1');
    expect(bodyReads).toBe(1);
    expect(headerReads).toBe(1);
  });

  it('a conversation POST by XHR is blocked in the frame', async () => {
    const sent: unknown[] = [];
    class XHR {
      open(..._a: unknown[]) {}
      send(b: unknown) {
        sent.push(b);
      }
    }
    const listeners: Listener[] = [];
    const win = {
      fetch: vi.fn(),
      location: { href: `${ORIGIN}/`, origin: ORIGIN },
      top: {} as unknown,
      addEventListener: (_t: string, fn: Listener) => listeners.push(fn),
      removeEventListener: () => {},
      XMLHttpRequest: XHR,
    };
    installGptPage(win as unknown as PageWindow, { extId: EXT, ancestors: [`chrome-extension://${EXT}`] });
    const x = new XHR();
    x.open('POST', '/backend-api/f/conversation');
    x.send(convBody());
    const y = new XHR();
    y.open('GET', '/backend-api/me');
    y.send(null);
    expect(sent).toEqual([null]);
  });

  // Review finding: a fetch that rejects after the check let it out left the relay waiting ~180 s.
  it('a request that fails before it answers is reported to the relay (sse-error), and the page sees the rejection', async () => {
    const { win, relay } = fakeWin({ respond: () => Promise.reject(new TypeError('Failed to fetch')) });
    const { got, armFor } = relay();
    await armFor();
    await expect(win.fetch('/backend-api/f/conversation', post(convBody()))).rejects.toThrow('Failed to fetch');
    await tick();
    expect(got).toContainEqual({ t: 'sse-error', req: REQ, name: 'TypeError' });
  });

  it('no verdict (the relay went quiet): not sent', async () => {
    vi.useFakeTimers();
    try {
      const { win, calls, connect } = fakeWin({ respond: () => sse() });
      const { port } = connect();
      port.postMessage({ t: 'arm', req: REQ });
      await vi.advanceTimersByTimeAsync(20);
      const p = win.fetch('/backend-api/f/conversation', post(convBody()));
      const r = expect(p).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(16_000);
      await r;
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-stream answer is reported with its status', async () => {
    const { win, relay } = fakeWin({ respond: () => new Response('{"detail":"x"}', { status: 429, headers: { 'content-type': 'application/json' } }) });
    const { got, armFor } = relay();
    await armFor();
    const r = await win.fetch('/backend-api/f/conversation', post(convBody()));
    expect(r.status).toBe(429);
    await tick();
    expect(got).toContainEqual({ t: 'conv-status', req: REQ, status: 429 });
  });

  it("in the pinned tab, only a question's own window is guarded (the owner may use that tab otherwise)", async () => {
    const { win, calls, relay } = fakeWin({ top: true, ancestors: [], marked: true, respond: () => sse() });
    const { link, armFor } = relay();
    link.send({ t: 'activate' });
    await tick();
    await win.fetch('/backend-api/f/conversation', post(convBody('my own chat')));
    expect(calls).toHaveLength(1); // not in a question: passes
    await armFor();
    await expect(win.fetch('/backend-api/f/conversation', post(convBody('something else')))).rejects.toThrow();
    expect(calls).toHaveLength(1);
    link.send({ t: 'disarm' });
    await tick();
    await win.fetch('/backend-api/f/conversation', post(convBody('my own chat again')));
    expect(calls).toHaveLength(2);
  });
});

describe('headerValue', () => {
  it('reads any HeadersInit, case-insensitively', () => {
    expect(headerValue({ 'ChatGPT-Account-Id': 'a' }, 'chatgpt-account-id')).toBe('a');
    expect(headerValue(new Headers({ 'chatgpt-account-id': 'b' }), 'ChatGPT-Account-Id')).toBe('b');
    expect(headerValue([['ChatGPT-Account-Id', 'c']], 'chatgpt-account-id')).toBe('c');
    expect(headerValue(undefined, 'x')).toBeNull();
  });
});
