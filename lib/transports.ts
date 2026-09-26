import type { Browser } from 'wxt/browser';
import { ext } from './ext';
import {
  DEBUG_DISABLE_OFFSCREEN,
  FRAME_READY_TIMEOUT_MS,
  FRAME_WAKE_TIMEOUT_MS,
  MSG_DROP_FRAME,
  MSG_RELOAD_FRAME,
  MSG_WAKE,
  PORT_RELAY,
  PORT_RELAY_GPT,
  PROTOCOL_VERSION,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_OPEN_TIMEOUT_MS,
  WAKE_RESEND_MS,
  type Transport,
} from './protocol';
import { TAB_MARK } from './gpt-channel';
import { providerById, type ProviderId } from './provider';
import { validateStreamEvent } from './validate';

/**
 * Background side of the relay transports. Each returns a port on which a relay (running inside the
 * provider's site, so every request is same-origin with the user's own session) has said hello:
 *
 *   1. offscreenFrame  an invisible <iframe> of the provider's site in the extension's offscreen
 *                      document (one document, one frame per provider, each created on its first
 *                      use). Chrome only. Needs session DNR rules that strip X-Frame-Options/CSP from
 *                      that site's sub_frame responses outside any tab (tabId -1) loaded by this
 *                      extension. claude.ai: several asks share the frame (each wake carries a
 *                      nonce; the frame opens one port per nonce). chatgpt.com: one question at a
 *                      time (the background queues them), and a sign-out block rule rides along.
 *   2. claudeTab       claude.ai only: any open top-level claude.ai tab running the relay.
 *   3. newTab          the one tab of the provider's site ARENA Ask opens (pinned + inactive),
 *                      reused afterwards. For ChatGPT this is the only tab it ever uses: its relay
 *                      drives the page, so it never touches the owner's own chatgpt.com tabs.
 *
 * The offscreen document is never closed or rebuilt while any ask (of either provider) is using or
 * waiting for its frame; an ask whose frame port doesn't arrive falls back to a tab without
 * disturbing the others. Opening, closing, rebuilding and reloading it, and adding/removing its
 * rules, run one at a time (`serialized`), and "is anyone using it?" is checked again right before
 * anything destructive. The rules are removed whenever the document is closed or found missing.
 *
 * The service-worker direct-fetch path is deliberately absent: it is Cloudflare-challenged and
 * would need a forged Origin.
 */

type Port = Browser.runtime.Port;
export interface RelayHandle {
  port: Port;
  via: Transport;
  /** The caller is done with this relay (idempotent). Frame relays count as in use until then. */
  release(): void;
}

const log = (...a: unknown[]) => console.info('[arena-ask]', ...a.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : x)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Browser APIs that exist only on Chrome (typed loosely so the Firefox build needs no stubs).
interface OffscreenApi {
  createDocument(o: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
  hasDocument?: () => Promise<boolean>;
}
interface DnrApi {
  updateSessionRules(o: { removeRuleIds?: number[]; addRules?: unknown[] }): Promise<void>;
  getSessionRules?: () => Promise<{ id: number }[]>;
}
const offscreenApi = () => (ext() as unknown as { offscreen?: OffscreenApi }).offscreen;
const dnrApi = () => (ext() as unknown as { declarativeNetRequest?: DnrApi }).declarativeNetRequest;

// ---------------------------------------------------------------------------------------------
// 1. Offscreen frames

const OFFSCREEN_PATH = 'offscreen.html';
const DNR_RULE_ID = 1; // claude.ai frame
const GPT_FRAME_RULE_ID = 2; // chatgpt.com frame
const GPT_SIGNOUT_FRAME_RULE_ID = 3; // chatgpt.com sign-out, from the frame
const GPT_SIGNOUT_TAB_RULE_ID = 4; // chatgpt.com sign-out, from ARENA Ask's pinned chatgpt.com tab
const FRAME_RULE_IDS = [DNR_RULE_ID, GPT_FRAME_RULE_ID, GPT_SIGNOUT_FRAME_RULE_ID];
const cooldownKey = (p: ProviderId) => (p === 'claude' ? 'offscreenCooldownUntil' : `offscreenCooldownUntil:${p}`);
const rebuildKey = (p: ProviderId) => (p === 'claude' ? 'offscreenRebuild' : `offscreenRebuild:${p}`);

/** How long the frame transport is skipped after it failed, by cause. */
export const COOLDOWN_MS = {
  /** A Cloudflare challenge that didn't clear, or a frame that never connected / died. */
  transient: 60_000,
  /** The frame is logged out while a tab may not be (e.g. third-party cookies blocked for it). */
  logged_out: 10 * 60_000,
} as const;

const STRIP_FRAMING = {
  type: 'modifyHeaders',
  responseHeaders: [
    { header: 'x-frame-options', operation: 'remove' },
    { header: 'content-security-policy', operation: 'remove' },
    { header: 'content-security-policy-report-only', operation: 'remove' },
  ],
};

/**
 * Remove framing blockers from claude.ai documents framed by THIS extension only: sub_frame
 * requests outside any tab (tabId -1 = extension contexts) whose initiator is our own origin. The
 * whole CSP has to go (DNR can't edit a header, and claude.ai's CSP carries a per-response script
 * nonce, so no static replacement would work); only this one frame runs without it.
 */
export function frameRule(extensionId: string) {
  return {
    id: DNR_RULE_ID,
    priority: 1,
    action: STRIP_FRAMING,
    condition: {
      requestDomains: ['claude.ai'],
      tabIds: [-1],
      resourceTypes: ['sub_frame'],
      initiatorDomains: [extensionId],
    },
  };
}

/**
 * Every resource type each browser's DNR accepts (DNR matches all but main_frame when none are
 * listed, so they are spelled out). A rule naming a type the browser doesn't know is rejected
 * outright (`updateSessionRules` throws), so each browser gets its own list:
 * - Chrome: its `declarativeNetRequest.ResourceType` (Chrome 116+, the minimum_chrome_version).
 * - Firefox: its `declarative_net_request.json` schema in Firefox 128 (the strict_min_version); later
 *   versions only add types (154 adds `json`), so this list is valid on every supported Firefox.
 *   Firefox has no `webtransport` or `webbundle`.
 */
export const CHROME_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report',
  'media', 'websocket', 'webtransport', 'webbundle', 'other',
] as const;
export const FIREFOX_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'object', 'object_subrequest', 'xmlhttprequest', 'xslt', 'ping',
  'beacon', 'xml_dtd', 'font', 'media', 'websocket', 'csp_report', 'imageset', 'web_manifest', 'speculative', 'other',
] as const;
const FIREFOX_BUILD = (import.meta as { env?: { FIREFOX?: boolean } }).env?.FIREFOX === true;

/**
 * chatgpt.com's frame rules: (2) the same header strip as claude.ai's, for chatgpt.com sub_frames
 * outside any tab loaded by this extension or, inside that frame, by chatgpt.com itself (its relay
 * moves the frame to a chat with `location.replace`, and chatgpt.com may frame itself); other
 * extensions' requests never reach our rules, so tabId -1 + these initiators is our frame only.
 * (3) Its sign-out endpoints blocked outside any tab: chatgpt.com's own code signs the owner out
 * when a hidden frame gets a 401, which would sign them out everywhere in this profile.
 */
export function gptFrameRules(extensionId: string) {
  return [
    {
      id: GPT_FRAME_RULE_ID,
      priority: 1,
      action: STRIP_FRAMING,
      condition: {
        requestDomains: ['chatgpt.com'],
        tabIds: [-1],
        resourceTypes: ['sub_frame'],
        initiatorDomains: [extensionId, 'chatgpt.com'],
      },
    },
    gptSignoutRule(GPT_SIGNOUT_FRAME_RULE_ID, -1),
  ];
}

/**
 * Block chatgpt.com's sign-out endpoints in one tab (-1: outside any tab), for every resource type
 * this browser knows (`firefox`: the Firefox list; see CHROME_RESOURCE_TYPES).
 */
export function gptSignoutRule(id: number, tabId: number, firefox = FIREFOX_BUILD) {
  return {
    id,
    priority: 2,
    action: { type: 'block' },
    condition: {
      regexFilter: '^https://chatgpt\\.com/(api/auth/signout|auth/logout)([/?#]|$)',
      tabIds: [tabId],
      resourceTypes: [...(firefox ? FIREFOX_RESOURCE_TYPES : CHROME_RESOURCE_TYPES)],
    },
  };
}

interface Slot {
  /** hello'd frame ports no ask has claimed yet (e.g. the frame's connect on load) */
  pool: Port[];
  /** wake nonce → waiting ask (insertion order = age) */
  waiters: Map<string, (p: Port) => void>;
  /** relays handed out on the frame and not yet released */
  inFlight: number;
  /** asks currently waiting for a frame port */
  claims: number;
  /** the current frame document has said hello since it was (re)loaded */
  ready: boolean;
}
const newSlot = (): Slot => ({ pool: [], waiters: new Map(), inFlight: 0, claims: 0, ready: false });
const slots: Record<ProviderId, Slot> = { claude: newSlot(), chatgpt: newSlot() };
let lifecycle: Promise<unknown> = Promise.resolve();

/** Offscreen document open / close / rebuild / reload and rule changes run one at a time. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(fn, fn);
  lifecycle = run.catch(() => {});
  return run;
}

/** A handle on a frame port; the port counts as in use (the frame is never closed) until released. */
function frameHandle(port: Port, provider: ProviderId): RelayHandle {
  let released = false;
  return {
    port,
    via: 'offscreenFrame',
    release: () => {
      if (released) return;
      released = true;
      slots[provider].inFlight = Math.max(0, slots[provider].inFlight - 1);
    },
  };
}
const tabHandle = (port: Port, via: Transport): RelayHandle => ({ port, via, release: () => {} });

export function offscreenSupported(): boolean {
  return !!offscreenApi()?.createDocument && !!dnrApi()?.updateSessionRules;
}

/** Anyone using or waiting for `provider`'s frame (other than `selfClaims` of that provider's claims)? */
function slotBusy(provider: ProviderId, selfClaims = 0): boolean {
  const s = slots[provider];
  return s.inFlight > 0 || s.claims > selfClaims;
}

/** Anyone using or waiting for any frame of the document (other than `self`'s own claims)? */
function frameBusy(selfClaims = 0, self: ProviderId = 'claude'): boolean {
  return (['claude', 'chatgpt'] as const).some((p) => slotBusy(p, p === self ? selfClaims : 0));
}

/** Background onConnect for a frame relay's port: hand it to the ask whose wake it answers. */
export function acceptFramePort(port: Port, provider: ProviderId = 'claude'): void {
  const slot = slots[provider];
  let ready = false;
  const onMsg = (m: unknown) => {
    const ev = validateStreamEvent(m, false);
    if (ready || ev?.type !== 'hello' || ev.v !== PROTOCOL_VERSION) return;
    ready = true;
    slot.ready = true;
    port.onMessage.removeListener(onMsg);
    // A nonce names its ask; a plain hello (the frame's own connect on load) goes to the oldest waiter.
    const waiter = ev.nonce ? slot.waiters.get(ev.nonce) : slot.waiters.values().next().value;
    if (waiter) return waiter(port);
    slot.pool.push(port);
    while (slot.pool.length > 2) slot.pool.shift()!.disconnect();
  };
  port.onMessage.addListener(onMsg);
  port.onDisconnect.addListener(() => {
    void ext().runtime.lastError;
    slot.pool = slot.pool.filter((p) => p !== port);
    scheduleFrameRuleSync(); // the document may be gone (closed by Chrome, crashed…)
  });
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleFrameRuleSync(): void {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncFrameRule().catch(() => {}), 1_000);
}

/** Wait for a frame port for one ask: wake the frame with this ask's nonce until it connects. */
function nextFramePort(provider: ProviderId, timeoutMs: number): Promise<Port | null> {
  const slot = slots[provider];
  const pooled = slot.pool.shift();
  if (pooled) return Promise.resolve(pooled);
  const nonce = crypto.randomUUID();
  return new Promise((resolve) => {
    let done = false;
    const finish = (p: Port | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(tick);
      slot.waiters.delete(nonce);
      resolve(p);
    };
    slot.waiters.set(nonce, finish);
    const timer = setTimeout(() => finish(null), timeoutMs);
    // Re-sent while waiting: a frame that is still loading misses the first ones (and the document
    // creates a provider's frame on its first wake).
    const wake = () =>
      ext()
        .runtime.sendMessage({ type: MSG_WAKE, nonce, provider })
        .catch(() => {}); // "Receiving end does not exist" while the document is still loading
    const tick = setInterval(wake, WAKE_RESEND_MS);
    void wake();
  });
}

async function hasOffscreenDocument(): Promise<boolean> {
  const rt = ext().runtime as unknown as {
    getContexts?: (f: { contextTypes: string[]; documentUrls?: string[] }) => Promise<unknown[]>;
    getURL: (p: string) => string;
  };
  if (rt.getContexts) {
    const ctx = await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [rt.getURL(OFFSCREEN_PATH)] });
    return ctx.length > 0;
  }
  return (await offscreenApi()?.hasDocument?.()) ?? false;
}

/** Install `provider`'s frame rules (replacing any old copy). */
async function installFrameRules(provider: ProviderId): Promise<void> {
  const id = ext().runtime.id;
  if (provider === 'chatgpt') {
    await dnrApi()!.updateSessionRules({ removeRuleIds: [GPT_FRAME_RULE_ID, GPT_SIGNOUT_FRAME_RULE_ID], addRules: gptFrameRules(id) });
  } else {
    await dnrApi()!.updateSessionRules({ removeRuleIds: [DNR_RULE_ID], addRules: [frameRule(id)] });
  }
}

async function removeFrameRule(): Promise<void> {
  await dnrApi()
    ?.updateSessionRules({ removeRuleIds: FRAME_RULE_IDS })
    .catch(() => {});
}

/** Drop the framing rules if there is no offscreen document behind them (serialized with open/close). */
export function syncFrameRule(): Promise<void> {
  if (!offscreenSupported()) return Promise.resolve();
  return serialized(async () => {
    if (await hasOffscreenDocument().catch(() => true)) return;
    slots.claude.ready = slots.chatgpt.ready = false;
    await removeFrameRule();
  });
}

/** Service-worker startup: drop framing rules left over from a previous run with no frame behind them. */
export const cleanupStaleFrameRules = syncFrameRule;

/** Create the document (rules first). Call only inside `serialized`. */
async function createOffscreenLocked(provider: ProviderId): Promise<void> {
  await installFrameRules(provider);
  try {
    await offscreenApi()!.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['IFRAME_SCRIPTING'],
      justification: 'Runs claude.ai / chatgpt.com invisibly so ARENA questions are answered with your own logged-in session.',
    });
    slots.claude.ready = slots.chatgpt.ready = false;
  } catch (e) {
    // created concurrently (e.g. by a question in another service-worker instance): fine
    if (/single offscreen|already exists/i.test(String((e as Error)?.message || e))) return;
    await removeFrameRule(); // no document: no rules
    throw e;
  }
}

/** `closeOffscreen` for callers already inside `serialized`. */
async function closeOffscreenLocked(reason: string, selfClaims: number, rebuildIfBusy = true, self: ProviderId = 'claude'): Promise<boolean> {
  const backOff = async () => {
    if (rebuildIfBusy) await markRebuild('claude');
    return false;
  };
  if (frameBusy(selfClaims, self)) return backOff();
  const has = await hasOffscreenDocument().catch(() => true);
  // Asks claim the frame without the lock: check again now that we've awaited.
  if (frameBusy(selfClaims, self)) return backOff();
  try {
    if (has) await offscreenApi()?.closeDocument();
  } catch {
    /* already closed */
  }
  await removeFrameRule();
  for (const s of Object.values(slots)) {
    for (const p of s.pool) p.disconnect();
    s.pool = [];
    s.ready = false;
  }
  for (const p of ['claude', 'chatgpt'] as const) {
    await ext()
      .storage.session?.remove(rebuildKey(p))
      .catch(() => {});
  }
  log('offscreen closed:', reason);
  return true;
}

/**
 * Close the offscreen document and drop the framing rules, unless anyone else is using or waiting
 * for a frame: then it is only marked for a rebuild on its next use (unless `rebuildIfBusy` is
 * false, as for an idle close: a busy frame isn't idle, and isn't broken either). Returns whether it
 * closed.
 */
export function closeOffscreen(reason: string, selfClaims = 0, rebuildIfBusy = true): Promise<boolean> {
  return serialized(() => closeOffscreenLocked(reason, selfClaims, rebuildIfBusy));
}

async function markRebuild(provider: ProviderId): Promise<void> {
  await ext()
    .storage.session?.set({ [rebuildKey(provider)]: true })
    .catch(() => {});
}

async function rebuildWanted(provider: ProviderId): Promise<boolean> {
  const got = await ext()
    .storage.session?.get(rebuildKey(provider))
    .catch(() => ({}) as Record<string, unknown>);
  return (got as Record<string, unknown> | undefined)?.[rebuildKey(provider)] === true;
}

async function offscreenAllowed(provider: ProviderId): Promise<boolean> {
  if (!offscreenSupported()) return false;
  const local = await ext().storage.local.get(DEBUG_DISABLE_OFFSCREEN);
  if (local[DEBUG_DISABLE_OFFSCREEN] === true) {
    log('offscreen disabled by debug flag');
    return false;
  }
  const session = ext().storage.session;
  if (session) {
    const k = cooldownKey(provider);
    const got = await session.get(k);
    if (typeof got[k] === 'number' && (got[k] as number) > Date.now()) return false;
  }
  return true;
}

/**
 * Skip `provider`'s offscreen transport for a while (it failed, or its session can't be used), and
 * rebuild its frame on its next use.
 */
export async function offscreenCooldown(reason: string, ms: number = COOLDOWN_MS.transient, provider: ProviderId = 'claude'): Promise<void> {
  log(`offscreen transport${provider === 'claude' ? '' : ` (${provider})`} paused for ${Math.round(ms / 1000)} s:`, reason);
  await ext()
    .storage.session?.set({ [cooldownKey(provider)]: Date.now() + ms, [rebuildKey(provider)]: true })
    .catch(() => {});
}

/**
 * Reload a provider's frame (e.g. a Cloudflare challenge that didn't clear by itself), unless other
 * asks are using it. Resolves true when a reload was requested.
 */
export function reloadFrame(provider: ProviderId = 'claude'): Promise<boolean> {
  return serialized(async () => {
    if (slotBusy(provider) || !(await hasOffscreenDocument().catch(() => false)) || slotBusy(provider)) return false;
    const slot = slots[provider];
    slot.ready = false;
    for (const p of slot.pool) p.disconnect();
    slot.pool = [];
    await ext()
      .runtime.sendMessage({ type: MSG_RELOAD_FRAME, provider })
      .catch(() => {});
    log('offscreen frame reloaded', { provider });
    return true;
  });
}

/**
 * Remove a provider's frame from the offscreen document right away (chatgpt.com logged out: a
 * signed-out page must not keep running). Its pooled ports are dropped; asks still holding one see it
 * disconnect. The document itself (and the other provider's frame) stays.
 */
export function dropFrame(provider: ProviderId, reason: string): Promise<void> {
  return serialized(async () => {
    const slot = slots[provider];
    slot.ready = false;
    for (const p of slot.pool) p.disconnect();
    slot.pool = [];
    if (await hasOffscreenDocument().catch(() => false)) {
      await ext()
        .runtime.sendMessage({ type: MSG_DROP_FRAME, provider })
        .catch(() => {});
    }
    log('offscreen frame removed', { provider, reason });
  });
}

/**
 * A hello'd port from the offscreen frame of `provider` for one ask, creating the document (or the
 * frame) if needed, rebuilding it (only when nobody else uses it) if it was marked for a rebuild or
 * doesn't answer. Null when this ask should use a tab instead. claude.ai's rebuild closes and
 * recreates the whole document; chatgpt.com's only removes its own frame (the next wake recreates it).
 */
async function getFramePort(provider: ProviderId): Promise<Port | null> {
  const slot = slots[provider];
  slot.claims++; // at once, without the lock: a close in progress sees it before closing
  try {
    const existed = await serialized(async () => {
      let has = await hasOffscreenDocument();
      if (has && !slotBusy(provider, 1) && (await rebuildWanted(provider))) {
        if (provider === 'claude') {
          if (await closeOffscreenLocked('rebuilding after a failure', 1, true, provider)) has = false;
        } else {
          await dropFrameLocked(provider);
        }
      }
      if (has) await installFrameRules(provider); // session rules outlive SW restarts, but make sure
      else await createOffscreenLocked(provider);
      return has;
    });
    let port = await nextFramePort(provider, existed && slot.ready ? FRAME_WAKE_TIMEOUT_MS : FRAME_READY_TIMEOUT_MS);
    if (!port && existed) {
      // An existing frame that doesn't answer. Rebuild it, but never under other asks.
      const rebuilt = await serialized(async () => {
        if (provider === 'claude') {
          if (!(await closeOffscreenLocked('frame did not answer; rebuilding', 1, true, provider))) return false;
          await createOffscreenLocked(provider);
          return true;
        }
        if (slotBusy(provider, 1)) return false;
        await dropFrameLocked(provider);
        await installFrameRules(provider);
        return true;
      });
      if (rebuilt) port = await nextFramePort(provider, FRAME_READY_TIMEOUT_MS);
    }
    if (port) slot.inFlight++; // handed over in the same step as the claim ends: never unaccounted
    return port;
  } finally {
    slot.claims--;
  }
}

/**
 * Drop the frame ports nobody has claimed yet (My ChatGPT: the frame's page is being replaced, and
 * its old document's ports must never get the next question).
 */
export function drainFramePool(provider: ProviderId): void {
  const slot = slots[provider];
  for (const p of slot.pool) p.disconnect();
  slot.pool = [];
  slot.ready = false;
}

/** Remove a provider's frame (inside `serialized`); its next wake recreates it. */
async function dropFrameLocked(provider: ProviderId): Promise<void> {
  const slot = slots[provider];
  slot.ready = false;
  for (const p of slot.pool) p.disconnect();
  slot.pool = [];
  await ext()
    .runtime.sendMessage({ type: MSG_DROP_FRAME, provider })
    .catch(() => {});
  await ext()
    .storage.session?.remove(rebuildKey(provider))
    .catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// 2./3. Tabs

// The claude.ai account is per cookie store: a Firefox container (or private window), a Chrome
// incognito window. A question is only ever answered through a claude.ai tab in the ARENA tab's own
// store (`tabStore`: the Firefox cookieStoreId; on Chrome "chrome-incognito" for incognito tabs and
// undefined for normal ones), and the tabs remembered below are per store. The offscreen frame
// belongs to Chrome's normal profile, so it serves only that store. ARENA Ask opens its pinned tab
// only for the default store: opening one in another container (tabs.create's cookieStoreId) needs
// the "cookies" permission, which would also let it read claude.ai's cookies. In another container,
// a private or an incognito window, the user opens claude.ai there. My ChatGPT uses only its own
// pinned tab, so it works only in the default store.
const FIREFOX_DEFAULT_STORE = 'firefox-default';
const CHROME_INCOGNITO_STORE = 'chrome-incognito';
/** A Firefox tab that reports no cookie store: it matches nothing (fail closed). */
const UNKNOWN_STORE = 'unknown';

/**
 * The cookie store a tab's pages use (see above); undefined = Chrome's normal profile. On Firefox
 * a tab without a cookieStoreId (every tab has one; this is defensive) is UNKNOWN_STORE.
 */
export function tabStore(tab: object, firefox = FIREFOX_BUILD): string | undefined {
  const t = tab as { cookieStoreId?: unknown; incognito?: unknown };
  if (typeof t.cookieStoreId === 'string' && t.cookieStoreId.length > 0 && t.cookieStoreId.length <= 100) return t.cookieStoreId;
  if (firefox) return UNKNOWN_STORE;
  return t.incognito === true ? CHROME_INCOGNITO_STORE : undefined;
}
const RELAY_TAB_KEY = 'relayTabId'; // the last claude.ai tab whose relay answered
const OWN_TAB_KEY = 'ownTabId'; // the pinned claude.ai tab ARENA Ask opened (at most one per store)
const GPT_OWN_TAB_KEY = 'gptOwnTabId'; // the pinned chatgpt.com tab ARENA Ask opened (default store only)
const TAB_KEY_RE = /^(relayTabId|ownTabId|gptOwnTabId)(:|$)/;
const ownKey = (p: ProviderId) => (p === 'chatgpt' ? GPT_OWN_TAB_KEY : OWN_TAB_KEY);
const mem: Record<string, number | null> = {};
const openingTab = new Map<string, Promise<number>>();
const tabKey = (key: string, store: string | undefined) => (store === undefined ? key : `${key}:${store}`);
/** Is this tab in the cookie store the question came from? */
const inStore = (t: object, store: string | undefined) => store !== UNKNOWN_STORE && tabStore(t) === store;
const isDefaultStore = (store: string | undefined) => store === undefined || store === FIREFOX_DEFAULT_STORE;

async function getTabKey(key: string): Promise<number | null> {
  const area = ext().storage.session;
  if (!area) return mem[key] ?? null;
  const got = await area.get(key);
  return typeof got[key] === 'number' ? (got[key] as number) : null;
}

async function setTabKey(key: string, id: number | null): Promise<void> {
  mem[key] = id;
  const area = ext().storage.session;
  if (!area) return;
  if (id === null) await area.remove(key);
  else await area.set({ [key]: id });
}

export const getRememberedTab = (store?: string) => getTabKey(tabKey(RELAY_TAB_KEY, store));
export const rememberTab = (id: number | null, store?: string) => setTabKey(tabKey(RELAY_TAB_KEY, store), id);

/** tabs.onRemoved: forget a closed tab (in every store); ARENA Ask's chatgpt.com tab takes its sign-out rule with it. */
export async function forgetTab(tabId: number): Promise<void> {
  const area = ext().storage.session;
  const all: Record<string, unknown> = area ? ((await area.get(null)) as Record<string, unknown>) : { ...mem };
  for (const [k, v] of Object.entries(all)) {
    if (!TAB_KEY_RE.test(k) || v !== tabId) continue;
    await setTabKey(k, null);
    if (k.startsWith(GPT_OWN_TAB_KEY)) await setGptTabRule(null);
  }
}

/** Is `tabId` ARENA Ask's own pinned tab of `provider` (in `store`)? */
export async function isOwnTab(provider: ProviderId, tabId: number, store: string | undefined): Promise<boolean> {
  if (!isDefaultStore(store) && provider === 'chatgpt') return false;
  return (await getTabKey(tabKey(ownKey(provider), store)).catch(() => null)) === tabId;
}

/**
 * Block chatgpt.com's sign-out in ARENA Ask's pinned chatgpt.com tab (null: that tab is gone).
 * Installing it throws when it fails (the tab must not load chatgpt.com without it); removing it
 * never does.
 */
async function setGptTabRule(tabId: number | null): Promise<void> {
  const dnr = dnrApi();
  if (tabId === null) {
    await dnr?.updateSessionRules({ removeRuleIds: [GPT_SIGNOUT_TAB_RULE_ID] }).catch(() => {});
    return;
  }
  if (!dnr) {
    if (FIREFOX_BUILD) return; // no session rules there: the MAIN world's swallowing only (docs/DESIGN.md)
    throw new Error('no declarativeNetRequest');
  }
  await dnr.updateSessionRules({ removeRuleIds: [GPT_SIGNOUT_TAB_RULE_ID], addRules: [gptSignoutRule(GPT_SIGNOUT_TAB_RULE_ID, tabId)] });
}

/** chatgpt.com as ARENA Ask's own page (the marker makes its MAIN-world script guard it; lib/gpt-page.ts). */
export const GPT_TAB_URL = `https://chatgpt.com/#${TAB_MARK}`;

/** Connect to the relay in a tab's top frame and wait for its hello. Null if there's no relay. */
function tryConnectTab(tabId: number, timeoutMs: number, name: string = PORT_RELAY): Promise<Port | null> {
  return new Promise((resolve) => {
    let port: Port;
    try {
      port = ext().tabs.connect(tabId, { name, frameId: 0 });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const settle = (p: Port | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      port.onMessage.removeListener(onMsg);
      port.onDisconnect.removeListener(onDis);
      resolve(p);
    };
    const onMsg = (m: unknown) => {
      const ev = validateStreamEvent(m, false);
      if (ev?.type === 'hello' && ev.v === PROTOCOL_VERSION) settle(port);
    };
    const onDis = () => {
      void ext().runtime.lastError; // "Receiving end does not exist": no relay in that tab
      settle(null);
    };
    const timer = setTimeout(() => {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      settle(null);
    }, timeoutMs);
    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(onDis);
  });
}

/** The pinned tab of `provider` ARENA Ask opened (in `store`): reused while it exists; never more than one. */
async function ownTab(provider: ProviderId, store: string | undefined): Promise<{ id: number; fresh: boolean }> {
  const site = providerById(provider);
  const key = tabKey(ownKey(provider), store);
  const known = await getTabKey(key).catch(() => null);
  if (known !== null) {
    const t = await ext()
      .tabs.get(known)
      .catch(() => null);
    const url = t ? (typeof t.url === 'string' && t.url ? t.url : typeof t.pendingUrl === 'string' ? t.pendingUrl : '') : '';
    // (ChatGPT's tab may still be at about:blank: opened, its rule not yet installed or its load not yet started.)
    if (t && (url.startsWith(`${site.origin}/`) || (provider === 'chatgpt' && url === 'about:blank')) && inStore(t, store)) {
      if (provider === 'chatgpt') {
        await setGptTabRule(known); // throws if it can't be installed: that tab isn't used
        if (url === 'about:blank') await ext().tabs.update(known, { url: GPT_TAB_URL });
      }
      return { id: known, fresh: false };
    }
    await setTabKey(key, null).catch(() => {}); // closed, or the user took it elsewhere
    if (provider === 'chatgpt') await setGptTabRule(null);
  }
  if (!isDefaultStore(store)) throw new Error(`no ${site.name} tab open in this container`);
  let fresh = false;
  let opening = openingTab.get(key);
  if (!opening) {
    fresh = true;
    opening = (async () => {
      log(`opening a pinned ${site.name} tab`);
      // ChatGPT: open it blank, install its sign-out rule (its tab id is known only now), and only
      // then load chatgpt.com in it, marked as ARENA Ask's page: no request of it goes out unruled.
      const gpt = provider === 'chatgpt';
      const tab = await ext().tabs.create({ url: gpt ? 'about:blank' : site.newTabUrl, pinned: true, active: false });
      if (typeof tab.id !== 'number') throw new Error('tab has no id');
      const drop = async (why: string) => {
        await ext()
          .tabs.remove(tab.id!)
          .catch(() => {});
        throw new Error(why);
      };
      // e.g. it opened in a private or incognito window: not the store the question came from
      if (!inStore(tab, store)) await drop(`the ${site.name} tab opened in another container`);
      if (gpt) {
        try {
          await setGptTabRule(tab.id);
        } catch (e) {
          await drop(`couldn't protect the ${site.name} tab (${String((e as Error)?.message || e).slice(0, 80)})`);
        }
      }
      await setTabKey(key, tab.id).catch(() => {});
      if (gpt) await ext().tabs.update(tab.id, { url: GPT_TAB_URL });
      return tab.id;
    })().finally(() => {
      openingTab.delete(key);
    });
    openingTab.set(key, opening);
  }
  return { id: await opening, fresh };
}

async function getTabPort(provider: ProviderId, store: string | undefined): Promise<RelayHandle> {
  const site = providerById(provider);
  const portName = provider === 'chatgpt' ? PORT_RELAY_GPT : PORT_RELAY;
  if (provider === 'claude') {
    const remembered = await getRememberedTab(store).catch(() => null);
    const own = await getTabKey(tabKey(OWN_TAB_KEY, store)).catch(() => null);
    const tabs = await ext().tabs.query({ url: site.tabMatch });
    const candidates = tabs
      .filter((t) => typeof t.id === 'number' && !t.discarded && inStore(t, store))
      .sort(
        (a, b) =>
          Number(b.id === remembered) - Number(a.id === remembered) ||
          Number(b.status === 'complete') - Number(a.status === 'complete') ||
          (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
      );
    for (const t of candidates.slice(0, 6)) {
      const port = await tryConnectTab(t.id!, RELAY_HELLO_TIMEOUT_MS);
      if (port) {
        if (t.id !== remembered) await rememberTab(t.id!, store).catch(() => {});
        return tabHandle(port, t.id === own ? 'newTab' : 'claudeTab');
      }
    }
  }

  const { id, fresh } = await ownTab(provider, store);
  const start = Date.now();
  const deadline = start + RELAY_OPEN_TIMEOUT_MS;
  let reloaded = fresh; // a fresh tab is loading anyway
  while (Date.now() < deadline) {
    await sleep(700);
    const t = await ext()
      .tabs.get(id)
      .catch(() => null);
    if (!t) {
      await setTabKey(tabKey(ownKey(provider), store), null).catch(() => {});
      if (provider === 'chatgpt') await setGptTabRule(null);
      throw new Error(`the ${site.name} tab was closed`);
    }
    const port = await tryConnectTab(id, RELAY_HELLO_TIMEOUT_MS, portName);
    if (port) {
      if (provider === 'claude') await rememberTab(id, store).catch(() => {});
      return tabHandle(port, 'newTab');
    }
    // Our existing tab loaded but its relay never answers (e.g. the extension was reloaded under
    // it): reload it once rather than opening another.
    if (!reloaded && t.status === 'complete' && Date.now() - start > 3_000) {
      reloaded = true;
      log(`reloading the pinned ${site.name} tab`);
      // ChatGPT's: loaded again as ARENA Ask's page (a plain reload may have lost its marker).
      await (provider === 'chatgpt' ? ext().tabs.update(id, { url: GPT_TAB_URL }) : ext().tabs.reload(id)).catch(() => {});
    }
  }
  throw new Error(`timed out waiting for the ${site.name} tab`);
}

// ---------------------------------------------------------------------------------------------

/**
 * The best available relay for `provider` (default claude.ai). Throws when no transport could be
 * reached. `store`: the ARENA tab's cookie store (`tabStore`): only tabs in it are used, ARENA Ask's
 * own pinned tab is opened only for the default one, and the offscreen frame only for Chrome's
 * normal profile.
 */
export async function acquireRelay(opts: { allowOffscreen: boolean; store?: string; provider?: ProviderId }): Promise<RelayHandle> {
  const store = opts.store;
  const provider = opts.provider ?? 'claude';
  if (opts.allowOffscreen && store === undefined && (await offscreenAllowed(provider).catch(() => false))) {
    try {
      const port = await getFramePort(provider);
      if (port) return frameHandle(port, provider);
      // Nobody else is on the frame and it never connected: pause it. (If others are using it,
      // this ask just goes to a tab and the frame is left alone.)
      if (!slotBusy(provider)) await offscreenCooldown('the frame never connected', COOLDOWN_MS.transient, provider);
    } catch (e) {
      await offscreenCooldown(`error: ${String((e as Error)?.message || e).slice(0, 120)}`, COOLDOWN_MS.transient, provider);
    }
    if (provider === 'claude') await closeOffscreen('fallback'); // only if nobody uses it; otherwise marked for a rebuild
    else if (!slotBusy(provider)) await dropFrame(provider, 'fallback');
  } else {
    await syncFrameRule().catch(() => {}); // not using the frame: make sure no rule outlives it
  }
  return getTabPort(provider, store);
}

/**
 * A claude.ai relay that is already up, for a quick `stop` after another relay died mid-answer: the
 * offscreen frame if its document exists and has answered before (unless `exclude`), else the relay
 * of an open claude.ai tab. Never creates the document or opens a tab. Null when none is ready.
 */
export async function acquireReadyRelay(exclude: Transport, store?: string): Promise<RelayHandle | null> {
  const slot = slots.claude;
  if (exclude !== 'offscreenFrame' && store === undefined && offscreenSupported()) {
    slot.claims++;
    try {
      const up = await serialized(async () => slot.ready && (await hasOffscreenDocument().catch(() => false)));
      const port = up ? await nextFramePort('claude', FRAME_WAKE_TIMEOUT_MS) : null;
      if (port) {
        slot.inFlight++;
        return frameHandle(port, 'claude');
      }
    } finally {
      slot.claims--;
    }
  }
  const own = await getTabKey(tabKey(OWN_TAB_KEY, store)).catch(() => null);
  const tabs = await ext()
    .tabs.query({ url: providerById('claude').tabMatch })
    .catch(() => []);
  for (const t of tabs.filter((x) => typeof x.id === 'number' && !x.discarded && x.status === 'complete' && inStore(x, store)).slice(0, 4)) {
    const port = await tryConnectTab(t.id!, RELAY_HELLO_TIMEOUT_MS);
    if (port) return tabHandle(port, t.id === own ? 'newTab' : 'claudeTab');
  }
  return null;
}
