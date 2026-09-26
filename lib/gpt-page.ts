import { HANDSHAKE_KEY, HANDSHAKE_V, parseToPage, type FromPage, type ToPage } from './gpt-channel';
import { CONV_POST_RE, SIGNOUT_PATH_RE } from './gpt-guard';

/**
 * chatgpt.com's MAIN world (My ChatGPT). No extension APIs, no secrets. Installed at document_start,
 * and INERT (nothing wrapped, nothing listened to) except in:
 *
 * - ARENA Ask's frame: a chatgpt.com frame whose only ancestor is this build's extension origin
 *   (`chrome-extension://<BUILD_EXTENSION_ID>`, see wxt.config.ts): active at once;
 * - ARENA Ask's pinned tab: a top-level chatgpt.com document that carries the tab marker (TAB_MARK:
 *   the URL fragment of a load ARENA Ask made, or the tab's `window.name` it set): dormant (a
 *   pass-through) until the isolated relay says `activate` (the background confirmed the tab).
 *
 * The owner's own chatgpt.com tabs and chatgpt.com framed anywhere else get nothing at all
 * (`window.fetch` stays the browser's own).
 *
 * Once active it:
 * - swallows sign-out: `/api/auth/signout` and `/auth/logout` fetches never settle, XHRs and beacons
 *   to them go nowhere, navigations to them are cancelled (and a session DNR rule blocks them at the
 *   network level too): chatgpt.com's own code signs the owner out when a hidden frame gets a 401;
 * - reports the first `/backend-api` 401 (`auth-401`);
 * - guards the page's own `POST /backend-api/f/conversation`: its request is snapshotted once (URL,
 *   method, headers copied into a Headers object of our own, the body string), the body and account
 *   header go to the isolated relay, which checks them in its own realm (lib/gpt-guard.ts), and only
 *   the exact body the relay returns is sent, with the snapshot; once per question. Any other one is
 *   blocked (in the frame always, in the pinned tab while a question is in progress), and so is a
 *   conversation POST by XHR or beacon;
 * - tees that request's SSE answer to the isolated relay (which parses it; lib/gpt-stream.ts),
 *   tagged with the question's tag; a request that fails before it answers is reported too.
 *
 * Every browser function it relies on (the channel's port and event accessors, URL and RegExp,
 * Headers, Request, Response and stream readers, timers) is captured at install, before any page
 * script runs, and called through the captured copy: a page script that replaces them later can't
 * reach the port or change what is checked. This hardens the wrapper against chatgpt.com's own code
 * misbehaving; it is not a boundary against hostile code running as chatgpt.com (which could, e.g.,
 * fetch from a fresh same-origin frame).
 */

export interface PageWindow {
  fetch: typeof fetch;
  location: { href: string; origin: string };
  top: unknown;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void, capture: boolean): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void, capture: boolean): void;
  XMLHttpRequest?: { prototype: { open: (...a: unknown[]) => unknown; send: (...a: unknown[]) => unknown } };
  navigator?: { sendBeacon?: (url: string, data?: unknown) => boolean };
  navigation?: { addEventListener(type: 'navigate', fn: (e: { destination: { url: string }; cancelable: boolean; preventDefault(): void }) => void): void };
}

/** The fields of a window `message` event, read through accessors captured at install. */
export interface EventFields {
  trusted: boolean;
  data: unknown;
  origin: unknown;
  source: unknown;
  ports: readonly MessagePort[] | undefined;
}

export interface InstallOptions {
  extId: string;
  /** location.ancestorOrigins (null in Firefox). */
  ancestors: ArrayLike<string> | null;
  /** A top-level document carrying ARENA Ask's tab marker (see chatgpt-page.content.ts). */
  marked?: boolean;
  /** Test hook: read a window message event's fields and stop it (default: the captured Event / MessageEvent functions). */
  events?: { fields: (e: unknown) => EventFields; stop: (e: unknown) => void };
}

const MARK = '__arenaAskGptWrapped';

/** Is `origins` (location.ancestorOrigins) exactly this extension's page? */
export function framedBy(origins: ArrayLike<string> | null | undefined, extId: string): boolean {
  return !!extId && !!origins && origins.length === 1 && origins[0] === `chrome-extension://${extId}`;
}

type Mode = 'frame' | 'tab';
type Fn = (...a: never[]) => unknown;

/** A prototype accessor's getter (or setter), captured now. */
function accessor(proto: object | undefined, key: string, which: 'get' | 'set' = 'get'): Fn | undefined {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (d) return d[which] as Fn | undefined;
  }
  return undefined;
}

/**
 * Install the wrapper. Returns the mode, or null where it does nothing at all (the owner's own tabs,
 * frames not hosted by this extension).
 */
export function installGptPage(win: PageWindow, opts: InstallOptions): Mode | null {
  const isTop = win.top === (win as unknown);
  let mode: Mode;
  if (isTop) {
    if (!opts.marked) return null;
    mode = 'tab';
  } else if (framedBy(opts.ancestors, opts.extId)) mode = 'frame';
  else return null;
  const orig = win.fetch as typeof fetch & { [MARK]?: boolean };
  if (typeof orig !== 'function' || orig[MARK]) return null;

  // --- captured now, before any page script can replace them -----------------------------------
  const g = globalThis as unknown as Record<string, { prototype: object } | undefined>;
  const G = (k: string) => ((win as unknown as Record<string, unknown>)[k] ?? g[k]) as { prototype: object } & Fn;
  const apply = Reflect.apply;
  const call = <T>(f: Fn | undefined, self: unknown, ...a: unknown[]): T => apply(f as unknown as (...x: unknown[]) => T, self, a);
  const tryCall = <T>(f: Fn | undefined, self: unknown, ...a: unknown[]): T | undefined => {
    try {
      return f ? call<T>(f, self, ...a) : undefined;
    } catch {
      return undefined;
    }
  };
  const origin = win.location.origin;
  const MP = G('MessagePort')?.prototype;
  const portPost = MP ? (MP as { postMessage?: Fn }).postMessage : undefined;
  const portOnMessage = accessor(MP, 'onmessage', 'set');
  const EV = G('Event')?.prototype;
  const stopImmediate = EV ? (EV as { stopImmediatePropagation?: Fn }).stopImmediatePropagation : undefined;
  const ME = G('MessageEvent')?.prototype;
  const meData = accessor(ME, 'data');
  const meOrigin = accessor(ME, 'origin');
  const meSource = accessor(ME, 'source');
  const mePorts = accessor(ME, 'ports');
  const evTrusted = (e: unknown) => {
    try {
      return (e as { isTrusted?: unknown }).isTrusted === true; // an unforgeable own attribute
    } catch {
      return false;
    }
  };
  const eventFields =
    opts.events?.fields ??
    ((e: unknown): EventFields => ({
      trusted: evTrusted(e),
      data: tryCall(meData, e),
      origin: tryCall(meOrigin, e),
      source: tryCall(meSource, e),
      ports: tryCall<readonly MessagePort[]>(mePorts, e),
    }));
  const removeListener = (G('EventTarget')?.prototype as { removeEventListener?: Fn } | undefined)?.removeEventListener;
  const URLc = G('URL') as unknown as typeof URL;
  const urlOrigin = accessor(URLc.prototype, 'origin');
  const urlPath = accessor(URLc.prototype, 'pathname');
  const urlHref = accessor(URLc.prototype, 'href');
  const reExec = RegExp.prototype.exec;
  const matches = (re: RegExp, s: string) => call<RegExpExecArray | null>(reExec as Fn, re, s) !== null;
  const toUpper = String.prototype.toUpperCase;
  const Hdrs = G('Headers') as unknown as typeof Headers;
  const hdrGet = (Hdrs.prototype as { get?: Fn }).get;
  const Req = (G('Request') as unknown as typeof Request | undefined) ?? null;
  const reqUrl = Req ? accessor(Req.prototype, 'url') : undefined;
  const reqMethod = Req ? accessor(Req.prototype, 'method') : undefined;
  const reqHeaders = Req ? accessor(Req.prototype, 'headers') : undefined;
  const reqClone = Req ? (Req.prototype as { clone?: Fn }).clone : undefined;
  const bodyText = Req ? (Req.prototype as { text?: Fn }).text : undefined;
  const Resp = G('Response') as unknown as typeof Response;
  const resStatus = accessor(Resp.prototype, 'status');
  const resStatusText = accessor(Resp.prototype, 'statusText');
  const resHeaders = accessor(Resp.prototype, 'headers');
  const resBody = accessor(Resp.prototype, 'body');
  const resUrl = accessor(Resp.prototype, 'url');
  const RS = G('ReadableStream')?.prototype as { tee?: Fn; getReader?: Fn } | undefined;
  const rsTee = RS?.tee;
  const rsGetReader = RS?.getReader;
  const readerRead = (G('ReadableStreamDefaultReader')?.prototype as { read?: Fn } | undefined)?.read;
  const Decoder = G('TextDecoder') as unknown as typeof TextDecoder;
  const decode = (Decoder.prototype as { decode?: Fn }).decode;
  const P = Promise;
  const then = Promise.prototype.then;
  const defineProp = Object.defineProperty;
  const setT = (G('setTimeout') as unknown as typeof setTimeout) ?? setTimeout;
  const clearT = (G('clearTimeout') as unknown as typeof clearTimeout) ?? clearTimeout;

  let active = mode === 'frame';
  let port: MessagePort | null = null;
  const queue: FromPage[] = [];
  /** The question in progress (from `arm` to `disarm`); its conversation request is checked once. */
  let question: string | null = null;
  let armedFor: string | null = null;
  let reported401 = false;
  let nextId = 1;
  const verdicts = new Map<number, (v: Extract<ToPage, { t: 'verdict' }> | null) => void>();

  const post = (m: FromPage) => {
    if (!port) {
      if (queue.length < 50) queue.push(m);
      return;
    }
    try {
      call(portPost, port, m);
    } catch {
      /* the isolated side went away */
    }
  };

  // --- the channel: the first trusted handshake only; nobody else sees it -----------------------
  const onHandshake = (e: MessageEvent) => {
    const f = eventFields(e);
    const d = f.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || d[HANDSHAKE_KEY] !== HANDSHAKE_V) return;
    if (opts.events) opts.events.stop(e);
    else tryCall(stopImmediate, e);
    if (port || !f.trusted || f.source !== (win as unknown) || f.origin !== origin || f.ports?.length !== 1) return;
    port = f.ports[0];
    try {
      call(removeListener, win, 'message', onHandshake, true);
    } catch {
      win.removeEventListener('message', onHandshake, true); // (not a real window: tests)
    }
    const onmsg = (ev: MessageEvent) => onCommand(eventFields(ev).data);
    if (portOnMessage) call(portOnMessage, port, onmsg);
    else port.onmessage = onmsg;
    post({ t: 'ready', mode, active });
    for (const m of queue.splice(0)) post(m);
  };
  win.addEventListener('message', onHandshake, true);

  const onCommand = (raw: unknown) => {
    const c = parseToPage(raw);
    if (!c) return;
    if (c.t === 'activate') {
      active = true;
    } else if (c.t === 'arm') {
      question = c.req;
      armedFor = c.req;
      post({ t: 'armed', req: c.req });
    } else if (c.t === 'disarm') {
      question = null;
      armedFor = null;
      for (const [id, r] of verdicts) {
        verdicts.delete(id);
        r(null);
      }
    } else if (c.t === 'verdict') {
      const r = verdicts.get(c.id);
      if (r && c.req === question) {
        verdicts.delete(c.id);
        r(c);
      }
    }
  };

  // --- URLs ---------------------------------------------------------------------------------------
  /** The URL a fetch/XHR/beacon names, parsed once: null when it isn't one. */
  const parse = (s: string): { origin: string; path: string; href: string } | null => {
    try {
      const u = new URLc(s, win.location.href);
      return { origin: call<string>(urlOrigin, u), path: call<string>(urlPath, u), href: call<string>(urlHref, u) };
    } catch {
      return null;
    }
  };
  const signout = (s: string): boolean => {
    const u = parse(s);
    return !!u && u.origin === origin && matches(SIGNOUT_PATH_RE, u.path);
  };
  const conversationUrl = (s: string): boolean => {
    const u = parse(s);
    return !!u && u.origin === origin && matches(CONV_POST_RE, u.path);
  };
  /** Where the conversation guard applies right now. */
  const guarded = () => active && (mode === 'frame' || question !== null);

  // --- fetch ----------------------------------------------------------------------------------
  const blocked = (req: string | null, why: string) => {
    post({ t: 'blocked', req, why });
    return P.reject(new TypeError('Failed to fetch'));
  };

  /** The init fields a conversation request may carry, each read once. */
  const INIT_KEYS = ['method', 'headers', 'body', 'signal', 'credentials', 'mode', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive', 'priority', 'duplex'] as const;

  async function conversation(self: unknown, url: string, input: unknown, init: RequestInit | undefined): Promise<Response> {
    const req = armedFor;
    armedFor = null; // one request per question
    if (!req) return blocked(question, question ? 'second' : 'unarmed');
    // The request as it is now: every field read once, the headers copied into a Headers of our own.
    const snap: Record<string, unknown> = {};
    let bodyStr: string | null = null;
    let headers: Headers;
    try {
      if (init !== undefined && init !== null) {
        for (const k of INIT_KEYS) {
          const v = (init as Record<string, unknown>)[k];
          if (v !== undefined) snap[k] = v;
        }
      }
      const fromReq = init === undefined && Req && tryCall(reqUrl, input) !== undefined;
      headers = new Hdrs((snap.headers ?? (fromReq ? call(reqHeaders, input) : undefined)) as HeadersInit | undefined);
      if (typeof snap.body === 'string') bodyStr = snap.body;
      else if (fromReq && snap.body === undefined) {
        snap.method = call<string>(reqMethod, input);
        bodyStr = await call<Promise<string>>(bodyText, call(reqClone, input));
      }
    } catch {
      return blocked(req, 'request');
    }
    if (bodyStr === null) return blocked(req, 'body_type');
    const method = call<string>(toUpper, String(snap.method ?? 'GET'));
    if (method !== 'POST') return blocked(req, 'method');
    const id = nextId++;
    const verdict = await new P<Extract<ToPage, { t: 'verdict' }> | null>((resolve) => {
      const t = setT(() => {
        verdicts.delete(id);
        resolve(null);
      }, 15_000);
      verdicts.set(id, (v) => {
        clearT(t);
        resolve(v);
      });
      post({ t: 'check', req, id, body: bodyStr!, account: call<string | null>(hdrGet, headers, 'chatgpt-account-id') });
    });
    if (!verdict) return blocked(req, 'no_verdict');
    if (!verdict.ok) return P.reject(new TypeError('Failed to fetch')); // the relay knows why
    let res: Response;
    try {
      res = await apply(orig, self, [url, { ...snap, method: 'POST', headers, body: verdict.body }]);
    } catch (e) {
      // Failed before any answer (network, the page's abort…): say so, then fail as the page expects.
      post({ t: 'sse-error', req, name: errName(e) });
      throw e;
    }
    post({ t: 'sent', req });
    const status = call<number>(resStatus, res);
    if (status === 401) report401();
    const ct = (call<string | null>(hdrGet, call(resHeaders, res), 'content-type') || '') as string;
    const body = call<ReadableStream<Uint8Array> | null>(resBody, res);
    if (status < 200 || status > 299 || !matches(/text\/event-stream/i, ct) || !body) {
      post({ t: 'conv-status', req, status });
      return res;
    }
    const [mine, theirs] = call<[ReadableStream<Uint8Array>, ReadableStream<Uint8Array>]>(rsTee, body);
    void pump(req, mine);
    const out = new Resp(theirs, { status, statusText: call<string>(resStatusText, res), headers: call<Headers>(resHeaders, res) });
    try {
      defineProp(out, 'url', { value: call<string>(resUrl, res) });
    } catch {
      /* ignore */
    }
    return out;
  }

  const errName = (e: unknown) => {
    let n = 'Error';
    try {
      n = String((e as { name?: unknown })?.name || 'Error');
    } catch {
      /* ignore */
    }
    return n.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40) || 'Error';
  };

  async function pump(req: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const dec = new Decoder();
    try {
      const reader = call<ReadableStreamDefaultReader<Uint8Array>>(rsGetReader, stream);
      for (;;) {
        const { value, done } = await call<Promise<ReadableStreamReadResult<Uint8Array>>>(readerRead, reader);
        if (done) break;
        const chunk = call<string>(decode, dec, value, { stream: true });
        if (chunk) post({ t: 'sse', req, chunk });
      }
      const rest = call<string>(decode, dec);
      if (rest) post({ t: 'sse', req, chunk: rest });
      post({ t: 'sse-end', req });
    } catch (e) {
      post({ t: 'sse-error', req, name: errName(e) });
    }
  }

  const report401 = () => {
    if (reported401) return;
    reported401 = true;
    post({ t: 'auth-401' });
  };

  const wrapped = function fetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // eslint-disable-next-line prefer-rest-params
    const args = arguments;
    if (!active) return apply(orig, this, args) as Promise<Response>;
    // The URL, read once (a Request's or URL's own; anything else as the string fetch would make of it).
    let url: string;
    let passInput: unknown = input;
    if (typeof input === 'string') url = input;
    else {
      const r = tryCall<string>(reqUrl, input) ?? tryCall<string>(urlHref, input);
      if (r !== undefined) url = r;
      else {
        try {
          url = String(input);
        } catch {
          return apply(orig, this, args) as Promise<Response>;
        }
        passInput = url;
      }
    }
    const u = parse(url);
    if (!u || u.origin !== origin) return apply(orig, this, passInput === input ? args : [url, init]) as Promise<Response>;
    if (matches(SIGNOUT_PATH_RE, u.path)) {
      post({ t: 'signout-blocked' });
      return new P<Response>(() => {}); // never settles: the page's sign-out never happens
    }
    if (matches(CONV_POST_RE, u.path) && guarded()) return conversation(this, u.href, input, init);
    const p = apply(orig, this, passInput === input ? args : [url, init]) as Promise<Response>;
    if (u.path.startsWith('/backend-api/')) {
      call(then as Fn, p, (r: Response) => {
        if (tryCall<number>(resStatus, r) === 401) report401();
      }, () => {});
    }
    return p;
  } as typeof fetch & { [MARK]?: boolean };
  wrapped[MARK] = true;
  win.fetch = wrapped;

  // --- sign-out and conversation requests by other means --------------------------------------
  const xhr = win.XMLHttpRequest?.prototype;
  if (xhr) {
    const open = xhr.open;
    const send = xhr.send;
    const doomed = new WeakSet<object>();
    xhr.open = function (this: object, ...a: unknown[]) {
      const url = typeof a[1] === 'string' ? a[1] : tryCall<string>(urlHref, a[1]);
      if (active && typeof url === 'string') {
        if (signout(url)) {
          doomed.add(this);
          post({ t: 'signout-blocked' });
        } else if (guarded() && conversationUrl(url)) {
          doomed.add(this); // conversation requests go through the guarded fetch only
          post({ t: 'blocked', req: question, why: 'xhr' });
        }
      }
      return apply(open as Fn as (...x: unknown[]) => unknown, this, a);
    };
    xhr.send = function (this: object, ...a: unknown[]) {
      if (doomed.has(this)) return undefined;
      return apply(send as Fn as (...x: unknown[]) => unknown, this, a);
    };
  }
  const nav = win.navigator;
  if (nav?.sendBeacon) {
    const beacon = nav.sendBeacon;
    nav.sendBeacon = (url: string, data?: unknown) => {
      const s = typeof url === 'string' ? url : tryCall<string>(urlHref, url);
      if (active && typeof s === 'string' && (signout(s) || conversationUrl(s))) {
        post(signout(s) ? { t: 'signout-blocked' } : { t: 'blocked', req: question, why: 'beacon' });
        return true;
      }
      return apply(beacon as (...x: unknown[]) => boolean, nav, [url, data]);
    };
  }
  try {
    win.navigation?.addEventListener('navigate', (e) => {
      if (!active || !signout(e.destination.url)) return;
      post({ t: 'signout-blocked' });
      if (e.cancelable) e.preventDefault();
    });
  } catch {
    /* no Navigation API */
  }
  return mode;
}

/** A header's value from any HeadersInit (case-insensitive); null when absent. */
export function headerValue(h: unknown, name: string): string | null {
  if (!h) return null;
  const want = name.toLowerCase();
  if (typeof (h as Headers).get === 'function' && typeof (h as Headers).has === 'function') return (h as Headers).get(want);
  if (Array.isArray(h)) {
    for (const pair of h) if (Array.isArray(pair) && String(pair[0]).toLowerCase() === want) return String(pair[1]);
    return null;
  }
  if (typeof h === 'object') {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (k.toLowerCase() === want) return typeof v === 'string' ? v : String(v);
  }
  return null;
}
