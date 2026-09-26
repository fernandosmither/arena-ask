import { accountTagFor, composerSafe, guardConversation, messageHash, type Expectation } from './gpt-guard';
import { GPT_NOT_PERSONAL_DETAIL, GPT_PINNED_MISMATCH_DETAIL, GPT_UNKNOWN_ACCOUNT_DETAIL, checkPersonal, parseSession, type GptSession } from './gpt-account';
import { HANDSHAKE_KEY, HANDSHAKE_V, parseFromPage, type FromPage, type ToPage } from './gpt-channel';
import { GptStream, type GptSignal } from './gpt-stream';
import { gptHandoffNote, safeName, type GptHandoffReason, type GptStopOutcome, type GptToolInfo } from './gpt-tools';
import { buildGptMessage, conversationName, planTurn, stateAfterBlocked, stateAfterFailure, stateAfterSuccess, type TurnInput, type TurnPlan } from './conversation';
import { sha256Hex } from './hash';
import {
  ANSWER_DEADLINE_MS,
  ANSWER_MAX_CHARS,
  GPT_MAX_HOPS,
  GPT_MAX_MESSAGE_CHARS,
  PROGRESS_EVERY_MS,
  STATUS_MAX_CHARS,
  TOOL_ANSWER_DEADLINE_MS,
  TOOL_STALL_MS,
  humanErrorFor,
  type ErrorCode,
  type GptRelayAsk,
  type StreamEvent,
} from './protocol';
import { CHATGPT } from './provider';
import { UUID_RE } from './uuid';

/**
 * My ChatGPT's relay (isolated world of ARENA Ask's own chatgpt.com frame or pinned tab). It drives
 * chatgpt.com's own UI, so chatgpt.com's code makes every request (its sentinel / proof-of-work
 * included), and never sends a conversation request itself:
 *
 *  1. checks the account (`/api/auth/session` + `accounts/check`, lib/gpt-account.ts): personal,
 *     and the pinned one; only its tag leaves;
 *  2. plans the turn (lib/conversation.ts); a chat to continue must read back as a plain personal
 *     chat (else a new one), and, with "don't remember" on, be confirmed "don't remember" first;
 *  3. moves the loaded app to the turn's chat (`/` for a new chat, `/c/<id>` to continue) with the
 *     app's own router (no page load); only if that doesn't work, reloads the page there
 *     (`navigating`: the background sends the question again once the page has loaded);
 *  4. builds the message (context inline, labelled; the gate-verified question last), arms the
 *     MAIN-world wrapper for one request (lib/gpt-page.ts), types the message into the composer in
 *     20,000-character chunks and clicks the composer's own Send;
 *  5. checks the conversation request the page then makes, here, in this realm (lib/gpt-guard.ts):
 *     only the exact body returned here leaves;
 *  6. parses the answer stream the MAIN world tees back (lib/gpt-stream.ts): answer text is
 *     forwarded, read tools get a status line, and an action, a stalled tool, an approval prompt on
 *     the page or anything unrecognised stops the answer (the page's Stop) and hands it off to
 *     chatgpt.com with a note that says what the stop achieved (read back from the chat, only a
 *     verdict leaves).
 */

// ---------------------------------------------------------------------------------------------
// The MAIN-world channel

type Verdict = { ok: true; body: string } | { ok: false; why: string };

export class PageLink {
  private listeners = new Set<(m: FromPage) => void>();
  private readyInfo: Extract<FromPage, { t: 'ready' }> | null = null;
  private readyWaiters: ((r: Extract<FromPage, { t: 'ready' }> | null) => void)[] = [];
  /** Checks the page's conversation request for the question in progress (set per question). */
  checker: ((m: Extract<FromPage, { t: 'check' }>) => Promise<Verdict>) | null = null;

  constructor(private readonly port: MessagePort) {
    port.onmessage = (e: MessageEvent) => {
      const m = parseFromPage(e.data);
      if (!m) return;
      if (m.t === 'ready') {
        this.readyInfo = m;
        for (const w of this.readyWaiters.splice(0)) w(m);
      }
      if (m.t === 'check') void this.check(m);
      for (const fn of [...this.listeners]) fn(m);
    };
  }

  private async check(m: Extract<FromPage, { t: 'check' }>): Promise<void> {
    let v: Verdict = { ok: false, why: 'unarmed' };
    try {
      if (this.checker) v = await this.checker(m);
    } catch {
      v = { ok: false, why: 'check_failed' };
    }
    this.send(v.ok ? { t: 'verdict', req: m.req, id: m.id, ok: true, body: v.body } : { t: 'verdict', req: m.req, id: m.id, ok: false, why: v.why });
  }

  send(c: ToPage): void {
    try {
      this.port.postMessage(c);
    } catch {
      /* ignore */
    }
  }

  on(fn: (m: FromPage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The MAIN world said hello (null after `ms` without it: its script isn't there). */
  ready(ms: number): Promise<Extract<FromPage, { t: 'ready' }> | null> {
    if (this.readyInfo) return Promise.resolve(this.readyInfo);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      this.readyWaiters.push((r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
  }

  /** Arm the wrapper for question `req` and wait for its acknowledgement. */
  arm(req: string, ms = 3_000): Promise<boolean> {
    return new Promise((resolve) => {
      const off = this.on((m) => {
        if (m.t !== 'armed' || m.req !== req) return;
        clearTimeout(t);
        off();
        resolve(true);
      });
      const t = setTimeout(() => {
        off();
        resolve(false);
      }, ms);
      this.send({ t: 'arm', req });
    });
  }
}

/** Create the channel and hand the MAIN world its end (call at document_start). */
export function openPageLink(win: Window): PageLink {
  const ch = new MessageChannel();
  const link = new PageLink(ch.port1);
  win.postMessage({ [HANDSHAKE_KEY]: HANDSHAKE_V }, win.location.origin, [ch.port2]);
  return link;
}

// ---------------------------------------------------------------------------------------------
// chatgpt.com's page (selectors seen live 2026-09-25; English labels as fallbacks)

const COMPOSER_SEL = 'form .ProseMirror[contenteditable="true"], #prompt-textarea[contenteditable="true"]';
const SEND_SEL = '[data-testid="send-button"], button[type="submit"]';
const STOP_SEL = '[data-testid="stop-button"], button[aria-label^="Stop"], button[aria-label="Stop streaming"]';
/** A rendered turn of a chat (any of the markups seen). */
const TURN_SEL = '[data-turn-key], [data-message-author-role], [data-user-message-bubble], article[data-testid^="conversation-turn"]';
/** Buttons of an approval / confirmation prompt (a connector write, a sign-in, …). */
const APPROVAL_TEXT_RE = /^(confirm|allow|always allow|allow once|approve|deny|decline|reject|authorize|connect|sign in|log in|continue|proceed|run|take over)$/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function composer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(COMPOSER_SEL);
}

/** The composer's own form (the Send and Stop buttons live in it; nothing outside it is ever clicked). */
function composerForm(): HTMLFormElement | null {
  return composer()?.closest('form') ?? null;
}

/** The composer form's enabled Send button (never a Stop, never a button outside that form). */
export function sendButton(): HTMLButtonElement | null {
  const form = composerForm();
  if (!form) return null;
  for (const b of form.querySelectorAll<HTMLButtonElement>(SEND_SEL)) {
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (/stop/i.test(b.getAttribute('aria-label') || '') || b.matches('[data-testid="stop-button"]')) continue;
    return b;
  }
  return null;
}

/** The page's Stop button (in the composer's form; else chatgpt.com's own stop-button test id). */
function stopButton(): HTMLButtonElement | null {
  const b = composerForm()?.querySelector<HTMLButtonElement>(STOP_SEL) ?? document.querySelector<HTMLButtonElement>('[data-testid="stop-button"]');
  return b && !b.disabled ? b : null;
}

function loginShown(): boolean {
  return !!document.querySelector('[data-testid="login-button"], [data-testid="signup-button"]') || /^\/auth\//.test(location.pathname);
}

function challengeShown(): boolean {
  if (document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, #challenge-stage, #cf-challenge-running')) return true;
  return /just a moment|verify you are human|checking your browser/i.test((document.title || '').slice(0, 200));
}

async function waitFor<T>(fn: () => T | null | false, ms: number, signal: AbortSignal, every = 150): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end || signal.aborted) return null;
    await sleep(every);
  }
}

/** Type `text` into the composer (execCommand insertText, CHUNK characters at a time), at its end. */
function insertInto(el: HTMLElement, text: string): boolean {
  el.focus();
  const sel = getSelection();
  sel?.selectAllChildren(el);
  sel?.collapseToEnd();
  for (let i = 0; i < text.length; i += INSERT_CHUNK) {
    if (!document.execCommand('insertText', false, text.slice(i, i + INSERT_CHUNK))) return false;
  }
  return true;
}
const INSERT_CHUNK = 20_000;

function clearComposer(el: HTMLElement): void {
  el.focus();
  getSelection()?.selectAllChildren(el);
  document.execCommand('delete');
}

/** Press the page's Stop (it sends POST /backend-api/stop_conversation itself). True if pressed. */
async function pressStop(signalMs = 2_000): Promise<boolean> {
  const end = Date.now() + signalMs;
  for (;;) {
    const b = stopButton();
    if (b) {
      b.click();
      return true;
    }
    if (Date.now() >= end) return false;
    await sleep(100);
  }
}

/** Approval / confirmation UI that wasn't on the page before `before` (a snapshot of elements). */
function approvalPrompt(before: WeakSet<Element>): boolean {
  for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    if (before.has(d)) continue;
    if ([...d.querySelectorAll('button')].some((b) => APPROVAL_TEXT_RE.test((b.textContent || '').trim()))) return true;
  }
  const main = document.querySelector('main') || document.body;
  for (const b of main.querySelectorAll('button, [role="button"]')) {
    if (before.has(b) || b.closest('form') || b.closest('nav')) continue;
    if (APPROVAL_TEXT_RE.test((b.textContent || b.getAttribute('aria-label') || '').trim())) return true;
  }
  return false;
}

function snapshotPrompts(): WeakSet<Element> {
  const s = new WeakSet<Element>();
  for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], button, [role="button"]')) s.add(el);
  return s;
}

const turnsShown = () => !!document.querySelector(TURN_SEL);

/**
 * Move the loaded app to `path` with its own router: a history entry plus the `popstate` its
 * router listens to (verified live 2026-09-25: the chat renders, no page load, no sidebar reload).
 * True once the route is there and rendered: the composer, and a chat's turns (none for `/`).
 */
export async function appNavigate(path: string, signal: AbortSignal, ms = 12_000): Promise<boolean> {
  const go = async (to: string): Promise<boolean> => {
    const st = history.state as Record<string, unknown> | null;
    const idx = st && typeof st.idx === 'number' ? st.idx + 1 : 0;
    const key = Math.random().toString(36).slice(2, 10);
    history.pushState({ ...(st && typeof st === 'object' ? st : {}), usr: null, key, idx }, '', to);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    const empty = to === '/';
    return !!(await waitFor(() => location.pathname === to && !!composer() && (empty ? !turnsShown() : turnsShown()), ms, signal));
  };
  // From one chat to another: through a new chat first, so the old chat's turns can't pass for the new one's.
  if (path !== '/' && location.pathname !== '/' && location.pathname !== path && !(await go('/'))) return false;
  if (!(await go(path))) return false;
  await sleep(300); // let the route settle
  return !signal.aborted;
}

// ---------------------------------------------------------------------------------------------
// chatgpt.com reads (same-origin, the page's own session; the token never leaves this scope)

interface Got {
  status: number;
  json: unknown;
}

/** A 429's wait: its Retry-After (seconds, ≤ 10 s), else `fallback`. */
function retryAfter(r: Response, fallback: number): number {
  const s = Number(r.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.min(10_000, s * 1_000) : fallback;
}

/** A read that backs off on 429 (≤ 2 retries, Retry-After honoured) and gives up after `timeoutMs` per try. */
async function getJson(path: string, signal: AbortSignal, session?: GptSession, timeoutMs = 15_000): Promise<Got> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (session) {
    headers.authorization = `Bearer ${session.accessToken}`;
    headers['chatgpt-account-id'] = session.accountId;
  }
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(path, { credentials: 'include', headers, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    if (r.status === 429 && attempt < 2) {
      await sleep(retryAfter(r, 1_000 * 3 ** attempt));
      if (signal.aborted) throw aborted();
      continue;
    }
    let json: unknown = null;
    if ((r.headers.get('content-type') || '').includes('application/json')) json = await r.json().catch(() => null);
    return { status: r.status, json };
  }
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Fields whose presence (non-null, non-empty) puts a chat in a project, a GPT, a workspace or a template. */
const NOT_PLAIN_KEY_RE = /(^|_)(gizmo|project|workspace|template|team|organization|org|snorlax)(_|$)/i;
const empty = (v: unknown) => v === null || v === undefined || v === false || v === '' || (Array.isArray(v) && v.length === 0);
/** Present and null on a plain chat. */
const PLAIN_NULL_KEYS = ['gizmo_id', 'gizmo_type', 'conversation_template_id'] as const;

/**
 * Is chatgpt.com's copy of the chat `id` a plain personal chat ARENA Ask may continue? It must say
 * so explicitly: its own `conversation_id`, `is_archived: false`, a `mapping` and `current_node`, no
 * GPT / project / workspace / template field set, not temporary, not read-only. Anything else
 * (another schema included): start a new chat.
 */
export function plainChat(conv: unknown, id: string): boolean {
  return notPlainWhy(conv, id) === null;
}

/** Why the chat isn't a plain personal chat (a field name, never a value), or null when it is. */
export function notPlainWhy(conv: unknown, id: string): string | null {
  if (!isObj(conv)) return 'shape';
  if (conv.conversation_id !== id) return 'conversation_id';
  if (conv.is_archived !== false) return 'is_archived';
  if (!isObj(conv.mapping)) return 'mapping';
  if (typeof conv.current_node !== 'string') return 'current_node';
  if (conv.is_temporary_chat !== false) return 'is_temporary_chat';
  if (conv.is_read_only === true) return 'is_read_only';
  // The fields that say it isn't in a GPT or a project must be there, and empty (seen live 2026-09-26).
  for (const k of PLAIN_NULL_KEYS) if (!(k in conv) || conv[k] !== null) return k;
  for (const [k, v] of Object.entries(conv)) if (NOT_PLAIN_KEY_RE.test(k) && !empty(v)) return k.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'field';
  return null;
}

/**
 * How setting (or clearing) "don't remember" on a chat ended: confirmed on (`on`) or off (`cleared`),
 * refused (`failed`), or not confirmed in time (`slow`).
 */
export type NoMemory = 'on' | 'cleared' | `failed:${string}` | `slow:${string}`;

/**
 * Mark a chat "don't remember" (`is_do_not_remember`, a per-chat flag chatgpt.com keeps on the
 * conversation): with it on, ChatGPT has no memory tool (`bio`) in that chat (verified live
 * 2026-09-25). The conversation request's own `is_do_not_remember` is ignored by the server, so this
 * is a PATCH on the chat once it exists, read back to confirm, retried with backoff until the read
 * back says so (a new chat may not be stored yet when its id first appears: its first PATCH can be
 * lost), each request bounded by `perTryMs`, the whole by `totalMs`, and stopped by `signal`. Only
 * ever on a chat ARENA Ask created (or continues). `failed:<why>`: chatgpt.com refused it or kept
 * it off; `slow:<why>`: no answer / not stored yet within the time. `on: false` clears the flag the
 * same way (the owner turned the option off; `cleared` once it reads back off).
 */
export async function setDoNotRemember(
  convId: string,
  session: GptSession,
  signal: AbortSignal,
  o: { totalMs?: number; perTryMs?: number; backoffMs?: number[]; on?: boolean } = {},
): Promise<NoMemory> {
  const on = o.on ?? true;
  const end = Date.now() + (o.totalMs ?? 20_000);
  const backoff = o.backoffMs ?? [0, 500, 1_000, 2_000, 4_000, 8_000];
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}`, 'chatgpt-account-id': session.accountId };
  let issue = 'timeout';
  let refused = false;
  for (let i = 0; ; i++) {
    const wait = backoff[Math.min(i, backoff.length - 1)];
    if (Date.now() + wait >= end) break;
    if (wait) await sleep(wait);
    if (signal.aborted) return `slow:aborted`;
    const left = Math.max(1, Math.min(o.perTryMs ?? 5_000, end - Date.now()));
    try {
      const r = await fetch(`/backend-api/conversation/${convId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers,
        body: JSON.stringify({ is_do_not_remember: on }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(left)]),
      });
      if (!r.ok) {
        // 404: not stored yet (a brand-new chat); 429 / 5xx: try again; anything else: refused.
        issue = r.status === 404 ? 'not_found' : r.status === 429 ? 'throttled' : `patch_${r.status}`;
        refused = !(r.status === 404 || r.status === 429 || r.status >= 500);
        if (r.status === 429) await sleep(retryAfter(r, 1_000));
        continue;
      }
      const c = await getJson(`/backend-api/conversation/${convId}`, signal, session, Math.max(1, Math.min(o.perTryMs ?? 5_000, end - Date.now())));
      if (c.status === 200 && isObj(c.json) && c.json.is_do_not_remember === on) return on ? 'on' : 'cleared';
      issue = c.status === 200 ? (on ? 'still_off' : 'still_on') : `read_${c.status}`;
      refused = c.status === 200; // stored, and not changed
    } catch (e) {
      if (signal.aborted) return `slow:aborted`;
      issue = isAbort(e) || (e as { name?: string })?.name === 'TimeoutError' ? 'timeout' : 'network';
      refused = false;
    }
  }
  return refused ? `failed:${issue}` : `slow:${issue}`;
}

/**
 * Does chatgpt.com's copy of the chat show a result for the call? Only by the call's own node (the
 * node whose message has the call's id): a tool message among its descendants → `result`; the call
 * there as an assistant message with an explicitly unfinished status, every descendant read back,
 * none a tool message → `none`; anything else (the call missing, no id to find it by, finished
 * (chatgpt.com runs a call once it is complete), no or another status, a gap in its descendants)
 * → `unknown` (it may have run). Only this verdict leaves the relay.
 */
export function toolResultIn(conv: unknown, callId: string | null): 'result' | 'none' | 'unknown' {
  if (!isObj(conv) || !isObj(conv.mapping) || !callId) return 'unknown';
  const mapping = conv.mapping as Record<string, unknown>;
  const msgOf = (n: unknown): Obj | null => (isObj(n) && isObj(n.message) ? (n.message as Obj) : null);
  const roleOf = (m: Obj | null) => (m && isObj(m.author) ? m.author.role : null);
  // The node whose message IS the call (by its id; a key alone proves nothing).
  const key = Object.keys(mapping).find((k) => msgOf(mapping[k])?.id === callId);
  if (!key) return 'unknown';
  const call = msgOf(mapping[key])!;
  if (roleOf(call) !== 'assistant') return 'unknown';
  const node = mapping[key] as Obj;
  if (!Array.isArray(node.children)) return 'unknown';
  const queue: unknown[] = [...node.children];
  for (let seen = 0; queue.length; seen++) {
    if (seen >= 500) return 'unknown';
    const k = queue.shift();
    const n = typeof k === 'string' ? mapping[k] : undefined;
    if (!isObj(n) || !Array.isArray(n.children)) return 'unknown'; // a gap in what was read back
    if (roleOf(msgOf(n)) === 'tool') return 'result';
    queue.push(...n.children);
  }
  // No result: only an explicitly unfinished call can say "it didn't run".
  return typeof call.status === 'string' && UNFINISHED.has(call.status) ? 'none' : 'unknown';
}

/** Statuses of a call message that stopped (or never finished) being written. */
const UNFINISHED: ReadonlySet<string> = new Set(['in_progress', 'finished_partial_completion', 'finished_incomplete', 'incomplete']);

// ---------------------------------------------------------------------------------------------
// One question

export interface GptRelayEnv {
  link: PageLink;
  /**
   * What this page (document) has served: nothing yet (null), or the chat its last question went to
   * and whether that question ended cleanly (answered, not handed off or failed).
   */
  served(): { conv: string | null; clean: boolean } | null;
  noteServed(s: { conv: string | null; clean: boolean }): void;
  /** Reload this page at `path` (location.replace; the fallback when the app's router didn't get there). */
  navigate(path: string): void;
}

class GptFail extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly detail?: string,
    public readonly diag?: string,
    /** Shown instead of the code's own message. */
    public readonly text?: string,
  ) {
    super(code);
  }
}

const aborted = () => new DOMException('aborted', 'AbortError');
const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';
const diagSafe = (s: string) => s.replace(/[^A-Za-z0-9_.:+-]/g, '_').slice(0, 120);

export const GPT_NO_MEMORY_UNCONFIRMED =
  "ARENA Ask didn't send your question: it couldn't confirm that this ChatGPT chat is \"don't remember\" (you turned on \"Don't let ARENA chats write to ChatGPT memory\" in ARENA Ask's options). Ask again in a moment.";

type Outcome =
  | { kind: 'done' }
  | { kind: 'handoff'; reason: GptHandoffReason; info: GptToolInfo; callId: string | null; recipient: string; ended?: boolean; seen?: string }
  | { kind: 'error'; code: ErrorCode; detail?: string; diag?: string }
  | { kind: 'aborted' };

/** Waits before each look at the stopped turn (the stop lands ~2 s after the click); a test hook shortens them. */
let verifyDelaysMs = [2_500, 2_500];
export function _setGptVerifyDelaysMs(ms: number[]) {
  verifyDelaysMs = ms;
}

const newReq = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function runGptAsk(
  req: GptRelayAsk,
  send: (ev: StreamEvent) => void,
  signal: AbortSignal,
  env: GptRelayEnv,
  opts: { limits?: { deadlineMs?: number; toolDeadlineMs?: number; maxChars?: number; stallMs?: number } } = {},
): Promise<void> {
  const err = (code: ErrorCode, detail?: string, diag?: string, text?: string): StreamEvent => ({
    type: 'error',
    code,
    message: text ?? humanErrorFor('chatgpt', code, detail),
    ...(diag ? { diag: `gpt:${diagSafe(diag)}` } : {}),
  });
  let input: TurnInput | null = null;
  let plan: TurnPlan | null = null;
  let convId: string | null = null;
  /** Send was clicked: from here on, an abort presses the page's Stop. */
  let clicked = false;
  let armed = false;
  let served = false;
  let clean = false;
  /** The answer stream's parser (its answer id and model, once the answer is complete). */
  let parser = null as GptStream | null;
  /** The request-body changes the check made (for the log). */
  let patched: string[] = [];
  /** The chat is marked "don't remember": confirmed, refused, not in time, or not asked for. */
  let noMemory: Promise<NoMemory | 'off'> = Promise.resolve('off');
  let sessionRef = null as GptSession | null;
  const qtag = newReq();
  /** For the log: how the page got to the chat (as it was, the app's router, or a reload), and why a chat wasn't continued. */
  let how = 'as_is';
  let notContinued = '';
  try {
    if (!(await env.link.ready(5_000))) throw new GptFail('internal', "(chatgpt.com's page script didn't start; reload chatgpt.com)", 'main_missing');
    if (signal.aborted) throw aborted();

    // 1. the account
    const s = await getJson('/api/auth/session', signal);
    if (s.status === 401 || s.status === 403) throw new GptFail('logged_out', undefined, `session:${s.status}`);
    if (s.status !== 200) throw new GptFail(s.status === 429 ? 'throttled' : 'http', `(session ${s.status})`, `session:${s.status}`);
    const session = parseSession(s.json);
    if (!session) throw new GptFail('logged_out', undefined, 'session:none');
    const check = await getJson('/backend-api/accounts/check/v4-2023-04-27', signal, session);
    if (check.status === 401) throw new GptFail('logged_out', undefined, 'accounts:401');
    if (check.status !== 200) throw new GptFail(check.status === 429 ? 'throttled' : 'http', `(accounts ${check.status})`, `accounts:${check.status}`);
    const verdict = checkPersonal(session, check.json);
    if (!verdict.ok) {
      throw new GptFail('wrong_account', verdict.why === 'not_personal' ? GPT_NOT_PERSONAL_DETAIL : GPT_UNKNOWN_ACCOUNT_DETAIL, `account:${verdict.why}`);
    }
    const tag = await accountTagFor(session.accountId);
    sessionRef = session;
    if (req.pinnedTag && req.pinnedTag !== tag) throw new GptFail('wrong_account', GPT_PINNED_MISMATCH_DETAIL, 'account:pinned');

    // 2. the turn
    const typed = new Set(req.typed);
    const history = req.history ? req.history.map((m, k) => (m.role === 'user' && typed.has(k) ? { ...m, typed: true as const } : { role: m.role, content: m.content })) : null;
    input = { state: req.state, orgTag: tag, anchor: req.anchor, priorCount: req.priorCount, history, ctxHash: req.context ? await sha256Hex(req.context) : null, mode: 'full' };
    plan = planTurn(input);
    if (!plan.create) {
      // Continue only a chat that reads back as a plain personal chat (not deleted or archived, not
      // in a project, a GPT or a workspace, which would add their own instructions, files and
      // memory): otherwise a new chat.
      const id = req.state!.convUuid;
      const c = await getJson(`/backend-api/conversation/${id}`, signal, session);
      if (c.status === 401) throw new GptFail('logged_out', undefined, 'conversation:401');
      if (c.status !== 200 && c.status !== 404) throw new GptFail(c.status === 429 ? 'throttled' : 'http', `(conversation ${c.status})`, `conversation:${c.status}`);
      const why = c.status === 200 ? notPlainWhy(c.json, id) : `status_${c.status}`;
      if (why) {
        notContinued = `:new_chat:${why}`;
        input = { ...input, replace: true };
        plan = planTurn(input);
      } else if (req.doNotRemember) {
        // The owner wants "don't remember": never a turn in this chat without it confirmed.
        const nm = (c.json as Obj).is_do_not_remember === true ? 'on' : await setDoNotRemember(id, session, signal);
        noMemory = Promise.resolve(nm);
        if (signal.aborted) throw aborted();
        if (nm !== 'on') throw new GptFail('unsafe', undefined, `nomem:${nm}`, GPT_NO_MEMORY_UNCONFIRMED);
      } else if ((c.json as Obj).is_do_not_remember === true) {
        // The owner turned "don't remember" off, and this chat was marked while it was on: unmark it
        // (read back) before the turn. If chatgpt.com doesn't confirm, the turn still goes: the chat
        // stays in the stricter state, and the next question tries again (the log says `nomem:<why>`).
        const nm = await setDoNotRemember(id, session, signal, { on: false });
        noMemory = Promise.resolve(nm);
        if (signal.aborted) throw aborted();
      }
    }

    // 3. the page: the turn's chat, loaded and idle
    const target = plan.create ? '/' : `/c/${req.state!.convUuid}`;
    const was = env.served();
    const reuse = location.pathname === target && (was === null ? true : !plan.create && was.clean && was.conv === req.state!.convUuid);
    if (!reuse) {
      // Same page, the app's own router (no page load); a reload only if that doesn't work.
      const moved = location.pathname === target && was !== null && !plan.create ? false : await appNavigate(target, signal);
      if (signal.aborted) throw aborted();
      if (!moved) {
        if (req.hops >= GPT_MAX_HOPS) throw new GptFail('internal', "(chatgpt.com didn't open the chat)", 'hops');
        send({ type: 'navigating' });
        env.navigate(target);
        return;
      }
      how = 'router';
    } else if (was !== null) how = 'reused';
    if (req.hops) how += `:after_${req.hops}_reload`;
    served = true; // from here on this question counts as this page's latest
    convId = plan.create ? null : req.state!.convUuid;

    // 4. the message (once the app is live and idle: a stopped answer's Stop may still be landing)
    const found = await waitFor(() => {
      if (loginShown()) throw new GptFail('logged_out', undefined, 'page:login');
      if (challengeShown()) throw new GptFail('cloudflare', undefined, 'page:challenge');
      return document.readyState === 'complete' && !stopButton() && composer();
    }, 25_000, signal);
    if (signal.aborted) throw aborted();
    if (!found) throw new GptFail('timeout', undefined, 'page:no_composer');
    const fence = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const text = composerSafe(buildGptMessage(req.prompt, plan, req.chapterTitle, req.context, fence));
    if (text.length > GPT_MAX_MESSAGE_CHARS) {
      throw new GptFail('too_large', `The message would be ${text.length.toLocaleString('en-US')} characters; the limit is ${GPT_MAX_MESSAGE_CHARS.toLocaleString('en-US')}. Select fewer sections and ask again.`, 'too_large');
    }
    const hash = await messageHash(text);
    const expect: Expectation = { hash, convId, accountTag: tag, model: req.model, patch: req.patch, ...(req.dryRun ? { dryRun: true } : {}) };
    armed = await env.link.arm(qtag);
    if (!armed) throw new GptFail('internal', "(chatgpt.com's page script didn't answer)", 'arm');
    if (signal.aborted) throw aborted();
    // The composer takes input once chatgpt.com's app has started: retry until it does (≤ 10 s).
    let typedIn = false;
    for (let i = 0; i < 20 && !typedIn && !signal.aborted; i++) {
      const el = composer();
      if (el) {
        if ((el.textContent || '').trim()) clearComposer(el);
        if (!(el.textContent || '').trim() && insertInto(el, text)) typedIn = true;
        else if ((el.textContent || '').trim()) clearComposer(el);
      }
      if (!typedIn) await sleep(500);
    }
    if (signal.aborted) throw aborted();
    if (!typedIn) throw new GptFail('unsafe', "(chatgpt.com's message box refused the text)", 'composer:insert');
    await sleep(300);
    // What the box holds now must be what was typed (another extension may rewrite it).
    if ((await messageHash(composer()?.textContent ?? '')) !== hash) throw new GptFail('unsafe', undefined, 'composer:changed');
    const btn = await waitFor(() => sendButton(), 20_000, signal);
    if (signal.aborted) throw aborted();
    if (!btn) throw new GptFail('timeout', undefined, 'page:no_send');

    // 5.–6. send, check the request, and follow the answer
    const outcome = await follow(btn, expect);
    if (outcome.kind === 'aborted') throw aborted();
    if (outcome.kind === 'error') throw new GptFail(outcome.code, outcome.detail, outcome.diag);
    if (outcome.kind === 'handoff') return await handoff(outcome);
    const answerId = parser?.answerId ?? null;
    const model = parser?.model ?? null;
    // The next turn's parent (only its "is this the first turn" matters here: chatgpt.com picks the parent itself).
    const assistant = answerId && UUID_RE.test(answerId) ? answerId : crypto.randomUUID();
    const st = stateAfterSuccess(input, plan, { convUuid: convId!, assistantUuid: assistant, name: conversationName(req.chapterTitle), filed: false, now: Date.now() });
    const nm = await Promise.race([noMemory, sleep(5_000).then(() => 'slow:pending' as const)]);
    clean = true;
    // The log line: what the check changed, the chat's memory flag, and (names only) the kinds of
    // messages the stream carried.
    const kinds = diagSafe([...(parser?.seen ?? [])].join('+')).slice(0, 110);
    send({
      type: 'done',
      convUuid: convId!,
      util5h: null,
      util7d: null,
      state: st,
      diag: `gpt:sent:${diagSafe(patched.join('+') || 'as_is')}:page:${how}${notContinued}:nomem:${nm}:${kinds}`.slice(0, 200),
      ...(model ? { model } : {}),
    });
  } catch (e) {
    if (signal.aborted || isAbort(e)) {
      // The asker went away (ARENA cancelled, the tab closed…): stop the answer on the page too.
      if (clicked) await pressStop(2_000);
      return;
    }
    const f = e instanceof GptFail ? e : new GptFail('internal', `(${String((e as Error)?.message || e).slice(0, 120)})`, 'exception');
    if (clicked) await pressStop(1_000);
    const ev = err(f.code, f.detail, f.diag, f.text);
    if (ev.type === 'error' && convId && input && plan) {
      ev.convUuid = convId;
      if (plan.create) {
        const st = stateAfterFailure(input, plan, { convUuid: convId, name: conversationName(req.chapterTitle), now: Date.now() });
        if (st) ev.state = st;
      }
    }
    send(ev);
  } finally {
    env.link.checker = null;
    if (armed) env.link.send({ t: 'disarm' });
    if (served) env.noteServed({ conv: convId, clean });
  }

  // --- helpers that share the state above ------------------------------------------------------

  function follow(btn: HTMLButtonElement, expect: Expectation): Promise<Outcome> {
    const limits = opts.limits ?? {};
    const maxChars = limits.maxChars ?? ANSWER_MAX_CHARS;
    const stallMs = limits.stallMs ?? TOOL_STALL_MS;
    const stream = new GptStream();
    parser = stream;
    const before = snapshotPrompts();
    return new Promise<Outcome>((resolve) => {
      let done = false;
      let chars = 0;
      /** The one conversation request of this question passed the check: its answer may be read. */
      let letOut = false;
      let checked = false;
      let toolTime = false;
      let lastProgress = Date.now();
      const running = new Map<number, ReturnType<typeof setTimeout>>();
      const runningInfo = new Map<number, GptToolInfo>();
      const t0 = Date.now();
      let deadline: ReturnType<typeof setTimeout>;
      const armDeadline = (ms: number) => {
        clearTimeout(deadline);
        deadline = setTimeout(() => finish({ kind: 'error', code: 'too_long', detail: `took over ${Math.round(ms / 60_000)} minutes`, diag: toolTime ? 'deadline:tools' : 'deadline' }), Math.max(0, t0 + ms - Date.now()));
      };
      armDeadline(limits.deadlineMs ?? ANSWER_DEADLINE_MS);
      // The page's own code prepares the request (sentinel, proof-of-work) before it leaves.
      const guardTimer = setTimeout(() => finish({ kind: 'error', code: 'timeout', diag: 'guard_timeout' }), 90_000);
      const observer = new MutationObserver(() => {
        if (!done && approvalPrompt(before)) {
          const info = runningInfo.values().next().value ?? unknownInfo('approval');
          finish({ kind: 'handoff', reason: 'waiting', info, callId: null, recipient: info.name });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const onAbort = () => finish({ kind: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });

      // The page's conversation request: checked here, once (the MAIN world sends only the body returned).
      env.link.checker = async (m) => {
        if (done || m.req !== qtag || checked) return { ok: false, why: checked ? 'second' : 'other_question' };
        checked = true;
        let body: unknown;
        try {
          body = JSON.parse(m.body);
        } catch {
          finish({ kind: 'error', code: 'unsafe', diag: 'guard:json' });
          return { ok: false, why: 'json' };
        }
        const r = await guardConversation(body, m.account, expect);
        // The question may have ended (cancelled, timed out) while the check ran: nothing goes out then.
        if (done || signal.aborted) return { ok: false, why: 'ended' };
        if (expect.dryRun) {
          // QA: the verdict, and nothing sent either way.
          const why = r.ok ? `dryrun_pass${r.patched.length ? `:${r.patched.join('+')}` : ''}` : `dryrun_${r.why}`;
          finish({ kind: 'error', code: 'unsafe', diag: `guard:${why}` });
          return { ok: false, why };
        }
        if (!r.ok) {
          finish({ kind: 'error', code: 'unsafe', diag: `guard:${r.why}` });
          return { ok: false, why: r.why };
        }
        letOut = true;
        clearTimeout(guardTimer);
        patched = r.patched;
        if (convId) send({ type: 'started', convUuid: convId, orgTag: input!.orgTag, ...(req.pinnedTag ? {} : { pin: true as const }) });
        return { ok: true, body: JSON.stringify(r.body) };
      };

      const finish = (o: Outcome) => {
        if (done) return;
        done = true;
        // This question's one request is over (sent, refused or abandoned): no verdict for it any more.
        env.link.checker = null;
        env.link.send({ t: 'disarm' });
        clearTimeout(deadline);
        clearTimeout(guardTimer);
        for (const t of running.values()) clearTimeout(t);
        observer.disconnect();
        off();
        signal.removeEventListener('abort', onAbort);
        resolve(o);
      };
      const armStall = (msg: number) => {
        clearTimeout(running.get(msg));
        running.set(
          msg,
          setTimeout(() => {
            const info = runningInfo.get(msg) ?? unknownInfo('tool');
            finish({ kind: 'handoff', reason: 'stall', info, callId: null, recipient: info.name });
          }, stallMs),
        );
      };
      const progress = () => {
        if (Date.now() - lastProgress < PROGRESS_EVERY_MS) return;
        lastProgress = Date.now();
        send({ type: 'progress' });
      };
      const onSignal = (sig: GptSignal) => {
        if (done) return;
        switch (sig.kind) {
          case 'conversation':
            if (convId === null) {
              convId = sig.id;
              // A new chat: known from now on (the next question continues it even if this one is
              // interrupted, and an interrupted answer links it).
              const st = stateAfterFailure(input!, plan!, { convUuid: sig.id, name: conversationName(req.chapterTitle), now: Date.now() });
              send({ type: 'started', convUuid: sig.id, orgTag: input!.orgTag, ...(req.pinnedTag ? {} : { pin: true as const }), ...(st ? { state: st } : {}) });
              // "Don't remember" (if on): from the next turn; this first turn's memory tool is still only handed off.
              if (req.doNotRemember) noMemory = setDoNotRemember(sig.id, sessionRef!, signal);
            } else if (convId !== sig.id) finish({ kind: 'handoff', reason: 'unknown', info: unknownInfo('conversation'), callId: null, recipient: 'conversation' });
            return;
          case 'text':
            chars += sig.text.length;
            if (chars > maxChars) {
              finish({ kind: 'error', code: 'too_long', detail: `passed ${maxChars.toLocaleString('en-US')} characters`, diag: 'cap' });
              return;
            }
            lastProgress = Date.now();
            send({ type: 'delta', text: sig.text });
            return;
          case 'tool':
            runningInfo.set(sig.msg, sig.info);
            armStall(sig.msg);
            if (!toolTime) {
              toolTime = true;
              armDeadline(Math.max(limits.deadlineMs ?? ANSWER_DEADLINE_MS, limits.toolDeadlineMs ?? TOOL_ANSWER_DEADLINE_MS));
            }
            lastProgress = Date.now();
            send({ type: 'status', text: sig.info.label.slice(0, STATUS_MAX_CHARS) });
            return;
          case 'tool_progress':
            if (running.has(sig.msg)) armStall(sig.msg);
            return;
          case 'tool_done':
            clearTimeout(running.get(sig.msg));
            running.delete(sig.msg);
            return;
          case 'action':
            finish({ kind: 'handoff', reason: 'action', info: sig.info, callId: sig.callId, recipient: sig.recipient });
            return;
          case 'unknown':
            finish({ kind: 'handoff', reason: 'unknown', info: unknownInfo(sig.what), callId: null, recipient: sig.what, seen: [...stream.seen].join('+') });
            return;
          case 'error':
            finish({ kind: 'error', code: 'http', detail: '(the answer stream reported an error)', diag: `stream:${sig.what}` });
            return;
        }
      };
      const ended = () => {
        for (const sig of stream.end()) onSignal(sig);
        if (done) return;
        if (stream.complete) {
          if (!convId) return finish({ kind: 'error', code: 'incomplete', diag: 'no_conversation' });
          return finish({ kind: 'done' });
        }
        const pending = stream.running()[0];
        if (pending !== undefined) {
          const info = runningInfo.get(pending) ?? unknownInfo('tool');
          return finish({ kind: 'handoff', reason: 'waiting', info, callId: null, recipient: info.name, ended: true, seen: [...stream.seen].join('+') });
        }
        finish({ kind: 'error', code: 'incomplete', diag: `end:${stream.done ? 'D' : ''}${stream.streamComplete ? 'C' : ''}:${stream.answerStatus ?? 'none'}:${[...stream.seen].join('+').slice(0, 80)}` });
      };
      const off = env.link.on((m) => {
        if (done) return;
        switch (m.t) {
          case 'blocked':
            // The MAIN world blocked a conversation request of this question itself (a second one, by XHR…).
            if (m.req === qtag) finish({ kind: 'error', code: 'unsafe', diag: `guard:${m.why}` });
            return;
          case 'conv-status': {
            if (m.req !== qtag || !letOut) return;
            const st = m.status;
            if (st === 401) return finish({ kind: 'error', code: 'logged_out', diag: 'conversation:401' });
            if (st === 429) return finish({ kind: 'error', code: 'rate_limited', diag: 'conversation:429' });
            if (st === 413) return finish({ kind: 'error', code: 'too_large', diag: 'conversation:413' });
            return finish({ kind: 'error', code: 'http', detail: `(${st})`, diag: `conversation:${st}` });
          }
          case 'sse':
            if (m.req !== qtag || !letOut) return;
            for (const sig of stream.push(m.chunk)) onSignal(sig);
            progress();
            return;
          case 'sse-end':
            if (m.req !== qtag || !letOut) return;
            return ended();
          case 'sse-error':
            if (m.req !== qtag || !letOut) return;
            // The page aborts its request once it has read [DONE]: that is the normal end.
            if (stream.done) return ended();
            return finish({ kind: 'error', code: 'network', diag: `sse:${m.name}` });
          case 'auth-401':
            return finish({ kind: 'error', code: 'logged_out', diag: 'auth401' });
          default:
            return;
        }
      });
      clicked = true;
      btn.click();
    });
  }

  async function handoff(o: Extract<Outcome, { kind: 'handoff' }>): Promise<void> {
    let stop: GptStopOutcome = o.ended ? 'ended' : (await pressStop()) ? 'requested' : 'failed';
    if (!convId || !input || !plan) {
      send(err('incomplete', undefined, `handoff:no_conversation:${o.reason}`));
      return;
    }
    if (stop === 'requested' && o.reason === 'action') stop = await stoppedBeforeRun(convId, o.callId);
    const note = gptHandoffNote(o.reason, o.info, CHATGPT.chatUrl(convId), Math.round((opts.limits?.stallMs ?? TOOL_STALL_MS) / 1000), stop);
    send({ type: 'delta', text: `\n\n${note}` });
    const st = stateAfterBlocked(input, plan, { convUuid: convId, name: conversationName(req.chapterTitle), now: Date.now(), answered: true });
    send({
      type: 'done',
      convUuid: convId,
      util5h: null,
      util7d: null,
      handoff: o.reason,
      diag: `gpt:handoff:${o.reason}:${diagSafe(o.info.name)}:${stop}${o.seen ? `:${diagSafe(o.seen).slice(0, 100)}` : ''}`,
      ...(st ? { state: st } : {}),
    });
  }

  /** "Stopped before it ran" only if EVERY read of the chat found the call, unfinished, with no result. */
  async function stoppedBeforeRun(conv: string, callId: string | null): Promise<GptStopOutcome> {
    if (!callId) return 'requested';
    const quiet = new AbortController().signal;
    const s = await getJson('/api/auth/session', quiet).catch(() => null);
    const session = s && s.status === 200 ? parseSession(s.json) : null;
    if (!session) return 'requested';
    for (const ms of verifyDelaysMs) {
      await sleep(ms);
      const c = await getJson(`/backend-api/conversation/${conv}`, quiet, session).catch(() => null);
      const seen = c && c.status === 200 ? toolResultIn(c.json, callId) : 'unknown';
      if (seen !== 'none') return 'requested';
    }
    return 'before-run';
  }
}

function unknownInfo(what: string): GptToolInfo {
  const name = safeName(what);
  return { kind: 'action', name, label: '', action: `use ${name}`, connector: null };
}
