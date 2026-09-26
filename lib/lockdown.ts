/**
 * ARENA Ask conversations are a plain tutor: the question, the ARENA context, and nothing of the
 * owner's claude.ai account. No connectors / MCP tools, no web search, no code execution, no memory
 * (read or write), no past-chat search, no profile preferences.
 *
 * How claude.ai controls this (its internal web API, verified live 2026-09-25):
 *
 * - `POST /api/organizations/{org}/chat_conversations` takes create-time parameters (the same ones
 *   claude.ai's own "new chat" sends): `project_uuid`, `include_conversation_preferences` (false =
 *   no profile preferences), `chat_memory_mode: "disabled"` (no memory tools, no past-chat search,
 *   nothing written to memory) and `is_temporary`. A `settings` object in this body is ignored.
 * - Everything else is per-conversation `settings`, copied from the account's settings when the
 *   conversation is created and changed with `PUT /api/organizations/{org}/chat_conversations/{id}`
 *   `{settings: {...}}` (202, echoes the conversation):
 *     enabled_web_search · enabled_mcp_tools (map "<server uuid>:<tool>" → bool, every connector
 *     tool) · enabled_monkeys_in_a_barrel (code execution + file creation) · enabled_saffron
 *     (memory) · enabled_bananagrams (Google Drive) · enabled_sourdough (Gmail) · enabled_foccacia
 *     (Google Calendar) · enabled_compass (Research) · enabled_megaminds (a list).
 * - Not changeable per conversation: `preview_feature_uses_artifacts` and `enabled_turmeric`
 *   ("AI-powered artifacts"). With code execution off Claude reports artifacts as unavailable, and
 *   an AI-powered artifact only ever runs when the owner opens it on claude.ai, so both are
 *   accepted.
 * - A project has its own memory: `PUT /api/organizations/{org}/projects/{id}/settings`
 *   `{memory_general_enabled: false}` (see relay.ts).
 * - The completion body's `tools` field only adds client-side tools; omitting it (or sending []) does
 *   not remove server-side ones. A few built-ins remain whatever the settings (end_conversation,
 *   tool_search, connector/plugin/skill directory search + suggestion cards, sports scores, the
 *   generic list_mcp_resources/read_resource_link, which need a connector's name; with every
 *   connector tool off Claude reports no connector loaded).
 */

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Create-time parameters for every ARENA Ask conversation. */
export const LOCKED_CREATE_PARAMS = {
  include_conversation_preferences: false,
  chat_memory_mode: 'disabled',
  is_temporary: false,
} as const;

/**
 * The feature flags claude.ai changes per conversation: each must read back as exactly `false`
 * (null, i.e. "account default", or a missing flag fails). Verified live 2026-09-25: after the
 * lockdown PUT all of these read `false`.
 */
export const KNOWN_FLAGS = [
  'enabled_web_search',
  'enabled_monkeys_in_a_barrel',
  'enabled_saffron',
  'enabled_bananagrams',
  'enabled_sourdough',
  'enabled_foccacia',
  'enabled_compass',
] as const;

/**
 * Also sent as `false`, but claude.ai ignores them per conversation (they are absent from the echo):
 * like any other `enabled_*` flag they only fail the check if they read as on.
 */
const ALSO_SEND_FALSE = ['enabled_drive_search', 'enabled_artifacts_attachments', 'enabled_imagine'] as const;

/** `enabled_*` flags that may stay on (see above). */
export const ACCEPTED_ON: ReadonlySet<string> = new Set(['enabled_turmeric']);

/** Checked separately: a map of connector tools, and a list. */
const STRUCTURED = new Set(['enabled_mcp_tools', 'enabled_megaminds']);

/** Does an unknown flag's value mean "on"? (true, a non-zero number, a non-empty list, a map with anything on, a string that isn't off). */
function onish(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return !/^(|false|off|disabled|none|0)$/i.test(v.trim());
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.values(v).some(onish);
  return true;
}

/** The value that switches an unknown flag off, in its own shape. */
function offValue(v: unknown): unknown {
  if (Array.isArray(v)) return [];
  if (isObj(v)) return Object.fromEntries(Object.keys(v).map((k) => [k, false]));
  return false;
}

/**
 * The `settings` to PUT so a conversation is locked down, given its current settings: the known
 * flags off, every connector tool in its `enabled_mcp_tools` off, `enabled_megaminds` empty, and
 * any other `enabled_*` flag that reads as on (a feature newer than this code) off too.
 */
export function lockdownSettings(current: unknown): Obj {
  const cur = isObj(current) ? current : {};
  const out: Obj = {};
  for (const [k, v] of Object.entries(cur)) {
    if (k.startsWith('enabled_') && !STRUCTURED.has(k) && !ACCEPTED_ON.has(k) && onish(v)) out[k] = offValue(v);
  }
  for (const k of [...KNOWN_FLAGS, ...ALSO_SEND_FALSE]) out[k] = false;
  const mcp = isObj(cur.enabled_mcp_tools) ? cur.enabled_mcp_tools : {};
  out.enabled_mcp_tools = Object.fromEntries(Object.keys(mcp).map((k) => [k, false]));
  out.enabled_megaminds = [];
  return out;
}

/**
 * Why `settings` is NOT locked down ([] = it is). Fail-closed:
 *  - every KNOWN_FLAGS flag must be exactly `false`;
 *  - `chat_memory_mode` must be "disabled";
 *  - `enabled_megaminds` must be an empty list;
 *  - `enabled_mcp_tools` must be a map whose every value is `false`, containing each of
 *    `requiredMcpKeys` (the connector tools the conversation started with). Tools missing from the
 *    map are allowed: the account's own map lacks many current connector tools (verified live:
 *    tool_search in a locked conversation found none of them). The backstop for anything this check
 *    can't see is the stream's tool kill switch (claude.ts): any tool call ends the answer.
 *  - any other `enabled_*` flag must not read as on (ACCEPTED_ON excepted).
 */
export function lockdownViolations(settings: unknown, requiredMcpKeys: readonly string[] = []): string[] {
  if (!isObj(settings)) return ['settings'];
  const v = new Set<string>();
  for (const k of KNOWN_FLAGS) if (settings[k] !== false) v.add(k);
  if (settings.chat_memory_mode !== 'disabled') v.add('chat_memory_mode');
  const mcp = settings.enabled_mcp_tools;
  if (!isObj(mcp) || Object.values(mcp).some((x) => x !== false) || requiredMcpKeys.some((k) => mcp[k] !== false)) {
    v.add('enabled_mcp_tools');
  }
  const mm = settings.enabled_megaminds;
  if (!(Array.isArray(mm) && mm.length === 0)) v.add('enabled_megaminds');
  for (const [k, val] of Object.entries(settings)) {
    if (k.startsWith('enabled_') && !STRUCTURED.has(k) && !ACCEPTED_ON.has(k) && onish(val)) v.add(k);
  }
  return [...v];
}

/** Connector tool keys in a settings object (to require them all off after the PUT). */
export function mcpKeys(settings: unknown): string[] {
  return isObj(settings) && isObj(settings.enabled_mcp_tools) ? Object.keys(settings.enabled_mcp_tools) : [];
}
