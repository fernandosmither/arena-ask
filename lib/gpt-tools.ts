/**
 * My ChatGPT's side-effect guard: which ChatGPT tool calls may run from the hidden chatgpt.com page.
 *
 * A ChatGPT tool call is an assistant message whose `recipient` isn't `all` (lib/gpt-stream.ts); its
 * result comes back as a `tool` message. chatgpt.com runs the call on its servers as soon as the
 * call message is complete, and its Stop (POST /backend-api/stop_conversation, sent by the page)
 * lands about 2 s later, so a call that must not run can only be stopped if it is caught at its
 * start and the model is still writing it. Classification is by recipient, exactly:
 *
 *  - `read`   runs, with a status line: `web`, `web.run` (web search/browsing),
 *             `api_tool.list_resources` (lists the connected apps' tools), `personal_context`, and
 *             `api_tool.call_tool` only for an exact Google Drive / Gmail / Google Calendar /
 *             Outlook read action (`search`, `fetch`, `list_*`, `get_*`, `read_*`) named by the call's
 *             `/<App>/link_<id>/<action>` path, once its WHOLE body is in (one JSON object, no key
 *             twice, exactly one top-level `path`) and on a link id this turn's
 *             `api_tool.list_resources` result listed as that app; re-checked on every change of
 *             the body (anything else, at any point, makes it an action);
 *  - `action` is stopped and handed off to chatgpt.com: `bio` (memory), `automations` (tasks),
 *             `user_settings`, `safety_settings`, `python*` / `container*` (code), `local.*`
 *             (client-side functions), `image_gen*`, `canmore` (canvas), every other app action, and
 *             ANY recipient not listed here, obfuscated names (`q7dr546`) included: fail closed.
 */

import { toolTokens } from './tools';

export type GptToolKind = 'read' | 'action';

export interface GptToolInfo {
  kind: GptToolKind;
  /** Safe display name (recipient, or the app action), for the note and the log. */
  name: string;
  /** Status line while it runs ("Searching the web…"). */
  label: string;
  /** What ChatGPT wants to do, as a verb phrase, for the handoff note. */
  action: string;
  /** The app it belongs to ("Gmail"), when known. */
  connector: string | null;
}

/** Recipients that only read, with their status lines. */
const READ_RECIPIENTS = new Map<string, string>(
  Object.entries({
    web: 'Searching the web…',
    'web.run': 'Searching the web…',
    'api_tool.list_resources': 'Looking through your connected apps…',
    personal_context: 'Checking what ChatGPT knows about you…',
  }),
);

/** Recipients (or prefixes) that change something or run code, with what they'd do. */
const ACTION_RECIPIENTS: [RegExp, string, string | null][] = [
  [/^bio(\.|$)/, 'save something to your ChatGPT memory', 'memory'],
  [/^automations?(\.|$)/, 'create or change a scheduled task', null],
  [/^user_settings(\.|$)/, 'change your ChatGPT settings', null],
  [/^safety_settings(\.|$)/, 'change your ChatGPT safety settings', null],
  [/^python/, "run code in ChatGPT's sandbox", null],
  [/^container(\.|$)/, "run commands in ChatGPT's container", null],
  [/^local\./, 'run an action in this browser', null],
  [/^image_gen/, 'generate an image', null],
  [/^canmore(\.|$)/, 'create or edit a canvas', null],
  [/^file_search(\.|$)/, 'search your uploaded files', null],
];

/** Apps whose exact read actions may run, by normalised app name. */
const READ_APPS = new Map<string, string>(
  Object.entries({
    'google drive': 'Google Drive',
    gmail: 'Gmail',
    'google calendar': 'Google Calendar',
    outlook: 'Outlook',
    'outlook email': 'Outlook',
    'outlook mail': 'Outlook',
    'outlook calendar': 'Outlook Calendar',
    'microsoft outlook': 'Outlook',
    'microsoft outlook email': 'Outlook',
    'microsoft outlook calendar': 'Outlook Calendar',
  }),
);

/** Words that make an app action more than a read (checked on every word of `list_*`/`get_*`/`read_*`). */
const NOT_READ_WORDS = new Set([
  'send', 'create', 'update', 'delete', 'write', 'post', 'draft', 'drafts', 'book', 'move', 'share', 'invite', 'edit',
  'remove', 'add', 'set', 'put', 'patch', 'trash', 'archive', 'publish', 'submit', 'save', 'cancel', 'reply',
  'forward', 'upload', 'rename', 'copy', 'insert', 'append', 'modify', 'mark', 'label', 'apply', 'assign', 'schedule',
  'respond', 'rsvp', 'accept', 'decline', 'and', 'or', 'then', 'plus', 'exec', 'run', 'query', 'url', 'http', 'code',
  'script', 'api', 'batch', 'bulk', 'move', 'restore', 'empty', 'purge', 'clear', 'mute', 'star', 'unstar',
]);

/** Printable ASCII only: the only names trusted as what they say. */
const ASCII_RE = /^[\x21-\x7e]+$/;

/** Strip ids and odd characters: what may be shown on the page or logged. */
export function safeName(s: string): string {
  return (
    String(s ?? '')
      .replace(/link_[A-Za-z0-9_-]+/g, 'link')
      .replace(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi, '')
      .replace(/[0-9a-f]{12,}/gi, '')
      .replace(/[^A-Za-z0-9_.\/ -]/g, '')
      .replace(/^[_./ -]+|[_./ -]+$/g, '')
      .slice(0, 60) || 'tool'
  );
}

const normApp = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_\-+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A `path` value that isn't a string (it can't name a read). */
const NOT_A_STRING = '\u0000';

/**
 * What an `api_tool.call_tool` body (JSON, possibly still streaming) says, read by a strict scanner
 * (not a regex, not `JSON.parse` alone): `JSON.parse` keeps the LAST of two equal keys, a regex finds
 * the FIRST `"path"` anywhere (a nested `args.path` included), and the server may read the body
 * either way. So:
 *  - `state`: `complete` (one JSON object and nothing after it), `partial` (a prefix of one), or
 *    `invalid`;
 *  - `paths`: every TOP-LEVEL `path` value read so far (decoded; a non-string value is NOT_A_STRING);
 *  - `dup`: some object (at any depth) has the same key twice (after decoding escapes: `"path"`
 *    is `path`).
 */
export interface CallBody {
  state: 'complete' | 'partial' | 'invalid';
  paths: string[];
  dup: boolean;
}

class Partial extends Error {}
class Invalid extends Error {}

export function scanCallBody(content: string): CallBody {
  const s = String(content ?? '');
  const paths: string[] = [];
  let dup = false;
  let i = 0;
  const ws = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i++;
  };
  const need = () => {
    if (i >= s.length) throw new Partial();
  };
  const str = (): string => {
    // at '"'
    const start = i;
    i++;
    for (;;) {
      need();
      const c = s.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) throw new Invalid();
      if (c === 0x5c) {
        i++;
        need();
        const e = s[i];
        if (e === 'u') {
          for (let k = 1; k <= 4; k++) {
            if (i + k >= s.length) throw new Partial();
            if (!/[0-9a-fA-F]/.test(s[i + k])) throw new Invalid();
          }
          i += 4;
        } else if (!'"\\/bfnrt'.includes(e)) throw new Invalid();
      }
      i++;
    }
    i++;
    try {
      return JSON.parse(s.slice(start, i)) as string;
    } catch {
      throw new Invalid();
    }
  };
  const lit = (word: string) => {
    for (let k = 0; k < word.length; k++) {
      if (i + k >= s.length) throw new Partial();
      if (s[i + k] !== word[k]) throw new Invalid();
    }
    i += word.length;
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i, i + 400));
    if (!m) {
      if (/^-?$/.test(s.slice(i))) throw new Partial();
      throw new Invalid();
    }
    i += m[0].length;
    if (i >= s.length) throw new Partial(); // a number may go on
  };
  /** A value; returns it only when it is a string (for `path`). */
  const value = (depth: number): string => {
    if (depth > 64) throw new Invalid();
    ws();
    need();
    const c = s[i];
    if (c === '{') {
      obj(depth + 1);
      return NOT_A_STRING;
    }
    if (c === '[') {
      i++;
      ws();
      need();
      if (s[i] === ']') {
        i++;
        return NOT_A_STRING;
      }
      for (;;) {
        value(depth + 1);
        ws();
        need();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === ']') {
          i++;
          return NOT_A_STRING;
        }
        throw new Invalid();
      }
    }
    if (c === '"') return str();
    if (c === 't') lit('true');
    else if (c === 'f') lit('false');
    else if (c === 'n') lit('null');
    else if (c === '-' || (c >= '0' && c <= '9')) num();
    else throw new Invalid();
    return NOT_A_STRING;
  };
  const obj = (depth: number) => {
    // at '{'
    i++;
    const keys = new Set<string>();
    ws();
    need();
    if (s[i] === '}') {
      i++;
      return;
    }
    for (;;) {
      ws();
      need();
      if (s[i] !== '"') throw new Invalid();
      const k = str();
      if (keys.has(k)) dup = true;
      keys.add(k);
      ws();
      need();
      if (s[i] !== ':') throw new Invalid();
      i++;
      const v = value(depth);
      if (depth === 1 && k === 'path') paths.push(v);
      ws();
      need();
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === '}') {
        i++;
        return;
      }
      throw new Invalid();
    }
  };
  try {
    ws();
    need();
    if (s[i] !== '{') return { state: 'invalid', paths, dup };
    obj(1);
    ws();
    return { state: i === s.length ? 'complete' : 'invalid', paths, dup };
  } catch (e) {
    if (e instanceof Partial) return { state: 'partial', paths, dup };
    return { state: 'invalid', paths, dup };
  }
}

/**
 * The one top-level `path` of a COMPLETE `api_tool.call_tool` body: a plain JSON object, no key twice
 * anywhere, exactly one top-level `path`, a string (and `JSON.parse` agrees). Undefined while the body
 * is a prefix of such an object that doesn't rule it out yet; null when it can't be one.
 */
export function callToolPath(content: string): string | null | undefined {
  const b = scanCallBody(content);
  if (b.state === 'invalid' || b.dup || b.paths.length > 1) return null;
  if (b.paths.length === 1 && b.paths[0] === NOT_A_STRING) return null;
  if (b.state === 'partial') return undefined;
  if (b.paths.length !== 1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(content));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return null;
  const p = (parsed as Record<string, unknown>).path;
  return typeof p === 'string' && p === b.paths[0] ? p : null;
}

/** Connected apps by link id (`link_<id>` → normalised app name, '' when two apps claimed it). */
export type LinkApps = ReadonlyMap<string, string>;

const LINK_RE = /^link_[A-Za-z0-9_-]{1,128}$/;
/** `/<App>/link_<id>` followed by a delimiter (in raw, possibly still streaming text: never at its end). */
const RESOURCE_PATH_RE = /\/([^/"\\\n\r]{1,80})\/(link_[A-Za-z0-9_-]{1,128})(?=[/"\\\s,;)\]}])/g;
/** The same in a complete JSON string value (its end is the id's end). */
const RESOURCE_PATH_END_RE = /\/([^/"\\\n\r]{1,80})\/(link_[A-Za-z0-9_-]{1,128})(?=[/"\\\s,;)\]}]|$)/g;

/**
 * Learn which app each link id belongs to from an `api_tool.list_resources` result (its text, as
 * streamed): every `/<App>/link_<id>` it lists, in the raw text and in its JSON strings. A link named
 * with two different apps is ambiguous (never a read). Adds to `into`.
 */
export function learnLinks(result: string, into: Map<string, string>): void {
  const raw = String(result ?? '');
  const texts: [string, RegExp][] = [[raw, RESOURCE_PATH_RE]];
  try {
    const walk = (x: unknown, d: number) => {
      if (d > 20 || texts.length > 5000) return;
      if (typeof x === 'string') texts.push([x, RESOURCE_PATH_END_RE]);
      else if (Array.isArray(x)) for (const y of x) walk(y, d + 1);
      else if (x && typeof x === 'object') for (const y of Object.values(x)) walk(y, d + 1);
    };
    walk(JSON.parse(raw), 0);
  } catch {
    /* not JSON (or not yet complete): the raw text only */
  }
  for (const [t, re] of texts) {
    for (const m of t.matchAll(re)) {
      const app = normApp(m[1]);
      const link = m[2];
      const had = into.get(link);
      if (had === undefined) into.set(link, app);
      else if (had !== app) into.set(link, '');
    }
  }
}

/**
 * Is `/<App>/link_<id>/<action>` an exact read of an allowed app, whose link id this turn's
 * `api_tool.list_resources` listed as that same app?
 */
function appRead(path: string, links: LinkApps): { app: string; action: string } | null {
  if (!ASCII_RE.test(path.replace(/ /g, '_'))) return null;
  const parts = path.split('/');
  if (parts.length !== 4 || parts[0] !== '') return null;
  const [, appRaw, link, action] = parts;
  const app = READ_APPS.get(normApp(appRaw));
  if (!app || !LINK_RE.test(link)) return null;
  const listed = links.get(link);
  if (!listed || READ_APPS.get(listed) !== app) return null;
  if (action !== 'search' && action !== 'fetch' && !/^(list|get|read)_[a-z0-9_]{1,60}$/.test(action)) return null;
  if (toolTokens(action).slice(1).some((w) => NOT_READ_WORDS.has(w))) return null;
  return { app, action };
}

const NO_LINKS: LinkApps = new Map();

/**
 * Classify a ChatGPT tool call by its recipient (and, for `api_tool.call_tool`, the app action its
 * body names). `api_tool.call_tool` is a read only once its COMPLETE body names exactly one read of
 * an allowed app on a link this turn's `api_tool.list_resources` listed as that app (`links`); an
 * action as soon as the body (even a prefix) can't be one; null while undecided (call again on every
 * change of the body, and treat it as an action if the call completes undecided).
 */
export function classifyRecipient(recipient: string, content = '', complete = false, links: LinkApps = NO_LINKS): GptToolInfo | null {
  const raw = String(recipient ?? '').slice(0, 200);
  const norm = raw.normalize('NFKC');
  const name = safeName(norm);
  const action = (what: string, connector: string | null = null): GptToolInfo => ({
    kind: 'action',
    name,
    label: `Using ${connector ?? name}…`,
    action: what,
    connector,
  });
  // Printable ASCII as sent (NFKC changes none of it): a fullwidth or otherwise non-canonical
  // spelling is never read as the tool it normalises to.
  if (!ASCII_RE.test(raw) || raw !== norm) return action('use a tool with an unusual name');
  const read = READ_RECIPIENTS.get(norm);
  if (read) return { kind: 'read', name, label: read, action: `use ${name}`, connector: null };
  if (norm === 'api_tool.call_tool') {
    const b = scanCallBody(content);
    /** The path the body names: a string, null (it can't name one), undefined (not decided yet). */
    let path: string | null | undefined;
    if (b.state === 'partial' && !b.dup && b.paths.length <= 1) {
      // A prefix: undecided while it may still become a read; an action as soon as its one path isn't one.
      const p = b.paths[0];
      if (p === undefined || (p !== NOT_A_STRING && appRead(p, links))) path = undefined;
      else path = p === NOT_A_STRING ? null : p;
    } else path = callToolPath(content);
    if (path === undefined && !complete) return null;
    // Only a COMPLETE body is ever a read.
    const r = path && b.state === 'complete' ? appRead(path, links) : null;
    if (r) {
      const shown = safeName(`${r.app}/${r.action}`);
      return { kind: 'read', name: shown, label: `Using ${r.app}…`, action: r.action.replace(/_/g, ' '), connector: r.app };
    }
    const parts = typeof path === 'string' ? path.split('/') : [];
    const appName = parts.length >= 2 && parts[1] ? safeName(parts[1]) : null;
    const act = parts.length >= 4 ? safeName(parts[parts.length - 1]).replace(/_/g, ' ') : 'use an app';
    return { ...action(act, appName && appName !== 'tool' ? appName : null), name: safeName(appName ? `${appName}/${act}` : 'api_tool.call_tool') };
  }
  for (const [re, what, connector] of ACTION_RECIPIENTS) if (re.test(norm)) return action(what, connector);
  if (norm.startsWith('api_tool.')) return action('use a connected app');
  return action('use a tool ARENA Ask doesn’t recognise');
}

/** Why a ChatGPT turn was handed off. */
export type GptHandoffReason = 'action' | 'stall' | 'waiting' | 'unknown';

/**
 * What stopping the turn achieved (see lib/tools.ts StopOutcome), or `ended`: the answer had already
 * ended (nothing left to stop) with that step unaccounted for.
 */
export type GptStopOutcome = 'before-run' | 'requested' | 'failed' | 'ended';

export const GPT_APPROVE_WARNING = 'Only approve this if you asked for it — text on the ARENA page can influence ChatGPT.';

/**
 * The note ARENA shows when a ChatGPT turn is handed off (markdown; the link is the chat on
 * chatgpt.com). It says only what was checked: "stopped before it ran" only when the page's Stop was
 * clicked and chatgpt.com's copy of the chat shows no result for the call.
 */
export function gptHandoffNote(reason: GptHandoffReason, tool: GptToolInfo, chatUrl: string, stallSeconds: number, stop: GptStopOutcome): string {
  const link = `[open this chat in ChatGPT to approve ↗](${chatUrl})`;
  const withConn = tool.connector && tool.connector !== 'memory' ? ` with ${tool.connector}` : '';
  let head: string;
  let tail: string;
  if (reason === 'action') {
    head = `**ChatGPT wants to ${tool.action}${withConn}** (\`${tool.name}\`) — ${link}`;
    tail =
      stop === 'before-run'
        ? 'ARENA Ask stopped it before it ran (ChatGPT shows no result from it).'
        : stop === 'requested'
          ? "Stop requested — the action may have run (ChatGPT's stop takes about 2 s to land); check the chat in ChatGPT."
          : "ChatGPT's stop couldn't be pressed — the action may have run or still be running; check the chat in ChatGPT.";
  } else if (reason === 'unknown') {
    head = `**ChatGPT's answer contained a step ARENA Ask doesn't recognise** (\`${tool.name}\`) — ${link}`;
    tail =
      stop === 'failed'
        ? "ChatGPT's stop couldn't be pressed — it may still be running; check the chat in ChatGPT."
        : 'Stop requested — it may have run; check the chat in ChatGPT.';
  } else {
    const what = reason === 'stall' ? `made no progress for ${stallSeconds} s` : stop === 'ended' ? 'never reported a result' : 'is waiting for ChatGPT';
    head = `**ChatGPT's \`${tool.name}\` step${withConn} ${what}** (it may need your approval) — ${link}`;
    tail =
      stop === 'ended'
        ? 'The answer ended before that step finished; check the chat in ChatGPT.'
        : stop === 'failed'
          ? "ChatGPT's stop couldn't be pressed — it may still be running; check the chat in ChatGPT."
          : 'ARENA Ask stopped this answer instead of waiting.';
  }
  return `${head}\n\n_${tail} ${GPT_APPROVE_WARNING}_`;
}
