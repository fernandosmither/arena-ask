import type { Browser } from 'wxt/browser';
import { ARENA_ORIGIN, isArenaCoursePage } from '@/lib/arena-selectors';
import { ext } from '@/lib/ext';
import { typedHash } from '@/lib/hash';
import type { BodyPatch } from '@/lib/gpt-guard';
import {
  ANSWER_DEADLINE_MS,
  ANSWER_MAX_CHARS,
  DEBUG_GPT_DRY_RUN,
  FORGET_STOP_WAIT_MS,
  FORGET_WAIT_MS,
  GPT_FULL_ONLY_DETAIL,
  GPT_MAX_HOPS,
  GPT_QUEUE_WAIT_MS,
  LIMITS,
  MODE_KEY,
  MSG_GPT_LOGGED_OUT,
  MSG_GPT_OWN_TAB,
  MSG_OFFSCREEN_IDLE,
  MSG_PROJECT_CREATED,
  PIN_FORGOTTEN_DETAIL,
  PIN_UNREADABLE_DETAIL,
  GPT_RELAY_BUSY_RETRIES,
  GPT_RELAY_BUSY_RETRY_MS,
  GPT_STOPPED_FOR_FORGET,
  PORT_ASK,
  PORT_RELAY_FRAME,
  PORT_RELAY_FRAME_GPT,
  RELAY_SILENCE_TIMEOUT_MS,
  RELAY_TOOL_TOTAL_TIMEOUT_MS,
  RELAY_TOTAL_TIMEOUT_MS,
  SETUP_LOCK_MAX_MS,
  TOOL_ANSWER_DEADLINE_MS,
  humanErrorFor,
  parseMode,
  relayClosedMessage,
  type AskRequest,
  type ConvState,
  type ErrorCode,
  type GptRelayAsk,
  type Mode,
  type ProjectRef,
  type RelayAsk,
  type RelayStop,
  type StreamEvent,
  type Transport,
} from '@/lib/protocol';
import { ProjectBook, SetupLock } from '@/lib/projects';
import { AccountPin, type PinRead } from '@/lib/pins';
import { AskQueue } from '@/lib/ask-queue';
import { BUILD_EXTENSION_ID } from '@/lib/build-id';
import type { ProviderId } from '@/lib/provider';
import { StateStore, idbBackend, memoryBackend, purgeLegacyState } from '@/lib/state-store';
import {
  COOLDOWN_MS,
  acceptFramePort,
  acquireReadyRelay,
  acquireRelay,
  cleanupStaleFrameRules,
  closeOffscreen,
  drainFramePool,
  dropFrame,
  forgetTab,
  isOwnTab,
  offscreenCooldown,
  reloadFrame,
  syncFrameRule,
  tabStore,
  type RelayHandle,
} from '@/lib/transports';
import {
  CHAPTER_KEY_RE,
  GPT_MODEL_RE,
  RateLimiter,
  validateAskRequest,
  validateProjectRef,
  validateStreamEvent,
} from '@/lib/validate';
import { validPatch } from '@/lib/gpt-guard';
import { OPTIONS_PAGE_PATH, routeSettingsMessage, type SettingsApi } from '@/lib/settings';

/**
 * Background (MV3 service worker / Firefox event page). Owns the per-chapter conversation state and
 * brokers each ARENA question to a relay running inside claude.ai (see lib/transports.ts):
 *
 *   ARENA bridge ──port "arena-ask"──▶ here ──▶ relay (offscreen frame | claude.ai tab)
 *
 * It never fetches claude.ai itself and never logs cookies, tokens, org ids or conversation ids.
 */

type Port = Browser.runtime.Port;
type Sender = Browser.runtime.MessageSender;

/** One line per step, objects inlined (chapter, transport, timings, codes; never ids or secrets). */
const log = (...a: unknown[]) => console.info('[arena-ask]', ...a.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : x)));

export default defineBackground(() => {
  // v1 kept conversation state in chrome.storage.local, which content scripts can write.
  purgeLegacyState(ext().storage.local as never)
    .then((n) => n && log('removed legacy conversation state', { entries: n }))
    .catch(() => {});

  ext().runtime.onConnect.addListener((port) => {
    if (port.name === PORT_ASK) {
      if (!isArenaSender(port.sender)) return port.disconnect();
      return handleAskPort(port);
    }
    if (port.name === PORT_RELAY_FRAME) {
      if (!isFrameRelaySender(port.sender)) return port.disconnect();
      return acceptFramePort(port);
    }
    if (port.name === PORT_RELAY_FRAME_GPT) {
      if (!isFrameRelaySender(port.sender, GPT_ORIGIN)) return port.disconnect();
      return acceptFramePort(port, 'chatgpt');
    }
  });

  if (BUILD_EXTENSION_ID && BUILD_EXTENSION_ID !== ext().runtime.id) {
    // chatgpt.com's MAIN world recognises our frame by the id compiled into it: with another id it
    // only wakes up once the isolated relay says so (the sign-out DNR rule still applies from the start).
    console.warn('[arena-ask] this build expects another extension id; see STORE_LISTING.md, "Chrome Web Store: the extension id"');
  }

  ext().runtime.onMessage.addListener((msg: unknown, sender: Sender, sendResponse: (r: unknown) => void) => {
    // The Options page's settings: accepted only from that page (lib/settings.ts), never from a content script.
    const settings = routeSettingsMessage(msg, sender, sendResponse, {
      extId: ext().runtime.id,
      optionsUrl: ext().runtime.getURL(OPTIONS_PAGE_PATH),
      api: settingsApi,
      log,
    });
    if (settings) return settings;
    const m = msg as { type?: unknown; chapterKey?: unknown; project?: unknown } | null;
    if (m?.type === MSG_GPT_OWN_TAB && isGptTabSender(sender)) {
      // A top-level chatgpt.com page asks whether it is ARENA Ask's pinned tab (only then is it driven).
      void isOwnTab('chatgpt', sender.tab!.id!, tabStore(sender.tab!))
        .catch(() => false)
        .then((own) => sendResponse({ own }));
      return true;
    }
    if (m?.type === MSG_GPT_LOGGED_OUT) {
      // chatgpt.com answered 401 in ARENA Ask's hidden frame while no question ran: take the frame down
      // (a logged-out page must not keep running there) and leave it alone for a while.
      if (isFrameRelaySender(sender, GPT_ORIGIN)) {
        log('chatgpt.com logged out in the hidden frame; frame removed');
        void dropFrame('chatgpt', 'logged out').then(() => offscreenCooldown('chatgpt.com logged out', COOLDOWN_MS.logged_out, 'chatgpt'));
      }
      return undefined;
    }
    if (m?.type === MSG_PROJECT_CREATED && isRelaySender(sender)) {
      // A relay created a project: known from now on (cleaned up later if it stays unused), even if
      // its question is cancelled before it reports `started`.
      const p = validateProjectRef(m.project);
      if (p) void book.record({ created: p }, null, false).catch(() => {});
      return undefined;
    }
    if (m?.type === 'reset' && isArenaSender(sender)) {
      if (typeof m.chapterKey !== 'string' || !CHAPTER_KEY_RE.test(m.chapterKey)) return undefined;
      // Forget the chapter's conversation (it stays on claude.ai): the next question starts a new one.
      // Its recorded questions go too: the ARENA history they vouched for is gone.
      db.deleteConv(m.chapterKey).catch(() => {});
      db.deleteTyped(m.chapterKey).catch(() => {});
      log('reset', m.chapterKey);
    } else if (m?.type === MSG_OFFSCREEN_IDLE && isOffscreenSender(sender)) {
      void closeOffscreen('idle', 0, false);
    }
    return undefined;
  });

  ext().tabs.onRemoved.addListener((tabId) => {
    forgetTab(tabId).catch(() => {});
  });

  // A framing rule left over from before a restart, with no offscreen frame behind it: remove it.
  cleanupStaleFrameRules().catch(() => {});

  // The owner's switches: the Options page (through routeSettingsMessage above) and, for the rest,
  // this service worker's console (content and page scripts can't reach its global scope or its
  // IndexedDB). See README "Settings".
  Object.assign(globalThis, {
    arenaAsk: Object.freeze({
      /** 'full' (the default) or 'locked'. */
      mode: () => readMode(),
      setMode: async (mode: unknown) => {
        if (mode !== 'full' && mode !== 'locked') throw new Error("arenaAsk.setMode: 'full' or 'locked'");
        await settingsApi.setMode(mode);
        return readMode();
      },
      /**
       * Forget the account a provider is pinned to (`'claude'`, the default, or `'chatgpt'`): its next
       * question pins its own.
       */
      forgetAccount: async (provider: unknown = 'claude') => {
        if (provider !== 'claude' && provider !== 'chatgpt') throw new Error("arenaAsk.forgetAccount: 'claude' or 'chatgpt'");
        await settingsApi.forgetAccount(provider);
        return 'forgotten';
      },
      /** My ChatGPT's model: a model slug to send instead of the page's choice, or null (the default: the page's). */
      setModel: async (provider: unknown, model: unknown) => {
        if (provider !== 'chatgpt') throw new Error("arenaAsk.setModel: only 'chatgpt' (Claude's model is fixed)");
        if (model !== null && (typeof model !== 'string' || !GPT_MODEL_RE.test(model))) throw new Error('arenaAsk.setModel: a model slug, or null');
        await db.saveGptModel(model as string | null);
        log('model set', { provider, model });
        return db.loadGptModel();
      },
      model: (provider: unknown = 'chatgpt') => (provider === 'chatgpt' ? db.loadGptModel() : Promise.resolve(null)),
      /**
       * My ChatGPT's request-body changes (the send guard applies them; docs/DESIGN.md "My ChatGPT: tools"):
       * `{is_do_not_remember?, disabled_tool_ids?, drop?: ['local_function_names'|'system_hints']}`, or
       * null for the default.
       */
      setGptPatch: async (patch: unknown) => {
        if (patch !== null && !validPatch(patch)) throw new Error('arenaAsk.setGptPatch: {is_do_not_remember?, disabled_tool_ids?, drop?} or null');
        await db.saveGptPatch(patch === null ? null : validPatch(patch));
        return gptPatch();
      },
      gptPatch: () => gptPatch(),
      /**
       * Whether My ChatGPT marks its chats "don't remember" (false, the default: normal chats, ChatGPT
       * sees your saved memories, and memory writes are only handed off; true: ChatGPT has no memory
       * tool there from the chat's second turn on and seems not to read saved memories either, and a
       * question in an existing chat is sent only once that is confirmed). The Options page's
       * "Don't let ARENA chats write to ChatGPT memory". See docs/DESIGN.md "My ChatGPT: tools".
       */
      setGptDoNotRemember: async (on: unknown) => {
        if (typeof on !== 'boolean') throw new Error('arenaAsk.setGptDoNotRemember: true or false');
        await settingsApi.setGptDoNotRemember(on);
        return db.loadGptDoNotRemember();
      },
      gptDoNotRemember: () => db.loadGptDoNotRemember(),
    }),
  });
});

/** Only the bridge in a top-level learn.arena.education frame may ask questions. */
function isArenaSender(s: Sender | undefined): boolean {
  if (!s || s.id !== ext().runtime.id) return false;
  if (!s.tab || typeof s.tab.id !== 'number' || s.frameId !== 0) return false;
  if (s.origin !== undefined && s.origin !== ARENA_ORIGIN) return false;
  return typeof s.url === 'string' && s.url.startsWith(`${ARENA_ORIGIN}/`) && isArenaCoursePage(s.url);
}

const GPT_ORIGIN = 'https://chatgpt.com';

/** The relay in a claude.ai (or chatgpt.com) frame hosted by our offscreen document (such frames have no tab). */
function isFrameRelaySender(s: Sender | undefined, origin = 'https://claude.ai'): boolean {
  if (!s || s.id !== ext().runtime.id || s.tab) return false;
  if (s.origin !== undefined && s.origin !== origin) return false;
  return typeof s.url === 'string' && s.url.startsWith(`${origin}/`);
}

/** Our ChatGPT relay in the top frame of a chatgpt.com tab. */
function isGptTabSender(s: Sender | undefined): boolean {
  if (!s || s.id !== ext().runtime.id || !s.tab || typeof s.tab.id !== 'number' || s.frameId !== 0) return false;
  if (s.origin !== undefined && s.origin !== GPT_ORIGIN) return false;
  return typeof s.url === 'string' && s.url.startsWith(`${GPT_ORIGIN}/`);
}

/** Our relay: the offscreen claude.ai frame, or the top frame of a claude.ai tab. */
function isRelaySender(s: Sender | undefined): boolean {
  if (isFrameRelaySender(s)) return true;
  if (!s || s.id !== ext().runtime.id || !s.tab || s.frameId !== 0) return false;
  if (s.origin !== undefined && s.origin !== 'https://claude.ai') return false;
  return typeof s.url === 'string' && s.url.startsWith('https://claude.ai/');
}

function isOffscreenSender(s: Sender | undefined): boolean {
  return !!s && s.id === ext().runtime.id && !s.tab && s.url === ext().runtime.getURL('/offscreen.html');
}

// ---------------------------------------------------------------------------------------------
// One ARENA question

const limiter = new RateLimiter(LIMITS.perMinute, 60_000);
const busyTabs = new Set<number>();
const chapterLocks = new Map<string, Promise<unknown>>();

/** Serialize questions per chapter so two turns never race on the same conversation. */
function withChapterLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chapterLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  chapterLocks.set(key, tail);
  void tail.then(() => {
    if (chapterLocks.get(key) === tail) chapterLocks.delete(key);
  });
  return run;
}

/** The latest turn (assistant uuid) started in each conversation, newest last (bounded). */
const latestTurn = new Map<string, string>();
function noteTurn(convUuid: string, turn: string): void {
  latestTurn.delete(convUuid);
  latestTurn.set(convUuid, turn);
  while (latestTurn.size > 200) latestTurn.delete(latestTurn.keys().next().value!);
}

/** A turn whose relay died mid-answer, to be stopped through another relay. */
interface PendingStop {
  convUuid: string;
  orgTag: string;
  turn: string;
  dead: Transport;
  /** The ARENA tab's cookie store (`tabStore`). */
  store: string | undefined;
}

/** How long a stop through another relay may hold its chapter's lock. */
const STOP_ELSEWHERE_MS = 25_000;

/** Errors from the offscreen frame, before any text, that a visible claude.ai tab may not have. */
const FRAME_RETRY_CODES: ReadonlySet<ErrorCode> = new Set(['cloudflare', 'logged_out', 'relay_closed']);
/**
 * The same for chatgpt.com's frame. Not logged_out: the frame reports it on a 401 from chatgpt.com's
 * API (the account really is signed out, or the session expired), and the answer is to sign in.
 */
const GPT_FRAME_RETRY_CODES: ReadonlySet<ErrorCode> = new Set(['cloudflare', 'relay_closed']);

/**
 * How one attempt ended: done; the frame failed before any text in a way worth retrying; or (My
 * ChatGPT) the relay moved its page to the question's chat and wants the question again.
 */
type Outcome = { end: true } | { end: false; code: ErrorCode } | { end: false; navigate: true };
const END: Outcome = { end: true };

/**
 * My ChatGPT's request-body changes when the owner has set none (see docs/DESIGN.md "My ChatGPT: tools"):
 * the page's `local_function_names` (functions chatgpt.com would run in this browser, e.g.
 * `local.continue_in_work`) are left out, so ChatGPT isn't offered them from the hidden page. The
 * body's `disabled_tool_ids` / `is_do_not_remember` are ignored by chatgpt.com (tested live).
 */
const DEFAULT_GPT_PATCH: BodyPatch = { drop: ['local_function_names'] };
async function gptPatch(): Promise<BodyPatch> {
  return (await db.loadGptPatch().catch(() => null)) ?? DEFAULT_GPT_PATCH;
}

/**
 * My ChatGPT drives one chatgpt.com page (the frame, or the pinned tab): one ChatGPT question at a
 * time, across chapters (lib/ask-queue.ts). A question waits at most GPT_QUEUE_WAIT_MS for its turn.
 */
const gptQueue = new AskQueue();

/** Shown under ARENA's bubble while a ChatGPT question waits for another one (never part of the answer). */
const GPT_QUEUED_STATUS = 'Waiting for your other ChatGPT question to finish…';

function handleAskPort(port: Port) {
  const tabId = port.sender!.tab!.id!;
  // The ARENA tab's cookie store (Firefox container / private window, Chrome incognito): its
  // questions go only through claude.ai in that same store.
  const store = tabStore(port.sender!.tab!);
  let started = false;
  let finished = false;
  let ownsTab = false;
  let relay: Port | null = null;
  /** Resolves the running attempt; needed when WE disconnect the relay (no onDisconnect then). */
  let endAttempt: (() => void) | null = null;
  /** Ends the running attempt if its relay is still setting up (the setup lock expired). */
  let abortSetup: (() => void) | null = null;
  /** The attempt's relay died after its question went out: stop that turn elsewhere, still under the chapter lock. */
  let pendingStop: PendingStop | null = null;

  const send = (ev: StreamEvent) => {
    try {
      port.postMessage(ev);
    } catch {
      /* the ARENA tab went away */
    }
  };
  const disconnectRelay = () => {
    try {
      relay?.disconnect(); // the relay aborts its fetch and stops generation
    } catch {
      /* already gone */
    }
  };
  const release = () => {
    if (ownsTab) busyTabs.delete(tabId);
    ownsTab = false;
  };
  const finish = (ev: StreamEvent) => {
    if (finished) return;
    finished = true;
    send(ev);
    release();
    disconnectRelay();
  };
  /** The provider of the question on this port (known once it arrives). */
  let provider: ProviderId = 'claude';
  const fail = (code: ErrorCode, detail?: string) => finish({ type: 'error', code, message: humanErrorFor(provider, code, detail) });

  port.onDisconnect.addListener(() => {
    void ext().runtime.lastError;
    finished = true; // the ARENA tab closed, navigated or cancelled: stop the relay
    release();
    disconnectRelay();
    endAttempt?.();
  });

  port.onMessage.addListener((raw: unknown) => {
    if ((raw as { type?: unknown } | null)?.type === 'ping') return; // keep-alive: receiving it is the point
    if (started) return;
    started = true;
    const req = validateAskRequest(raw);
    if (!req) return fail('invalid', '(malformed request)');
    provider = req.provider;
    if (busyTabs.has(tabId)) return fail('busy');
    if (!limiter.allow()) return fail('too_many');
    busyTabs.add(tabId);
    ownsTab = true;
    log('ask', { chapter: req.chapterKey, provider: req.provider, promptChars: req.prompt.length, contextChars: req.context.length, prior: req.priorCount });
    withChapterLock(req.chapterKey, () => (req.provider === 'chatgpt' ? runGpt(req) : run(req))).catch((e) => {
      log('internal error', String((e as Error)?.message || e).slice(0, 200));
      fail('internal');
    });
  });

  async function run(req: AskRequest): Promise<void> {
    let allowOffscreen = true;
    let frameReloaded = false;
    const mode = await readMode();
    log('mode', { chapter: req.chapterKey, mode });
    // This question came through the bridge's trusted-Send gate: record it, and find the earlier ARENA
    // messages that are questions recorded the same way (the rest of ARENA's history is page data).
    const typed = await recordAndMatchTyped(req).catch(() => [] as number[]);
    if (finished) return;
    /** The pin's generation at this question's first attempt: a retry after a forget doesn't go ahead. */
    let pinGen: number | null = null;
    for (let attempt = 0; attempt < 3 && !finished; attempt++) {
      const state = await loadState(req.chapterKey);
      if (finished) return;
      let handle: RelayHandle;
      try {
        handle = await acquireRelay({ allowOffscreen, ...(store !== undefined ? { store } : {}) });
      } catch (e) {
        log('no relay:', String((e as Error)?.message || e));
        return fail('no_relay');
      }
      if (finished) {
        handle.release();
        return handle.port.disconnect();
      }
      log('transport:', handle.via);
      // One relay setup at a time (until it reports 'started'): concurrent first questions then
      // share the project the first one creates, which is stored before the next one reads it. A
      // setup still running when the lock expires is stopped (its relay disconnected, which aborts
      // it) before the next one starts.
      let expired = false;
      const releaseSetup = await setupLock.acquire(SETUP_LOCK_MAX_MS, () => {
        expired = true;
        abortSetup?.();
      });
      let outcome: Outcome;
      try {
        if (finished) return handle.port.disconnect();
        // Full mode runs in the org it was first used in (the relay checks it is a personal one).
        // Read under the setup lock: a first question before this one has stored its pin (awaited)
        // by now. Unreadable: refused, never run unpinned.
        let pin: PinRead | null = null;
        if (mode === 'full') {
          try {
            pin = await claudePin.read();
          } catch {
            handle.port.disconnect();
            return fail('wrong_account', PIN_UNREADABLE_DETAIL);
          }
          pinGen ??= pin.gen;
          if (pin.gen !== pinGen) {
            handle.port.disconnect();
            return fail('wrong_account', PIN_FORGOTTEN_DETAIL);
          }
        }
        const { project, cleanup } = await book.forRelay().catch(() => ({ project: null, cleanup: [] }));
        if (finished) return handle.port.disconnect(); // cancelled meanwhile: nothing goes out
        if (expired) {
          handle.port.disconnect();
          return fail('timeout');
        }
        outcome = await runOnRelay(handle, req, mode, pin, typed, state, project, cleanup, releaseSetup);
      } finally {
        releaseSetup();
        handle.release();
      }
      if (pendingStop) {
        // Awaited here, inside the chapter's lock: the next question for this chapter (the retry)
        // can't start a turn in the same conversation before this stop has been sent or given up.
        const p = pendingStop;
        pendingStop = null;
        await stopElsewhere(p);
      }
      if (outcome.end || 'navigate' in outcome) return; // (claude.ai relays never navigate)
      // The frame failed before any text. A Cloudflare challenge that didn't clear within the
      // relay's wait: reload the frame once (if nobody else is on it) and try it again. Otherwise,
      // or if that fails too: pause the frame and ask once more through a claude.ai tab.
      if (outcome.code === 'cloudflare' && !frameReloaded && (await reloadFrame())) {
        frameReloaded = true;
        continue;
      }
      await offscreenCooldown(
        `frame reported ${outcome.code}`,
        outcome.code === 'logged_out' ? COOLDOWN_MS.logged_out : COOLDOWN_MS.transient,
      );
      allowOffscreen = false;
    }
  }

  /**
   * My ChatGPT (full mode only): one ChatGPT question at a time (it drives one chatgpt.com page),
   * through the hidden chatgpt.com frame, else ARENA Ask's pinned chatgpt.com tab. The relay may move
   * its page to the question's chat first (`navigating`): the same question then goes to the page
   * once it has loaded (at most GPT_MAX_HOPS times; not counted as a retry).
   */
  async function runGpt(req: AskRequest): Promise<void> {
    const mode = await readMode();
    log('mode', { chapter: req.chapterKey, mode, provider: 'chatgpt' });
    if (mode !== 'full') return fail('invalid', GPT_FULL_ONLY_DETAIL);
    const typed = await recordAndMatchTyped(req).catch(() => [] as number[]);
    if (finished) return;
    // One ChatGPT question at a time: say so while this one waits (a status line, never saved).
    if (gptQueue.busy) send({ type: 'status', text: GPT_QUEUED_STATUS });
    const leave = await gptQueue.acquire(GPT_QUEUE_WAIT_MS);
    if (!leave) return fail('busy');
    // Forgetting the pinned account stops this question rather than run alongside it (lib/ask-queue.ts).
    gptQueue.onStop(leave, () => {
      log('ChatGPT question stopped: the pinned account is being forgotten', { chapter: req.chapterKey });
      finish({ type: 'error', code: 'invalid', message: GPT_STOPPED_FOR_FORGET });
      endAttempt?.();
    });
    try {
      if (finished) return;
      // Read under the queue: the question before this one has written its pin (awaited) by now.
      // Unreadable: refused, never run unpinned.
      let pin: PinRead;
      try {
        pin = await gptPin.read();
      } catch {
        return fail('wrong_account', PIN_UNREADABLE_DETAIL);
      }
      const pinnedTag = pin.value;
      const model = await db.loadGptModel().catch(() => null);
      const patch = await gptPatch();
      // "Don't remember" is the owner's opt-in; unreadable → on (the stricter setting).
      const doNotRemember = await db.loadGptDoNotRemember().catch(() => true);
      const dryRun = ((await ext().storage.local.get(DEBUG_GPT_DRY_RUN).catch(() => ({}))) as Record<string, unknown>)[DEBUG_GPT_DRY_RUN] === true;
      let allowOffscreen = true;
      let frameReloaded = false;
      let hops = 0;
      let busyWaits = 0;
      for (let attempt = 0; attempt < 3 && !finished; ) {
        const state = await db.loadConv(req.chapterKey, 'chatgpt');
        if (finished) return;
        let handle: RelayHandle;
        try {
          handle = await acquireRelay({ provider: 'chatgpt', allowOffscreen, ...(store !== undefined ? { store } : {}) });
        } catch (e) {
          log('no relay:', String((e as Error)?.message || e));
          return fail('no_relay');
        }
        if (finished) {
          handle.release();
          return handle.port.disconnect();
        }
        log('transport:', handle.via, { provider: 'chatgpt', hops });
        let outcome: Outcome;
        try {
          outcome = await runOnRelay(handle, req, mode, null, typed, state, null, [], () => {}, { pinnedTag, pinGen: pin.gen, model, patch, hops, dryRun, doNotRemember });
        } finally {
          handle.release();
        }
        if (outcome.end) return;
        if ('navigate' in outcome) {
          if (++hops > GPT_MAX_HOPS) return fail('internal', "(chatgpt.com didn't open the chat)");
          if (handle.via === 'offscreenFrame') drainFramePool('chatgpt'); // the old page's ports
          continue;
        }
        if (outcome.code === 'busy') {
          // The page is still finishing a question that was stopped (nothing of this one was sent):
          // wait for it, on the same transport.
          if (++busyWaits > GPT_RELAY_BUSY_RETRIES) return fail('busy');
          await new Promise((r) => setTimeout(r, GPT_RELAY_BUSY_RETRY_MS));
          continue;
        }
        attempt++;
        if (outcome.code === 'cloudflare' && !frameReloaded && (await reloadFrame('chatgpt'))) {
          frameReloaded = true;
          continue;
        }
        await offscreenCooldown(`frame reported ${outcome.code}`, COOLDOWN_MS.transient, 'chatgpt');
        allowOffscreen = false;
      }
    } finally {
      leave();
    }
  }

  /** Stream one attempt; a frame failure before any text may be retried (see FRAME_RETRY_CODES). */
  async function runOnRelay(
    handle: RelayHandle,
    req: AskRequest,
    mode: Mode,
    /** Full-mode Claude: the pin as read under the setup lock (null otherwise). */
    claudePinRead: PinRead | null,
    typed: number[],
    state: ConvState | null,
    project: ProjectRef | null,
    cleanup: ProjectRef[],
    releaseSetup: () => void,
    gpt?: { pinnedTag: string | null; pinGen: number; model: string | null; patch: BodyPatch; hops: number; dryRun: boolean; doNotRemember: boolean },
  ): Promise<Outcome> {
    const pinnedOrg = claudePinRead?.value ?? null;
    const r = handle.port;
    relay = r;
    const isFrame = handle.via === 'offscreenFrame';
    const provider: ProviderId = gpt ? 'chatgpt' : 'claude';
    const say = (code: ErrorCode, detail?: string) => humanErrorFor(provider, code, detail);
    const t0 = Date.now();
    let firstMs: number | null = null;
    let convUuid: string | null = null;
    /** The turn this attempt started (assistant uuid) and its account's org tag, from `started`. */
    let turn: string | null = null;
    let orgTag: string | null = null;
    let settled = false;
    let chars = 0;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    /** Writes this attempt started (the account pin, a new chat's state): awaited before it ends. */
    const pending: Promise<unknown>[] = [];
    const retryable = (code: ErrorCode) => isFrame && firstMs === null && (gpt ? GPT_FRAME_RETRY_CODES : FRAME_RETRY_CODES).has(code) && !finished;
    try {
      return await new Promise<Outcome>((resolve) => {
        endAttempt = () => {
          if (settled) return;
          settled = true;
          resolve(END);
        };
        abortSetup = () => {
          if (settled || convUuid !== null) return; // it reported 'started': not setting up anymore
          settled = true;
          log('relay setup took too long; stopped', { chapter: req.chapterKey, via: handle.via });
          finish({ type: 'error', code: 'timeout', message: say('timeout') }); // disconnects the relay
          resolve(END);
        };
        const alive = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            if (settled) return;
            settled = true;
            log('relay silent; giving up', { chapter: req.chapterKey, via: handle.via });
            finish({ type: 'error', code: 'timeout', message: say('timeout'), ...(convUuid ? { convUuid } : {}) });
            resolve(END);
          }, RELAY_SILENCE_TIMEOUT_MS);
        };
        alive();
        // Backstops the relay's own limits (it stops claude.ai itself): however lively the relay,
        // an attempt ends after the answer deadline plus setup time. Disconnecting stops the relay.
        const tooLong = (detail: string, why: string) => {
          if (settled) return;
          settled = true;
          log(why, { chapter: req.chapterKey, via: handle.via });
          finish({ type: 'error', code: 'too_long', message: say('too_long', detail), ...(convUuid ? { convUuid } : {}) });
          resolve(END);
        };
        hardStop = setTimeout(
          () => tooLong(`took over ${Math.round(ANSWER_DEADLINE_MS / 60_000)} minutes`, 'answer over the time limit; stopped'),
          RELAY_TOTAL_TIMEOUT_MS,
        );
        /** A tool is running (full mode): the relay's deadline is the longer one now, so is this backstop. */
        let toolTime = false;
        const allowToolTime = () => {
          if (toolTime) return;
          toolTime = true;
          clearTimeout(hardStop);
          hardStop = setTimeout(
            () => tooLong(`took over ${Math.round(TOOL_ANSWER_DEADLINE_MS / 60_000)} minutes`, 'answer (with tools) over the time limit; stopped'),
            Math.max(0, t0 + RELAY_TOOL_TOTAL_TIMEOUT_MS - Date.now()),
          );
        };
        r.onDisconnect.addListener(() => {
          void ext().runtime.lastError;
          if (settled) return;
          settled = true;
          console.warn('[arena-ask] relay closed mid-answer', {
            chapter: req.chapterKey,
            via: handle.via,
            hadText: firstMs !== null,
            conversationStarted: convUuid !== null,
            afterMs: Date.now() - t0,
          });
          if (isFrame) void syncFrameRule().catch(() => {}); // the offscreen document may be gone
          // Nothing reached claude.ai yet: the same question can go through a tab instead.
          if (retryable('relay_closed') && convUuid === null) {
            relay = null;
            return resolve({ end: false, code: 'relay_closed' });
          }
          // The question went out and its relay died with it: claude.ai would keep generating.
          if (convUuid !== null && turn && orgTag) pendingStop = { convUuid, orgTag, turn, dead: handle.via, store };
          finish({ type: 'error', code: 'relay_closed', message: relayClosedMessage(handle.via, provider), ...(convUuid ? { convUuid } : {}) });
          resolve(END);
        });
        r.onMessage.addListener((raw: unknown) => {
          const ev = validateStreamEvent(raw, true);
          if (!ev || settled) return;
          alive();
          if (ev.type === 'hello' || ev.type === 'progress' || ev.type === 'stopped') return;
          if (ev.type === 'navigating') {
            // My ChatGPT: the relay is loading the question's chat; its port closes now.
            if (!gpt) return;
            settled = true;
            relay = null;
            return resolve({ end: false, navigate: true });
          }
          if (ev.type === 'status') {
            allowToolTime();
            if (!finished) send(ev); // shown under ARENA's bubble, never part of the answer
            return;
          }
          if (ev.type === 'started') {
            convUuid = ev.convUuid;
            if (gpt) {
              // My ChatGPT's first use: pin the (personal) account the relay checked (awaited before this
              // attempt ends, so the next question, which reads the pin under the same queue, sees it).
              // Never forwarded.
              if (ev.pin && !gpt.pinnedTag && ev.orgTag) {
                pending.push(
                  gptPin.pin(ev.orgTag, gpt.pinGen).then((r) => {
                    // not stored: held for this worker's life (cleared by forgetAccount)
                    if (r === 'memory') log('pinning the ChatGPT account failed; held in memory');
                  }),
                );
              }
              // A new chat: remembered as soon as it exists (the next question continues it, even if this one is interrupted).
              if (ev.state) pending.push(db.saveConv(req.chapterKey, ev.state, 'chatgpt').catch(() => {}));
              return;
            }
            turn = ev.turn ?? null;
            orgTag = ev.orgTag ?? ev.project?.orgTag ?? null;
            if (turn) noteTurn(convUuid, turn);
            // Full mode's first use: pin the (personal) org the relay chose (dropped if the account was
            // forgotten since this question read the pin). Awaited before the setup lock is released
            // (the next question reads the pin under it) and before this attempt ends. Never logged or
            // forwarded.
            const pinned =
              mode === 'full' && claudePinRead && !claudePinRead.value && ev.org
                ? claudePin.pin(ev.org, claudePinRead.gen).then((r) => {
                    if (r === 'memory') log('pinning the Claude account failed; held in memory');
                  })
                : Promise.resolve();
            pending.push(pinned);
            // Store the project before the next relay's setup may start.
            void pinned
              .then(() => book.record(ev, project, true))
              .catch(() => {})
              .finally(releaseSetup);
            return;
          }
          if (ev.type === 'delta') {
            if (firstMs === null) firstMs = Date.now() - t0;
            chars += ev.text.length;
            if (chars > ANSWER_MAX_CHARS) {
              return tooLong(`passed ${ANSWER_MAX_CHARS.toLocaleString('en-US')} characters`, 'answer over the size limit; stopped');
            }
            if (!finished) send(ev);
            return;
          }
          settled = true;
          void (async () => {
            let outcome: Outcome = END;
            try {
              await Promise.all(pending.splice(0)); // the started state first: the final state overwrites it
              if (ev.state) await db.saveConv(req.chapterKey, ev.state, provider).catch(() => {});
              const inUse = ev.type === 'done' || !!ev.convUuid;
              if (!gpt) await book.record(ev, project, inUse).catch(() => {});
              if (ev.type === 'done') {
                log('done', {
                  chapter: req.chapterKey,
                  provider,
                  via: handle.via,
                  firstTextMs: firstMs,
                  totalMs: Date.now() - t0,
                  ...(ev.handoff ? { handoff: ev.handoff } : {}),
                  ...(ev.diag ? { diag: ev.diag } : {}),
                });
                finish({ type: 'done', convUuid: ev.convUuid, util5h: ev.util5h, util7d: ev.util7d, via: handle.via, ...(ev.model ? { model: ev.model } : {}) });
              } else if (ev.type === 'error') {
                log('error', { chapter: req.chapterKey, provider, via: handle.via, code: ev.code, afterMs: Date.now() - t0, ...(ev.diag ? { diag: ev.diag } : {}) });
                if (gpt && ev.code === 'logged_out' && isFrame) {
                  // chatgpt.com signed out in the hidden frame (its sign-out itself is blocked): take the
                  // frame down and leave it alone for a while.
                  void dropFrame('chatgpt', 'logged out').then(() => offscreenCooldown('chatgpt.com logged out', COOLDOWN_MS.logged_out, 'chatgpt'));
                }
                if (retryable(ev.code) || (gpt && ev.code === 'busy' && convUuid === null && firstMs === null && !finished)) {
                  // (My ChatGPT: `busy` before anything was sent is the page still finishing a stopped question: runGpt waits for it.)
                  outcome = { end: false, code: ev.code };
                  relay = null;
                  try {
                    r.disconnect();
                  } catch {
                    /* already gone */
                  }
                } else {
                  finish({ type: 'error', code: ev.code, message: ev.message, ...(ev.convUuid ? { convUuid: ev.convUuid } : {}) });
                }
              }
            } catch (e) {
              log('internal error', String((e as Error)?.message || e).slice(0, 200));
              fail('internal');
              outcome = END;
            } finally {
              resolve(outcome);
            }
          })();
        });
        const base = {
          chapterKey: req.chapterKey,
          chapterTitle: req.chapterTitle,
          prompt: req.prompt,
          context: req.context,
          history: req.history,
          priorCount: req.priorCount,
          anchor: req.anchor,
          typed,
          state,
        };
        const msg: RelayAsk | GptRelayAsk = gpt
          ? { type: 'ask', provider: 'chatgpt', mode: 'full', ...base, pinnedTag: gpt.pinnedTag, model: gpt.model, patch: gpt.patch, hops: gpt.hops, doNotRemember: gpt.doNotRemember, ...(gpt.dryRun ? { dryRun: true } : {}) }
          : { type: 'ask', mode, ...base, pinnedOrg, project, cleanup };
        try {
          r.postMessage(msg);
        } catch {
          /* disconnected already: onDisconnect reports it */
        }
      });
    } finally {
      clearTimeout(watchdog);
      clearTimeout(hardStop);
      endAttempt = null;
      abortSetup = null;
      await Promise.all(pending.splice(0)); // however the attempt ended (the queue is released after this)
    }
  }
}

/**
 * A relay died mid-answer (its claude.ai tab closed, the offscreen frame went away): ask another
 * relay that is already up to stop generation there, in the account the turn was started in, and
 * only while that turn is still the conversation's latest. Never opens a tab or the offscreen
 * document just for this; if none is up, claude.ai finishes the answer on its own. Bounded by
 * STOP_ELSEWHERE_MS (the caller holds the chapter's lock).
 */
async function stopElsewhere(p: PendingStop): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>((r) => (timer = setTimeout(() => r('expired'), STOP_ELSEWHERE_MS)));
  try {
    if ((await Promise.race([stopThroughReadyRelay(p), expired])) === 'expired') log('gave up stopping the answer through another claude.ai page', { deadVia: p.dead });
  } finally {
    clearTimeout(timer);
  }
}

async function stopThroughReadyRelay({ convUuid, orgTag, turn, dead, store }: PendingStop): Promise<void> {
  const current = () => latestTurn.get(convUuid) === turn;
  if (!current()) return log('not stopping an answer: a newer turn has started in its conversation', { via: dead });
  const h = await acquireReadyRelay(dead, store).catch(() => null);
  if (!h) return log('answer left running on claude.ai: no other claude.ai page is open to stop it', { via: dead });
  try {
    if (!current()) return log('not stopping an answer: a newer turn has started in its conversation', { via: dead });
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 12_000);
      h.port.onMessage.addListener((m: unknown) => {
        const ev = validateStreamEvent(m, true);
        if (ev?.type !== 'stopped') return;
        clearTimeout(timer);
        resolve(ev.ok);
      });
      h.port.onDisconnect.addListener(() => {
        void ext().runtime.lastError;
        clearTimeout(timer);
        resolve(false);
      });
      const msg: RelayStop = { type: 'stop', convUuid, orgTag };
      h.port.postMessage(msg);
    });
    log('stopped the answer through another claude.ai page', { deadVia: dead, via: h.via, ok });
  } catch {
    /* the port went away */
  } finally {
    try {
      h.port.disconnect();
    } catch {
      /* already gone */
    }
    h.release();
  }
}

/**
 * Record the question of an accepted ask (only the bridge's trusted-Send gate lets one through; see
 * isArenaSender) and return the indexes of ARENA history entries that are user messages matching a
 * question recorded for this chapter. Kept in the background's own IndexedDB, which page and content
 * scripts can't reach.
 */
async function recordAndMatchTyped(req: AskRequest): Promise<number[]> {
  await db.addTyped(req.chapterKey, await typedHash(req.prompt));
  if (!req.history?.length) return [];
  const known = await db.loadTyped(req.chapterKey);
  const out: number[] = [];
  for (const [k, m] of req.history.entries()) if (m.role === 'user' && known.has(await typedHash(m.content))) out.push(k);
  return out;
}

/**
 * The conversation mode (the background's IndexedDB; see MODE_KEY). Read per question. Absent: full;
 * unreadable or unexpected: locked (fail closed).
 */
async function readMode(): Promise<Mode> {
  try {
    await migrateLegacyMode();
    return await db.loadMode();
  } catch {
    return 'locked';
  }
}

/**
 * Versions before this kept the mode in chrome.storage.local (`arenaAsk.mode`), which content scripts
 * can write. A value found there can only make things stricter: 'locked' or anything unrecognised
 * becomes locked (unless a mode is already stored); 'full' changes nothing. Then it is removed.
 */
async function migrateLegacyMode(): Promise<void> {
  const got = (await ext().storage.local.get(MODE_KEY)) as Record<string, unknown>;
  if (!(MODE_KEY in got)) return;
  if (parseMode(got[MODE_KEY]) === 'locked' && !(await db.hasMode())) await db.saveMode('locked');
  await ext().storage.local.remove(MODE_KEY);
  log('moved the mode out of chrome.storage.local', { mode: await db.loadMode() });
}

// ---------------------------------------------------------------------------------------------
// Conversation state + the extension's project: the background's own IndexedDB (lib/state-store.ts)

const db = new StateStore(typeof indexedDB === 'undefined' ? memoryBackend() : idbBackend());
const loadState = (chapterKey: string) => db.loadConv(chapterKey);
/** Full-mode Claude's pinned org, and My ChatGPT's pinned account tag (lib/pins.ts). */
const claudePin = new AccountPin({ load: () => db.loadPinnedOrg(), pinOnce: (v) => db.pinOrgOnce(v), forget: () => db.forgetPinnedOrg() });
const gptPin = new AccountPin({ load: () => db.loadPinnedGpt(), pinOnce: (v) => db.pinGptOnce(v), forget: () => db.forgetPinnedGpt() });
const book = new ProjectBook(db);
const setupLock = new SetupLock();

/**
 * The owner's settings, shared by the Options page (lib/settings.ts routes its messages here) and
 * the `arenaAsk.*` console helpers. Pinned accounts are reported as booleans only.
 */
const settingsApi: SettingsApi = {
  mode: () => readMode(),
  setMode: async (mode) => {
    await db.saveMode(mode);
    log('mode set', { mode });
  },
  gptDoNotRemember: () => db.loadGptDoNotRemember(),
  setGptDoNotRemember: async (on) => {
    await db.saveGptDoNotRemember(on);
    log('ChatGPT "don\'t remember" set', { on });
  },
  pinned: (provider) => (provider === 'chatgpt' ? gptPin : claudePin).pinned(),
  forgetAccount: async (provider) => {
    if (provider === 'chatgpt') {
      // Never alongside a ChatGPT question (it may be pinning right now): wait for the running one,
      // ahead of queued ones; if it runs on, stop it first. If it still holds the page, nothing is
      // forgotten.
      const leave = await gptQueue.acquireStopping(FORGET_WAIT_MS, FORGET_STOP_WAIT_MS);
      if (!leave) throw new Error('a ChatGPT question is still running; try again in a moment');
      try {
        await gptPin.forget();
      } finally {
        leave();
      }
    } else {
      // A Claude question that read the pin before this can't pin afterwards (lib/pins.ts).
      await claudePin.forget();
    }
    log('pinned account forgotten', { provider });
  },
};
