/**
 * Full mode's side-effect guard: which tool calls may run from the hidden claude.ai frame.
 *
 * In full mode an ARENA Ask conversation is a normal claude.ai chat on the owner's account (memory,
 * past chats, web search). Nobody is watching that frame, and the page that asked (and its lesson
 * context) can steer Claude, so nothing there may CHANGE anything or run code: a tool call is
 * classified from its name the moment Claude starts it (the stream's tool_use block, before claude.ai
 * runs it) as
 *
 *  - `read`   runs: claude.ai's own read built-ins by exact identity (web search, web fetch, past-chat
 *             search, tool_search, …), the few connector reads on CONNECTOR_READS, and unknown
 *             claude.ai tools whose name clearly only reads;
 *  - `action` is stopped (stop_response) and handed off to claude.ai, where the owner can see and
 *             approve it: send / create / update / delete / write / … , memory edits, ending the
 *             conversation, claude.ai's code-execution sandbox and its file tools (code there can
 *             reach the network), every other connector (MCP) tool, and ANYTHING UNKNOWN.
 *
 * Rules, in order:
 *  1. The name is NFKC-normalised; a name that still has anything but printable ASCII (a homoglyph,
 *     a zero-width character) is an action.
 *  2. Known claude.ai built-ins, only as claude.ai's own tool (no MCP server fields, no namespace,
 *     and no integration label or one claude.ai gives its own tools): READ_BUILTINS read;
 *     SANDBOX_BUILTINS and ACTION_BUILTINS are actions (ACTION_BUILTINS under any identity).
 *  3. A connector tool (MCP server fields, a namespace such as `Server:tool`, `mcp__server__tool`,
 *     `server/tool` or `server.tool`, or an integration label that isn't one of claude.ai's own, a
 *     label that sanitises to nothing included) is an action unless its exact (label, name) pair is
 *     on CONNECTOR_READS.
 *  4. Anything else (an unknown, unlabelled claude.ai tool), from its words (split on `_ - . : /`,
 *     camelCase and letter/digit boundaries): any action verb or risky word (query, url, exec, …),
 *     a conjunction, or an action verb hidden inside a word (`getANDcreate`) → action; else a read
 *     verb as the first or last word → read; else action.
 */

export type ToolKind = 'read' | 'action';

export interface ToolInfo {
  kind: ToolKind;
  /** The tool's name for display (the note, the log): no namespace, no ids, safe characters only. */
  name: string;
  /** Status line while it runs, e.g. "Searching past chats…". */
  label: string;
  /** What Claude wants to do, as a verb phrase ("create event"): for the handoff note. */
  action: string;
  /** The connector it belongs to, when known ("Gmail", "Google Calendar"); null otherwise. */
  connector: string | null;
}

/** What the stream says about a tool call besides its name. */
export interface ToolHints {
  /** The integration label the tool_use block carries (claude.ai's `integration_name`, …), raw. */
  connector?: string | null;
  /** The block says it belongs to an MCP server (an `mcp_tool_use` block, server fields): never a built-in. */
  marked?: boolean;
}

/**
 * The integration labels claude.ai gives its OWN tools (lowercased, compared exactly). A built-in's
 * name with any other label (a connector's tool of the same name) is a connector tool. Only labels
 * seen live (2026-09-25) are listed: conversation_search → "Search Past Conversations", tool_search
 * → "Tool Search", bash_tool (code execution) → "File Creation"; web_search and
 * search_mcp_registry carry none.
 */
export const BUILTIN_INTEGRATIONS: ReadonlySet<string> = new Set(['search past conversations', 'tool search', 'file creation']);

/** claude.ai built-ins that only read. */
const READ_BUILTINS = new Map<string, string>(Object.entries({
  web_search: 'Searching the web…',
  web_fetch: 'Reading a web page…',
  image_search: 'Searching images…',
  conversation_search: 'Searching past chats…',
  recent_chats: 'Looking through recent chats…',
  read_conversation: 'Reading a past chat…',
  google_drive_search: 'Searching Google Drive…',
  google_drive_fetch: 'Reading from Google Drive…',
  tool_search: 'Looking for the right tool…',
  list_mcp_resources: 'Listing connector resources…',
  read_resource_link: 'Reading a connector resource…',
  read_mcp_resource: 'Reading a connector resource…',
  fetch_sports_data: 'Fetching sports data…',
  search_mcp_registry: 'Searching the connector directory…',
  search_plugins: 'Searching plugins…',
  search_skills: 'Searching skills…',
}));

/**
 * claude.ai's code-execution sandbox, its files and artifacts. Handed off in full mode: code there
 * runs unattended with network access, so an injected instruction could use it to send data out.
 * (Full mode also switches code execution off per conversation; this is the backstop.)
 */
const SANDBOX_BUILTINS = new Map<string, string>(Object.entries({
  repl: "run code in claude.ai's sandbox",
  bash_tool: "run code in claude.ai's sandbox",
  code_execution: "run code in claude.ai's sandbox",
  create_file: "create a file in claude.ai's sandbox",
  str_replace: "edit a file in claude.ai's sandbox",
  str_replace_based_edit_tool: "edit a file in claude.ai's sandbox",
  view: "open a file in claude.ai's sandbox",
  present_files: "share files from claude.ai's sandbox",
  artifacts: 'write an artifact',
}));

/** claude.ai built-ins that change things although their names don't say so (actions under any identity). */
const ACTION_BUILTINS = new Map<string, { action: string; connector: string | null }>(Object.entries({
  memory_user_edits: { action: 'change what it remembers about you', connector: 'memory' },
  end_conversation: { action: 'end this conversation', connector: null },
}));

/**
 * Connector tools that may run, by exact (integration label, tool name): pure reads of claude.ai's
 * own Google connectors. (claude.ai's REST completion doesn't offer connector tools at all as of
 * 2026-09-25; this only matters if it starts to.) Every other connector tool is handed off.
 */
const CONNECTOR_READS = new Map<string, { name: string; tools: ReadonlySet<string> }>([
  ['gmail', { name: 'Gmail', tools: new Set(['search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft']) }],
  ['google calendar', { name: 'Google Calendar', tools: new Set(['list_events', 'get_event', 'search_events', 'list_calendars']) }],
  ['google drive', { name: 'Google Drive', tools: new Set(['search_files', 'read_file_content', 'get_file_metadata', 'list_recent_files', 'download_file_content']) }],
]);

const READ_VERBS = new Set([
  'search', 'list', 'get', 'read', 'fetch', 'view', 'find', 'lookup', 'browse', 'describe', 'show',
  'count', 'download', 'retrieve', 'preview', 'whoami', 'ping', 'status',
]);

const ACTION_VERBS = new Set([
  'send', 'create', 'update', 'delete', 'write', 'post', 'draft', 'book', 'move', 'share', 'invite', 'edit',
  'remove', 'add', 'set', 'put', 'patch', 'trash', 'untrash', 'archive', 'unarchive', 'publish', 'unpublish',
  'submit', 'save', 'cancel', 'reply', 'forward', 'upload', 'rename', 'copy', 'duplicate', 'insert', 'append',
  'modify', 'mark', 'unmark', 'label', 'unlabel', 'apply', 'assign', 'unassign', 'reserve', 'schedule',
  'reschedule', 'order', 'pay', 'buy', 'purchase', 'transfer', 'withdraw', 'sign', 'approve', 'reject', 'accept',
  'decline', 'respond', 'rsvp', 'join', 'leave', 'subscribe', 'unsubscribe', 'enable', 'disable', 'toggle',
  'execute', 'exec', 'run', 'deploy', 'merge', 'commit', 'push', 'close', 'open', 'start', 'stop', 'restart', 'kill',
  'grant', 'revoke', 'import', 'export', 'sync', 'checkin', 'remember', 'forget', 'memorize', 'end', 'clear', 'reset',
  'restore', 'revert', 'undo', 'redo', 'notify', 'comment', 'react', 'like', 'follow', 'unfollow', 'mute',
  'block', 'report', 'flag', 'pin', 'unpin', 'star', 'unstar', 'snooze', 'resolve', 'complete', 'confirm',
  'install', 'uninstall', 'register', 'connect', 'disconnect', 'authorize', 'authenticate', 'login', 'logout',
  'rotate', 'replace', 'upsert', 'overwrite', 'fill', 'click', 'type', 'press', 'act', 'action', 'navigate', 'request',
  'promote', 'rollback', 'generate', 'suggest', 'change', 'store', 'record', 'log', 'track', 'attach', 'detach',
  'link', 'unlink', 'tag', 'untag', 'rate', 'vote', 'refund', 'charge', 'invoice', 'dismiss', 'destroy', 'purge',
  'erase', 'wipe', 'drop', 'truncate', 'terminate', 'launch', 'spawn', 'trigger', 'invoke', 'emit', 'dispatch',
  'broadcast', 'transmit', 'call', 'email', 'tweet', 'build', 'rebuild', 'provision', 'migrate', 'kick', 'ban',
  'escalate', 'offboard', 'onboard',
]);

/** Words that make a "read" too broad to trust by name: generic query / URL / code runners. */
const RISKY_WORDS = new Set([
  'query', 'queries', 'sql', 'url', 'urls', 'uri', 'http', 'https', 'eval', 'shell', 'command', 'cmd', 'script',
  'code', 'python', 'bash', 'curl', 'wget', 'webhook', 'api', 'graphql', 'rpc', 'proxy', 'browser',
]);

const CONJUNCTIONS = new Set(['and', 'or', 'then', 'plus']);

/** Action verbs long enough to look for inside a single word (`getANDcreate`, `searchanddestroy`). */
const HIDDEN_VERBS = [...ACTION_VERBS].filter((v) => v.length >= 5);

/** Leading words that name a service, not an action (`gcal_create_event` → create event). */
const SERVICE_WORDS = new Map<string, string>(Object.entries({
  gmail: 'Gmail',
  gcal: 'Google Calendar',
  calendar: 'Google Calendar',
  gdrive: 'Google Drive',
  drive: 'Google Drive',
  gdocs: 'Google Docs',
  docs: 'Google Docs',
  gsheets: 'Google Sheets',
  sheets: 'Google Sheets',
  google: 'Google',
  slack: 'Slack',
  notion: 'Notion',
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira',
  asana: 'Asana',
  airtable: 'Airtable',
  figma: 'Figma',
  mcp: '',
}));

/** The name's words, lowercased (camelCase and letter/digit boundaries split, separators dropped). */
export function toolTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A verb in any of its common forms: `edits`, `labels`, `created`, `sending`. */
function isVerb(set: ReadonlySet<string>, t: string): boolean {
  if (set.has(t)) return true;
  if (t.length > 3 && t.endsWith('s') && set.has(t.slice(0, -1))) return true;
  if (t.length > 4 && t.endsWith('es') && set.has(t.slice(0, -2))) return true;
  if (t.length > 4 && t.endsWith('ed') && (set.has(t.slice(0, -2)) || set.has(t.slice(0, -1)))) return true;
  if (t.length > 5 && t.endsWith('ing') && (set.has(t.slice(0, -3)) || set.has(`${t.slice(0, -3)}e`))) return true;
  return false;
}

/** Common Cyrillic/Greek lookalikes → ASCII, for describing a rejected name (never for trusting it). */
const CONFUSABLES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', Α: 'A', Ε: 'E', Ι: 'I', Κ: 'K', Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X',
};
const foldConfusables = (s: string) => [...s].map((c) => CONFUSABLES[c] ?? c).join('');

/** Printable ASCII, no spaces: the only names (and labels, spaces allowed) trusted as what they say. */
const ASCII_NAME_RE = /^[\x21-\x7e]+$/;
const ASCII_LABEL_RE = /^[\x20-\x7e]+$/;

/** Strip ids (uuids, long hex runs) and odd characters: what may be shown on the page or logged. */
function displayName(s: string): string {
  return (
    s
      .replace(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi, '')
      .replace(/[0-9a-f]{12,}/gi, '')
      .replace(/[^A-Za-z0-9_.-]/g, '')
      .replace(/^[_.-]+|[_.-]+$/g, '')
      .slice(0, 60) || 'tool'
  );
}

/** Kept for callers that only need a safe token (logs). */
export const safeToolName = displayName;
const safeConnector = (s: string) => s.replace(/[^A-Za-z0-9 +&._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

/** A namespace separator: `Server:tool`, `mcp__server__tool`, `server/tool`, `server.tool`. */
const NS_RE = /:|__|\/|\./;

/**
 * `Server:tool`, `mcp__server__tool`, `server/tool`, `server.tool` → { base: 'tool', ns: 'Server' }.
 * `ns` is null for a plain name, '' for a namespaced one whose namespace names nothing (`mcp__tool`).
 */
function splitNamespace(raw: string): { base: string; ns: string | null } {
  if (!NS_RE.test(raw)) return { base: raw, ns: null };
  const parts = raw.split(/:|__|\/|\./);
  const base = parts.pop() ?? '';
  const nsParts = parts.filter((p) => p && p.toLowerCase() !== 'mcp');
  return { base, ns: nsParts.length ? nsParts[nsParts.length - 1] : '' };
}

/** A namespace that is an id (claude.ai keys connector tools by server uuid): not a name to show. */
const isIdLike = (s: string) => /^[0-9a-f-]{8,}$/i.test(s);

/**
 * Classify a tool call from its name (conservative: unknown → action). `hints` are what the
 * tool_use block said about its connector.
 */
export function classifyTool(rawName: string, hints: ToolHints = {}): ToolInfo {
  const raw = String(rawName ?? '').slice(0, 200);
  const norm = raw.normalize('NFKC');
  // 1. Only printable ASCII names are read as what they say.
  if (!ASCII_NAME_RE.test(norm)) {
    const shown = displayName(foldConfusables(norm));
    return { kind: 'action', name: shown, label: `Using ${shown}…`, action: `use ${shown} (a tool with an unusual name)`, connector: null };
  }
  const { base, ns } = splitNamespace(norm);
  const key = base.toLowerCase();
  const name = displayName(base);

  // The label: absent (null, or only whitespace), a claude.ai built-in's, or anything else.
  const rawLabel = typeof hints.connector === 'string' ? hints.connector.normalize('NFKC').trim() : '';
  const labelled = rawLabel !== '';
  const builtinLabel = labelled && ASCII_LABEL_RE.test(rawLabel) && BUILTIN_INTEGRATIONS.has(rawLabel.toLowerCase());
  const shownLabel = labelled ? safeConnector(rawLabel) : '';
  /** claude.ai's own tool: no MCP server fields, no namespace, no label or a built-in one. */
  const own = !hints.marked && ns === null && (!labelled || builtinLabel);

  const all = toolTokens(base);
  // Service words name the connector, not the action: `gcal_create_event`, `search_gmail_messages`.
  let service: string | null = null;
  for (const w of all) {
    const s = SERVICE_WORDS.get(w);
    if (s && (service === null || service === 'Google')) service = s;
  }
  const words = all.some((w) => !SERVICE_WORDS.has(w)) ? all.filter((w) => !SERVICE_WORDS.has(w)) : all;
  const nsName = ns && !isIdLike(ns) ? SERVICE_WORDS.get(ns.toLowerCase()) || safeConnector(ns.replace(/_/g, ' ')) : '';
  const connector = (labelled && !builtinLabel ? shownLabel : '') || nsName || service || null;
  const phrase = words.join(' ').slice(0, 60) || name;

  const read = (label: string, conn: string | null = connector): ToolInfo => ({ kind: 'read', name, label, action: phrase, connector: conn });
  const action = (what: string, conn: string | null = connector): ToolInfo => ({
    kind: 'action',
    name,
    label: conn ? `Using ${conn}…` : `Using ${name}…`,
    action: what,
    connector: conn,
  });

  // 2. claude.ai built-ins: actions whoever labels them; reads and the sandbox only as claude.ai's own
  const a = ACTION_BUILTINS.get(key);
  if (a) return action(a.action, own ? a.connector : connector);
  if (own) {
    const r = READ_BUILTINS.get(key);
    if (r) return read(r, null);
    const sb = SANDBOX_BUILTINS.get(key);
    if (sb) return action(sb, null);
  }

  // 3. connector tools: only exact pairs on the allowlist run
  if (!own) {
    const entry = labelled && ASCII_LABEL_RE.test(rawLabel) ? CONNECTOR_READS.get(rawLabel.toLowerCase()) : undefined;
    const plainNs = ns === null || (ns !== '' && isIdLike(ns));
    if (entry && plainNs && entry.tools.has(base)) return read(`Using ${entry.name}…`, entry.name);
    const verbAt = words.findIndex((w) => isVerb(ACTION_VERBS, w));
    return action(verbAt >= 0 ? words.slice(verbAt).join(' ').slice(0, 60) : `use ${phrase}`);
  }

  // 4. an unknown claude.ai tool, by its words
  if (!words.length) return action(`use ${name}`);
  const squashed = words.join('');
  const at = words.findIndex((w) => isVerb(ACTION_VERBS, w) || RISKY_WORDS.has(w) || CONJUNCTIONS.has(w));
  if (at >= 0) return action(words.slice(CONJUNCTIONS.has(words[at]) ? 0 : at).join(' ').slice(0, 60));
  if (HIDDEN_VERBS.some((v) => squashed.includes(v))) return action(`use ${phrase}`);
  if (isVerb(READ_VERBS, words[0]) || isVerb(READ_VERBS, words[words.length - 1])) {
    return read(connector ? `Using ${connector}…` : `Using ${name}…`);
  }
  return action(`use ${phrase}`);
}

/** Why a turn was handed off to claude.ai. */
export type HandoffReason = 'action' | 'stall' | 'waiting' | 'unknown';

/**
 * What stopping the turn on claude.ai achieved:
 *  - `before-run`: stop_response succeeded and the conversation shows no result for the tool;
 *  - `requested`: stop_response succeeded but that couldn't be confirmed (the tool may have started);
 *  - `failed`: stop_response itself failed (claude.ai may still be running it).
 */
export type StopOutcome = 'before-run' | 'requested' | 'failed';

export const APPROVE_WARNING = 'Only approve this if you asked for it — text on the ARENA page can influence Claude.';

/**
 * The note ARENA shows when a turn is handed off (markdown; the link is the conversation's page on
 * claude.ai, which carries no org id). It says only what was checked: "stopped before it ran" only
 * when claude.ai confirmed the stop and shows no result for the tool.
 */
export function handoffNote(reason: HandoffReason, tool: ToolInfo, chatUrl: string, stallSeconds: number, stop: StopOutcome): string {
  const link = `[open this chat in claude.ai to approve ↗](${chatUrl})`;
  const withConn = tool.connector ? ` with ${tool.connector}` : '';
  let head: string;
  let tail: string;
  if (reason === 'action') {
    head = `**Claude wants to ${tool.action}${withConn}** (\`${tool.name}\`) — ${link}`;
    tail =
      stop === 'before-run'
        ? 'ARENA Ask stopped it before it ran (claude.ai shows no result from it).'
        : stop === 'requested'
          ? 'Stop requested — the action may have started; check the chat in claude.ai.'
          : "claude.ai didn't confirm the stop — the action may have started or still be running; check the chat in claude.ai.";
  } else if (reason === 'unknown') {
    head = `**Claude's answer contained a step ARENA Ask doesn't recognise** (\`${tool.name}\`) — ${link}`;
    tail =
      stop === 'failed'
        ? "claude.ai didn't confirm the stop — it may still be running; check the chat in claude.ai."
        : 'Stop requested — it may have started; check the chat in claude.ai.';
  } else {
    const what = reason === 'stall' ? `made no progress for ${stallSeconds} s` : 'is waiting for claude.ai';
    head = `**Claude's \`${tool.name}\` call${withConn} ${what}** (it may need your approval) — ${link}`;
    tail =
      stop === 'failed'
        ? "claude.ai didn't confirm the stop — it may still be running; check the chat in claude.ai."
        : 'ARENA Ask stopped this answer instead of waiting.';
  }
  return `${head}\n\n_${tail} ${APPROVE_WARNING}_`;
}
