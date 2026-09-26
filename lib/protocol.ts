import type { BodyPatch } from './gpt-guard';
import type { ProviderId } from './provider';

/**
 * Message shapes and limits shared by the four contexts:
 *
 *   ARENA page, MAIN world (arena-page)  ──window.postMessage──▶  ARENA page, isolated (arena bridge)
 *   arena bridge  ──runtime port "ask"──▶  background  ──tabs port "relay"──▶  claude.ai tab (relay)
 *
 * Nothing here is secret. The MAIN world only ever sees answer text and short error strings.
 */

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Max question length (chars) accepted from the page. */
  promptChars: 20_000,
  /** Max ARENA context length (chars) accepted from the page. */
  contextChars: 1_500_000,
  /** Prior ARENA chat messages forwarded (most recent kept). */
  historyMessages: 200,
  /** Total chars of prior ARENA chat forwarded (most recent kept). */
  historyChars: 200_000,
  /** Per-message cap inside the forwarded history. */
  messageChars: 50_000,
  /** Asks per minute (per ARENA tab in the bridge, and globally in the background). */
  perMinute: 20,
  /** A single streamed delta. */
  deltaChars: 200_000,
} as const;

/**
 * At most this many skipped ARENA messages (tool-blocked or handed-off questions, and the notes
 * saved as their answers) are remembered per chapter (ConvState.skip); more, and the next question
 * starts a new conversation (ConvState.renew).
 */
export const MAX_SKIP = 32;

/** Keep-alive ping interval while a stream is open (MV3 service workers idle out at ~30 s). */
export const KEEPALIVE_MS = 20_000;

/** How long the MAIN world waits for the bridge to acknowledge an ask. */
export const ACK_TIMEOUT_MS = 4_000;

/** How long the background waits for a claude.ai relay tab to say hello. */
export const RELAY_HELLO_TIMEOUT_MS = 1_500;
/** Fail a question after this long without any sign of life from the relay (SSE keep-alives don't count). */
export const RELAY_SILENCE_TIMEOUT_MS = 180_000;
/** The relay stops Claude's answer (stop_response) after this long… */
export const ANSWER_DEADLINE_MS = 5 * 60_000;
/** …or, once a tool has run in it (full mode), after this long (from the same start)… */
export const TOOL_ANSWER_DEADLINE_MS = 10 * 60_000;
/** …or once its text passes this many characters. */
export const ANSWER_MAX_CHARS = 200_000;
/** Setup time the background allows on top of the answer deadline. */
export const RELAY_SETUP_ALLOWANCE_MS = 90_000;
/** The background's own backstop per relay attempt: the answer deadline plus time for setup. */
export const RELAY_TOTAL_TIMEOUT_MS = ANSWER_DEADLINE_MS + RELAY_SETUP_ALLOWANCE_MS;
/** …raised to this once the relay reports a tool running. */
export const RELAY_TOOL_TOTAL_TIMEOUT_MS = TOOL_ANSWER_DEADLINE_MS + RELAY_SETUP_ALLOWANCE_MS;
/**
 * Full mode: a tool call that makes no progress of its own for this long (keep-alive pings and other
 * blocks' events don't count) is taken to be waiting for a claude.ai approval prompt nobody can see,
 * and is handed off.
 */
export const TOOL_STALL_MS = 45_000;
/** The relay reports stream activity (e.g. while Claude is thinking) at most this often. */
export const PROGRESS_EVERY_MS = 15_000;
export const RELAY_OPEN_TIMEOUT_MS = 25_000;
/**
 * Relays run their setup (org → project → conversation → lockdown) one at a time, until they report
 * `started`, so concurrent first questions share one project. A setup that takes longer than this
 * stops holding the others up.
 */
export const SETUP_LOCK_MAX_MS = 45_000;
/** Projects the extension created and never used, handed to one relay for deletion at a time. */
export const MAX_CLEANUP_PROJECTS = 3;

export const PAGE_SOURCE = 'arena-ask:page';
export const BRIDGE_SOURCE = 'arena-ask:bridge';

export const PORT_ASK = 'arena-ask';
/** background → relay in a top-level claude.ai tab (chrome.tabs.connect). */
export const PORT_RELAY = 'relay';
/** relay in the offscreen claude.ai frame → background (a framed page has no tab id to connect to). */
export const PORT_RELAY_FRAME = 'relay-frame';
/** background → ChatGPT relay in ARENA Ask's own pinned chatgpt.com tab (chrome.tabs.connect). */
export const PORT_RELAY_GPT = 'relay-chatgpt';
/** ChatGPT relay in the offscreen chatgpt.com frame → background. */
export const PORT_RELAY_FRAME_GPT = 'relay-frame-chatgpt';

/** How long to wait for the offscreen claude.ai frame to connect after creating/waking it. */
export const FRAME_READY_TIMEOUT_MS = 20_000;
/** How long to wait for an already-loaded offscreen frame to answer a wake before rebuilding it. */
export const FRAME_WAKE_TIMEOUT_MS = 4_000;
/** While an ask waits for a frame port, its wake is re-sent this often (a loading frame misses some). */
export const WAKE_RESEND_MS = 1_000;
/** Close the offscreen document after this long without a question. */
export const OFFSCREEN_IDLE_MS = 10 * 60_000;

/**
 * Runtime/window message types between background, offscreen document and its frames. A wake,
 * reload or drop names its frame (`provider`, default `claude`); the offscreen document creates a
 * provider's frame on its first wake.
 */
export const MSG_WAKE = 'arena-ask:wake';
export const MSG_OFFSCREEN_IDLE = 'arena-ask:offscreen-idle';
/** background → offscreen document: reload a frame (a challenge that didn't clear). */
export const MSG_RELOAD_FRAME = 'arena-ask:reload-frame';
/** background → offscreen document: remove a frame (chatgpt.com logged out: it must not keep running). */
export const MSG_DROP_FRAME = 'arena-ask:drop-frame';
/**
 * ChatGPT relay in a top-level chatgpt.com tab → background, at document_start: is this ARENA Ask's
 * own pinned tab? (`{own: boolean}`; only then does its MAIN-world wrapper wake up.)
 */
export const MSG_GPT_OWN_TAB = 'arena-ask:gpt-own-tab';
/** ChatGPT relay → background: chatgpt.com answered 401 while no question was running (the frame is dropped). */
export const MSG_GPT_LOGGED_OUT = 'arena-ask:gpt-logged-out';
/**
 * relay → background (runtime message, not the ask's port, which a cancel may already have
 * closed): `{type, project: ProjectRef}`, a project the relay just created.
 */
export const MSG_PROJECT_CREATED = 'arena-ask:project-created';

/** Debug switch (chrome.storage.local): true forces the tab transports (QA of the fallback). */
export const DEBUG_DISABLE_OFFSCREEN = 'arenaAsk.debug.disableOffscreen';
/**
 * Debug switch (chrome.storage.local): true makes My ChatGPT's send guard check the request and
 * report its verdict without ever sending it (QA of the whole path without spending a message).
 * It can only stop messages from going out.
 */
export const DEBUG_GPT_DRY_RUN = 'arenaAsk.debug.gptDryRun';

/**
 * How ARENA Ask conversations behave. Kept in the background's own IndexedDB (`mode`; content and
 * page scripts can't reach it) and changed only from the Options page (through the background) or
 * the service worker's console; see docs/DESIGN.md "Modes":
 * - `full` (the default): a normal claude.ai chat on the owner's personal account (memory, past
 *   chats, profile preferences, web search; code execution off); tools that only read run, tools
 *   that change things or run code are stopped and handed off to claude.ai (lib/tools.ts);
 * - `locked`: a plain tutor (lib/lockdown.ts): no tools, memory, past chats or preferences, inside
 *   the extension's own project; any tool call stops the answer.
 * `MODE_KEY` is where versions before that kept it (chrome.storage.local, which content scripts can
 * write): migrated once (a locked or unrecognised value stays locked), then removed.
 */
export const MODE_KEY = 'arenaAsk.mode';
export const MODES = ['full', 'locked'] as const;
export type Mode = (typeof MODES)[number];

/** The stored mode: absent means `full` (the owner's default); anything else unrecognised (null included) means `locked` (fail closed). */
export function parseMode(v: unknown): Mode {
  if (v === undefined || v === 'full') return 'full';
  return 'locked';
}

/**
 * My ChatGPT: the longest message (context + earlier chat + question) put in chatgpt.com's composer;
 * longer is refused (select fewer sections). Inline text, inserted 20,000 characters at a time.
 */
export const GPT_MAX_MESSAGE_CHARS = 250_000;
/** How long a ChatGPT question may wait for another one to finish with the (single) ChatGPT page. */
export const GPT_QUEUE_WAIT_MS = 120_000;
/**
 * Forgetting the pinned ChatGPT account never runs alongside a ChatGPT question (it may be pinning):
 * it waits this long for the running one, then stops it and waits FORGET_STOP_WAIT_MS more for it to
 * let go; if it still hasn't, nothing is forgotten (the Options page says so).
 */
export const FORGET_WAIT_MS = 10_000;
export const FORGET_STOP_WAIT_MS = 20_000;
/** A question can't be sent because the pinned account couldn't be read (fail closed). */
export const PIN_UNREADABLE_DETAIL =
  "It couldn't read which account it is pinned to (its local storage didn't answer). Ask again; if it keeps happening, reload the extension.";
/** A question retried (e.g. through a tab after the hidden frame failed) after its pinned account was forgotten. */
export const PIN_FORGOTTEN_DETAIL = 'The pinned account was forgotten while this question was being retried. Ask again.';
/**
 * A ChatGPT relay still busy with a stopped question (e.g. checking whether a handed-off tool ran)
 * answers `busy` before anything is sent: the next question waits for it (every GPT_RELAY_BUSY_RETRY_MS,
 * at most GPT_RELAY_BUSY_RETRIES times) instead of failing.
 */
export const GPT_RELAY_BUSY_RETRY_MS = 1_500;
export const GPT_RELAY_BUSY_RETRIES = 15;
/** Shown in the bubble of a ChatGPT question stopped because the owner forgot the pinned account. */
export const GPT_STOPPED_FOR_FORGET =
  "ARENA Ask stopped this ChatGPT question: you asked it to forget the pinned ChatGPT account. Ask again to use the account you're signed in to.";
/** How many times one ChatGPT question may move its page (to a new chat, or its chat's /c/<id>). */
export const GPT_MAX_HOPS = 2;

/** Longest status line ("Searching past chats…") the relay may send. */
export const STATUS_MAX_CHARS = 100;

/**
 * How a question reached claude.ai, in order of preference:
 * - offscreenFrame: an invisible claude.ai iframe in the extension's offscreen document (Chrome)
 * - claudeTab: an already-open top-level claude.ai tab running the relay
 * - newTab: a claude.ai tab ARENA Ask opened (pinned, inactive)
 */
export const TRANSPORTS = ['offscreenFrame', 'claudeTab', 'newTab'] as const;
export type Transport = (typeof TRANSPORTS)[number];

// ---------------------------------------------------------------------------------------------
// Errors

export const ERROR_CODES = [
  'no_relay',
  'logged_out',
  'cloudflare',
  'rate_limited',
  'throttled',
  'overloaded',
  'too_large',
  'network',
  'timeout',
  'relay_closed',
  'http',
  'busy',
  'too_many',
  'invalid',
  'disconnected',
  'incomplete',
  'unsafe',
  'tool_blocked',
  'too_long',
  'wrong_account',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && (ERROR_CODES as readonly string[]).includes(x);
}

/** The short, human message shown in ARENA's bubble for each failure. */
export function humanError(code: ErrorCode, detail?: string): string {
  const d = detail?.trim() ? ` ${detail.trim()}` : '';
  switch (code) {
    case 'no_relay':
      return 'Open claude.ai and log in, then ask again.';
    case 'logged_out':
      return "You're not logged in to claude.ai. Open claude.ai and log in, then ask again.";
    case 'cloudflare':
      return 'claude.ai is showing a security check. Open the claude.ai tab, complete it, then ask again.';
    case 'rate_limited':
      return `You've hit your Claude usage limit.${d || ' Try again later.'}`;
    case 'throttled':
      return "claude.ai is rate-limiting requests right now (this isn't your usage limit). Wait a moment and ask again.";
    case 'overloaded':
      return 'Claude is overloaded right now. Try again in a moment.';
    case 'too_large':
      return `That's too much for Claude in one go.${d || ' Select fewer sections and ask again.'}`;
    case 'network':
      return "Couldn't reach claude.ai (network error). Check your connection and ask again.";
    case 'timeout':
      return 'claude.ai stopped responding. Ask again.';
    case 'relay_closed':
      return 'The claude.ai tab was closed or reloaded before Claude finished. Ask again.';
    case 'http':
      return `claude.ai returned an error.${d}`;
    case 'busy':
      return 'Wait for the current answer to finish.';
    case 'too_many':
      return 'Too many questions in the last minute. Wait a moment and ask again.';
    case 'invalid':
      return `ARENA Ask couldn't send that question.${d}`;
    case 'disconnected':
      return 'ARENA Ask was restarted or updated mid-answer. Reload this page and ask again.';
    case 'incomplete':
      return 'claude.ai ended the answer before it finished. Ask again.';
    case 'unsafe':
      return "ARENA Ask couldn't confirm that connectors, web search, code execution and memory are off for this claude.ai conversation, so your question was not sent. Ask again in a moment.";
    case 'tool_blocked':
      return "Claude tried to use a tool; ARENA Ask blocks tools in locked mode (a plain tutor), so it stopped this answer. Ask again or rephrase the question.";
    case 'too_long':
      return `ARENA Ask stopped Claude's answer: it${d || ' ran too long'}. Ask again (a narrower question may help).`;
    case 'wrong_account':
      return `ARENA Ask didn't send your question.${d || " Full mode only runs in the personal claude.ai account it was first used with."}`;
    case 'internal':
    default:
      return `Something went wrong in ARENA Ask.${d}`;
  }
}

/** humanError, worded for the provider (ChatGPT's own session, page and limits). */
export function humanErrorFor(provider: ProviderId, code: ErrorCode, detail?: string): string {
  if (provider !== 'chatgpt') return humanError(code, detail);
  const d = detail?.trim() ? ` ${detail.trim()}` : '';
  switch (code) {
    case 'no_relay':
      return 'Open chatgpt.com and sign in, then ask again.';
    case 'logged_out':
      return 'ChatGPT session expired — open chatgpt.com and sign in, then ask again.';
    case 'cloudflare':
      return 'chatgpt.com is showing a security check. Open chatgpt.com, complete it, then ask again.';
    case 'rate_limited':
      return `You've hit your ChatGPT usage limit.${d || ' Try again later.'}`;
    case 'too_large':
      return `That's too much for My ChatGPT in one go.${d || ' Select fewer sections and ask again.'}`;
    case 'network':
      return "Couldn't reach chatgpt.com (network error). Check your connection and ask again.";
    case 'timeout':
      return 'ChatGPT stopped responding. Ask again.';
    case 'relay_closed':
      return 'The chatgpt.com page ARENA Ask uses was closed or reloaded before ChatGPT finished. Ask again.';
    case 'http':
      return `chatgpt.com returned an error.${d}`;
    case 'incomplete':
      return 'ChatGPT ended the answer before it finished. Ask again.';
    case 'too_long':
      return `ARENA Ask stopped ChatGPT's answer: it${d || ' ran too long'}. Ask again (a narrower question may help).`;
    case 'unsafe':
      return `ARENA Ask couldn't confirm the message chatgpt.com was about to send, so it wasn't sent.${d || ' Ask again.'}`;
    case 'wrong_account':
      return `ARENA Ask didn't send your question.${d || ' My ChatGPT only runs in the personal ChatGPT account it was first used with.'}`;
    default:
      return humanError(code, detail);
  }
}

/** My ChatGPT in locked mode: there is no per-chat lockdown on chatgpt.com (docs/DESIGN.md "My ChatGPT"). */
export const GPT_FULL_ONLY_DETAIL = 'My ChatGPT is only available with full account access (ARENA Ask is set to Locked; change it in ARENA Ask\'s options).';

/** relay_closed, worded for the transport that actually went away. */
export function relayClosedMessage(via: Transport, provider: ProviderId = 'claude'): string {
  if (provider === 'chatgpt') {
    return via === 'offscreenFrame'
      ? 'The hidden chatgpt.com page ARENA Ask uses stopped before ChatGPT finished. Ask again.'
      : humanErrorFor('chatgpt', 'relay_closed');
  }
  return via === 'offscreenFrame'
    ? "The hidden claude.ai page ARENA Ask uses stopped before Claude finished. Ask again."
    : humanError('relay_closed');
}

/** Appended to an answer that was cut off after some text had already streamed. */
export function interruptionNote(message: string): string {
  return `\n\n⚠️ Interrupted: ${message}`;
}

/** Streamed in place of an answer that completed without any text. */
export const EMPTY_ANSWER_NOTE = "_(Claude's reply had no text. Open it in claude.ai to see it.)_";
export const GPT_EMPTY_ANSWER_NOTE = "_(ChatGPT's reply had no text. Open it in ChatGPT to see it.)_";

// ---------------------------------------------------------------------------------------------
// Shapes

export type Role = 'user' | 'assistant';
export interface ArenaMsg {
  role: Role;
  content: string;
  /**
   * Relay side only: this user message's text is a question the extension forwarded from a trusted
   * Send (the background checks it against what it recorded; RelayAsk.typed). Never taken from the
   * page or the bridge.
   */
  typed?: true;
}

/** MAIN world → bridge (window.postMessage). The only verb the page channel carries. */
export interface PageAsk {
  source: typeof PAGE_SOURCE;
  type: 'ask';
  id: string;
  prompt: string;
  context: string;
  /** The dropdown value ARENA's request carried (`my-claude` | `my-chatgpt`). */
  model: string;
}

/** Bridge → MAIN world. */
export type BridgeToPage =
  | { source: typeof BRIDGE_SOURCE; id: string; type: 'ack' }
  | { source: typeof BRIDGE_SOURCE; id: string; type: 'delta'; text: string }
  | { source: typeof BRIDGE_SOURCE; id: string; type: 'done' }
  | { source: typeof BRIDGE_SOURCE; id: string; type: 'error'; message: string };

/** The ARENA-side facts about one question, as the bridge sends them to the background. */
export interface AskRequest {
  type: 'ask';
  provider: ProviderId;
  /** Stable key for the ARENA chapter (ARENA's chapter id, or "static"). */
  chapterKey: string;
  chapterTitle: string;
  prompt: string;
  /** ARENA's context string ("" when none). */
  context: string;
  /** Prior ARENA chat messages (most recent kept), or null when ARENA's history was unreadable. */
  history: ArenaMsg[] | null;
  /** Untrimmed number of prior ARENA messages (-1 when unknown). */
  priorCount: number;
  /** Hash of the first message of this ARENA chat thread (identifies the thread across reloads). */
  anchor: string;
}

/** Bridge → background, while a stream is open. */
export interface Ping {
  type: 'ping';
}

/** Per-chapter claude.ai conversation state, owned by the background (its IndexedDB; lib/state-store.ts). */
export interface ConvState {
  v: 1;
  /** Short hash of the org id, to notice an account switch without storing the id itself. */
  orgTag: string;
  convUuid: string;
  /** Parent for the next turn: the assistant uuid we chose last turn, or ROOT. */
  parent: string;
  anchor: string;
  /** ARENA messages Claude has seen (prior + question + answer) after the last completed turn. */
  arenaLen: number;
  /**
   * Indexes (≥ arenaLen) of ARENA questions that were stopped for a tool call: never replayed to
   * Claude as unseen chat. Absent when there are none.
   */
  skip?: number[];
  /**
   * The skip list was full: the next question starts a new conversation, and ARENA messages before
   * `arenaLen` are never sent to it. Absent otherwise.
   */
  renew?: true;
  /**
   * A question of this ARENA thread was stopped for a tool call. Blocked questions before
   * `arenaLen` aren't listed in `skip` (they count as seen), so a replacement conversation for the
   * thread gets none of the chat before `arenaLen`. Absent otherwise.
   */
  blocked?: true;
  /** sha256 of the context last attached (null = none delivered yet). */
  ctxHash: string | null;
  /** Filed under the "ARENA" project yet (locked mode). */
  filed: boolean;
  name: string;
  updatedAt: number;
  /**
   * `full`: a full-mode conversation (a plain chat on the owner's account). Absent: a locked-down
   * one (state from before modes existed is locked). A conversation is only ever continued in its
   * own mode.
   */
  mode?: 'full';
}

/** The extension's own "ARENA" project on claude.ai, per account (org tag, never the org id). */
export interface ProjectRef {
  orgTag: string;
  uuid: string;
}

/** Background → relay. */
export interface RelayAsk extends Omit<AskRequest, 'type' | 'provider'> {
  type: 'ask';
  /** How the conversation behaves (see MODE_KEY). */
  mode: Mode;
  /**
   * Full mode: the claude.ai org full mode was first used in (pinned by the background, never sent to
   * the page); null before the first full-mode question. The relay uses it whatever org claude.ai
   * has active, and refuses if it's gone or not a personal one.
   */
  pinnedOrg: string | null;
  /**
   * Indexes into `history` of the user messages whose text matches a question the extension itself
   * forwarded from a trusted Send in this chapter (recorded by the background). Only these are
   * presented to Claude as the user's words; the rest of the history is labelled page-supplied.
   */
  typed: number[];
  state: ConvState | null;
  /** The project this extension created for the relay's account, if it has one. */
  project: ProjectRef | null;
  /**
   * Projects this extension created but never put a conversation in (e.g. made by a question that
   * then failed): the relay deletes each one that is still an empty, private "ARENA" project.
   */
  cleanup: ProjectRef[];
}

/**
 * Background → ChatGPT relay (lib/gpt-relay.ts). Full mode only. `state` is the chapter's ChatGPT
 * chat (its `orgTag` is the ChatGPT account's tag); `pinnedTag` the account My ChatGPT is pinned to
 * (null before its first question); `model` the owner's model override (null = the page's choice);
 * `patch` the request-body changes the send guard applies; `hops` how many times this question has
 * already moved the page (to a new chat or its chat's /c/<id>).
 */
export interface GptRelayAsk extends Omit<AskRequest, 'type' | 'provider'> {
  type: 'ask';
  provider: 'chatgpt';
  mode: 'full';
  typed: number[];
  state: ConvState | null;
  pinnedTag: string | null;
  model: string | null;
  patch: BodyPatch;
  hops: number;
  /** QA only (debug switch DEBUG_GPT_DRY_RUN): run everything, but the send guard never lets the message out. */
  dryRun?: boolean;
  /**
   * Mark the chat "don't remember" (off by default; the owner opts in on the Options page, or with
   * `arenaAsk.setGptDoNotRemember(true)`): no memory tool in it from its second turn on, and a turn
   * in an existing chat only once that is confirmed (see lib/gpt-relay.ts setDoNotRemember). Off: an
   * existing chat still marked from before is unmarked before its turn.
   */
  doNotRemember: boolean;
}

/**
 * Background → relay, instead of an `ask`: stop generating in one conversation this extension
 * started, because the relay that was streaming it went away (tab closed, frame gone) mid-answer.
 * Sent only while that turn is still the conversation's latest (under its chapter's lock).
 */
export interface RelayStop {
  type: 'stop';
  convUuid: string;
  /** The account (org tag) that conversation belongs to: a relay logged into another one doesn't stop anything. */
  orgTag: string;
}

/** Relay → background, and (minus `state`/`project`/`started`/`stopped`) background → bridge. */
export type StreamEvent =
  /** `nonce` answers one specific wake of the offscreen frame (several asks can share the frame). */
  | { type: 'hello'; v: number; nonce?: string }
  /**
   * The conversation this answer goes to exists, is locked down and lives in `project` (relay →
   * background only). `created`: a project this relay created; `cleaned`: `cleanup` projects it
   * dealt with (deleted, gone, or not deletable).
   */
  | {
      type: 'started';
      convUuid: string;
      /** The assistant message this turn generates (the turn's identity, for a later `stop`). */
      turn?: string;
      /** The account's org tag (for a later `stop`). */
      orgTag?: string;
      /** Full mode, first use: the (personal) org the relay chose, for the background to pin. Never forwarded. */
      org?: string;
      /** My ChatGPT, first use: pin `orgTag` (the ChatGPT account's tag). Never forwarded. */
      pin?: true;
      /** My ChatGPT, a new chat: its state as soon as it exists (the next question continues it even if this one is interrupted). */
      state?: ConvState;
      project?: ProjectRef;
      created?: ProjectRef;
      cleaned?: string[];
    }
  | { type: 'delta'; text: string }
  /**
   * Full mode: a tool is running; `text` is a short status line derived from the tool's name (never
   * its input), shown under ARENA's bubble until the answer's text resumes; never part of the answer.
   */
  | { type: 'status'; text: string }
  /** Relay heartbeat while the stream is alive but not producing text (never forwarded to the page). */
  | { type: 'progress' }
  /** The answer to a `stop` (relay → background only). */
  | { type: 'stopped'; ok: boolean }
  /**
   * My ChatGPT (relay → background only): the relay is moving its page to the question's chat (a new
   * chat, or /c/<id>); its port closes, and the background sends the same question (hops + 1) to the
   * page once it has loaded.
   */
  | { type: 'navigating' }
  | {
      type: 'done';
      convUuid: string;
      util5h: number | null;
      util7d: number | null;
      /** Set by the background for the bridge (shown as data-via on the footer, for QA). */
      via?: Transport;
      /** The model that answered, when the provider says (ChatGPT: `model_slug`; shown in the footer). */
      model?: string;
      state?: ConvState;
      project?: ProjectRef;
      /** The answer ends in a handoff note (a tool call stopped for approval; relay → background only, for the log). */
      handoff?: 'action' | 'stall' | 'waiting' | 'unknown';
      /** Id-free diagnostic for the background's log (relay → background only): the handed-off tool. */
      diag?: string;
    }
  | {
      type: 'error';
      code: ErrorCode;
      message: string;
      convUuid?: string;
      state?: ConvState;
      project?: ProjectRef;
      created?: ProjectRef;
      cleaned?: string[];
      /** Id-free diagnostic for the background's log (relay → background only). */
      diag?: string;
    };

export const metaKey = (chapterKey: string) => `meta.v1.${chapterKey}`;
