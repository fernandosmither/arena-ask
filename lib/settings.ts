import type { Mode } from './protocol';
import type { ProviderId } from './provider';

/**
 * The owner's settings, changed from the extension's Options page (entrypoints/options) through
 * runtime messages to the background. The background accepts them ONLY from that page: the
 * sender must be this extension (`sender.id`) AND the document must be the options page itself
 * (`sender.url`, plus `sender.origin` where the browser reports one). Content scripts share the
 * extension's id but report their web page's URL, so they are refused, and so is every other
 * extension page (the offscreen document). A refused message gets no answer at all.
 *
 * Only booleans and the mode ever go back to the page: whether an account is pinned, never which.
 * The service worker's `arenaAsk.*` console helpers change the same settings (README "Settings").
 */

export const MSG_SETTINGS = 'arena-ask:settings';
/** The options page's path in the build (WXT's `options` entrypoint). */
export const OPTIONS_PAGE_PATH = '/options.html';

export type SettingsRequest =
  | { type: typeof MSG_SETTINGS; op: 'get' }
  | { type: typeof MSG_SETTINGS; op: 'setMode'; mode: Mode }
  | { type: typeof MSG_SETTINGS; op: 'setGptDoNotRemember'; on: boolean }
  | { type: typeof MSG_SETTINGS; op: 'forgetAccount'; provider: ProviderId };

export interface SettingsSnapshot {
  /** Claude access: 'full' (the default) or 'locked'. */
  mode: Mode;
  /** My ChatGPT marks its chats "don't remember" (off by default). */
  gptDoNotRemember: boolean;
  /** Whether each provider is pinned to an account (never which one). */
  pinned: { claude: boolean; chatgpt: boolean };
}

export type SettingsResponse = { ok: true; settings: SettingsSnapshot } | { ok: false; error: string };

/** What the background provides (its IndexedDB, and its ChatGPT queue for the pin). */
export interface SettingsApi {
  mode(): Promise<Mode>;
  setMode(mode: Mode): Promise<void>;
  gptDoNotRemember(): Promise<boolean>;
  setGptDoNotRemember(on: boolean): Promise<void>;
  pinned(provider: ProviderId): Promise<boolean>;
  forgetAccount(provider: ProviderId): Promise<void>;
}

/** The subset of `runtime.MessageSender` the check reads. */
export interface SenderLike {
  id?: string;
  url?: string;
  origin?: string;
}

const isPlain = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

/** Exactly these own keys, no more, no fewer. */
const hasExactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};

/**
 * True only for the extension's own options page: same extension id, and the sender's document
 * URL is the options page's (optionally followed by a query or fragment). `optionsUrl` is
 * `runtime.getURL(OPTIONS_PAGE_PATH)`, e.g. `chrome-extension://<id>/options.html`.
 */
export function isOptionsPageSender(s: SenderLike | undefined | null, extId: string, optionsUrl: string): boolean {
  if (!s || typeof extId !== 'string' || !extId || s.id !== extId) return false;
  if (typeof s.url !== 'string' || typeof optionsUrl !== 'string' || !optionsUrl) return false;
  let page: URL;
  let want: URL;
  try {
    page = new URL(s.url);
    want = new URL(optionsUrl);
  } catch {
    return false;
  }
  // Web pages (a content script's sender.url) never qualify, whatever their path.
  if (page.protocol === 'http:' || page.protocol === 'https:' || page.protocol !== want.protocol) return false;
  // (URL.origin is "null" for extension schemes outside a browser, so compare scheme + host.)
  if (!want.host || page.host !== want.host || page.username || page.password || page.pathname !== want.pathname) return false;
  // The raw string must start with the options URL too (no userinfo, port or path tricks).
  const rest = s.url.slice(optionsUrl.length);
  if (!s.url.startsWith(optionsUrl) || !(rest === '' || rest.startsWith('?') || rest.startsWith('#'))) return false;
  // Chrome reports the sender document's origin: it must be the extension's own.
  if (s.origin !== undefined && s.origin !== `${want.protocol}//${want.host}`) return false;
  return true;
}

/** A settings request with exactly the expected shape, or null. */
export function validateSettingsRequest(raw: unknown): SettingsRequest | null {
  if (!isPlain(raw) || raw.type !== MSG_SETTINGS) return null;
  switch (raw.op) {
    case 'get':
      return hasExactKeys(raw, ['type', 'op']) ? { type: MSG_SETTINGS, op: 'get' } : null;
    case 'setMode':
      return hasExactKeys(raw, ['type', 'op', 'mode']) && (raw.mode === 'full' || raw.mode === 'locked')
        ? { type: MSG_SETTINGS, op: 'setMode', mode: raw.mode }
        : null;
    case 'setGptDoNotRemember':
      return hasExactKeys(raw, ['type', 'op', 'on']) && typeof raw.on === 'boolean'
        ? { type: MSG_SETTINGS, op: 'setGptDoNotRemember', on: raw.on }
        : null;
    case 'forgetAccount':
      return hasExactKeys(raw, ['type', 'op', 'provider']) && (raw.provider === 'claude' || raw.provider === 'chatgpt')
        ? { type: MSG_SETTINGS, op: 'forgetAccount', provider: raw.provider }
        : null;
    default:
      return null;
  }
}

export async function readSettings(api: SettingsApi): Promise<SettingsSnapshot> {
  const [mode, gptDoNotRemember, claude, chatgpt] = await Promise.all([
    api.mode(),
    api.gptDoNotRemember(),
    api.pinned('claude'),
    api.pinned('chatgpt'),
  ]);
  return { mode, gptDoNotRemember, pinned: { claude, chatgpt } };
}

/** Apply one validated request and answer with the settings as they now are. */
export async function handleSettingsRequest(req: SettingsRequest, api: SettingsApi): Promise<SettingsResponse> {
  if (req.op === 'setMode') await api.setMode(req.mode);
  else if (req.op === 'setGptDoNotRemember') await api.setGptDoNotRemember(req.on);
  else if (req.op === 'forgetAccount') await api.forgetAccount(req.provider);
  return { ok: true, settings: await readSettings(api) };
}

export interface SettingsRouteDeps {
  extId: string;
  optionsUrl: string;
  api: SettingsApi;
  log?: (...a: unknown[]) => void;
}

/**
 * The background's `runtime.onMessage` route for settings. Returns true when it will answer
 * asynchronously (keep the channel open), undefined otherwise. Messages of another type are left
 * alone; settings messages from anything but the options page are dropped without an answer.
 */
export function routeSettingsMessage(
  msg: unknown,
  sender: SenderLike | undefined,
  sendResponse: (r: SettingsResponse) => void,
  deps: SettingsRouteDeps,
): true | undefined {
  if (!isPlain(msg) || msg.type !== MSG_SETTINGS) return undefined;
  if (!isOptionsPageSender(sender, deps.extId, deps.optionsUrl)) {
    deps.log?.('settings message refused: not from the options page');
    return undefined;
  }
  const req = validateSettingsRequest(msg);
  if (!req) {
    sendResponse({ ok: false, error: 'malformed settings request' });
    return undefined;
  }
  void handleSettingsRequest(req, deps.api).then(
    (r) => {
      if (req.op !== 'get') deps.log?.('settings changed from the options page', { op: req.op });
      sendResponse(r);
    },
    () => sendResponse({ ok: false, error: "couldn't save the setting" }),
  );
  return true;
}
