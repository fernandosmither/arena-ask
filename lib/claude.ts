import type { ErrorCode } from './protocol';
import { ANSWER_DEADLINE_MS, ANSWER_MAX_CHARS, TOOL_ANSWER_DEADLINE_MS, TOOL_STALL_MS, humanError } from './protocol';
import { SseParser, interpretSse, isKeepAlive, isToolSignal } from './sse';
import { classifyTool, safeToolName, type HandoffReason, type ToolInfo } from './tools';
import { UUID_RE, uuidv7 } from './uuid';

/**
 * Thin client over claude.ai's internal (undocumented) API, adapted from Tangents' lib/claude.ts.
 * Every call is same-origin: it runs in the relay content script of a top-level claude.ai tab, so
 * the session cookie and Cloudflare's clearance cookie are sent and the Origin is native.
 *
 * Nothing here logs or returns cookies, tokens or the org id.
 */

const API = 'https://claude.ai/api';

export class ClaudeError extends Error {
  /** A short, id-free description for the background's log (phase, status, error type/code). */
  public diag?: string;
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/** `phase:status:type:code` from an error body, restricted to [A-Za-z0-9_.-] so nothing else leaks. */
export function diagFor(phase: string, status: number, body: string): string {
  let type = '';
  let code = '';
  try {
    const d = JSON.parse(body) as { error?: { type?: unknown; error_code?: unknown; details?: { error_code?: unknown } } };
    type = typeof d.error?.type === 'string' ? d.error.type : '';
    const c = d.error?.error_code ?? d.error?.details?.error_code;
    code = typeof c === 'string' ? c : '';
  } catch {
    type = /html/i.test(body.slice(0, 200)) ? 'html' : '';
  }
  const clean = (x: string) => x.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
  const flags = [/exceeded_limit/i.test(body) && 'exceeded', futureResetMs(body) !== null && 'reset'].filter(Boolean).join('+');
  return [phase, status, clean(type), clean(code), flags].join(':');
}

export const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

async function rawApi(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API}${path}`, {
      credentials: 'include',
      ...init,
      headers: { accept: 'application/json', ...((init.headers as Record<string, string>) || {}) },
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ClaudeError('network', humanError('network'));
  }
}

/** Base wait before retrying a transient 429 (a test hook can shorten it). */
let throttleRetryMs = 2_000;
export function _setThrottleRetryMs(ms: number) {
  throttleRetryMs = ms;
}

/** How long to wait before the single retry of a transient 429 (Retry-After, clamped to 8 s). */
export function throttleDelayMs(retryAfter: string | null, base = throttleRetryMs): number {
  const s = retryAfter !== null && /^\s*\d+(\.\d+)?\s*$/.test(retryAfter) ? Number(retryAfter) * 1000 : NaN;
  const ms = Number.isFinite(s) ? s : base + Math.random() * base * 0.5;
  return Math.min(8_000, Math.max(base, ms));
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * One claude.ai API call. A 429 that is NOT the usage limit (claude.ai throttling a burst of
 * requests) is retried once after a short backoff; the usage limit is returned as is.
 */
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await rawApi(path, init);
  if (res.status !== 429) return res;
  const body = await res
    .clone()
    .text()
    .catch(() => '');
  if (isQuotaBody(body)) return res;
  await sleep(throttleDelayMs(res.headers.get('retry-after')), init.signal);
  return rawApi(path, init);
}

// ---------------------------------------------------------------------------------------------
// Failure classification

export function looksLikeCloudflare(status: number, contentType: string, body: string): boolean {
  if (/json/i.test(contentType)) return false;
  if (/cf-chl|challenge-platform|cf_chl_opt|cf-browser-verification|Just a moment|Attention Required|cf-turnstile/i.test(body))
    return true;
  return (status === 403 || status === 503) && /html/i.test(contentType);
}

/** `error.message` from a JSON error body, flattened and capped (it is shown to the user). */
export function jsonErrorMessage(body: string): string {
  try {
    const d = JSON.parse(body) as { error?: { message?: unknown }; detail?: unknown };
    const m = typeof d.error?.message === 'string' ? d.error.message : typeof d.detail === 'string' ? d.detail : '';
    return m.replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** The reset time (ms) a rate-limit body carries, if it is in the future. */
export function futureResetMs(body: string, now = Date.now()): number | null {
  const m = /"resets_?[aA]t\\?"\s*:\s*(\d{9,13})/.exec(body) || /resets_?[aA]t\\?"?\s*:\s*(\d{9,13})/.exec(body);
  if (!m) return null;
  let ms = Number(m[1]);
  if (ms < 1e12) ms *= 1000;
  return Number.isFinite(ms) && ms >= now ? ms : null;
}

/** "Resets at 14:05." from a rate-limit body, when it carries a reset time. */
export function resetDetail(body: string, now = Date.now()): string {
  const ms = futureResetMs(body, now);
  if (ms === null) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = ms - now > 20 * 3600_000 ? `${d.toLocaleDateString([], { weekday: 'short' })} ` : '';
  return ` It resets at ${day}${time}.`;
}

/**
 * Whether a 429 body (or an SSE rate-limit error message) is the account's usage limit, as opposed
 * to claude.ai throttling a burst of requests. The usage limit says `exceeded_limit` (or "usage
 * limit") AND tells when it resets (a future reset time, or the 5-hour / 7-day window it hit).
 * Seen live: four parallel asks at 4% usage got a 429 with no reset time — that is throttling.
 */
export function isQuotaBody(body: string, now = Date.now()): boolean {
  if (!/exceeded_limit|usage[ _-]?limit/i.test(body)) return false;
  return futureResetMs(body, now) !== null || /five_hour|seven_day|"5h"|"7d"|weekly/i.test(body);
}

function rateLimitError(body: string, status?: number): ClaudeError {
  return isQuotaBody(body)
    ? new ClaudeError('rate_limited', humanError('rate_limited', resetDetail(body)), status)
    : new ClaudeError('throttled', humanError('throttled'), status);
}

export type Phase = 'orgs' | 'create' | 'completion' | 'settings' | 'project';

export function classifyFailure(status: number, contentType: string, body: string, phase: Phase): ClaudeError {
  if (looksLikeCloudflare(status, contentType, body)) return new ClaudeError('cloudflare', humanError('cloudflare'), status);
  if (status === 429) return rateLimitError(body, status);
  if (status === 401 || (phase === 'orgs' && (status === 403 || !/json/i.test(contentType))))
    return new ClaudeError('logged_out', humanError('logged_out'), status);
  if (status === 413) return new ClaudeError('too_large', humanError('too_large'), status);
  if (status === 529 || /overloaded/i.test(body)) return new ClaudeError('overloaded', humanError('overloaded'), status);
  const detail = jsonErrorMessage(body);
  return new ClaudeError('http', humanError('http', `(HTTP ${status}${detail ? `: ${detail}` : ''})`), status);
}

async function fail(res: Response, phase: Phase): Promise<never> {
  const body = (await res.text().catch(() => '')).slice(0, 4000);
  const err = classifyFailure(res.status, res.headers.get('content-type') || '', body, phase);
  err.diag = diagFor(phase, res.status, body);
  throw err;
}

// ---------------------------------------------------------------------------------------------
// Calls

let orgCache: { uuid: string; preferred: string | null; at: number } | null = null;
const ORG_TTL_MS = 5 * 60_000; // short, so an account switch in a long-lived frame/tab is noticed
const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The org claude.ai itself is using, from its non-HttpOnly `lastActiveOrg` cookie (readable by the
 * relay, which runs in claude.ai). Null when absent or malformed. Never leaves the relay.
 */
export function lastActiveOrgFromCookie(cookie: string): string | null {
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== 'lastActiveOrg') continue;
    let v = part.slice(eq + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      return null;
    }
    v = v.replace(/^"|"$/g, '');
    return ORG_UUID_RE.test(v) ? v : null;
  }
  return null;
}

type Obj0 = Record<string, unknown>;
const isObj0 = (x: unknown): x is Obj0 => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The account's organizations (`/organizations`). Throws `logged_out` (or the failure) if unreadable. */
async function fetchOrgs(): Promise<Obj0[]> {
  const res = await api('/organizations');
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !/json/i.test(ct)) return fail(res, 'orgs');
  let orgs: unknown;
  try {
    orgs = await res.json();
  } catch {
    throw new ClaudeError('logged_out', humanError('logged_out'), res.status);
  }
  return Array.isArray(orgs) ? orgs.filter(isObj0) : [];
}

const canChat = (o: Obj0): boolean => Array.isArray(o.capabilities) && o.capabilities.includes('chat') && typeof o.uuid === 'string';

/**
 * A personal (consumer) organization: nothing about it says team or enterprise. Seen live
 * 2026-09-25: a personal paid org has `capabilities` like `["claude_<plan>", "chat"]` and `raven_type: null`;
 * claude.ai's Team/Enterprise orgs are "raven" orgs (`raven_type` set, a `raven` capability).
 */
export function isPersonalOrg(o: { capabilities?: unknown; raven_type?: unknown }): boolean {
  const caps = Array.isArray(o.capabilities) ? o.capabilities.filter((c): c is string => typeof c === 'string') : [];
  return caps.includes('chat') && (o.raven_type === null || o.raven_type === undefined) && !caps.some((c) => /raven|enterprise|team/i.test(c));
}

export interface ChatOrg {
  uuid: string;
  personal: boolean;
}

/** The account's organizations that can chat, in claude.ai's order. Throws `logged_out` when there is none. */
export async function listChatOrgs(): Promise<ChatOrg[]> {
  const orgs = (await fetchOrgs()).filter(canChat).map((o) => ({ uuid: o.uuid as string, personal: isPersonalOrg(o) }));
  if (!orgs.length) throw new ClaudeError('logged_out', humanError('logged_out'));
  return orgs;
}

/**
 * The organization to chat in (cached briefly): the one claude.ai is using (`preferred`, from the
 * lastActiveOrg cookie) when it can chat, else the first org whose capabilities include `chat`.
 */
export async function getChatOrg(preferred: string | null = null): Promise<string> {
  if (orgCache && orgCache.preferred === preferred && Date.now() - orgCache.at < ORG_TTL_MS) return orgCache.uuid;
  orgCache = null;
  const chatOrgs = (await fetchOrgs()).filter(canChat);
  const chat = chatOrgs.find((o) => preferred !== null && o.uuid === preferred) ?? chatOrgs[0];
  if (!chat) throw new ClaudeError('logged_out', humanError('logged_out'));
  orgCache = { uuid: chat.uuid as string, preferred, at: Date.now() };
  return orgCache.uuid;
}

/** Test hook. */
export function _resetClaudeCaches() {
  orgCache = null;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const jsonHeaders = { 'content-type': 'application/json' };

/**
 * Full mode's create-time parameters: a normal, non-temporary chat outside any project, with the
 * profile preferences included, so the conversation takes the account's own defaults (its settings
 * are copied from the account: memory, past-chat search, connector tools, web search, code
 * execution). `chat_memory_mode: "enabled"` is added when the account has memory on (see
 * `accountMemoryOn`), as the web app's own new chats have it; it is never forced on an account that
 * has memory off.
 *
 * claude.ai's web app itself no longer uses this REST endpoint for a new chat: it goes through a
 * Connect-RPC service (`/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/`
 * GetNewConversationDefaults → PerformAction → StreamTimeline, binary protobuf; its JSON defaults
 * carry no memory, effort or code-execution fields). Compared live (2026-09-25) with a chat the web
 * app made, a REST chat differs in `chat_memory_mode` (unset unless sent at create), code execution
 * (on for REST, off in the app's composer) and `effort_level` (unset; "xhigh" in the app's): see
 * FULL_NEW_SETTINGS. Connector tools are NOT offered to a REST completion (tool_search finds none),
 * and web search only when declared (see `fullModeTools` in relay.ts).
 */
export const FULL_CREATE_PARAMS: Readonly<Record<string, unknown>> = {
  include_conversation_preferences: true,
  is_temporary: false,
};

/**
 * Settings PUT on every new full-mode chat right after it is created: the web app's defaults (code
 * execution off, the app's effort level). Verified live 2026-09-25: the PUT echoes both and leaves
 * memory, past-chat search and web search on. Code execution must read back exactly `false`, or the
 * question isn't sent (`CODE_EXECUTION_FLAG`).
 */
export const FULL_NEW_SETTINGS: Readonly<Record<string, unknown>> = {
  enabled_monkeys_in_a_barrel: false,
  effort_level: 'xhigh',
};

/** claude.ai's per-conversation code execution + file creation flag. */
export const CODE_EXECUTION_FLAG = 'enabled_monkeys_in_a_barrel';

/**
 * Does the account have memory on (`settings.enabled_saffron` of /api/account)? False when it can't
 * tell. Only this boolean leaves the function (the account object carries personal details).
 */
export async function accountMemoryOn(signal?: AbortSignal): Promise<boolean> {
  const res = await api('/account', { signal });
  if (!res.ok) return false;
  const j = await res.json().catch(() => null);
  return isObj(j) && isObj(j.settings) && j.settings.enabled_saffron === true;
}

/**
 * Create an empty conversation with a client-chosen UUID and the given create-time parameters:
 * locked mode passes `projectUuid` and LOCKED_CREATE_PARAMS (no memory, no profile preferences; see
 * lockdown.ts), full mode FULL_CREATE_PARAMS and no project (a plain chat, like claude.ai's own new
 * chat). Returns the settings claude.ai gave it (copied from the account: locked mode must lock
 * them down next).
 */
export async function createConversation(o: {
  org: string;
  uuid: string;
  name: string;
  model: string;
  projectUuid?: string;
  params: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<Obj | null> {
  const res = await api(`/organizations/${o.org}/chat_conversations`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      uuid: o.uuid,
      name: o.name,
      model: o.model,
      ...(o.projectUuid ? { project_uuid: o.projectUuid } : {}),
      ...o.params,
    }),
    signal: o.signal,
  });
  if (!res.ok) await fail(res, 'create');
  const j = await res.json().catch(() => null);
  return isObj(j) && isObj(j.settings) ? j.settings : null;
}

export interface ConversationInfo {
  settings: Obj | null;
  projectUuid: string | null;
}

/** One conversation's settings (the one named in extension-owned state). Null if it's gone (404). */
export async function getConversation(org: string, uuid: string, signal?: AbortSignal): Promise<ConversationInfo | null> {
  const res = await api(`/organizations/${org}/chat_conversations/${uuid}?rendering_mode=raw`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) await fail(res, 'settings');
  const j = await res.json().catch(() => null);
  if (!isObj(j)) throw new ClaudeError('http', humanError('http', '(unreadable conversation)'), res.status);
  return { settings: isObj(j.settings) ? j.settings : null, projectUuid: typeof j.project_uuid === 'string' ? j.project_uuid : null };
}

/** PUT conversation settings; returns the settings claude.ai echoes back. */
export async function putConversationSettings(org: string, uuid: string, settings: Obj, signal?: AbortSignal): Promise<Obj | null> {
  const res = await api(`/organizations/${org}/chat_conversations/${uuid}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ settings }),
    signal,
  });
  if (!res.ok) await fail(res, 'settings');
  const j = await res.json().catch(() => null);
  return isObj(j) && isObj(j.settings) ? j.settings : null;
}

/** Best-effort delete of a conversation this relay just created (e.g. it could not be locked down). */
export async function deleteConversation(org: string, uuid: string): Promise<boolean> {
  const res = await rawApi(`/organizations/${org}/chat_conversations/${uuid}`, { method: 'DELETE' }).catch(() => null);
  return !!res && (res.ok || res.status === 404);
}

/** Ask claude.ai to stop generating (what its own Stop button calls). Best-effort, bounded; `abort` cancels it. */
export async function stopResponse(org: string, uuid: string, timeoutMs = 8_000, abort?: AbortSignal): Promise<boolean> {
  if (abort?.aborted) return false;
  const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  const both = [timeout, abort].filter((s): s is AbortSignal => !!s);
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  const signal = both.length > 1 && typeof any === 'function' ? any(both) : (abort ?? timeout);
  const res = await rawApi(`/organizations/${org}/chat_conversations/${uuid}/stop_response`, { method: 'POST', signal }).catch(() => null);
  return !!res && res.ok;
}

/**
 * After a turn was stopped for a tool call: does claude.ai's copy of that turn (assistant message
 * `assistantUuid`) show a result for the call? `none`: the message is there and has no result for
 * it; `result`: it has one (or one it can't tell apart from it); `unknown`: the message isn't there
 * (yet) or the conversation couldn't be read. Only this verdict leaves the function: no message
 * content, ever. A result counts when it names the call's tool_use id, or, lacking an id, the call's
 * name (or no name at all).
 */
export async function toolResultRecorded(
  org: string,
  convUuid: string,
  assistantUuid: string,
  call: { id: string | null; rawName: string },
  signal?: AbortSignal,
): Promise<'none' | 'result' | 'unknown'> {
  const res = await api(`/organizations/${org}/chat_conversations/${convUuid}?tree=True&rendering_mode=messages&render_all_tools=true`, { signal }).catch((e) => {
    if (isAbort(e)) throw e;
    return null;
  });
  if (!res?.ok) return 'unknown';
  const j = await res.json().catch(() => null);
  const msgs = isObj(j) && Array.isArray(j.chat_messages) ? (j.chat_messages as unknown[]) : null;
  const m = msgs?.find((x): x is Obj => isObj(x) && x.uuid === assistantUuid);
  if (!m) return 'unknown';
  if (!Array.isArray(m.content)) return 'unknown';
  for (const b of m.content as unknown[]) {
    if (!isObj(b) || typeof b.type !== 'string' || !/result/i.test(b.type)) continue;
    const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : null;
    if (id !== null) {
      if (call.id === null || id === call.id) return 'result';
      continue; // another call's result (an earlier read in the same turn)
    }
    const name = typeof b.name === 'string' ? b.name : null;
    if (name === null || name === call.rawName) return 'result';
  }
  return 'none';
}

export interface CompletionOpts {
  org: string;
  convUuid: string;
  prompt: string;
  parentUuid: string;
  model: string;
  assistantUuid: string;
  humanUuid?: string;
  attachments?: unknown[];
  signal?: AbortSignal;
  onText: (text: string) => void;
  /** Called whenever stream events other than keep-alives arrive (text, thinking, …). */
  onActivity?: () => void;
  /**
   * What a tool call does to the answer: `block` (locked mode, the default): any tool call ends it
   * ('tool_blocked'); `guard` (full mode): tools that only read run, with `onTool` told about each;
   * a tool that would change something (or run code), one that stalls (`stallMs`), one still pending
   * when the stream ends, and any stream shape this code doesn't know are handed off (ToolHandoff).
   */
  toolPolicy?: 'block' | 'guard';
  /**
   * Client-declared tools for the completion body (`tools`), e.g. claude.ai's web search
   * (`{type: 'web_search_v0', name: 'web_search'}`). Omitted when empty.
   */
  declaredTools?: unknown[];
  /** A tool started running (guard mode). */
  onTool?: (tool: ToolInfo) => void;
  /** Stop the answer after this long (default ANSWER_DEADLINE_MS) … */
  deadlineMs?: number;
  /** … or, once a tool has run (guard mode), after this long from the start (default TOOL_ANSWER_DEADLINE_MS) … */
  toolDeadlineMs?: number;
  /** … or once its text passes this many characters (default ANSWER_MAX_CHARS). */
  maxChars?: number;
  /** Guard mode: how long a running tool call may go without progress of its own (default TOOL_STALL_MS). */
  stallMs?: number;
}

export interface CompletionResult {
  text: string;
  util5h: number | null;
  util7d: number | null;
}

/**
 * Full mode: a tool call that must not run (or finish) in the hidden frame. The caller stops the
 * answer on claude.ai and hands the turn off to the owner there (lib/tools.ts `handoffNote`).
 */
export class ToolHandoff extends ClaudeError {
  constructor(
    public readonly reason: HandoffReason,
    public readonly tool: ToolInfo,
    /** Usage seen in the stream so far. */
    public readonly partial: CompletionResult,
    /** Guard mode's stall limit, in seconds (for the note). */
    public readonly stallSeconds: number,
    /** The call's tool_use id and raw name, to look for its result on claude.ai after stopping. */
    public readonly call: { id: string | null; rawName: string } = { id: null, rawName: '' },
  ) {
    super('tool_blocked', humanError('tool_blocked'));
    this.name = 'ToolHandoff';
    const id = (x: string | null) => (x ?? '').replace(/\s+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
    this.diag = `completion:handoff:${reason}:${tool.kind}:${id(tool.name)}:${id(tool.connector)}`;
  }
}

/**
 * POST a completion and stream it, calling `onText` for every text delta. Throws ClaudeError on
 * HTTP failure, on a non-SSE body, on an SSE `error` event, when the usage limit is exceeded before
 * any text, when the stream ends without `message_stop` ('incomplete'), and when the answer runs
 * past the deadline or the character cap ('too_long'). Tool calls: in `block` mode (locked) the
 * first sign of one throws 'tool_blocked'; in `guard` mode (full) see `toolPolicy` and ToolHandoff. The
 * caller stops generation on claude.ai after any of these.
 */
export async function streamCompletion(o: CompletionOpts): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    prompt: o.prompt,
    parent_message_uuid: o.parentUuid,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    model: o.model,
    rendering_mode: 'messages',
    turn_message_uuids: { human_message_uuid: o.humanUuid || uuidv7(), assistant_message_uuid: o.assistantUuid },
  };
  if (o.attachments?.length) body.attachments = o.attachments;
  if (o.declaredTools?.length) body.tools = o.declaredTools;
  const res = await api(`/organizations/${o.org}/chat_conversations/${o.convUuid}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: o.signal,
  });
  if (!res.ok || !res.body) return fail(res, 'completion');
  const ct = res.headers.get('content-type') || '';
  // Only an SSE body is an answer: a challenge page or a JSON error served with 200 is a failure.
  if (!/text\/event-stream/i.test(ct)) return fail(res, 'completion');

  const parser = new SseParser();
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  const out: CompletionResult = { text: '', util5h: null, util7d: null };
  const maxChars = o.maxChars ?? ANSWER_MAX_CHARS;
  const guard = o.toolPolicy === 'guard';
  let exceeded = false;
  let resetsAt: number | null = null;
  let stopped = false;

  // The deadline counts from the start; a tool-using answer (guard mode) gets the longer one.
  const t0 = Date.now();
  let limitMs = o.deadlineMs ?? ANSWER_DEADLINE_MS;
  let timedOut = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (ms: number) => {
    limitMs = ms;
    clearTimeout(deadline);
    deadline = setTimeout(
      () => {
        timedOut = true;
        reader.cancel().catch(() => {}); // a pending read() resolves as done
      },
      Math.max(0, t0 + ms - Date.now()),
    );
  };
  armDeadline(limitMs);

  // Guard mode: every tool call running now (started, no result yet), by content block, each with
  // its own stall timer. Only the call's own events (its input, its block's end, deltas in its block)
  // count as its progress; keep-alive pings and other blocks' events don't.
  interface Running {
    info: ToolInfo;
    index: number | null;
    id: string | null;
    rawName: string;
    /** Its tool_use block has ended (content_block_stop): its input is complete. */
    closed: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }
  const running: Running[] = [];
  /** Content block index → type, for blocks seen starting (text only counts from text blocks). */
  const blockTypes = new Map<number, string>();
  let toolUsed = false;
  let stalled: Running | null = null;
  const stallMs = o.stallMs ?? TOOL_STALL_MS;
  const armStall = (r: Running) => {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      stalled ??= r;
      reader.cancel().catch(() => {});
    }, stallMs);
  };
  const settle = (r: Running) => {
    clearTimeout(r.timer);
    running.splice(running.indexOf(r), 1);
  };
  const handoff = (reason: HandoffReason, tool: ToolInfo, call?: { id: string | null; rawName: string }) =>
    new ToolHandoff(reason, tool, { ...out }, Math.round(stallMs / 1000), call);
  /** Something this code can't account for: stop and hand off (fail closed). */
  const unknown = (what: string) => {
    const name = safeToolName(what);
    return handoff('unknown', { kind: 'action', name, label: '', action: `use ${name}`, connector: null });
  };
  const byIndex = (index: number | null) => (index === null ? (running.length === 1 ? running[0] : undefined) : running.find((r) => r.index === index));

  const handle = (events: ReturnType<SseParser['push']>) => {
    if (events.some((ev) => !isKeepAlive(ev))) o.onActivity?.();
    for (const ev of events) {
      for (const sig of interpretSse(ev)) {
        if (isToolSignal(sig) && !guard) {
          // Locked mode: a plain tutor never needs a tool: whatever it is, stop here (the caller stops claude.ai).
          const err = new ClaudeError('tool_blocked', humanError('tool_blocked'));
          err.diag = `completion:tool:${sig.kind === 'tool' || sig.kind === 'tool_result' ? sig.name : 'tool'}`;
          throw err;
        }
        switch (sig.kind) {
          case 'tool': {
            if (sig.index !== null) blockTypes.set(sig.index, sig.type);
            // A tool-ish block of a type this code doesn't know: stop before it runs.
            if (!sig.standard) throw unknown(sig.type);
            // Two calls claiming the same block or id: something is off.
            if (running.some((r) => (sig.index !== null && r.index === sig.index) || (sig.id !== null && r.id === sig.id))) throw unknown('duplicate_tool_call');
            const info = classifyTool(sig.rawName, { connector: sig.connector, marked: sig.marked });
            // Something that would change things (or run code): stopped before claude.ai runs it.
            if (info.kind === 'action') throw handoff('action', info, { id: sig.id, rawName: sig.rawName });
            const r: Running = { info, index: sig.index, id: sig.id, rawName: sig.rawName, closed: false };
            running.push(r);
            if (!toolUsed) {
              toolUsed = true;
              armDeadline(Math.max(limitMs, o.toolDeadlineMs ?? TOOL_ANSWER_DEADLINE_MS));
            }
            armStall(r);
            o.onTool?.(info);
            break;
          }
          case 'tool_input': {
            // Input for a call that never started (or can't be told apart): fail closed.
            const r = byIndex(sig.index);
            if (!r || r.closed) throw unknown('tool_input');
            armStall(r);
            break;
          }
          case 'tool_result': {
            if (sig.index !== null) blockTypes.set(sig.index, sig.type);
            if (!sig.standard) throw unknown(sig.type);
            // Only the matching call's result settles it: by tool_use id; without one, the only call
            // running, or the only one with that name. A result for no running call: fail closed.
            const r = sig.toolUseId
              ? running.find((x) => x.id === sig.toolUseId)
              : running.length === 1
                ? running[0]
                : running.filter((x) => x.rawName === sig.rawName).length === 1
                  ? running.find((x) => x.rawName === sig.rawName)
                  : undefined;
            if (!r) throw unknown('tool_result');
            settle(r);
            break;
          }
          case 'tool_stop':
            break; // the message ended asking for a tool: a call still running is handed off below
          case 'block':
            if (sig.index !== null) blockTypes.set(sig.index, sig.type);
            break;
          case 'block_stop': {
            const r = sig.index === null ? undefined : running.find((x) => x.index === sig.index);
            if (r) {
              r.closed = true;
              armStall(r);
            }
            break;
          }
          case 'delta': {
            const r = sig.index === null ? undefined : running.find((x) => x.index === sig.index);
            if (r) armStall(r);
            else if (guard && /tool|input|json/i.test(sig.type)) throw unknown(sig.type);
            break;
          }
          case 'unknown':
            if (guard) throw unknown(sig.type);
            break; // locked mode: no tool can run there anyway (see lockdown.ts)
          case 'text': {
            // Text only from text blocks (never a tool's or thinking's deltas).
            const bt = sig.index === null ? undefined : blockTypes.get(sig.index);
            if (bt !== undefined && bt !== 'text') {
              // A result's or thinking's own text is never answer text; text inside a tool call is unknown.
              if (guard && !/result|thinking/i.test(bt)) throw unknown(`text_in_${bt}`);
              break;
            }
            // The model writing again after a call whose block has ended means it has that call's
            // result (it can't continue without it): such calls are done even if their result
            // block wasn't streamed. A call whose block is still open stays running.
            for (const r of [...running]) if (r.closed && (sig.index === null || r.index === null || r.index < sig.index)) settle(r);
            if (out.text.length + sig.text.length > maxChars) {
              const err = new ClaudeError('too_long', humanError('too_long', `passed ${maxChars.toLocaleString('en-US')} characters`));
              err.diag = 'completion:cap';
              throw err;
            }
            out.text += sig.text;
            o.onText(sig.text);
            break;
          }
          case 'limit':
            if (sig.util5h !== null) out.util5h = sig.util5h;
            if (sig.util7d !== null) out.util7d = sig.util7d;
            exceeded = sig.exceeded;
            resetsAt = sig.resetsAt;
            break;
          case 'stop':
            stopped = true;
            break;
          case 'error': {
            if (/rate_limit/i.test(sig.errorType)) throw rateLimitError(sig.message);
            if (/overloaded/i.test(sig.errorType)) throw new ClaudeError('overloaded', humanError('overloaded'));
            const detail = sig.message.replace(/\s+/g, ' ').slice(0, 200);
            throw new ClaudeError('http', humanError('http', detail ? `(${detail})` : '(stream error)'));
          }
        }
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      // What already arrived is looked at first (an action in the last chunk is still caught).
      if (value) handle(parser.push(dec.decode(value, { stream: true })));
      if (done || timedOut || stalled) break;
    }
    if (!timedOut && !stalled) {
      handle(parser.push(dec.decode()));
      handle(parser.flush());
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    if (e instanceof ClaudeError || isAbort(e)) throw e;
    if (!timedOut && !stalled) throw new ClaudeError('network', humanError('network'));
  } finally {
    clearTimeout(deadline);
    for (const r of running) clearTimeout(r.timer);
  }
  if (timedOut) {
    const span = limitMs >= 60_000 ? `${Math.round(limitMs / 60_000)} minutes` : `${Math.round(limitMs / 1000)} seconds`;
    const err = new ClaudeError('too_long', humanError('too_long', `took over ${span}`));
    err.diag = toolUsed ? 'completion:deadline:tools' : 'completion:deadline';
    throw err;
  }
  // A tool call that went quiet (most likely waiting for an approval prompt nobody can see here),
  // or that the stream left running when it ended: hand it off instead of hanging or guessing.
  const quiet = stalled as Running | null;
  if (quiet) throw handoff('stall', quiet.info, { id: quiet.id, rawName: quiet.rawName });
  if (guard && running.length) throw handoff('waiting', running[0].info, { id: running[0].id, rawName: running[0].rawName });
  if (!out.text && exceeded) {
    throw new ClaudeError(
      'rate_limited',
      humanError('rate_limited', resetsAt ? resetDetail(`"resetsAt":${resetsAt}`) : ''),
    );
  }
  // A stream that ends without message_stop was cut off: the assistant message may not exist on
  // claude.ai, so the caller must not continue from it.
  if (!stopped) throw new ClaudeError('incomplete', humanError('incomplete'));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The "ARENA" project. Conversations are created directly inside it (they still show in claude.ai's
// Recents and conversation list). Only the project this extension created and stored is used, never
// "any project named ARENA" (which could be someone else's, shared, with instructions, files or
// memory of its own), and its settings are the only project settings the extension ever changes.

export const PROJECT_NAME = 'ARENA';
export const PROJECT_DESCRIPTION = 'Conversations from the ARENA Ask extension (learn.arena.education).';

export interface ProjectInfo {
  name: string;
  description: string;
  isPrivate: boolean;
  archived: boolean;
  /** claude.ai reports it moved elsewhere (`moved_to`). */
  moved: boolean;
  /** Project memory (`memory_general_enabled`); null when claude.ai doesn't report it. */
  memory: boolean | null;
  /** Project instructions are set (the extension never sets any). */
  hasInstructions: boolean;
  /** Knowledge docs + files (`docs_count` + `files_count`); null when claude.ai doesn't report them. */
  knowledge: number | null;
}

/**
 * Null only when the project is gone or not ours to read (404/403). Any other failure, including a
 * 200 whose body isn't this project, throws: "unreadable right now" is not "gone".
 */
export async function getProject(org: string, uuid: string, signal?: AbortSignal): Promise<ProjectInfo | null> {
  const res = await api(`/organizations/${org}/projects/${uuid}`, { signal });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) await fail(res, 'project');
  const j = await res.json().catch(() => null);
  if (!isObj(j) || j.uuid !== uuid) throw new ClaudeError('http', humanError('http', '(project: unreadable response)'));
  const count = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null);
  const docs = count(j.docs_count);
  const files = count(j.files_count);
  return {
    name: typeof j.name === 'string' ? j.name : '',
    description: typeof j.description === 'string' ? j.description : '',
    isPrivate: j.is_private === true,
    archived: j.archived_at != null,
    moved: j.moved_to != null,
    memory: typeof j.memory_general_enabled === 'boolean' ? j.memory_general_enabled : null,
    hasInstructions: j.prompt_template != null && (typeof j.prompt_template !== 'string' || j.prompt_template.trim() !== ''),
    knowledge: docs === null || files === null ? null : docs + files,
  };
}

export async function createProject(org: string, signal?: AbortSignal): Promise<string> {
  const res = await api(`/organizations/${org}/projects`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: PROJECT_NAME, description: PROJECT_DESCRIPTION, is_private: true }),
    signal,
  });
  if (!res.ok) await fail(res, 'project');
  const j = await res.json().catch(() => null);
  if (!isObj(j) || typeof j.uuid !== 'string' || !UUID_RE.test(j.uuid)) {
    throw new ClaudeError('http', humanError('http', '(createProject: no uuid)'));
  }
  return j.uuid;
}

/**
 * Turn the project's own memory on/off (claude.ai's project "Memory" toggle). Only ever called for
 * the extension's own project. Returns the `memory_general_enabled` claude.ai answers with (null if
 * it doesn't say).
 */
export async function setProjectMemory(org: string, uuid: string, enabled: boolean, signal?: AbortSignal): Promise<boolean | null> {
  const res = await api(`/organizations/${org}/projects/${uuid}/settings`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ memory_general_enabled: enabled }),
    signal,
  });
  if (!res.ok) await fail(res, 'project');
  const j = await res.json().catch(() => null);
  return isObj(j) && typeof j.memory_general_enabled === 'boolean' ? j.memory_general_enabled : null;
}

/**
 * How many conversations claude.ai lists in a project (the extension's own, being cleaned up); null
 * if it can't tell. Only the count leaves this function.
 */
export async function projectConversationCount(org: string, uuid: string, signal?: AbortSignal): Promise<number | null> {
  const res = await api(`/organizations/${org}/projects/${uuid}/conversations`, { signal });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return Array.isArray(j) ? j.length : null;
}

/** Delete a project (only ever an empty one this extension created). True when it is gone. */
export async function deleteProject(org: string, uuid: string, signal?: AbortSignal): Promise<boolean> {
  const res = await rawApi(`/organizations/${org}/projects/${uuid}`, { method: 'DELETE', signal }).catch((e) => {
    if (isAbort(e)) throw e;
    return null;
  });
  return !!res && (res.ok || res.status === 404);
}
