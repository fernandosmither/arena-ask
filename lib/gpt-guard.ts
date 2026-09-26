/**
 * The send guard for My ChatGPT (pure; runs in chatgpt.com's MAIN world, lib/gpt-page.ts, right
 * before the page's own `POST /backend-api/f/conversation` leaves): the request must carry exactly
 * the message the relay put in the composer, to the chat the relay expects, from the account it
 * checked, or it is never sent.
 *
 * chatgpt.com's composer sends its ProseMirror document serialised as markdown, not the text that was
 * inserted: it escapes markdown punctuation with backslashes (`#` → `\#`, `*` → `\*`, `<` → `\<`, …),
 * turns URLs into links (`https://x` → `[https://x](https://x)`), writes a trailing space as `&#x20;`,
 * turns tabs and no-break spaces into spaces and paragraph breaks into blank lines (seen live
 * 2026-09-25). So both sides are compared in a canonical form (`canonText`): numeric character
 * references decoded, backslashes dropped, `[X](X)` links (also `http(s)://X`, `mailto:X`) collapsed
 * to X, all whitespace dropped. Words, symbols and their order must match exactly.
 */

export const CONV_POST_RE = /^\/backend-api\/(f\/)?conversation$/;
/** Sign-out endpoints: never allowed from ARENA Ask's own chatgpt.com frame or tab. */
export const SIGNOUT_PATH_RE = /^\/(api\/auth\/signout|auth\/logout)(\/|$)/i;

export type Digest = (data: Uint8Array) => Promise<ArrayBuffer>;
const defaultDigest: Digest = (d) => crypto.subtle.digest('SHA-256', d as unknown as ArrayBuffer);

async function sha256Hex(s: string, digest: Digest = defaultDigest): Promise<string> {
  const buf = await digest(new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const fromCodePoint = (n: number, fallback: string) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : fallback);

/** `[X](X)` (or `(http://X)`, `(https://X)`, `(mailto:X)`) → X, nested ones included (`[a]([u](u))` → `[a](u)`). */
function collapseLinks(t: string): string {
  if (!t.includes('](')) return t;
  let out = '';
  let i = 0;
  while (i < t.length) {
    const j = t.indexOf('](', i);
    if (j < 0) {
      out += t.slice(i);
      break;
    }
    let done = false;
    for (let k = j - 1; k >= i && j - k <= 4096 && !done; k--) {
      if (t[k] !== '[') continue;
      const x = t.slice(k + 1, j);
      for (const url of [x, `http://${x}`, `https://${x}`, `mailto:${x}`]) {
        if (t.startsWith(`${url})`, j + 2)) {
          out += t.slice(i, k) + x;
          i = j + 2 + url.length + 1;
          done = true;
          break;
        }
      }
    }
    if (!done) {
      out += t.slice(i, j + 2);
      i = j + 2;
    }
  }
  return out;
}

/** The canonical form both sides of the send guard are compared in (see the module comment). */
export function canonText(s: string): string {
  let t = String(s ?? '')
    .normalize('NFKC')
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h: string) => fromCodePoint(parseInt(h, 16), m))
    .replace(/&#([0-9]{1,7});/g, (m, d: string) => fromCodePoint(parseInt(d, 10), m))
    .replace(/\\/g, '');
  for (let n = 0; n < 3; n++) {
    const next = collapseLinks(t);
    if (next === t) break;
    t = next;
  }
  return t.replace(/[\s​-‍⁠﻿]+/gu, '');
}

/** The hash the relay arms the guard with, and the guard compares against. */
export async function messageHash(text: string, digest?: Digest): Promise<string> {
  return sha256Hex(`arena-ask/chatgpt-message\n${canonText(text)}`, digest);
}

/** A short, non-reversible tag for a ChatGPT account id (only this leaves chatgpt.com). */
export async function accountTagFor(accountId: string, digest?: Digest): Promise<string> {
  return (await sha256Hex(`arena-ask/chatgpt-account/${accountId}`, digest)).slice(0, 16);
}

/**
 * Text the relay is about to insert, made safe to round-trip through the composer: CRLF → LF, and
 * control characters other than tab and newline (which ProseMirror may keep or drop) removed.
 */
export function composerSafe(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/**
 * Request-body changes the guard may make (only these keys; chosen in the background, see
 * docs/DESIGN.md "My ChatGPT: tools").
 */
export interface BodyPatch {
  is_do_not_remember?: boolean;
  disabled_tool_ids?: string[];
  /** Top-level keys removed from the body (tool-related hints). */
  drop?: ('local_function_names' | 'system_hints')[];
}

/** What the relay armed the guard with, for one message. */
export interface Expectation {
  /** messageHash() of the text the relay inserted. */
  hash: string;
  /** The chat it continues, or null for a new chat (the body must carry no conversation_id). */
  convId: string | null;
  /** accountTagFor() of the account the relay checked (the request's ChatGPT-Account-Id must match). */
  accountTag: string;
  /** Model slug to send instead of the page's choice (the owner's setting), or null. */
  model: string | null;
  patch: BodyPatch;
  /** QA only: check the request, report the verdict, and never send it. */
  dryRun?: boolean;
}

export type GuardResult = { ok: true; body: Record<string, unknown>; patched: string[] } | { ok: false; why: string };

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Where two canonical texts first differ, described without their content (for the log). */
export function describeMismatch(sent: string, expected: string): string {
  const a = canonText(sent);
  const b = canonText(expected);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cls = (ch: string | undefined) => {
    if (ch === undefined) return 'end';
    if (/\p{L}/u.test(ch)) return 'L';
    if (/\p{N}/u.test(ch)) return 'N';
    const cp = ch.codePointAt(0)!;
    return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  };
  return `len:${a.length}/${b.length}:at:${i}:${cls(a[i])}/${cls(b[i])}`;
}

/**
 * Check a conversation request body against the expectation, and return the body to send (with the
 * patch and model override applied). Any doubt: not sent.
 */
export async function guardConversation(
  body: unknown,
  accountHeader: string | null,
  expect: Expectation,
  digest?: Digest,
): Promise<GuardResult> {
  const no = (why: string): GuardResult => ({ ok: false, why });
  if (!isObj(body)) return no('body');
  if (body.action !== 'next') return no('action');
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length !== 1 || !isObj(msgs[0])) return no('messages');
  const m = msgs[0];
  if (!isObj(m.author) || m.author.role !== 'user') return no('role');
  if (m.recipient !== undefined && m.recipient !== null && m.recipient !== 'all') return no('recipient');
  if (!isObj(m.content) || m.content.content_type !== 'text') return no('content_type');
  const parts = m.content.parts;
  if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0] !== 'string') return no('parts');
  const meta = isObj(m.metadata) ? m.metadata : {};
  if (meta.attachments !== undefined && !(Array.isArray(meta.attachments) && meta.attachments.length === 0)) return no('attachments');
  if ((await messageHash(parts[0], digest)) !== expect.hash) return no('text');
  const conv = body.conversation_id;
  if (expect.convId === null ? conv !== undefined && conv !== null : conv !== expect.convId) return no('conversation');
  if (body.system_hints !== undefined && !(Array.isArray(body.system_hints) && body.system_hints.length === 0)) return no('system_hints');
  if (body.gizmo_id !== undefined && body.gizmo_id !== null) return no('gizmo');
  const mode = body.conversation_mode;
  if (mode !== undefined && mode !== null && !(isObj(mode) && mode.kind === 'primary_assistant' && Object.keys(mode).length === 1)) return no('conversation_mode');
  if (!accountHeader || (await accountTagFor(accountHeader, digest)) !== expect.accountTag) return no('account');

  const out: Obj = { ...body };
  const patched: string[] = [];
  if (expect.model) {
    out.model = expect.model;
    patched.push('model');
  }
  const p = expect.patch;
  if (typeof p.is_do_not_remember === 'boolean') {
    out.is_do_not_remember = p.is_do_not_remember;
    patched.push('is_do_not_remember');
  }
  if (Array.isArray(p.disabled_tool_ids)) {
    out.disabled_tool_ids = [...p.disabled_tool_ids];
    patched.push('disabled_tool_ids');
  }
  for (const k of p.drop ?? []) {
    if (k in out) {
      delete out[k];
      patched.push(`-${k}`);
    }
  }
  return { ok: true, body: out, patched };
}

/** A patch as the background may pass it on (anything else is dropped). */
export function validPatch(x: unknown): BodyPatch | null {
  if (x === null || x === undefined) return {};
  if (!isObj(x)) return null;
  const out: BodyPatch = {};
  for (const [k, v] of Object.entries(x)) {
    if (k === 'is_do_not_remember' && typeof v === 'boolean') out.is_do_not_remember = v;
    else if (k === 'disabled_tool_ids' && Array.isArray(v) && v.length <= 40 && v.every((s) => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(s))) out.disabled_tool_ids = [...v];
    else if (k === 'drop' && Array.isArray(v) && v.every((s) => s === 'local_function_names' || s === 'system_hints')) out.drop = [...new Set(v)] as BodyPatch['drop'];
    else return null;
  }
  return out;
}
