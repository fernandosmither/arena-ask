/**
 * Which chatgpt.com account the hidden page is using, and whether My ChatGPT may use it (pure).
 *
 * `GET /api/auth/session` names the account the page acts as (`account.id`, `planType`,
 * `structure`; it is the same id the page sends as `ChatGPT-Account-Id`, checked live 2026-09-25),
 * and `GET /backend-api/accounts/check/v4-2023-04-27` confirms it: an entry for that id with
 * `structure: "personal"`, no workspace or organization, and a personal plan. Team, Enterprise, Edu
 * and other workspace accounts are refused. Only a tag of the id (`accountTagFor`) ever leaves
 * chatgpt.com, never the id itself, the access token or anything else from these responses.
 */

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Plan types of workspace accounts (Team, Enterprise, Edu, Business, …): never used. */
const WORKSPACE_PLAN_RE = /team|enterprise|edu|business|k12|gov|workspace|org|corp|school/i;

export interface GptSession {
  /**
   * The access token the page uses: kept in the relay's function scope, sent only as the
   * `Authorization` header of the relay's own requests to chatgpt.com, never stored or logged.
   */
  accessToken: string;
  accountId: string;
  planType: string | null;
  structure: string | null;
}

/** Parse `/api/auth/session`: null when logged out (no user, token or account). */
export function parseSession(j: unknown): GptSession | null {
  if (!isObj(j) || !isObj(j.user) || typeof j.accessToken !== 'string' || !j.accessToken) return null;
  const a = isObj(j.account) ? j.account : null;
  if (!a || typeof a.id !== 'string' || !a.id || a.id.length > 200) return null;
  return {
    accessToken: j.accessToken,
    accountId: a.id,
    planType: typeof a.planType === 'string' ? a.planType : null,
    structure: typeof a.structure === 'string' ? a.structure : null,
  };
}

export type AccountVerdict = { ok: true; plan: string } | { ok: false; why: 'not_personal' | 'unknown' };

/**
 * Is the session's account a personal one, per the session AND accounts/check? Anything missing or
 * unexpected is refused (`unknown`).
 */
export function checkPersonal(session: GptSession, accountsCheck: unknown): AccountVerdict {
  if (session.structure !== 'personal') return { ok: false, why: session.structure ? 'not_personal' : 'unknown' };
  if (session.planType && WORKSPACE_PLAN_RE.test(session.planType)) return { ok: false, why: 'not_personal' };
  if (!isObj(accountsCheck) || !isObj(accountsCheck.accounts)) return { ok: false, why: 'unknown' };
  const entry = (accountsCheck.accounts as Obj)[session.accountId];
  const acc = isObj(entry) && isObj(entry.account) ? entry.account : null;
  if (!acc || acc.account_id !== session.accountId) return { ok: false, why: 'unknown' };
  if (acc.structure !== 'personal') return { ok: false, why: 'not_personal' };
  if (acc.workspace_type !== null && acc.workspace_type !== undefined) return { ok: false, why: 'not_personal' };
  if (acc.organization_id !== null && acc.organization_id !== undefined) return { ok: false, why: 'not_personal' };
  if (acc.is_deactivated === true) return { ok: false, why: 'unknown' };
  const plan = typeof acc.plan_type === 'string' ? acc.plan_type : '';
  if (!plan || WORKSPACE_PLAN_RE.test(plan)) return { ok: false, why: plan ? 'not_personal' : 'unknown' };
  return { ok: true, plan: plan.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) };
}

export const GPT_NOT_PERSONAL_DETAIL =
  'My ChatGPT only runs in a personal ChatGPT account, and the one chatgpt.com is using is a workspace (Team, Enterprise, Edu, …) account. Switch chatgpt.com to your personal account.';
export const GPT_UNKNOWN_ACCOUNT_DETAIL = "ARENA Ask couldn't confirm which ChatGPT account chatgpt.com is using. Reload chatgpt.com and ask again.";
export const GPT_PINNED_MISMATCH_DETAIL =
  "My ChatGPT is tied to the ChatGPT account it was first used with, and chatgpt.com is now using another one. Switch back, or use 'Forget pinned account' (ChatGPT) in ARENA Ask's options.";
