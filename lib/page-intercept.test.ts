import { afterEach, describe, expect, it, vi } from 'vitest';
import { installInterceptor, matchAsk, type InterceptWindow } from './page-intercept';
import { ACK_TIMEOUT_MS, BRIDGE_SOURCE, PAGE_SOURCE } from './protocol';

const ORIGIN = 'https://learn.arena.education';
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function fakeWindow() {
  const listeners = new Set<(e: MessageEvent) => void>();
  const posted: Record<string, unknown>[] = [];
  const realFetch = vi.fn(async () => new Response('from ARENA server'));
  const win = {
    fetch: realFetch as unknown as typeof fetch,
    location: { href: `${ORIGIN}/chapter0_fundamentals/01_ray_tracing/`, origin: ORIGIN },
    crypto: { randomUUID: () => ID },
    postMessage: (m: unknown) => void posted.push(m as Record<string, unknown>),
    addEventListener: (_t: 'message', fn: (e: MessageEvent) => void) => void listeners.add(fn),
    removeEventListener: (_t: 'message', fn: (e: MessageEvent) => void) => void listeners.delete(fn),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
  } satisfies InterceptWindow;
  const fromBridge = (data: Record<string, unknown>, over: Partial<MessageEvent> = {}) => {
    for (const fn of [...listeners]) fn({ source: win, origin: ORIGIN, data: { source: BRIDGE_SOURCE, id: ID, ...data }, ...over } as never);
  };
  installInterceptor(win);
  return { win, posted, realFetch, fromBridge, listeners };
}

/** Exactly what ARENA's right-sidebar.js sends. */
const arenaCall = (win: InterceptWindow, model = 'my-claude', extra: Record<string, unknown> = {}) =>
  win.fetch('/api/chat/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'What is einsum?' },
      ],
      context: '# Context\n...',
      model,
      ...extra,
    }),
  });

const arenaCallWith = (win: InterceptWindow, extra: RequestInit) =>
  win.fetch('/api/chat/', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'What is einsum?' }], context: '', model: 'my-claude' }),
    ...extra,
  });

afterEach(() => vi.useRealTimers());

describe('matchAsk', () => {
  const w = { location: { href: `${ORIGIN}/x/`, origin: ORIGIN } };
  it('only matches POST /api/chat/ on the ARENA origin with our model', () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'q' }], context: null, model: 'my-claude' });
    expect(matchAsk(w, '/api/chat/', { method: 'POST', body })).toEqual({ prompt: 'q', context: '', model: 'my-claude' });
    expect(matchAsk(w, '/api/chat/', { method: 'POST', body: body.replace('my-claude', 'my-chatgpt') })).toEqual({ prompt: 'q', context: '', model: 'my-chatgpt' });
    expect(matchAsk(w, '/api/chat/', { method: 'POST', body: body.replace('my-claude', 'my-gemini') })).toBeNull();
    expect(matchAsk(w, `${ORIGIN}/api/chat/`, { method: 'post', body })).not.toBeNull();
    expect(matchAsk(w, new URL(`${ORIGIN}/api/chat/`), { method: 'POST', body })).not.toBeNull();
    expect(matchAsk(w, '/api/chat/', { method: 'GET', body })).toBeNull();
    expect(matchAsk(w, '/api/chat', { method: 'POST', body })).toBeNull();
    expect(matchAsk(w, 'https://evil.example/api/chat/', { method: 'POST', body })).toBeNull();
    expect(matchAsk(w, '/api/chat/', { method: 'POST', body: body.replace('my-claude', 'gpt-4.1-mini') })).toBeNull();
    expect(matchAsk(w, '/api/chat/', undefined)).toBeNull();
  });
});

describe('installInterceptor', () => {
  it('passes every other request through to the real fetch', async () => {
    const { win, realFetch, posted } = fakeWindow();
    await win.fetch('/api/raw/chapter0/01.md');
    await arenaCall(win, 'gpt-4.1-mini');
    await win.fetch('/api/chat/', { method: 'POST', body: 'not json' });
    expect(realFetch).toHaveBeenCalledTimes(3);
    expect(posted).toEqual([]);
  });

  it('is installed only once', () => {
    const { win } = fakeWindow();
    const wrapped = win.fetch;
    installInterceptor(win);
    expect(win.fetch).toBe(wrapped);
  });

  it('forwards only {source,type,id,prompt,context,model} and streams the answer as ARENA reads it', async () => {
    const { win, posted, realFetch, fromBridge, listeners } = fakeWindow();
    const p = arenaCall(win);
    expect(realFetch).not.toHaveBeenCalled();
    expect(posted).toEqual([{ source: PAGE_SOURCE, type: 'ask', id: ID, prompt: 'What is einsum?', context: '# Context\n...', model: 'my-claude' }]);
    fromBridge({ type: 'ack' });
    fromBridge({ type: 'delta', text: 'Hel' });
    const res = await p;
    expect(res.ok).toBe(true);
    fromBridge({ type: 'delta', text: 'lo ' });
    fromBridge({ type: 'delta', text: '\ud83d' }); // an emoji split across two deltas
    fromBridge({ type: 'delta', text: '\ude00' });
    fromBridge({ type: 'done' });
    expect(await res.text()).toBe('Hello 😀');
    expect(listeners.size).toBe(0);
  });

  it('keeps ARENA loading (unresolved) until the first text arrives', async () => {
    const { win, fromBridge } = fakeWindow();
    let resolved = false;
    const p = arenaCall(win).then((r) => ((resolved = true), r));
    fromBridge({ type: 'ack' });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    fromBridge({ type: 'delta', text: 'x' });
    await p;
    expect(resolved).toBe(true);
  });

  it('an error before any text becomes a 502 {error} (ARENA shows "Error: …" and does not save it)', async () => {
    const { win, fromBridge } = fakeWindow();
    const p = arenaCall(win);
    fromBridge({ type: 'ack' });
    fromBridge({ type: 'error', message: 'Open claude.ai and log in, then ask again.' });
    const res = await p;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Open claude.ai and log in, then ask again.' });
  });

  it('ignores spoofed or foreign messages (wrong source window, origin, tag or id)', async () => {
    const { win, fromBridge } = fakeWindow();
    const p = arenaCall(win);
    fromBridge({ type: 'delta', text: 'evil' }, { source: {} as never });
    fromBridge({ type: 'delta', text: 'evil' }, { origin: 'https://evil.example' });
    fromBridge({ type: 'delta', text: 'evil', id: 'other-id-000000' });
    fromBridge({ type: 'delta', text: 'evil', source: 'arena-ask:page' });
    fromBridge({ type: 'delta', text: 'ok' });
    fromBridge({ type: 'done' });
    expect(await (await p).text()).toBe('ok');
  });

  it('fails fast if the bridge never acknowledges (extension gone)', async () => {
    vi.useFakeTimers();
    const { win } = fakeWindow();
    const p = arenaCall(win);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1);
    const res = await p;
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/not responding/);
  });

  it('ARENA aborting before any text rejects with AbortError and tells the bridge to cancel', async () => {
    const { win, posted, listeners } = fakeWindow();
    const ac = new AbortController();
    const p = arenaCallWith(win, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(posted.at(-1)).toEqual({ source: PAGE_SOURCE, type: 'cancel', id: ID });
    expect(listeners.size).toBe(0);
  });

  it('ARENA aborting mid-stream errors the body and cancels; cancelling the reader cancels too', async () => {
    const { win, posted, fromBridge } = fakeWindow();
    const ac = new AbortController();
    const p = arenaCallWith(win, { signal: ac.signal });
    fromBridge({ type: 'delta', text: 'Hel' });
    const res = await p;
    ac.abort();
    await expect(res.text()).rejects.toMatchObject({ name: 'AbortError' });
    expect(posted.filter((m) => m.type === 'cancel')).toHaveLength(1);

    const second = fakeWindow();
    const p2 = arenaCallWith(second.win, {});
    second.fromBridge({ type: 'delta', text: 'x' });
    await (await p2).body!.cancel();
    expect(second.posted.at(-1)).toEqual({ source: PAGE_SOURCE, type: 'cancel', id: ID });
  });

  it('an already-aborted signal never reaches the bridge', async () => {
    const { win, posted } = fakeWindow();
    const ac = new AbortController();
    ac.abort();
    await expect(arenaCallWith(win, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(posted).toEqual([]);
  });

  it('an empty completed answer resolves with an empty body', async () => {
    const { win, fromBridge } = fakeWindow();
    const p = arenaCall(win);
    fromBridge({ type: 'done' });
    expect(await (await p).text()).toBe('');
  });
});
