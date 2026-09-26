import {
  CODE_EXECUTION_FLAG,
  ClaudeError,
  FULL_CREATE_PARAMS,
  FULL_NEW_SETTINGS,
  accountMemoryOn,
  PROJECT_DESCRIPTION,
  PROJECT_NAME,
  ToolHandoff,
  createConversation,
  createProject,
  deleteConversation,
  deleteProject,
  getChatOrg,
  getConversation,
  listChatOrgs,
  getProject,
  isAbort,
  type ProjectInfo,
  lastActiveOrgFromCookie,
  projectConversationCount,
  putConversationSettings,
  setProjectMemory,
  stopResponse,
  streamCompletion,
  toolResultRecorded,
} from './claude';
import {
  buildPrompt,
  contextAttachment,
  conversationName,
  planTurn,
  stateAfterBlocked,
  stateAfterFailure,
  stateAfterSuccess,
  type TurnInput,
  type TurnPlan,
} from './conversation';
import { sha256Hex } from './hash';
import { LOCKED_CREATE_PARAMS, lockdownSettings, lockdownViolations, mcpKeys } from './lockdown';
import { PROGRESS_EVERY_MS, STATUS_MAX_CHARS, humanError, type ProjectRef, type RelayAsk, type StreamEvent } from './protocol';
import { CLAUDE } from './provider';

/** Claude's model id (fixed; see lib/provider.ts). */
const CLAUDE_MODEL = CLAUDE.model ?? 'claude-opus-5-5';
import { handoffNote, type StopOutcome } from './tools';
import { uuidv7 } from './uuid';

/** claude.ai's cookies as the relay sees them ("" outside a page, e.g. in tests). */
function readCookie(): string {
  try {
    return typeof document === 'undefined' ? '' : document.cookie;
  } catch {
    return '';
  }
}

/** A short, non-reversible tag for the org id: enough to notice an account switch. */
export async function orgTagFor(org: string): Promise<string> {
  return (await sha256Hex(`arena-ask/org/${org}`)).slice(0, 16);
}

const unsafe = (why: string) => {
  console.warn('[arena-ask] conversation not locked down:', why);
  return new ClaudeError('unsafe', humanError('unsafe'));
};

/** Full mode: code execution couldn't be confirmed off for the conversation. Nothing is sent. */
export const FULL_UNSAFE_MESSAGE =
  "ARENA Ask couldn't confirm that code execution is off for this claude.ai conversation, so your question was not sent. Ask again in a moment.";
const fullUnsafe = (why: string) => {
  console.warn('[arena-ask] full-mode conversation not set up:', why);
  const e = new ClaudeError('unsafe', FULL_UNSAFE_MESSAGE);
  e.diag = `settings:full:${why.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40)}`;
  return e;
};

/**
 * Full mode: make sure code execution (and file creation) is off in a conversation, from what
 * claude.ai echoes back: switched off with `settings` (on a new chat, the web app's defaults) when
 * it isn't already. Returns the conversation's settings; throws (fail closed) if it stays on.
 */
async function codeExecutionOff(
  org: string,
  convUuid: string,
  current: Record<string, unknown> | null,
  settings: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  if (current && current[CODE_EXECUTION_FLAG] === false && Object.keys(settings).length === 1) return current;
  const echoed = await putConversationSettings(org, convUuid, settings, signal).catch((e) => {
    if (isAbort(e)) throw e;
    throw fullUnsafe('settings request failed');
  });
  if (echoed?.[CODE_EXECUTION_FLAG] !== false) throw fullUnsafe('code execution stays on');
  return echoed;
}

/**
 * Is the extension's own project fit to hold ARENA Ask conversations? Private, not archived or
 * moved, no instructions, no knowledge files, and its memory PROVEN off: switched off here if it
 * isn't (null, i.e. unreported, doesn't count as off). Only ever called with the project this
 * extension created (stored, or just created): no other project's settings are ever changed.
 */
async function projectUsable(org: string, uuid: string, signal: AbortSignal): Promise<boolean> {
  const info = await getProject(org, uuid, signal);
  if (!projectFit(info)) return false;
  if (info.memory === false) return true;
  const echoed = await setProjectMemory(org, uuid, false, signal);
  // Read back and check EVERYTHING again: the project may have been shared, archived, moved or given
  // instructions or knowledge meanwhile.
  const again = await getProject(org, uuid, signal);
  if (!projectFit(again)) return false;
  return again.memory === false || (again.memory === null && echoed === false);
}

/** Private, not archived or moved, no instructions, no knowledge files (memory is checked apart). */
function projectFit(info: ProjectInfo | null): info is ProjectInfo {
  return !!info && !info.archived && !info.moved && info.isPrivate && !info.hasInstructions && info.knowledge === 0;
}

/**
 * The extension's own "ARENA" project for this account: the stored one if it is still usable
 * (`projectUsable`), otherwise a new one. `created` = this call created it. Throws 'unsafe' (after
 * reporting the new project through `onCreated`) if even a new project can't be made usable.
 */
async function ensureProject(
  org: string,
  stored: string | null,
  checked: Map<string, boolean>,
  signal: AbortSignal,
  onCreated: (uuid: string) => void,
): Promise<{ uuid: string; created: boolean }> {
  if (stored && (checked.get(stored) ?? (await projectUsable(org, stored, signal)))) return { uuid: stored, created: false };
  // Not abortable: once claude.ai may have made it, its uuid must be known (and reported at once),
  // or a cancel during the first setup would leave a project nobody can clean up.
  const uuid = await createProject(org);
  onCreated(uuid);
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  if (!(await projectUsable(org, uuid, signal))) throw unsafe('new project not usable');
  return { uuid, created: true };
}

/**
 * Delete a project this extension created and never put a conversation in, if it is still exactly
 * that: named and described as the extension names its project, private, no instructions, no
 * knowledge, and no conversations. True when done with it (deleted, already gone, or not something
 * to delete: then it is left alone for good); false when that couldn't be settled now (its
 * conversations couldn't be counted, or the DELETE failed): it is tried again another time.
 */
async function cleanupProject(org: string, uuid: string, signal: AbortSignal): Promise<boolean> {
  const info = await getProject(org, uuid, signal);
  if (!info) return true; // gone (or not ours to read)
  const ours =
    info.name === PROJECT_NAME &&
    info.description === PROJECT_DESCRIPTION &&
    info.isPrivate &&
    !info.hasInstructions &&
    info.knowledge === 0;
  if (!ours) return true;
  const count = await projectConversationCount(org, uuid, signal);
  if (count === null) return false;
  if (count !== 0) return true;
  const deleted = await deleteProject(org, uuid, signal);
  if (deleted) console.info('[arena-ask] deleted an unused ARENA project this extension had created');
  return deleted;
}

/**
 * Lock a conversation down (lockdown.ts) and confirm it from what claude.ai echoes back. Returns
 * the remaining violations ([] = locked down).
 */
async function lockDown(org: string, convUuid: string, current: Record<string, unknown> | null, signal: AbortSignal) {
  const required = mcpKeys(current);
  const echoed = await putConversationSettings(org, convUuid, lockdownSettings(current), signal);
  return lockdownViolations(echoed, required);
}

/**
 * Execute one ARENA question inside claude.ai: plan the turn; get its conversation; stream the
 * completion (every text delta goes to `send`); and finish with exactly one `done` or `error` event
 * (none if aborted, in which case generation is stopped).
 *
 * - `locked` mode: the conversation is locked down (no connectors, web search, code execution,
 *   memory, past-chat search or profile preferences) and inside the extension's own, usable project
 *   BEFORE anything is sent to Claude (a new one is created there when needed); any tool call ends
 *   the answer.
 * - `full` mode: a plain claude.ai chat (no project) with the web app's defaults: the account's
 *   memory, past chats, preferences and web search apply; code execution is switched off (and must
 *   read back off) before anything is sent. Tools that only read run (each reported as a `status`
 *   line); a tool call that would change something or run code, one that stalls (most likely waiting
 *   for an approval prompt nobody can see here), and any stream shape the guard doesn't know are
 *   stopped and handed off: the answer ends with a note linking the conversation on claude.ai.
 *
 * It only ever touches the conversation it creates, the one named in the extension-owned
 * `req.state` (read-only in locked mode unless it is still in the extension's project), and the
 * project named in `req.project` (or one it creates, locked mode only); it never lists, reads or
 * returns any other conversation, and never changes another project (projects it created and never
 * used are deleted, in either mode, while still empty).
 */
export async function runRelayAsk(
  req: RelayAsk,
  send: (ev: StreamEvent) => void,
  signal: AbortSignal,
  opts: {
    waitForOrg?: (e: ClaudeError) => boolean;
    /**
     * A project was just created (before anything else happens): report it where it survives this
     * ask being cancelled, so the extension can clean it up later if it stays unused.
     */
    onProjectCreated?: (p: ProjectRef) => void;
    /** Test hook: the answer deadlines / character cap / tool stall limits (defaults in protocol.ts). */
    limits?: { deadlineMs?: number; toolDeadlineMs?: number; maxChars?: number; stallMs?: number };
  } = {},
): Promise<void> {
  let org: string | null = null;
  let input: TurnInput | null = null;
  let plan: TurnPlan | null = null;
  let convUuid: string | null = null;
  let project: ProjectRef | undefined;
  /** A project this relay created (reported so the extension knows it may clean it up later). */
  let createdProject: ProjectRef | undefined;
  const cleaned: string[] = [];
  let name = '';
  let created = false;
  /** A conversation this relay created (or may have) that Claude hasn't been sent anything in yet. */
  let fresh: string | null = null;
  let generating = false;
  /** Some answer text has been sent (a handoff note then starts on a new paragraph). */
  let streamed = false;
  /** Full mode: the conversation's settings as claude.ai reports them (the account's defaults). */
  let convSettings: Record<string, unknown> | null = null;
  /** The assistant message this turn generates (chosen here, sent as turn_message_uuids). */
  let assistantUuid: string | null = null;
  const full = req.mode === 'full';
  const bail = () => {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  };
  try {
    const picked = await pickOrg(req, opts.waitForOrg, signal);
    org = picked.org;
    const orgTag = await orgTagFor(org);
    // Only user messages the background vouched for (req.typed) count as the user's own words.
    const typed = new Set(req.typed);
    const history = req.history ? req.history.map((m, k) => (m.role === 'user' && typed.has(k) ? { ...m, typed: true as const } : { role: m.role, content: m.content })) : null;
    input = {
      state: req.state,
      orgTag,
      anchor: req.anchor,
      priorCount: req.priorCount,
      history,
      ctxHash: req.context ? await sha256Hex(req.context) : null,
      mode: req.mode,
    };
    plan = planTurn(input);
    /** The extension's own project for this account (the only project whose settings it changes). */
    const own = req.project && req.project.orgTag === orgTag ? req.project.uuid : null;
    const checked = new Map<string, boolean>();

    // Projects this extension created and never used (e.g. by a question that then failed).
    for (const c of req.cleanup) {
      if (c.orgTag !== orgTag || c.uuid === own) continue;
      try {
        if (await cleanupProject(org, c.uuid, signal)) cleaned.push(c.uuid);
      } catch (e) {
        if (isAbort(e)) throw e; // anything else: try again another time
      }
    }

    if (!plan.create && full) {
      // A full-mode conversation is a plain chat: continued while it exists and is still outside any
      // project (moved into one, it would get that project's instructions, knowledge and memory: a new
      // plain chat starts instead, and the moved one is left alone). Code execution stays off in it.
      const conv = await getConversation(org, req.state!.convUuid, signal);
      if (conv && conv.projectUuid === null) {
        convSettings = await codeExecutionOff(org, req.state!.convUuid, conv.settings, { [CODE_EXECUTION_FLAG]: false }, signal);
      } else {
        input = { ...input, replace: true };
        plan = planTurn(input);
      }
    } else if (!plan.create) {
      // Continuing needs all of: the stored conversation still exists; it is still inside the
      // extension's own project (the owner may have moved it); that project is still usable
      // (private, no instructions or knowledge, memory off); and the conversation is still locked
      // down (re-locked if the owner switched something on). Otherwise a new conversation starts in
      // the extension's project. A conversation outside it is left exactly as it is.
      const conv = await getConversation(org, req.state!.convUuid, signal);
      let ok = !!conv && !!own && conv.projectUuid === own;
      if (ok) {
        const usable = await projectUsable(org, own!, signal);
        checked.set(own!, usable);
        ok = usable;
      }
      if (ok && lockdownViolations(conv!.settings).length) ok = (await lockDown(org, req.state!.convUuid, conv!.settings, signal)).length === 0;
      if (ok) project = { orgTag, uuid: own! };
      else {
        // A new conversation for the same ARENA thread (the stored state still says which of its
        // questions were blocked, so they aren't replayed to it).
        input = { ...input, replace: true };
        plan = planTurn(input);
      }
    }

    if (plan.create && full) {
      // A plain chat with the web app's defaults: no project, the account's own settings, memory and
      // preferences; code execution off (verified from claude.ai's echo) and the app's effort level.
      name = conversationName(req.chapterTitle);
      const memory = await accountMemoryOn(signal).catch((e) => {
        if (isAbort(e)) throw e;
        return false;
      });
      bail();
      const uuid = crypto.randomUUID();
      fresh = uuid; // from here on, an abort or failure deletes it
      const params = { ...FULL_CREATE_PARAMS, ...(memory ? { chat_memory_mode: 'enabled' } : {}) };
      const initial = await createConversation({ org, uuid, name, model: CLAUDE_MODEL, params, signal });
      convUuid = uuid;
      created = true;
      convSettings = await codeExecutionOff(org, uuid, initial, { ...FULL_NEW_SETTINGS }, signal);
    } else if (plan.create) {
      const p = await ensureProject(org, own, checked, signal, (uuid) => {
        createdProject = { orgTag, uuid };
        opts.onProjectCreated?.(createdProject);
      });
      project = { orgTag, uuid: p.uuid };
      name = conversationName(req.chapterTitle);
      bail();
      const uuid = crypto.randomUUID();
      fresh = uuid; // from here on, an abort or failure deletes it
      const initial = await createConversation({ org, uuid, name, model: CLAUDE_MODEL, projectUuid: p.uuid, params: LOCKED_CREATE_PARAMS, signal });
      convUuid = uuid;
      created = true;
      const left = await lockDown(org, uuid, initial, signal).catch((e) => {
        if (isAbort(e)) throw e;
        return ['settings request failed'];
      });
      if (left.length) throw unsafe(left.join(', '));
    } else {
      name = req.state!.name;
      convUuid = req.state!.convUuid;
    }
    bail();
    assistantUuid = uuidv7();
    const turn = assistantUuid;
    send({
      type: 'started',
      convUuid,
      turn,
      orgTag,
      ...(picked.pin ? { org } : {}),
      ...(project ? { project } : {}),
      ...(createdProject ? { created: createdProject } : {}),
      ...(cleaned.length ? { cleaned } : {}),
    });

    let lastProgress = Date.now();
    fresh = null; // the question goes out now: keep the conversation, whatever happens next
    generating = true;
    const result = await streamCompletion({
      org,
      convUuid,
      prompt: buildPrompt(req.prompt, plan, req.chapterTitle),
      parentUuid: plan.parent,
      model: CLAUDE_MODEL,
      assistantUuid: turn,
      attachments: plan.attach ? [contextAttachment(req.context)] : undefined,
      signal,
      toolPolicy: full ? 'guard' : 'block',
      declaredTools: full ? fullModeTools(convSettings) : undefined,
      ...opts.limits,
      onText: (text) => {
        lastProgress = Date.now();
        streamed = true;
        send({ type: 'delta', text });
      },
      onTool: (tool) => {
        lastProgress = Date.now();
        send({ type: 'status', text: tool.label.slice(0, STATUS_MAX_CHARS) });
      },
      onActivity: () => {
        if (Date.now() - lastProgress < PROGRESS_EVERY_MS) return;
        lastProgress = Date.now();
        send({ type: 'progress' });
      },
    });
    generating = false;
    const state = stateAfterSuccess(input, plan, { convUuid, assistantUuid: turn, name, filed: true, now: Date.now() });
    send({ type: 'done', convUuid, util5h: result.util5h, util7d: result.util7d, state, ...(project ? { project } : {}) });
  } catch (e) {
    // A conversation made for this question that Claude was never sent anything in (e.g. aborted
    // or failed between create and lockdown) never stays behind, locked down or not.
    if (org && fresh) {
      await deleteConversation(org, fresh);
      if (convUuid === fresh) {
        convUuid = null;
        created = false;
      }
      fresh = null;
    }
    if (signal.aborted || isAbort(e)) {
      // The asker went away (ARENA cancelled, tab closed): nobody to tell, but don't let claude.ai
      // keep generating an answer nobody will read.
      if (generating && org && convUuid) void stopResponse(org, convUuid);
      return;
    }
    if (e instanceof ToolHandoff && org && convUuid && input && plan) {
      // Full mode: a tool call that must not run (or wait) here. Stop it on claude.ai first, then
      // finish the answer with a note linking the conversation, where the owner can approve it. The
      // note says "stopped before it ran" only when claude.ai confirmed the stop AND its copy of the
      // turn shows no result for that call. The question is skipped like a blocked one: the next
      // turn continues from the last complete answer.
      let stop: StopOutcome = (await stopResponse(org, convUuid)) ? 'requested' : 'failed';
      if (stop === 'requested' && e.reason === 'action' && assistantUuid) stop = await stoppedBeforeRun(org, convUuid, assistantUuid, e.call);
      generating = false;
      send({ type: 'delta', text: `${streamed ? '\n\n' : ''}${handoffNote(e.reason, e.tool, CLAUDE.chatUrl(convUuid), e.stallSeconds, stop)}` });
      // The note is saved by ARENA as this question's answer: skipped with it, never replayed.
      const st = stateAfterBlocked(input, plan, { convUuid, name, now: Date.now(), answered: true });
      send({
        type: 'done',
        convUuid,
        util5h: e.partial.util5h,
        util7d: e.partial.util7d,
        handoff: e.reason,
        ...(e.diag ? { diag: e.diag } : {}),
        ...(st ? { state: st } : {}),
        ...(project ? { project } : {}),
      });
      return;
    }
    // Any failure mid-answer (a tool call, the deadline or cap, a broken stream): make sure
    // claude.ai stops generating before reporting it.
    if (generating && org && convUuid) await stopResponse(org, convUuid);
    const err =
      e instanceof ClaudeError ? e : new ClaudeError('internal', humanError('internal', `(${String((e as Error)?.message || e).slice(0, 120)})`));
    const ev: StreamEvent = { type: 'error', code: err.code, message: err.message };
    if (err.diag) ev.diag = err.diag;
    if (convUuid && (created || !plan?.create)) ev.convUuid = convUuid; // it exists on claude.ai
    if (err.code === 'tool_blocked' && convUuid && input && plan) {
      // Text already streamed: ARENA saves it (with the interruption note) as the answer; skipped too.
      const st = stateAfterBlocked(input, plan, { convUuid, name, now: Date.now(), answered: streamed });
      if (st) ev.state = st;
    } else if (created && convUuid && input && plan) {
      const st = stateAfterFailure(input, plan, { convUuid, name, now: Date.now() });
      if (st) ev.state = st;
    }
    if (project) ev.project = project;
    if (createdProject) ev.created = createdProject;
    if (cleaned.length) ev.cleaned = cleaned;
    send(ev);
  }
}

/** Waits before each look at the stopped turn (claude.ai saves it as the stop lands); a test hook shortens them. */
let verifyDelaysMs = [800, 1500];
export function _setVerifyDelaysMs(ms: number[]) {
  verifyDelaysMs = ms;
}

/**
 * After a successful stop_response for an action: `before-run` if claude.ai's copy of the turn shows
 * no result for the call on the last look (a moment after the stop, so a stop still landing has
 * landed) and on no look a result; else `requested` (it may have started). Bounded: ~2.5 s, two reads.
 */
async function stoppedBeforeRun(org: string, convUuid: string, turn: string, call: { id: string | null; rawName: string }): Promise<StopOutcome> {
  let last: 'none' | 'result' | 'unknown' = 'unknown';
  for (const ms of verifyDelaysMs) {
    await new Promise((r) => setTimeout(r, ms));
    last = await toolResultRecorded(org, convUuid, turn, call).catch(() => 'unknown' as const);
    if (last === 'result') return 'requested';
  }
  return last === 'none' ? 'before-run' : 'requested';
}

/**
 * Full mode: the tools claude.ai's REST completion only offers when the request declares them, for
 * the features the conversation has on (its settings are the account's own defaults): web search.
 */
export function fullModeTools(settings: Record<string, unknown> | null): unknown[] | undefined {
  const tools: unknown[] = [];
  if (settings?.enabled_web_search === true) tools.push({ type: 'web_search_v0', name: 'web_search' });
  return tools.length ? tools : undefined;
}

/**
 * Stop generating in one conversation (the `stop` verb: another relay died mid-answer). Only the
 * background can ask, and only for a conversation an ARENA Ask relay reported as started, in the
 * account (`orgTag`) it was started in: a relay logged into another account stops nothing. Best effort.
 */
export async function runRelayStop(convUuid: string, orgTag: string, signal?: AbortSignal): Promise<boolean> {
  // Bounded well inside the background's 12 s wait, and given up once the background hangs up
  // (`signal`): after that it may already have released the chapter's lock and started a new turn
  // in this conversation, which a late stop_response would stop instead. The org is whichever of the
  // account's chat orgs has that tag (full mode may run in a pinned org claude.ai doesn't have active).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const orgs = await Promise.race([listChatOrgs(), new Promise<null>((r) => (timer = setTimeout(() => r(null), STOP_ORG_MS)))]);
    if (!orgs || signal?.aborted) return false;
    let org: string | null = null;
    for (const o of orgs) if ((await orgTagFor(o.uuid)) === orgTag) org = o.uuid;
    if (!org || signal?.aborted) return false;
    return await stopResponse(org, convUuid, STOP_REQUEST_MS, signal);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The `stop` verb's budget: finding the org, then the stop_response request (≤ 10 s together). */
const STOP_ORG_MS = 4_000;
const STOP_REQUEST_MS = 6_000;

/**
 * `fn` (an org lookup), retried while `waitFor` says the failure may clear by itself (the offscreen
 * frame's first requests can get a Cloudflare challenge that clears within seconds).
 */
async function patiently<T>(fn: () => Promise<T>, waitFor: ((e: ClaudeError) => boolean) | undefined, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + ORG_WAIT_MS;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ClaudeError) || !waitFor?.(e) || Date.now() >= deadline || signal.aborted) throw e;
      await new Promise((r) => setTimeout(r, ORG_WAIT_POLL_MS));
    }
  }
}

export const NOT_PERSONAL_DETAIL =
  'Full mode only runs in a personal claude.ai account, and the organization claude.ai has in use is a team or enterprise one. Switch claude.ai to your personal account, or set ARENA Ask to Locked in its options.';
export const PINNED_MISSING_DETAIL =
  "Full mode is tied to the personal claude.ai account it was first used with, and that account isn't logged in here. Log in to it, or use 'Forget pinned account' (Claude) in ARENA Ask's options.";

/**
 * The org this question runs in. Locked mode: the one claude.ai is using (lastActiveOrg) when it can
 * chat, else the first chat org. Full mode: the pinned org (`req.pinnedOrg`) whatever claude.ai has
 * active, refused if it's gone or not personal; before any is pinned, the one claude.ai is using,
 * refused if it isn't personal, else reported (`pin`) for the background to pin.
 */
async function pickOrg(
  req: RelayAsk,
  waitFor: ((e: ClaudeError) => boolean) | undefined,
  signal: AbortSignal,
): Promise<{ org: string; pin: boolean }> {
  const preferred = lastActiveOrgFromCookie(readCookie());
  if (req.mode !== 'full') return { org: await patiently(() => getChatOrg(preferred), waitFor, signal), pin: false };
  const orgs = await patiently(listChatOrgs, waitFor, signal);
  if (req.pinnedOrg) {
    const o = orgs.find((x) => x.uuid === req.pinnedOrg);
    if (!o) throw new ClaudeError('wrong_account', humanError('wrong_account', PINNED_MISSING_DETAIL));
    if (!o.personal) throw new ClaudeError('wrong_account', humanError('wrong_account', NOT_PERSONAL_DETAIL));
    return { org: o.uuid, pin: false };
  }
  const o = orgs.find((x) => preferred !== null && x.uuid === preferred) ?? orgs[0];
  if (!o.personal) throw new ClaudeError('wrong_account', humanError('wrong_account', NOT_PERSONAL_DETAIL));
  return { org: o.uuid, pin: true };
}

/** How long the frame relay waits for a Cloudflare challenge on its first request to clear. */
export const ORG_WAIT_MS = 12_000;
const ORG_WAIT_POLL_MS = 1_500;
