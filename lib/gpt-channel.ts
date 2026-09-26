/**
 * The private channel between My ChatGPT's two chatgpt.com scripts (same frame, two worlds):
 *
 *   ISOLATED (lib/gpt-relay.ts)  ── MessagePort ──  MAIN (lib/gpt-page.ts)
 *
 * The isolated script creates a MessageChannel at document_start and hands one port to the MAIN
 * world in a single window message (HANDSHAKE). The MAIN world's capture listener on `window` is
 * registered at document_start too, before any chatgpt.com script runs, takes the FIRST handshake
 * only, and stops it from reaching any other listener, so page scripts never hold the port (the MAIN
 * world uses only the port and event functions it captured at document_start, so a page script that
 * replaces `MessagePort.prototype.postMessage` later never sees the port either). Nothing secret
 * crosses it: the MAIN world gets a per-question tag and verdicts; the isolated world gets the page's
 * conversation request body (to check it in its own realm) and the answer stream the page receives.
 *
 * Every message about a question carries its tag (`req`, from `arm`): the relay ignores anything
 * with another tag, and anything about the answer before its own check let the request out.
 */

export const HANDSHAKE_KEY = '__arenaAskGpt';
export const HANDSHAKE_V = 'channel-v2';

/** The marker of ARENA Ask's own chatgpt.com tab: its URL fragment on a load ARENA Ask makes, then the tab's `window.name`. */
export const TAB_MARK = 'arena-ask-gpt';

/** isolated → MAIN */
export type ToPage =
  /** This is ARENA Ask's frame or pinned tab: start guarding (a top-level tab starts dormant). */
  | { t: 'activate' }
  /** A question is in progress (until `disarm`): the next conversation request is checked with the relay, once. */
  | { t: 'arm'; req: string }
  /** The relay's verdict on the conversation request `id` of question `req`: send exactly `body`, or block it. */
  | { t: 'verdict'; req: string; id: number; ok: true; body: string }
  | { t: 'verdict'; req: string; id: number; ok: false; why: string }
  | { t: 'disarm' };

/** MAIN → isolated */
export type FromPage =
  | { t: 'ready'; mode: 'frame' | 'tab'; active: boolean }
  | { t: 'armed'; req: string }
  /** The page's conversation request for question `req`: its body and ChatGPT-Account-Id, for the relay to check. */
  | { t: 'check'; req: string; id: number; body: string; account: string | null }
  /** A conversation request the MAIN world blocked itself (nobody armed it, a second one, no verdict in time…). */
  | { t: 'blocked'; req: string | null; why: string }
  /** The checked request went out. */
  | { t: 'sent'; req: string }
  /** The conversation request's answer isn't a stream (an HTTP error, a JSON error…). */
  | { t: 'conv-status'; req: string; status: number }
  | { t: 'sse'; req: string; chunk: string }
  | { t: 'sse-end'; req: string }
  /** The request or its stream failed (the page's own abort after [DONE] included). */
  | { t: 'sse-error'; req: string; name: string }
  /** A /backend-api request got 401 (the page would now sign the owner out; that is blocked). */
  | { t: 'auth-401' }
  /** The page tried to sign out; it was blocked. */
  | { t: 'signout-blocked' };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const WHY_RE = /^[A-Za-z0-9_.:+-]{1,120}$/;
/** A question's tag: 16–32 lowercase hex. */
export const REQ_RE = /^[0-9a-f]{16,32}$/;
const isReq = (x: unknown): x is string => typeof x === 'string' && REQ_RE.test(x);
const isId = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 1e9;

/** Validate a message from the MAIN world (a copy; unknown shapes → null). */
export function parseFromPage(x: unknown): FromPage | null {
  if (!isObj(x)) return null;
  switch (x.t) {
    case 'ready':
      return (x.mode === 'frame' || x.mode === 'tab') && typeof x.active === 'boolean' ? { t: 'ready', mode: x.mode, active: x.active } : null;
    case 'auth-401':
    case 'signout-blocked':
      return { t: x.t };
    case 'armed':
    case 'sent':
    case 'sse-end':
      return isReq(x.req) ? { t: x.t, req: x.req } : null;
    case 'check':
      if (!isReq(x.req) || !isId(x.id) || typeof x.body !== 'string' || x.body.length > 2_000_000) return null;
      if (x.account !== null && (typeof x.account !== 'string' || x.account.length > 200)) return null;
      return { t: 'check', req: x.req, id: x.id, body: x.body, account: x.account };
    case 'blocked':
      return (x.req === null || isReq(x.req)) && typeof x.why === 'string' && WHY_RE.test(x.why) ? { t: 'blocked', req: x.req as string | null, why: x.why } : null;
    case 'conv-status':
      return isReq(x.req) && typeof x.status === 'number' && Number.isInteger(x.status) ? { t: 'conv-status', req: x.req, status: x.status } : null;
    case 'sse':
      return isReq(x.req) && typeof x.chunk === 'string' && x.chunk.length <= 4_000_000 ? { t: 'sse', req: x.req, chunk: x.chunk } : null;
    case 'sse-error':
      return isReq(x.req) ? { t: 'sse-error', req: x.req, name: typeof x.name === 'string' && WHY_RE.test(x.name) ? x.name : 'Error' } : null;
    default:
      return null;
  }
}

/** Validate a command from the isolated world (MAIN side; unknown shapes → null). */
export function parseToPage(x: unknown): ToPage | null {
  if (!isObj(x)) return null;
  switch (x.t) {
    case 'activate':
    case 'disarm':
      return { t: x.t };
    case 'arm':
      return isReq(x.req) ? { t: 'arm', req: x.req } : null;
    case 'verdict':
      if (!isReq(x.req) || !isId(x.id)) return null;
      if (x.ok === true) return typeof x.body === 'string' && x.body.length <= 2_000_000 ? { t: 'verdict', req: x.req, id: x.id, ok: true, body: x.body } : null;
      return x.ok === false && typeof x.why === 'string' && WHY_RE.test(x.why) ? { t: 'verdict', req: x.req, id: x.id, ok: false, why: x.why } : null;
    default:
      return null;
  }
}
