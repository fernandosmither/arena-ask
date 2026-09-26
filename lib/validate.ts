import { validPatch } from './gpt-guard';
import { textHash, TEXT_HASH_RE } from './hash';
import {
  GPT_MAX_HOPS,
  LIMITS,
  MAX_CLEANUP_PROJECTS,
  MAX_SKIP,
  MODES,
  PAGE_SOURCE,
  STATUS_MAX_CHARS,
  TRANSPORTS,
  humanError,
  isErrorCode,
  type ArenaMsg,
  type AskRequest,
  type ConvState,
  type ErrorCode,
  type GptRelayAsk,
  type Mode,
  type ProjectRef,
  type RelayAsk,
  type RelayStop,
  type StreamEvent,
} from './protocol';
import { PROVIDERS, isProviderId } from './provider';
import { UUID_RE } from './uuid';

/**
 * Everything that crosses a trust boundary is re-validated here and copied into a fresh object, so
 * nothing page-controlled (or merely unexpected) is passed along by reference.
 */

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const numOrNull = (x: unknown): number | null | undefined =>
  x === null ? null : typeof x === 'number' && Number.isFinite(x) ? x : undefined;

/** Request ids minted by the MAIN world (crypto.randomUUID()). */
export const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** ARENA chapter keys (ARENA's chapter id, or "static", or a hash of an odd id). */
export const CHAPTER_KEY_RE = /^[A-Za-z0-9_.-]{1,100}$/;

const fmt = (n: number) => n.toLocaleString('en-US');

// ---------------------------------------------------------------------------------------------
// MAIN world → bridge

export type PageParse =
  | { kind: 'ignore' }
  | { kind: 'invalid'; id: string | null; code: ErrorCode; message: string }
  | { kind: 'ask'; msg: { id: string; prompt: string; context: string; model: string } }
  | { kind: 'cancel'; id: string };

const PAGE_KEYS = new Set(['source', 'type', 'id', 'prompt', 'context', 'model']);
const CANCEL_KEYS = new Set(['source', 'type', 'id']);

/**
 * Validate a message the bridge received via window.postMessage (the caller has already checked
 * `event.source === window` and `event.origin`). Anything without our source tag is ignored.
 */
export function parsePageMessage(data: unknown): PageParse {
  if (!isObj(data) || data.source !== PAGE_SOURCE) return { kind: 'ignore' };
  const id = typeof data.id === 'string' && ID_RE.test(data.id) ? data.id : null;
  const bad = (code: ErrorCode, detail?: string): PageParse => ({
    kind: 'invalid',
    id,
    code,
    message: humanError(code, detail),
  });
  if (!id) return bad('invalid', 'Bad request id.');
  if (data.type === 'cancel') {
    for (const k of Object.keys(data)) if (!CANCEL_KEYS.has(k)) return { kind: 'ignore' };
    return { kind: 'cancel', id };
  }
  for (const k of Object.keys(data)) if (!PAGE_KEYS.has(k)) return bad('invalid', 'Unexpected field.');
  if (data.type !== 'ask') return bad('invalid', 'Unknown request.');
  if (typeof data.prompt !== 'string') return bad('invalid', 'The question is not text.');
  const prompt = data.prompt.trim();
  if (!prompt) return bad('invalid', 'The question is empty.');
  if (prompt.length > LIMITS.promptChars) {
    return bad('too_large', `Your question is ${fmt(prompt.length)} characters; the limit is ${fmt(LIMITS.promptChars)}.`);
  }
  const context = data.context == null ? '' : data.context;
  if (typeof context !== 'string') return bad('invalid', 'The context is not text.');
  if (context.length > LIMITS.contextChars) {
    return bad(
      'too_large',
      `The selected context is ${fmt(context.length)} characters; the limit is ${fmt(LIMITS.contextChars)}. Select fewer sections.`,
    );
  }
  // Which of our models ARENA's request named (absent: the only one older builds had).
  const model = data.model === undefined ? PROVIDERS[0].optionValue : data.model;
  if (typeof model !== 'string' || !PROVIDERS.some((p) => p.optionValue === model)) return bad('invalid', 'Unknown model.');
  return { kind: 'ask', msg: { id, prompt, context, model } };
}

// ---------------------------------------------------------------------------------------------
// ARENA's own chat history (localStorage, page-controlled)

function validMsg(x: unknown): x is ArenaMsg {
  return isObj(x) && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string';
}

/** Keep the most recent messages within the count/char budget (each message capped). */
export function trimHistory(prior: ArenaMsg[]): ArenaMsg[] {
  const out: ArenaMsg[] = [];
  let chars = 0;
  for (let k = prior.length - 1; k >= 0 && out.length < LIMITS.historyMessages; k--) {
    const content = prior[k].content.slice(0, LIMITS.messageChars);
    if (chars + content.length > LIMITS.historyChars) break;
    chars += content.length;
    out.push({ role: prior[k].role, content });
  }
  return out.reverse();
}

/**
 * Turn ARENA's saved history (`localStorage['arena_chat_<id>']`, read at ask time) into the facts
 * the background needs. ARENA saves the new question BEFORE calling fetch, so the last entry is
 * normally the current question: it is dropped from `history`.
 */
export function parseArenaHistory(
  raw: string | null,
  prompt: string,
): { history: ArenaMsg[] | null; priorCount: number; anchor: string } {
  const unknown = { history: null, priorCount: -1, anchor: textHash(prompt.trim()) };
  if (raw == null) return unknown;
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return unknown;
  }
  if (!Array.isArray(arr)) return unknown;
  const msgs = arr.filter(validMsg).map((m) => ({ role: m.role, content: m.content }));
  const last = msgs[msgs.length - 1];
  const prior = last && last.role === 'user' && last.content.trim() === prompt.trim() ? msgs.slice(0, -1) : msgs;
  const first = prior.length ? prior[0].content : prompt;
  return { history: trimHistory(prior), priorCount: prior.length, anchor: textHash(first.trim()) };
}

/** A chapter id → a safe storage key. */
export function chapterKeyFor(id: string | null): string {
  if (!id) return 'static';
  return CHAPTER_KEY_RE.test(id) ? id : `h-${textHash(id)}`;
}

// ---------------------------------------------------------------------------------------------
// bridge → background (port), background → relay

function validHistory(x: unknown): ArenaMsg[] | null | undefined {
  if (x === null) return null;
  if (!Array.isArray(x) || x.length > LIMITS.historyMessages) return undefined;
  let chars = 0;
  const out: ArenaMsg[] = [];
  for (const m of x) {
    if (!validMsg(m) || m.content.length > LIMITS.messageChars) return undefined;
    chars += m.content.length;
    out.push({ role: m.role, content: m.content });
  }
  return chars > LIMITS.historyChars ? undefined : out;
}

const ASK_KEYS = new Set([
  'type', 'provider', 'chapterKey', 'chapterTitle', 'prompt', 'context', 'history', 'priorCount', 'anchor',
]);

export function validateAskRequest(x: unknown): AskRequest | null {
  if (!isObj(x) || x.type !== 'ask' || !isProviderId(x.provider)) return null;
  const provider = x.provider;
  for (const k of Object.keys(x)) if (!ASK_KEYS.has(k)) return null;
  const { chapterKey, chapterTitle, prompt, context, priorCount, anchor } = x;
  if (typeof chapterKey !== 'string' || !CHAPTER_KEY_RE.test(chapterKey)) return null;
  if (typeof chapterTitle !== 'string' || chapterTitle.length > 200) return null;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > LIMITS.promptChars) return null;
  if (typeof context !== 'string' || context.length > LIMITS.contextChars) return null;
  if (!isInt(priorCount) || priorCount < -1 || priorCount > 1_000_000) return null;
  if (typeof anchor !== 'string' || !TEXT_HASH_RE.test(anchor)) return null;
  const history = validHistory(x.history);
  if (history === undefined) return null;
  if (history === null ? priorCount !== -1 : history.length > priorCount) return null;
  return { type: 'ask', provider, chapterKey, chapterTitle, prompt, context, history, priorCount, anchor };
}

/** background → relay: an AskRequest (minus provider) plus the mode and the extension-owned conversation state. */
export function validateRelayAsk(x: unknown): RelayAsk | null {
  if (!isObj(x) || x.type !== 'ask' || 'provider' in x) return null;
  const { state, project, cleanup, mode, typed, pinnedOrg, ...rest } = x;
  if (!(MODES as readonly unknown[]).includes(mode)) return null;
  if (pinnedOrg !== undefined && pinnedOrg !== null && (typeof pinnedOrg !== 'string' || !UUID_RE.test(pinnedOrg))) return null;
  const req = validateAskRequest({ ...rest, provider: 'claude' });
  if (!req) return null;
  let st: ConvState | null = null;
  if (state !== null && state !== undefined) {
    st = validateConvState(state);
    if (!st) return null;
  }
  let pr: ProjectRef | null = null;
  if (project !== null && project !== undefined) {
    pr = validateProjectRef(project);
    if (!pr) return null;
  }
  let cl: ProjectRef[] = [];
  if (cleanup !== undefined) {
    if (!Array.isArray(cleanup) || cleanup.length > MAX_CLEANUP_PROJECTS) return null;
    cl = cleanup.map(validateProjectRef).filter((p): p is ProjectRef => p !== null);
    if (cl.length !== cleanup.length) return null;
  }
  const { chapterKey, chapterTitle, prompt, context, history, priorCount, anchor } = req;
  // `typed`: distinct indexes of user messages in `history` (none without history).
  let ty: number[] = [];
  if (typed !== undefined) {
    if (!Array.isArray(typed) || typed.length > LIMITS.historyMessages) return null;
    const n = history?.length ?? 0;
    if (!typed.every((k) => isInt(k) && k >= 0 && k < n && history![k].role === 'user')) return null;
    ty = [...new Set(typed as number[])];
    if (ty.length !== typed.length) return null;
  }
  return {
    type: 'ask',
    mode: mode as Mode,
    chapterKey,
    chapterTitle,
    prompt,
    context,
    history,
    priorCount,
    anchor,
    typed: ty,
    pinnedOrg: typeof pinnedOrg === 'string' ? pinnedOrg : null,
    state: st,
    project: pr,
    cleanup: cl,
  };
}

/** `typed`: distinct indexes of user messages in `history` (none without history); null when malformed. */
function validTyped(typed: unknown, history: ArenaMsg[] | null): number[] | null {
  if (typed === undefined) return [];
  if (!Array.isArray(typed) || typed.length > LIMITS.historyMessages) return null;
  const n = history?.length ?? 0;
  if (!typed.every((k) => isInt(k) && k >= 0 && k < n && history![k].role === 'user')) return null;
  const ty = [...new Set(typed as number[])];
  return ty.length === typed.length ? ty : null;
}

/** ChatGPT model slugs the owner may set (`arenaAsk.setModel('chatgpt', …)`). */
export const GPT_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** background → ChatGPT relay: the question, its full-mode setup and the chapter's ChatGPT chat. */
export function validateGptRelayAsk(x: unknown): GptRelayAsk | null {
  if (!isObj(x) || x.type !== 'ask' || x.provider !== 'chatgpt' || x.mode !== 'full') return null;
  const { state, typed, pinnedTag, model, patch, hops, dryRun, doNotRemember, mode: _m, ...rest } = x;
  if (dryRun !== undefined && dryRun !== true) return null;
  if (typeof doNotRemember !== 'boolean') return null;
  const req = validateAskRequest(rest);
  if (!req || req.provider !== 'chatgpt') return null;
  let st: ConvState | null = null;
  if (state !== null && state !== undefined) {
    st = validateConvState(state);
    if (!st || st.mode !== 'full') return null;
  }
  if (pinnedTag !== null && pinnedTag !== undefined && (typeof pinnedTag !== 'string' || !ORG_TAG_RE.test(pinnedTag))) return null;
  if (model !== null && model !== undefined && (typeof model !== 'string' || !GPT_MODEL_RE.test(model))) return null;
  const pa = validPatch(patch);
  if (!pa) return null;
  if (!isInt(hops) || hops < 0 || hops > GPT_MAX_HOPS) return null;
  const ty = validTyped(typed, req.history);
  if (!ty) return null;
  const { chapterKey, chapterTitle, prompt, context, history, priorCount, anchor } = req;
  return {
    type: 'ask',
    provider: 'chatgpt',
    mode: 'full',
    chapterKey,
    chapterTitle,
    prompt,
    context,
    history,
    priorCount,
    anchor,
    typed: ty,
    state: st,
    pinnedTag: typeof pinnedTag === 'string' ? pinnedTag : null,
    model: typeof model === 'string' ? model : null,
    patch: pa,
    hops,
    doNotRemember,
    ...(dryRun === true ? { dryRun: true } : {}),
  };
}

/** Project uuids a relay reports it cleaned up (dropped when malformed). */
function validCleaned(x: unknown): string[] | undefined {
  if (!Array.isArray(x) || x.length > MAX_CLEANUP_PROJECTS || !x.every((u) => typeof u === 'string' && UUID_RE.test(u))) return undefined;
  return [...(x as string[])];
}

/** background → relay: stop generating in one conversation. Exactly `{type:'stop', convUuid, orgTag}`. */
export function validateRelayStop(x: unknown): RelayStop | null {
  if (!isObj(x) || x.type !== 'stop' || Object.keys(x).length !== 3) return null;
  const { convUuid, orgTag } = x;
  if (typeof convUuid !== 'string' || !UUID_RE.test(convUuid)) return null;
  if (typeof orgTag !== 'string' || !ORG_TAG_RE.test(orgTag)) return null;
  return { type: 'stop', convUuid, orgTag };
}

export const ORG_TAG_RE = /^[0-9a-f]{16}$/;

/** A tool status line: short, one line, printable (it is shown as text, never as markup). */
const STATUS_RE = new RegExp(`^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]{1,${STATUS_MAX_CHARS}}$`);

export function validateProjectRef(x: unknown): ProjectRef | null {
  if (!isObj(x)) return null;
  const { orgTag, uuid } = x;
  if (typeof orgTag !== 'string' || !ORG_TAG_RE.test(orgTag)) return null;
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return null;
  return { orgTag, uuid };
}

export function validateConvState(x: unknown): ConvState | null {
  if (!isObj(x) || x.v !== 1) return null;
  const { orgTag, convUuid, parent, anchor, arenaLen, ctxHash, filed, name, updatedAt } = x;
  if (typeof orgTag !== 'string' || !ORG_TAG_RE.test(orgTag)) return null;
  if (typeof convUuid !== 'string' || !UUID_RE.test(convUuid)) return null;
  if (typeof parent !== 'string' || !UUID_RE.test(parent)) return null;
  if (typeof anchor !== 'string' || !TEXT_HASH_RE.test(anchor)) return null;
  if (!isInt(arenaLen) || arenaLen < 0) return null;
  if (ctxHash !== null && (typeof ctxHash !== 'string' || !/^[0-9a-f]{64}$/.test(ctxHash))) return null;
  if (typeof filed !== 'boolean' || typeof name !== 'string' || name.length > 200) return null;
  if (!isInt(updatedAt)) return null;
  const st: ConvState = { v: 1, orgTag, convUuid, parent, anchor, arenaLen, ctxHash, filed, name, updatedAt };
  if (x.skip !== undefined) {
    const { skip } = x;
    if (!Array.isArray(skip) || skip.length > MAX_SKIP || !skip.every((k) => isInt(k) && k >= arenaLen && k < 1e6)) return null;
    if (skip.length) st.skip = [...skip];
  }
  if (x.renew !== undefined) {
    if (x.renew !== true) return null;
    st.renew = true;
  }
  if (x.blocked !== undefined) {
    if (x.blocked !== true) return null;
    st.blocked = true;
  }
  if (x.mode !== undefined) {
    if (x.mode !== 'full') return null;
    st.mode = 'full';
  }
  return st;
}

/**
 * Validate a stream event (relay → background, or background → bridge). `allowState` is true only
 * on the relay side of the background; the bridge never receives conversation state, the project
 * or `started`.
 */
export function validateStreamEvent(x: unknown, allowState: boolean): StreamEvent | null {
  if (!isObj(x)) return null;
  switch (x.type) {
    case 'hello': {
      if (!isInt(x.v)) return null;
      if (x.nonce === undefined) return { type: 'hello', v: x.v };
      return typeof x.nonce === 'string' && ID_RE.test(x.nonce) ? { type: 'hello', v: x.v, nonce: x.nonce } : null;
    }
    case 'started': {
      if (!allowState || typeof x.convUuid !== 'string' || !UUID_RE.test(x.convUuid)) return null;
      const ev: StreamEvent = { type: 'started', convUuid: x.convUuid };
      if (typeof x.turn === 'string' && UUID_RE.test(x.turn)) ev.turn = x.turn;
      if (typeof x.orgTag === 'string' && ORG_TAG_RE.test(x.orgTag)) ev.orgTag = x.orgTag;
      if (typeof x.org === 'string' && UUID_RE.test(x.org)) ev.org = x.org;
      if (x.pin === true) ev.pin = true;
      if (x.state !== undefined) {
        const st = validateConvState(x.state);
        if (st) ev.state = st;
      }
      const pr = x.project === undefined ? null : validateProjectRef(x.project);
      if (pr) ev.project = pr;
      const cr = x.created === undefined ? null : validateProjectRef(x.created);
      if (cr) ev.created = cr;
      const cl = x.cleaned === undefined ? undefined : validCleaned(x.cleaned);
      if (cl) ev.cleaned = cl;
      return ev;
    }
    case 'progress':
      return { type: 'progress' };
    case 'navigating':
      return allowState ? { type: 'navigating' } : null;
    case 'status':
      return typeof x.text === 'string' && STATUS_RE.test(x.text) ? { type: 'status', text: x.text } : null;
    case 'stopped':
      return allowState && typeof x.ok === 'boolean' ? { type: 'stopped', ok: x.ok } : null;
    case 'delta':
      return typeof x.text === 'string' && x.text.length <= LIMITS.deltaChars ? { type: 'delta', text: x.text } : null;
    case 'done': {
      const util5h = numOrNull(x.util5h);
      const util7d = numOrNull(x.util7d);
      if (typeof x.convUuid !== 'string' || !UUID_RE.test(x.convUuid)) return null;
      if (util5h === undefined || util7d === undefined) return null;
      const ev: StreamEvent = { type: 'done', convUuid: x.convUuid, util5h, util7d };
      if (typeof x.via === 'string' && (TRANSPORTS as readonly string[]).includes(x.via)) {
        ev.via = x.via as (typeof TRANSPORTS)[number];
      }
      if (typeof x.model === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(x.model)) ev.model = x.model;
      if (allowState && x.state !== undefined) {
        const st = validateConvState(x.state);
        if (st) ev.state = st; // a bad state is dropped, never the answer
      }
      if (allowState && x.project !== undefined) {
        const pr = validateProjectRef(x.project);
        if (pr) ev.project = pr;
      }
      if (allowState && (x.handoff === 'action' || x.handoff === 'stall' || x.handoff === 'waiting' || x.handoff === 'unknown')) ev.handoff = x.handoff;
      if (allowState && typeof x.diag === 'string' && /^[A-Za-z0-9_.:+-]{1,200}$/.test(x.diag)) ev.diag = x.diag;
      return ev;
    }
    case 'error': {
      if (!isErrorCode(x.code) || typeof x.message !== 'string' || x.message.length > 1000) return null;
      const ev: StreamEvent = { type: 'error', code: x.code, message: x.message };
      if (typeof x.convUuid === 'string' && UUID_RE.test(x.convUuid)) ev.convUuid = x.convUuid;
      if (allowState && x.state !== undefined) {
        const st = validateConvState(x.state);
        if (st) ev.state = st;
      }
      if (allowState && x.project !== undefined) {
        const pr = validateProjectRef(x.project);
        if (pr) ev.project = pr;
      }
      if (allowState && x.created !== undefined) {
        const cr = validateProjectRef(x.created);
        if (cr) ev.created = cr;
      }
      if (allowState && x.cleaned !== undefined) {
        const cl = validCleaned(x.cleaned);
        if (cl) ev.cleaned = cl;
      }
      if (allowState && typeof x.diag === 'string' && /^[A-Za-z0-9_.:+-]{1,200}$/.test(x.diag)) ev.diag = x.diag;
      return ev;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Rate limiting

/** Sliding-window limiter: at most `max` events per `windowMs`. */
export class RateLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Record an attempt; false (and not recorded) when over the limit. */
  allow(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}
