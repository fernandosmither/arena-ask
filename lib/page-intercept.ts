import { ARENA_CHAT_PATH } from './arena-selectors';
import { ACK_TIMEOUT_MS, BRIDGE_SOURCE, PAGE_SOURCE } from './protocol';
import { PROVIDERS } from './provider';

/**
 * Runs in the ARENA page's MAIN world (page JS can see and replace it; it holds nothing secret and
 * has no extension APIs). It wraps `window.fetch` so that ARENA's own chat code, when the selected
 * model is one of ours ("my-claude", "my-chatgpt"), gets a streamed `Response` produced by the extension instead of hitting
 * `/api/chat/`. ARENA then renders the stream and saves history exactly as it does for its own
 * models. Every other request passes through untouched.
 *
 * The only things it sends out, via window.postMessage to the isolated-world bridge (which
 * validates them), are `{source, type:'ask', id, prompt, context, model}` and, if ARENA aborts the request
 * or cancels its body, `{source, type:'cancel', id}`.
 */

export interface InterceptWindow {
  fetch: typeof fetch;
  location: { href: string; origin: string };
  crypto: { randomUUID(): string };
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const MARK = '__arenaAskWrapped';

export interface AskPayload {
  prompt: string;
  context: string;
  /** Which of our options ARENA's request named. */
  model: string;
}

/** Is this ARENA's chat request for one of our models? Returns the question + context + model, or null. */
export function matchAsk(
  win: Pick<InterceptWindow, 'location'>,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  optionValues: string | readonly string[] = PROVIDERS.map((p) => p.optionValue),
): AskPayload | null {
  const ours = typeof optionValues === 'string' ? [optionValues] : optionValues;
  if (!init || typeof init.body !== 'string') return null; // ARENA always posts a JSON string
  const isReq = typeof Request !== 'undefined' && input instanceof Request;
  const method = (init.method || (isReq ? (input as Request).method : 'GET')).toUpperCase();
  if (method !== 'POST') return null;
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = new URL(raw, win.location.href);
  if (url.origin !== win.location.origin || url.pathname !== ARENA_CHAT_PATH) return null;
  const data = JSON.parse(init.body) as { model?: unknown; messages?: unknown; context?: unknown };
  if (!data || typeof data.model !== 'string' || !ours.includes(data.model)) return null;
  const msgs = Array.isArray(data.messages) ? (data.messages as { role?: unknown; content?: unknown }[]) : [];
  let prompt = '';
  for (let k = msgs.length - 1; k >= 0; k--) {
    if (msgs[k]?.role === 'user') {
      prompt = typeof msgs[k].content === 'string' ? (msgs[k].content as string) : '';
      break;
    }
  }
  return { prompt, context: typeof data.context === 'string' ? data.context : '', model: data.model };
}

const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8' };

/**
 * Produce ARENA's Response for one question. The promise resolves when the first text arrives (so
 * ARENA's own "..." loading indicator keeps running until then), or with a 502 JSON `{error}`
 * (which ARENA shows as "Error: …" and does not save) if the question fails before any text.
 */
export function answer(win: InterceptWindow, ask: AskPayload, signal?: AbortSignal | null): Promise<Response> {
  const abortError = () => signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  if (signal?.aborted) return Promise.reject(abortError());
  const id = win.crypto.randomUUID();
  return new Promise<Response>((resolve, reject) => {
    const enc = new TextEncoder();
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false;
    let closed = false;
    let carry = ''; // a trailing high surrogate, held until its pair arrives

    const cleanup = () => {
      closed = true;
      win.clearTimeout(ackTimer);
      win.removeEventListener('message', onMsg);
      signal?.removeEventListener('abort', onAbort);
    };
    /** ARENA (or the browser) gave up on this request: tell the bridge, which stops Claude. */
    const cancel = () => {
      if (closed) return;
      cleanup();
      win.postMessage({ source: PAGE_SOURCE, type: 'cancel', id }, win.location.origin);
    };
    const onAbort = () => {
      if (closed) return;
      const err = abortError();
      const wasSettled = settled;
      settled = true;
      cancel();
      if (!wasSettled) reject(err);
      else {
        try {
          ctrl?.error(err);
        } catch {
          /* already closed */
        }
      }
    };
    const emit = (bytes: Uint8Array) => {
      if (!settled) {
        settled = true;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            c.enqueue(bytes);
          },
          cancel() {
            cancel(); // the reader was cancelled
          },
        });
        resolve(new Response(body, { status: 200, headers: TEXT_HEADERS }));
      } else {
        ctrl?.enqueue(bytes);
      }
    };
    const push = (t: string) => {
      let s = carry + t;
      carry = '';
      const last = s.charCodeAt(s.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        carry = s.slice(-1);
        s = s.slice(0, -1);
      }
      if (s) emit(enc.encode(s));
    };
    const done = () => {
      if (closed) return;
      if (carry) emit(enc.encode(carry));
      cleanup();
      if (!settled) {
        settled = true;
        resolve(new Response('', { status: 200, headers: TEXT_HEADERS }));
      } else {
        ctrl?.close();
      }
    };
    const fail = (message: string) => {
      if (closed) return;
      cleanup();
      if (!settled) {
        settled = true;
        resolve(
          new Response(JSON.stringify({ error: message }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          }),
        );
      } else {
        ctrl?.close(); // the bridge already streamed an interruption note
      }
    };
    const onMsg = (e: MessageEvent) => {
      if (e.source !== (win as unknown) || e.origin !== win.location.origin) return;
      const d = e.data as { source?: unknown; id?: unknown; type?: unknown; text?: unknown; message?: unknown } | null;
      if (!d || typeof d !== 'object' || d.source !== BRIDGE_SOURCE || d.id !== id) return;
      if (d.type === 'ack') win.clearTimeout(ackTimer);
      else if (d.type === 'delta' && typeof d.text === 'string') {
        win.clearTimeout(ackTimer);
        push(d.text);
      } else if (d.type === 'done') done();
      else if (d.type === 'error') fail(typeof d.message === 'string' ? d.message.slice(0, 500) : 'ARENA Ask failed.');
    };
    const ackTimer = win.setTimeout(
      () => fail('ARENA Ask is not responding. Reload this page and ask again.'),
      ACK_TIMEOUT_MS,
    );
    win.addEventListener('message', onMsg);
    signal?.addEventListener('abort', onAbort, { once: true });
    win.postMessage({ source: PAGE_SOURCE, type: 'ask', id, prompt: ask.prompt, context: ask.context, model: ask.model }, win.location.origin);
  });
}

/** Wrap `win.fetch` once. */
export function installInterceptor(win: InterceptWindow): void {
  const orig = win.fetch as typeof fetch & { [MARK]?: boolean };
  if (typeof orig !== 'function' || orig[MARK]) return;
  const wrapped = function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let ask: AskPayload | null = null;
    try {
      ask = matchAsk(win, input, init);
    } catch {
      ask = null; // unparseable body etc.: not ours
    }
    if (ask) return answer(win, ask, init?.signal ?? (input instanceof Request ? input.signal : null));
    // eslint-disable-next-line prefer-rest-params
    return Reflect.apply(orig, win, arguments) as Promise<Response>;
  } as typeof fetch & { [MARK]?: boolean };
  wrapped[MARK] = true;
  win.fetch = wrapped;
}
