# ARENA Ask: design notes

The internals behind the [README](../README.md): how a question travels, what each mode does, how
tool calls are classified and handed off, how My ChatGPT drives chatgpt.com, and the full security
model. Everything here was verified against the live services on the dates given. claude.ai's and
chatgpt.com's internal APIs are undocumented and may have changed since; so may ARENA's page.

- [Claude: the path of one question](#claude-the-path-of-one-question)
- [Modes](#modes)
- [Full mode (default)](#full-mode-default)
- [Locked mode](#locked-mode)
- [My ChatGPT](#my-chatgpt)
- [Security model](#security-model)

## Claude: the path of one question

```
learn.arena.education tab
┌──────────────────────────────────────────────────────────────────────────────┐
│ ARENA right-sidebar.js: fetch('/api/chat/', {messages, context, model})       │
│   │                                                                          │
│   ▼ MAIN world · arena-page      wraps window.fetch; model 'my-claude' is     │
│   │                              answered with a streamed Response (no secrets)│
│   │ window.postMessage {type:'ask', id, prompt, context}                     │
│   ▼ ISOLATED world · arena       needs a trusted Send/Enter gesture; validates,│
│                                  rate-limits, reads ARENA history, adds the   │
│                                  dropdown option, renders answers             │
└───┼──────────────────────────────────────────────────────────────────────────┘
    │ runtime port "arena-ask" (delta… done|error; ping every 20 s)
    ▼
background service worker        per-chapter state (its IndexedDB), picks a transport
    │
    ├─① offscreenFrame ─ offscreen.html ─iframe─▶ claude.ai/new ─┐   (Chrome, preferred)
    ├─② claudeTab ────── an open claude.ai tab ─────────────────┤   relay content script:
    └─③ newTab ───────── claude.ai/new, pinned + inactive ──────┘   same-origin claude.ai API
                                                                    (full: org → create → settings → SSE;
                                                                     locked: org → project → create → lock → SSE)
```

1. ARENA's own code validates the model against `#chat-model`, builds the context string and calls
   `fetch('/api/chat/')`. The MAIN-world wrapper claims only POST `/api/chat/` with
   `model: 'my-claude'` and hands `{prompt, context}` to the bridge. ARENA then renders the stream
   and saves history exactly as it does for its own models; its "..." loading indicator keeps
   running until the first text arrives. If ARENA aborts the request (or cancels the body), the
   wrapper sends `cancel`, which stops the answer all the way to claude.ai (`stop_response`).
2. The bridge accepts the ask only for a question the user typed and sent (`lib/gesture.ts`; see
   "Security model"): a **trusted** click on ARENA's real send button or Enter in its real box,
   with the box holding exactly what trusted typing produced. That gesture is a one-shot token for
   that question, valid for 60 s (ARENA fetches its context first, which can take seconds) and for
   the chapter it was made on; once used, the text it covered no longer counts as typed. The bridge
   sends the question, the chapter (the one the page was loaded for, see "Security model"), and
   ARENA's saved history to the background.
3. The background loads the chapter's conversation state and gets a **relay**: the
   `claude-relay` content script running *inside* claude.ai, where every API call is same-origin
   with your session. Transports, in order:
   1. **offscreenFrame** (Chrome): an invisible claude.ai iframe in the extension's offscreen
      document. It's created on the first question and closed after 10 idle minutes. Framing is
      allowed by a **session** DNR rule that strips `X-Frame-Options` / `Content-Security-Policy`
      (+ `-Report-Only`) from `claude.ai` **sub_frame** responses with **tabId -1** and
      **initiatorDomains = this extension's id**, i.e. only frames this extension loads outside a
      tab. Normal claude.ai tabs, and claude.ai framed anywhere else, are unaffected (verified:
      framing claude.ai from an ARENA tab is still refused). The whole CSP has to go because DNR
      can't edit a header and claude.ai's CSP carries a per-response script nonce. A stale rule
      with no offscreen document is removed when the service worker starts. Such a frame has no
      tab id, so each waiting question wakes it with its own nonce and the frame opens one port
      per nonce: any number of questions run in it at once. The document is never closed, rebuilt
      or reloaded while a question is using or waiting for it.
   2. **claudeTab**: any open claude.ai tab running the relay (`chrome.tabs.connect`).
   3. **newTab**: opens `https://claude.ai/new` pinned and inactive, then waits for its relay. The
      tab's id is remembered and the same tab is reused (reloaded once if its relay never
      answers); ARENA Ask never has more than one.

   A Cloudflare challenge on the frame's first request usually clears by itself: the frame relay
   polls for up to 12 s, then the background reloads the frame once and retries. If the frame
   never connects, reports `logged_out`, or is still challenged, the same question is retried
   once through a tab (where you can log in or solve a challenge), the frame is skipped for 60 s
   (10 min for `logged_out`) and rebuilt on its next use. A question whose frame port doesn't
   arrive while other questions are using the frame just goes to a tab. Why not fetch from the
   service worker? Those requests get Cloudflare-challenged (the partitioned `cf_clearance` is
   never sent from extension contexts) and would need a forged `Origin`.
4. The relay picks the org: in **locked mode** the one claude.ai itself is using (its
   `lastActiveOrg` cookie, if that org can chat); in **full mode** the org full mode was first used
   in (pinned by the background, see "Full mode"), which must be a personal one. It decides
   new-vs-continue (see `lib/conversation.ts`; unknown ARENA history always means new; a
   conversation is only continued in the mode it was made in). What it does next depends on the mode
   the background read (see "Modes"): in **full mode** a new conversation is a plain chat created
   with the web app's defaults (code execution off, confirmed from claude.ai's echo before anything
   is sent), and a stored one is continued while it exists outside any project (with code execution
   still off); in **locked mode** the conversation is locked down before anything is sent to Claude
   (see "Locked mode"). A conversation created for a question that never went out (aborted,
   lockdown or settings failed) is deleted.
   Relays run this setup one at a time (the background's setup lock, released when a relay reports
   `started`), so concurrent first questions in locked mode share one project. The relay then
   streams the completion (Anthropic streaming events + claude.ai's `message_limit`); only a stream
   that ends with `message_stop` counts as an answer (otherwise `incomplete`, and the previous
   parent is kept). Tool calls: full mode runs read-only ones and hands off the rest, and anything in
   the stream it can't account for ("Full mode: tools"); locked mode ends the answer at the first
   sign of any (`tool_blocked`). An answer is stopped after 5 minutes (10 once a tool ran) or
   200,000 characters (`too_long`); after any
   failure mid-answer the relay calls claude.ai's `stop_response`. SSE keep-alive pings don't count
   as progress, so a stalled answer also trips the background's 180 s silence watchdog. A 429 is the
   usage limit only if it has a reset time; otherwise it's throttling and is retried once. Text
   deltas are forwarded one by one; the new state goes back to the background, which stores it.
5. When the answer completes, the bridge renders it with a small escape-first markdown renderer
   plus an allowlist sanitizer, adds copy buttons (ARENA's `.code-copy-button` look) and the
   footer, and records `(answer position, conversation, hash(answer)) → {conversation, usage}` so bubbles ARENA re-renders from
   localStorage get the same treatment on reload. The Claude footer shows the usage windows
   claude.ai reported with the answer (`7d 74% · 5h 4%`), the one closest to its limit first, each
   amber from 80% and red from 95% (ARENA's `[data-theme="dark"]` gets lighter shades); the tooltip
   explains both, and a window claude.ai didn't report is left out. A ChatGPT footer never shows
   one.

All ARENA selectors, endpoint paths and storage keys live in **`lib/arena-selectors.ts`**. The
claude.ai endpoints are in **`lib/claude.ts`** (adapted from the [Tangent](https://github.com/fernandosmither/claude-tangents) extension).

## Modes

The mode lives in the background's own IndexedDB (`arena-ask` / `state`, key `mode`), which page
and content scripts can't reach, and is read for every question. Absent: full mode (the default).
`'locked'`: locked mode. Anything else, `null` included: locked (fail closed).

It is set on the **Options page** ("Claude access": Full account / Locked). The page doesn't touch
storage itself: it sends a runtime message, and the background accepts settings messages only from
the options page (`lib/settings.ts`: the sender is this extension and its document URL is the
options page's; content scripts, which share the extension id but report their web page's URL,
get no answer and change nothing). The same settings, plus a few advanced ones, are available as
helpers in the extension's service-worker console (`chrome://extensions` → ARENA Ask → "service
worker"):

```js
await arenaAsk.setMode('locked') // plain tutor
await arenaAsk.setMode('full')   // back to full mode (the default)
await arenaAsk.mode()            // which one is on
await arenaAsk.forgetAccount()   // full mode pins the account of its next question again (Options: Forget pinned account)
await arenaAsk.forgetAccount('chatgpt') // the same for My ChatGPT
await arenaAsk.setModel('chatgpt', 'gpt-5-6-thinking') // My ChatGPT's model (null: the page's default)
await arenaAsk.setGptDoNotRemember(true) // opt in: My ChatGPT's chats "don't remember" (Options: ChatGPT memory; off by default)
```

`arenaAsk` exists only in the service worker's own global scope. Versions before this kept the mode
in `chrome.storage.local['arenaAsk.mode']`, which content scripts can write; a value found there is
migrated once (it can only make things stricter: `'locked'` or anything unrecognised becomes locked
unless a mode is already stored, `'full'` changes nothing) and removed.

**My ChatGPT runs in full mode only**: in locked mode it refuses with "My ChatGPT is only available
in full mode". chatgpt.com has no per-chat lockdown to rely on (its request fields for disabling
tools are ignored, tested live; see "My ChatGPT: tools"), so a locked ChatGPT would be a promise it
can't keep.

A conversation is only continued in the mode it was made in (`mode: 'full'` in its stored state;
state from before modes existed counts as locked). After a switch, the chapter's next question
starts a new conversation, which gets that chapter's earlier ARENA chat (minus stopped questions);
the old conversation stays on claude.ai untouched.

## Full mode (default)

Verified live 2026-09-25 (docs/TESTING.md).

- **Account**: full mode runs only in a personal claude.ai organization (`capabilities` with
  `chat`, no `raven_type` and no `raven`/team/enterprise capability; a personal paid org reads
  e.g. `["claude_<plan>", "chat"]`, `raven_type: null`). The org of its first question is **pinned** in the
  background's IndexedDB (the relay reports it in `started`, which never reaches the page) and used
  from then on, whatever org claude.ai has active. A team/enterprise org, or a pinned org that isn't
  logged in, is refused ("ARENA Ask didn't send your question…" with what to do; `wrong_account`).
  The pin is read under the setup lock and its write is awaited before that lock is released, so
  two first questions at once both end up in the first one's org; a pin that can't be read refuses
  the question (never runs unpinned). The Options page's "Forget pinned account" (or
  `await arenaAsk.forgetAccount()` in the service-worker console) unpins it; a question that read the
  pin before the forget can't pin afterwards, and one retried after it (e.g. through a tab when the
  hidden frame failed) is refused (`lib/pins.ts`). Every pin read and write has a 5 s deadline: a
  read that doesn't answer refuses the question, a write that doesn't is held in memory (and undone
  if it lands after a forget). Locked mode doesn't use the pin: it
  runs in whichever org claude.ai has active.
- **Create**: `POST /api/organizations/{org}/chat_conversations` `{uuid, name, model,
  include_conversation_preferences: true, is_temporary: false}` (`FULL_CREATE_PARAMS`), plus
  `chat_memory_mode: "enabled"` when the account has memory on (`/api/account`
  `settings.enabled_saffron`; only that boolean leaves the relay), as the web app's own new chats
  have it; it is never forced on an account with memory off. No project.
- **Web-app defaults**: right after the create, `PUT …/chat_conversations/{id}` `{settings:
  {enabled_monkeys_in_a_barrel: false, effort_level: "xhigh"}}` (`FULL_NEW_SETTINGS`): code execution
  and file creation off, as in the web app's composer (a REST-created chat has it on), and the app's
  effort level. Verified live: the echo shows both, with memory, past-chat search and web search
  still on. Code execution must read back exactly `false`, or the question isn't sent and the new
  chat is deleted ("couldn't confirm that code execution is off…"). A follow-up switches it off
  again (only that flag) if it was turned back on in claude.ai.
- **Follow-ups** continue the stored chat while it exists and is outside any project. One the owner
  moved into a project (which would add that project's instructions, knowledge and memory) is left
  alone and a new plain chat starts.
- **Completion**: the same body as locked mode (`prompt`, `parent_message_uuid`, `timezone`,
  `model`, `rendering_mode: "messages"`, `turn_message_uuids`, `attachments`), plus `tools:
  [{type: "web_search_v0", name: "web_search"}]` when the conversation's settings have web search
  on: claude.ai's REST completion only offers web search when the request declares it.
- **The web app itself** no longer creates chats through this REST API: a new chat goes through a
  Connect-RPC service, `/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/`
  `GetNewConversationDefaults` → `PerformAction` → `StreamTimeline`, in binary protobuf. Its
  defaults (which also answer in JSON) give regular chats `workMode: WORK_MODE_TOOL_FAULT_PROXY` and
  a `permissionMode`, and carry no memory, effort or code-execution fields; so ARENA Ask keeps the
  REST API and sets those three itself (above). Connector tools are not offered to a REST completion
  at all: `tool_search` for Calendar tools finds none, although the conversation's connector-tool
  map has them on.

### Full mode: tools (`lib/tools.ts`)

Every tool call is classified from its name the moment Claude starts it (the stream's
`content_block_start` of a `tool_use` / `server_tool_use` / `mcp_tool_use` block, before claude.ai
runs it), with the block's integration label and MCP fields as its identity:

| Class | What happens | Examples |
|---|---|---|
| read | runs; a status line under the bubble | claude.ai's own `web_search`, `web_fetch`, `conversation_search`, `recent_chats`, `read_conversation`, `tool_search`, `list_mcp_resources`, `read_resource_link`, `image_search`; Gmail / Google Calendar / Google Drive reads by exact (label, name) pair (`search_threads`, `list_events`, `read_file_content`, …); an unknown unlabelled tool whose name clearly only reads (`browse_menu`, `whoami`) |
| action | stopped at its start and handed off | `send_message`, `create_event`, `update_file`, `memory_user_edits`, `end_conversation`, `suggest_connectors`; claude.ai's sandbox (`bash_tool`, `repl`, `code_execution`, `create_file`, `str_replace`, `view`, `present_files`, `artifacts`); every other connector tool; `query`, `fetch_url`, `exec_*`; anything unknown |

Rules, in order:

1. The name is NFKC-normalised; anything but printable ASCII left (a homoglyph, a zero-width
   character) makes it an action.
2. claude.ai built-ins count only as claude.ai's own tool: no MCP server fields, no namespace, and
   no integration label or one claude.ai gives its own tools (seen live: "Search Past
   Conversations", "Tool Search", "File Creation"; compared exactly; a label that sanitises to
   nothing still counts as a label). Its read built-ins read; its sandbox and file tools are actions
   (code there runs unattended with network access, so an injected instruction could use it to send
   data out; full mode also switches code execution off per chat, this is the backstop). Memory
   edits and `end_conversation` are actions under any identity.
3. A connector tool (MCP server fields, any namespace such as `Server:tool`, `mcp__server__tool`,
   `server/tool`, `server.tool`, or a label that isn't claude.ai's own) is an action unless its exact
   (label, name) pair is on the allowlist (`CONNECTOR_READS`: reads of claude.ai's Gmail, Google
   Calendar and Google Drive connectors). A connector's `create_file` is never the sandbox's.
4. Anything else (an unknown, unlabelled claude.ai tool), by its words (split on `_ - . : /`,
   camelCase and letter/digit boundaries): an action verb (send, create, update, delete, write,
   replace, overwrite, destroy, purge, launch, trigger, invoke, run, exec, …, plurals and past forms
   included), a risky word (query, sql, url, http, exec, eval, shell, code, api, browser, …), a
   conjunction (`and`/`or`/`then`/`plus`) or an action verb hidden inside one word (`getANDcreate`)
   makes it an action; otherwise a read verb as the first or last word (search, list, get, read,
   fetch, view, find, browse, show, download, …) makes it a read; anything else is an action.

- **Stream guard** (`lib/claude.ts`, `lib/sse.ts`): every running tool call is tracked by its
  content block and `tool_use` id, several at once, each with its own stall timer. Only that call's
  own events (its input, its block's end, deltas in its block) count as its progress; keep-alive
  pings and other blocks' events don't. A result must name a running call (by `tool_use_id`; without
  one, the only running call, or the only one of that name); input for a call that never started,
  a result for no running call, a tool-ish block of a non-standard type (`mcp_call`,
  `function_call`), any unknown content block type, content in `message_start`, and text inside a
  `tool_use` block all stop the answer and hand it off ("Claude's answer contained a step ARENA Ask
  doesn't recognise"). A tool result's own text is never answer text. Text after a call whose block
  has ended settles it (Claude can only continue once it has the result; the fallback when no
  result block is streamed); text never settles a call whose block is still open.
- **Handoff**: the relay calls `stop_response` and ends the answer with **Claude wants to create
  event with Google Calendar** (`create_event`) — [open this chat in claude.ai to approve
  ↗](https://claude.ai/chat/…), then what the stop achieved, checked, not assumed:
  - "ARENA Ask stopped it before it ran (claude.ai shows no result from it)." only when
    `stop_response` succeeded and claude.ai's copy of the turn (read back twice within ~2.5 s,
    `?tree=True&rendering_mode=messages`; only a verdict leaves the relay, never content) has no
    result block for that call's `tool_use` id;
  - "Stop requested — the action may have started; check the chat in claude.ai." otherwise;
  - "claude.ai didn't confirm the stop — …" when `stop_response` failed.

  Every note ends with "Only approve this if you asked for it — text on the ARENA page can influence
  Claude." The detection is at the call's start, so it can't be earlier than that, and "no result"
  isn't proof that nothing happened (a tool whose effect landed but whose result was never saved
  would look the same). Claude's stopped turn stays on claude.ai (`user_canceled`), so "approve"
  means asking again there, where you see what runs. The question and the note ARENA saves as its
  answer are both skipped like a blocked question: the next ARENA turn continues from the last
  complete answer and replays neither.
- **Stalls**: a running tool with no progress of its own for 45 s (most likely waiting for an
  approval prompt nobody can see in the hidden frame) is handed off the same way ("Stop requested"
  / "stopped this answer instead of waiting"), and so is a tool still running when the stream ends.
- **Deadlines**: 5 minutes for an answer without tools, 10 minutes once a tool ran (the
  background's backstop moves with it, +90 s); 200,000 characters either way.
- **Status line**: a sibling element right under ARENA's bubble (`.arena-ask-status`, italics). Its
  text is a fixed label or "Using <connector>…" / "Using <tool name>…" with namespaces and ids
  stripped, never the tool's input or result and never a chat id. It goes away when text resumes or
  the answer ends, and is never part of the text ARENA saves. (The handoff note's "open this chat"
  link does carry the chat's id, as the footer's "Open in claude.ai ↗" link does.)

## Locked mode

How claude.ai controls tools and memory (its internal web API, verified live 2026-09-25; the
details are in `lib/lockdown.ts`):

- **Create** `POST /api/organizations/{org}/chat_conversations` with `project_uuid`,
  `include_conversation_preferences: false` (no profile preferences), `chat_memory_mode:
  "disabled"` (no memory tools, no past-chat search, nothing written to memory), `is_temporary:
  false`. Settings in this body are ignored.
- **Lock** `PUT /api/organizations/{org}/chat_conversations/{id}` `{settings: {...}}` (202, echoes
  the conversation): `enabled_web_search`, `enabled_mcp_tools` (every `"<server>:<tool>"` → false),
  `enabled_monkeys_in_a_barrel` (code execution + file creation), `enabled_saffron` (memory),
  `enabled_bananagrams` / `enabled_sourdough` / `enabled_foccacia` (Drive / Gmail / Calendar),
  `enabled_compass` (Research), `enabled_megaminds: []`, plus any other `enabled_*` flag that reads
  as on. The echo must show: each of those seven flags exactly `false` (null = "account default"
  fails), `enabled_megaminds` exactly `[]`, every `enabled_mcp_tools` value `false`, memory mode
  `disabled`, and no other `enabled_*` flag on (`enabled_turmeric` excepted); otherwise the question
  isn't sent. `enabled_drive_search` / `enabled_artifacts_attachments` / `enabled_imagine` are sent
  too but claude.ai ignores them per conversation (absent from the echo).
- **Connector tools missing from the map** are allowed: the account's own `enabled_mcp_tools` lacks
  many current Gmail/Calendar tool keys (and `tool_search` in a locked conversation finds none of
  them). The backstop for anything the settings check can't see is the stream's **tool kill
  switch**: the first tool call of any kind stops the answer (`stop_response`) and ARENA shows
  "Claude tried to use a tool; ARENA Ask blocks tools in locked mode". claude.ai runs server-side tools itself,
  so that one call may already have run (live: a request to call `list_mcp_resources` for Gmail
  became a `tool_search` call that found nothing, then was stopped; it used to hang for minutes on
  keep-alive pings). The blocked question is remembered as skipped, so it is never replayed to
  Claude as earlier chat; ARENA messages Claude hadn't seen before it are still sent next time. If
  that conversation later has to be replaced (deleted or moved in claude.ai, its project no longer
  usable), the new one gets none of the ARENA chat the old one had seen, and still skips the
  blocked questions after it.
- **Project** memory: `PUT /api/organizations/{org}/projects/{id}/settings
  {memory_general_enabled: false}` (it answers with the new value). Only the project this extension
  created and stored is used, never "any project named ARENA", and it's the only project whose
  settings the extension ever changes. It must stay private, unarchived, without instructions and
  without knowledge (`docs_count + files_count = 0`), with memory proven off (unreported memory
  counts as off only if the settings PUT answers `false`); if it doesn't, a new project is made and
  the old one left alone. After switching memory off, the project is read back and checked in full
  again (not just its memory). Projects the extension created but never put a conversation in (a
  question that failed or was cancelled after creating one) are deleted later, only if still
  empty, private and named/described as the extension names its project; a failed DELETE (or a
  conversation count that can't be read) is retried by a later question.
- Not changeable per conversation, and accepted: `preview_feature_uses_artifacts` and
  `enabled_turmeric` (AI-powered artifacts). With code execution off Claude reports artifacts as
  unavailable.
- What Claude still lists after the lockdown (live): `end_conversation`, `fetch_sports_data`,
  `search_mcp_registry`, `suggest_connectors`, `search_plugins`, `suggest_plugin_install`,
  `search_skills`, `suggest_skills`, `suggest_research`, `tool_search`, and the deferred generic
  `list_mcp_resources` / `read_resource_link` (which need a connector's name; with every
  connector tool off Claude reports no connector loaded). These are claude.ai built-ins that no
  setting or completion field (`tools: []` included) removes.

## My ChatGPT

Verified live 2026-09-25 (Chrome for Testing, a personal ChatGPT test account with connectors;
docs/TESTING.md, round 8), and again after the review fixes on 2026-09-26 (round 9).

Pick **My ChatGPT** in ARENA's dropdown. The answer streams into ARENA's bubble from your own
chatgpt.com account with an **Open in ChatGPT ↗ · <model>** footer (the model the stream reports;
no usage figure, chatgpt.com doesn't stream one). One ChatGPT chat per ARENA chapter, kept apart from
the chapter's Claude chat; ARENA's **Clear chat history** starts a new one next time; follow-ups
continue it. It is a normal chat in your ChatGPT history (title chosen by ChatGPT).

### How it works

chatgpt.com guards its conversation request with sentinel tokens and a proof-of-work computed by its
own page code, so ARENA Ask never sends that request itself: it **drives chatgpt.com's own page**.

```
background ──port──▶ chatgpt.com (ISOLATED world, lib/gpt-relay.ts)   ──MessagePort──▶ MAIN world (lib/gpt-page.ts)
                     account check · plan · app router · type · Send ·    request snapshot · sign-out guard ·
                     check the request · parse the stream · Stop · readback   tee of the answer stream
```

- **Transport** (`lib/transports.ts`): a second iframe, `https://chatgpt.com/`, in the same offscreen
  document as claude.ai's (each created on its provider's first question). Framing is allowed by a
  session DNR rule that strips `X-Frame-Options`/CSP from chatgpt.com **sub_frame** responses with
  **tabId -1** whose initiator is this extension or, inside that frame, chatgpt.com itself (the relay
  moves the frame between chats with `location.replace`, and chatgpt.com frames itself); other
  extensions' requests never reach our rules, so that is our frame only (verified: framing
  chatgpt.com from an ARENA tab matches nothing). A hidden document never renders, so the offscreen
  page lays the frame out itself (without that its viewport is 0×0 and the composer takes no input),
  and wakes the frame only once chatgpt.com has loaded in it (not while it is still blank).
  Fallback: ARENA Ask's **own pinned, inactive chatgpt.com tab** (opened once, reused). It is opened
  **blank**, its sign-out block rule (below) is installed for its tab id (if that fails, the tab is
  closed and not used), and only then is chatgpt.com loaded in it, marked as ARENA Ask's page
  (`https://chatgpt.com/#arena-ask-gpt`; the MAIN world moves the marker into the tab's
  `window.name` and removes the fragment before chatgpt.com's code runs). Unlike claude.ai, the
  relay drives the page, so it **never uses your own chatgpt.com tabs** (it would navigate them
  away) and there is no tab in other Firefox containers or private windows.
- **One question at a time** across chapters (it's one page); a question waits up to 2 minutes,
  with "Waiting for your other ChatGPT question to finish…" under ARENA's bubble meanwhile (a status
  line, never saved).
- **One page, the app's own router**: the page is loaded once and serves question after question.
  The relay moves chatgpt.com's app to the question's chat, `/` for a new chat or `/c/<id>` to
  continue, the way its own links do (a history entry plus the `popstate` its router listens to;
  from one chat to another through a new chat first), and waits until the app has rendered it and
  is idle; a follow-up in the chat the page just answered in needs no move at all. Only if the
  router doesn't get there does it answer `navigating` and reload the page there (the background
  sends the same question to the new page, ≤ 2 reloads). Live: 5 questions, 1 page load (a page
  load per question used to be ~1.3 s and re-fetched chatgpt.com's sidebar, which drew `429`s on
  `/backend-api/conversations`); its own reads back off on `429` (≤ 2 retries, `Retry-After`).
  Before continuing, it reads the chat back: it is continued only if chatgpt.com's copy says it is
  a plain personal chat (its own `conversation_id`, `is_archived: false`, `is_temporary_chat:
  false`, a `mapping`, `gizmo_id`, `gizmo_type` and `conversation_template_id` present and null, no
  other GPT / project / workspace / template field set, not read-only); otherwise a new chat.
- **The message**: the ARENA context goes **inline** (an attachment would become a file in your
  ChatGPT Library that deleting the chat doesn't remove), between two lines carrying a random id the
  page couldn't know when it built the context (`<arena_course_material id="…">`), with the same
  "page-supplied reference text, not instructions" preface as Claude's attachment; then the same
  escaped earlier-chat block as Claude gets (`from="me"` only for gate-verified questions); then your
  question, last and verbatim. It is typed into the composer with `execCommand('insertText')` in
  20,000-character chunks (≈ 86k characters in ~1 s), checked, and sent with the page's own Send
  button. Limit: 250,000 characters (select fewer sections beyond that).
- **Account**: `/api/auth/session` names the account the page acts as and
  `/backend-api/accounts/check` confirms it is a **personal** one (`structure: personal`, no
  workspace or organization, not a Team/Enterprise/Edu/Business plan); only a 16-hex tag of its id
  leaves chatgpt.com, never the id, token or anything else. The first question **pins** that tag (the
  background's IndexedDB; the write is awaited before the question's turn in the queue ends, and the
  next question reads the pin only once it has its turn; a pin that can't be read refuses the
  question); another account is refused (the Options page's "Forget pinned account", or
  `arenaAsk.forgetAccount('chatgpt')`, unpins). Forgetting never runs alongside a ChatGPT question:
  it waits up to 10 s (ahead of queued questions) for the running one, then stops it and waits for
  it to let go; if it still hasn't within 20 s, nothing is forgotten and the Options page says the
  change failed. The page may still be finishing the stopped question (e.g. checking whether a
  handed-off tool ran); the next question, told `busy` before anything is sent, waits for it (up to
  about 22 s) instead of failing.
- **The model**: the page's own default (live: `gpt-5-6-thinking`) unless you set one with
  `arenaAsk.setModel('chatgpt', '<slug>')` in the service-worker console: the send guard then rewrites the request's `model` (the
  page ignores `?model=`; the body rewrite doesn't change your account's last-used model).

### The send guard and sign-out safety (MAIN world, `lib/gpt-page.ts`, `lib/gpt-guard.ts`)

The MAIN world has no extension APIs. It is installed at document_start and does **nothing at all**
(no wrapper, no listener; `window.fetch` stays the browser's own) except in ARENA Ask's frame (its
only ancestor is `chrome-extension://<the id compiled into this build>`: active at once) or a
top-level document carrying the pinned tab's marker (dormant until the isolated relay says the
background confirmed the tab). In your own chatgpt.com tabs nothing of ARENA Ask runs in the page
(verified live: no ARENA Ask wrapper, `sendBeacon` native). The two worlds talk over a
**MessageChannel** the isolated script creates at document_start (only where the MAIN world
listens): its one port is handed over in a single window message that the MAIN world's
document_start capture listener takes (the first **trusted** one only) and stops before any page
listener sees it. The MAIN world captures, at install and before any page script runs, every
browser function it relies on (the port's `postMessage` and `onmessage`, the event accessors,
`URL`, `RegExp`, `Headers`, `Request`, `Response`, stream readers, timers) and calls only those
copies, so a page script that replaces them later can't obtain the port or change what is checked.
Every message about a question carries that question's random tag; the relay ignores any other tag,
and reads no answer before its own check let the request out. Only the request body the page is
about to send, a chat id and the stream the page itself receives cross it.

- **Send guard**: the relay arms the MAIN world for one request, with the question's tag. When the
  page then calls `POST /backend-api/f/conversation`, the MAIN world reads the request **once**
  (each init field read once, the headers copied into a `Headers` object of its own, the body
  string) and hands the body and the `ChatGPT-Account-Id` to the relay, which checks them **in the
  isolated world's own realm** (page scripts can't touch its `JSON`, `String` or crypto): exactly one
  user text message whose text matches the sha256 of what the relay typed (compared after
  chatgpt.com's own markdown serialisation, which escapes punctuation, turns URLs into links and
  rewrites whitespace: `canonText` drops backslashes, collapses `[X](X)` links, decodes `&#x20;` and
  removes whitespace; words, symbols and their order must match), `action: next`, no attachments, no
  `system_hints`, GPT or project, the expected `conversation_id` (none for a new chat), and a
  `ChatGPT-Account-Id` whose tag is the checked account's. The relay returns the body to send (with
  `local_function_names` dropped, functions chatgpt.com would run in this browser such as
  `local.continue_in_work`, and the model override), serialised in its realm, and the MAIN world
  sends exactly that body with the snapshot. Anything else, a second request, one nobody armed
  (always in the frame; in the pinned tab while a question is in progress), no verdict within 15 s,
  or a conversation POST by XHR or `sendBeacon`, is never sent. A request that fails before it
  answers is reported (the question ends with a network error instead of waiting). This hardens the
  wrapper against chatgpt.com's own code misbehaving; it is **not** a boundary against hostile code
  running as chatgpt.com (which could, e.g., fetch from a fresh same-origin frame): chatgpt.com's
  page code is trusted to be chatgpt.com's.
- **Sign-out**: chatgpt.com's own code calls `POST /api/auth/signout` when a hidden frame gets a 401,
  which signs you out everywhere in the profile (it happened once while researching). So in ARENA
  Ask's frame and pinned tab, session DNR rules block `chatgpt.com/api/auth/signout` and
  `/auth/logout` for every resource type (tabId -1, and the pinned tab's id, installed before that
  tab ever loads chatgpt.com), and the MAIN world swallows them too (fetches never settle, XHRs and
  beacons go nowhere, navigations are cancelled). The first `/backend-api` 401 is reported: a
  running question ends with "ChatGPT session expired — open chatgpt.com and sign in", and the frame
  is removed and left alone for 10 minutes. Verified live: a sign-out fetch and XHR from the frame
  were swallowed and the session stayed; the DNR rules match the frame's sign-out requests and not
  your own tabs'.
- **Store builds**: the id is compiled in from the manifest key (`wxt.config.ts`). A Chrome Web Store
  build (which takes no `key`) is made by `pnpm zip:store` with the store item's id
  (`ARENA_ASK_EXTENSION_ID=<store id>`, see STORE_LISTING.md); with a wrong id the frame's MAIN world stays inert, the relay doesn't drive that frame (the background
  warns), and My ChatGPT falls back to its pinned tab.

### The answer stream (`lib/gpt-stream.ts`)

The MAIN world tees the SSE answer (`delta_encoding` "v1": `add`/`append`/`replace`/`truncate`/
`remove`/`patch` ops on `{message, conversation_id, error}` per message index `c`; later adds and
bare-string appends omit `p`/`o`) to the relay, which parses it **fail closed**:

- Only text of assistant messages to `all`, `content_type: text`, channel `final` (or none), not marked
  hidden (`is_visually_hidden*`, `is_user_system_message`, on assistant messages too), reaches ARENA,
  with citation markers (U+E200…U+E201 spans, stray U+E2xx) removed. System messages, your
  message's echo, custom instructions (`user_editable_context`, `is_user_system_message`), memory
  (`model_editable_context`), reasoning (`thoughts`, `reasoning_recap`, `analysis`/`commentary`) and
  tool results are never forwarded.
- An assistant message that doesn't name its recipient yet is **undecided**: nothing of it goes out
  until it does (a late recipient makes it a tool call, never text) or it completes (then
  chatgpt.com's default, `all`). An answer whose first `add` doesn't carry final metadata (its
  recipient, channel and `message_type` / `model_slug`, which real answers carry: verified live, they
  stream as before) is **held back whole** until it completes, so a hidden flag that arrives later
  still keeps it out; a hidden flag after text of it went out stops the answer.
- An unknown op, SSE event, typed event, role, content type or channel, a rewritten answer, a changed
  chat id, or a tool result for no call stops the answer and hands it off ("ChatGPT's answer contained
  a step ARENA Ask doesn't recognise").
- Complete = `message_stream_complete` + `[DONE]` + the answer `finished_successfully` (the page
  aborts its request after `[DONE]`: that AbortError is the normal end). Otherwise "ChatGPT ended the
  answer before it finished".
- Limits as Claude's: 5 minutes (10 once a tool ran), 200,000 characters, 45 s per running tool
  without progress of its own.

### My ChatGPT: tools (`lib/gpt-tools.ts`)

A tool call is an assistant message whose `recipient` isn't `all`, classified the moment its
recipient is known:

| Class | Recipients | What happens |
|---|---|---|
| read | `web`, `web.run`, `api_tool.list_resources`, `personal_context`; `api_tool.call_tool` only for an exact Google Drive / Gmail / Google Calendar / Outlook `search`, `fetch`, `list_*`, `get_*`, `read_*` (from the call's `/<App>/link_<id>/<action>` path, no write word in it), and only once its **whole** body is in: one JSON object (a strict scanner: no key twice anywhere, escapes decoded, nothing after it), exactly one **top-level** string `path`, on a `link_<id>` that this turn's `api_tool.list_resources` result listed as that same app (a link it didn't list, or listed for two apps: an action). Re-checked on every change of the body: a read replaced or extended afterwards becomes an action | runs; status line ("Searching the web…"); settled by its result, or by the answer continuing after the call was complete (web search results ride on the answer) |
| action | `bio` (memory), `automations`, `user_settings`, `safety_settings`, `python*`, `container*`, `local.*`, `image_gen*`, `canmore`, `file_search`, every other app action, and **anything else**: unknown or obfuscated recipients (`q7dr546` was seen right before a Drive read: it is handed off, so such reads are too) | the page's Stop is pressed at once, the chat is read back, and the answer ends with a handoff note |

The note: **ChatGPT wants to save something to your ChatGPT memory** (`bio`) — [open this chat in
ChatGPT to approve ↗](https://chatgpt.com/c/…), then "ARENA Ask stopped it before it ran (ChatGPT
shows no result from it)" only if **both** reads of the chat (2.5 s and 5 s after the Stop) find that
call by its message id, as an assistant message with an explicitly unfinished status, every node
under it read back and none a result; a call missing from the read-back, with no id or no status,
already finished there (chatgpt.com runs a call once it is complete), a gap under it or a failed
read gives "Stop
requested — the action may have run (ChatGPT's stop takes about 2 s to land)"; and always "Only
approve this if you asked for it — text on the ARENA page can influence ChatGPT." An approval or confirmation prompt appearing on the hidden page (a dialog, or buttons such as
Confirm / Allow / Deny) hands the answer off the same way instead of hanging. Skipped questions and
notes work as for Claude, except that chatgpt.com keeps the stopped turn in the chat (the page, not
ARENA Ask, picks the parent), so ChatGPT still sees it later.

**The ~2 s Stop latency, and what it means.** chatgpt.com runs a tool on its servers as soon as the
call message is complete, and the Stop the page sends (`POST /backend-api/stop_conversation`) lands
about 2 s after the click. A short call is complete long before that: **live, a `bio` (memory) call
was caught at its start and Stop was pressed at once, and the memory write still happened** (the note
said "may have run", correctly). So for ChatGPT the handoff is a report, not a barrier: an action that
text on the ARENA page talks ChatGPT into can run once before you see the note.

**What prevents actions up front** (tested live, 2026-09-25):
- The conversation request's `disabled_tool_ids` and `is_do_not_remember: true` are accepted and
  **ignored**: not stored on the chat, and `bio` still ran. A `PATCH` of `disabled_tool_ids` (or
  `memory_scope`) on the chat answers `{success: true}` and changes nothing.
- A `PATCH` of `is_do_not_remember: true` on the chat **is** stored, and with it ChatGPT has no memory
  tool: an explicit "use your memory tool to save …" then got no `bio` call ("unavailable"). The
  trade-off: ChatGPT then also reported not seeing your saved memories. So **"don't remember" is off
  by default** (ChatGPT sees your saved memories; a memory write is only handed off, and may run,
  see above) and is an **opt-in**: the Options page's "Don't let ARENA chats write to ChatGPT memory" (or
  `arenaAsk.setGptDoNotRemember(true)`). With it on, a new chat is
  marked as soon as its id appears (it takes effect from its second turn: the first turn's memory
  tool is still only handed off) and a continued chat before its question is typed; the `PATCH` is
  retried with backoff (a brand-new chat may not be stored yet, so its first `PATCH` can be lost)
  until a read-back of the chat confirms it, each request with a timeout, 20 s in all, stopped with
  the question. It **fails closed**: a question in an existing chat is never sent until the flag is
  confirmed ("ARENA Ask didn't send your question: it couldn't confirm that this ChatGPT chat is
  "don't remember" … Ask again in a moment."). The log says `nomem:on`, `nomem:failed:<why>`
  (chatgpt.com refused it or kept it off) or `nomem:slow:<why>` (no answer, or not stored yet, in
  time). Turned **off** again, it applies from the next question: a continued chat that still
  reads back as "don't remember" is unmarked the same way (`PATCH` `false`, read back; the log says
  `nomem:cleared`) before its question is typed. If that isn't confirmed the question still goes
  (the chat stays in the stricter state; the log says `nomem:failed:<why>` or `nomem:slow:<why>`),
  and the next question tries again.
- Dropping `local_function_names` is accepted (answers were normal); whether chatgpt.com would ever
  call one from here is unknown.
- Nothing else found stops connector writes (Gmail send, Calendar create, …) up front on a test
  account with connectors. They are handed off at their start and may have run. **If that matters, don't use My ChatGPT on a page you don't trust, or disconnect write access in
  ChatGPT.** No write-approval card was seen for a Drive read; whether chatgpt.com asks before a
  connector write in this setup is unverified.

## Security model

- **Where it runs**: every `learn.arena.education` page except the PR previews (`/pr-preview/*`,
  `/preview/*`, which render untrusted PR markdown on the same origin): the content scripts carry
  `exclude_matches` for them, bail out there anyway, and the background refuses asks from them.
  The runtime checks match the path after decoding ASCII escapes (repeatedly), folding slashes and
  lowercasing, so encoded or case variants (`/%70review/`, `/pr%2Dpreview/`, `/PREVIEW/`) are
  excluded too.
- **MAIN world** (`lib/page-intercept.ts`): no extension APIs, no secrets. It only posts
  `{source:'arena-ask:page', type:'ask', id, prompt, context}` (and `{type:'cancel', id}` when
  ARENA aborts) and reads back answer text and short error strings. ("Clear chat history" is
  observed directly by the isolated bridge.)
- **Bridge** (`entrypoints/arena.content.ts`, top frame only): accepts a page message only if
  `event.source === window`, `event.origin === 'https://learn.arena.education'`, it passes a
  strict schema (known keys only, string types, id format, prompt ≤ 20,000 chars, context ≤
  1,500,000 chars) **and** it matches a send gesture (`lib/gesture.ts`). Rate limits: 1 question
  in flight, ≤ 20 per minute. Every object is copied, never passed through.
- **Gesture gate** (`lib/gesture.ts`). Its listeners are registered first thing at document_start,
  in the isolated world, on `window` in the capture phase, so they run before any listener a page
  script can add (a page script's own window-capture listener included).
  - *Real nodes*: ARENA's `#chat-input`, `#chat-send-btn` and `#chat-clear-btn` are bound as the
    parser creates them and re-resolved only once they leave the page; only events targeted at
    those exact nodes count, so moving the ids to other elements does nothing.
  - *Sent*: a trusted click on the real send button, or a trusted Enter in the real box with no
    modifier, not while an IME is composing (`isComposing` / keyCode 229), not a key repeat. A
    mouse click must land inside the button's **own** border box (a `::before` stretched over the
    page doesn't count), on a shown button, with the button or its icon topmost at that point
    (`elementFromPoint`). *Shown* = no bigger than 200×120 CSS px (content moved into it makes it
    bigger), at least partly in the viewport, not `visibility: hidden`, and an effective opacity
    ≥ 0.3 (`opacity` and `filter: opacity()` of the button and every rendered ancestor multiplied).
    A click with no mouse position (`detail` 0) counts only as the browser's own click for a trusted
    Enter keypress or Space keyup on the button, in that key's task, when the user put the focus
    there with a trusted Tab (not one a page listener cancelled) and it hasn't left the button since;
    the button must also be shown and topmost at its centre. So a script's `btn.focus()` doesn't
    turn your next Space/Enter into a Send, and clicks a `<label for=chat-send-btn>` forwards to the
    button don't count.
  - *Typed*: the box's value must be exactly what trusted editing produced since the last question
    was sent. Every trusted `input` must follow its own trusted `beforeinput` (execCommand fires
    none) from a box holding only user-produced text, and be exactly the edit it announced, at the
    selection the user's keystroke found: the capture's keydown (which runs before any page
    listener) records the box's selection, and typed text, a line break or a paste must replace
    exactly that selection, a deletion must remove exactly it (or, with a caret, one run ending at the
    caret for Backspace-like deletions, starting at it for Delete-like ones), and the selection must
    still be the same when the edit starts. That record has no time limit; it ends with the edit, the
    key's keyup, a released Cmd/Ctrl or a mouse press. So a page listener that moves the caret or
    widens the selection before your keystroke (on keydown, keypress or beforeinput, however long it
    blocks first) taints the box instead of reordering or deleting your text.
    Without a keystroke (menu paste, emoji picker) the selection at our `beforeinput` counts. A paste
    = the clipboard text (`data`, else `dataTransfer` text/plain; CRLF normalized to LF like the
    textarea does; macOS smart-paste spaces allowed); a drop = the dropped text, but not text
    dragged from this page itself (a trusted `dragstart` here: the page chooses what a drag
    carries), except your own selection moved within the box; an IME update = its composition text.
    Inserts without text and `format*` edits don't count. Undo/redo (Chrome often fires no
    `beforeinput` for it) counts only when it returns to a value the user produced since the last
    send, and that value keeps the edit number it was produced with. A script writing `.value`,
    calling execCommand, dispatching synthetic input events, or rewriting the box mid-edit taints
    it; a tainted box arms nothing and voids pending gestures until the user empties it or replaces
    all of it (select all, then type or paste). Empty is always clean (ARENA clears the box after
    sending).
  - *Once, soon, same chapter*: the gesture is a one-shot token for that exact question, valid for
    60 s, voided by a later script write to the box, and bound to the chapter segment of the URL at
    the gesture. Once an ask uses it, everything typed up to that gesture, and the sent question
    itself wherever undo/redo put it, stops counting as typed (the next question typed meanwhile
    stays yours), and any other pending Send of the same text is void; so a script can't put the
    sent question back (by `.value`, or by undo/redo during or after the Send) and replay it. A
    second ask for an already-used Send (a script racing ARENA with the user's question and its own
    context) stops the running answer and is refused.
  - *Chapter*: the bridge records the URL's chapter segment when the page loads (document_start).
    `#chapter-data` (which any page script can rewrite) is used only while it names that chapter
    (pages without chapter data, ARENA's "static" chat, must not be under a `/chapterN…` path), and
    the gesture must have been made on it; otherwise the ask is refused. So a script can't point
    your question at another chapter's conversation and history.
  - *Model*: the provider a question goes to is the one **you** picked: the capture records the
    dropdown's value from trusted `input`/`change` events on ARENA's real `#chat-model` (a value a
    page listener sets between your `input` and the browser's `change` is no choice at all), or the
    choice the extension restored from its own storage; a Send arms only while the dropdown still
    shows that model (a script can set its value without any event), the gesture carries it, and
    the ask must name the same model; the bridge routes by the gesture's model, never by what
    ARENA's request says. So a script can't send your typed question to My ChatGPT while you picked
    My Claude (or the other way round).
  - *Why*: a Send that arms nothing records the reason, and ARENA's ask for that text (within 60 s)
    is refused with a specific message instead of the generic one.
  - "Clear chat history" resets the chapter's conversation only on a trusted click on the real
    button.
- **Background**: accepts `arena-ask` ports only from this extension's content script in a
  **top-level learn.arena.education frame** (not a preview page, matched on the decoded,
  lowercased path so `/%70review/` or `/PR-Preview/` count too), `relay-frame` ports only from
  claude.ai frames **without a tab** (the offscreen frame), and `relay-frame-chatgpt` ports only from
  chatgpt.com frames without a tab (My ChatGPT's frame; its pinned tab is reached with
  `chrome.tabs.connect` and asks "am I ARENA Ask's tab?" only from a chatgpt.com top frame). It re-validates every message,
  rate-limits globally (20/min), serializes questions per chapter and relay setups globally (a setup
  still running after 45 s is stopped, its relay disconnected, before the next one starts), ends
  any attempt after the answer deadline + 90 s or 200,000 characters, and never fetches claude.ai
  itself. If a relay dies mid-answer (its tab closed, the frame gone), it asks a relay that is
  already up (the offscreen frame, or an open claude.ai tab; it never opens one for this) to stop
  that answer: still inside the chapter's lock (the retry waits, ≤ 25 s), only while that turn is
  still the conversation's latest, and only in the account the turn was started in (the `stop`
  carries its org tag). It uses only claude.ai pages in the ARENA tab's own cookie store (Firefox
  container or private window via `cookieStoreId`; Chrome incognito vs normal), and opens its
  pinned tab (or the invisible frame) only for the default one. The offscreen document's
  open/close/rebuild and its framing rule are serialized, and the rule is removed whenever the
  document is closed or found missing.
- **Relay** (`entrypoints/claude-relay.content.ts`): top-level tabs accept ports only from this
  extension (`chrome.tabs.connect`). In frames it activates only when its sole ancestor is this
  extension's origin. One verb per port: `ask` (disconnecting cancels it and stops generation) or
  `stop {convUuid, orgTag}` (`stop_response` for a conversation an ARENA Ask relay started, only if
  the relay's account has that org tag, within 10 s, and never after the background hung up). A project it creates is reported to the background the
  moment it exists (a runtime message, so a cancel during the first setup can't lose it). It changes
  only the conversation it creates, the one named in the extension-owned state (in locked mode only
  while that one is inside the extension's project; in full mode only its code-execution flag, and
  only while it is outside any project), and the extension's own projects; in locked mode every
  conversation is locked down before the first completion, in full mode code execution is confirmed
  off. There is no API passthrough, and it never lists, reads or returns other conversations (a
  project cleanup only counts a project's conversations; it runs in both modes and only deletes empty
  projects this extension created; after a handoff it reads its own conversation back and returns
  only whether the stopped call has a result). It reads `/api/account` only for the memory
  setting's boolean.
- **Stored data**: the background's own **IndexedDB** (`arena-ask` / `state`, unreachable from
  content scripts) holds, per chapter, the conversation uuid, the last assistant uuid, a context
  hash and a 16-hex **tag** of the org id (sha256, not the id), the conversation's mode (`full`, or
  none for locked), the stopped (blocked or handed-off) questions and notes to skip (with a
  `blocked` flag once any was, and `renew`, see the README's "Limitations"), and up to 256 32-hex hashes of the
  questions the bridge forwarded after a trusted Send (`typed:<chapter>`, cleared with "Clear chat
  history"); plus the mode (`mode`, see "Modes"), the org full mode is pinned to (`pinnedOrg`, the
  only place the org id is kept; never sent to the page or logged), the extension's project uuid
  (with its org tag) and the uuids of the projects it created (marked used once a conversation
  lives in one). v1's `conv.v1.*` keys in `chrome.storage.local` (writable by content scripts) are
  deleted at startup, and so is a legacy `arenaAsk.mode` there (after migrating it, see "Modes").
  `meta.v1.<chapter>` (`chrome.storage.local`) holds answer-hash → conversation uuid + usage.
  `chrome.storage.session` holds the relay/pinned tab ids (per cookie store) and the offscreen
  cooldown / rebuild flags. `chrome.storage.local['arenaAsk.modelChoice']` remembers your
  dropdown choice (saved only on a trusted change of the dropdown; older builds kept it in ARENA's
  `localStorage['arena-ask:model']`, which page scripts can write: that key is removed, never read).
  My ChatGPT adds, in the same IndexedDB: the chapter's ChatGPT chat (`gpt:<chapter>`, same shape; its
  `orgTag` is the ChatGPT account's tag), the pinned account tag (`pinnedGpt`), and the owner's
  `model:chatgpt`, `patch:chatgpt` and `doNotRemember:chatgpt` settings (`true` only when you opted
  in; absent, or the `false` older builds stored, is off); a new chat is saved as soon as it exists
  (so interrupting its first answer doesn't orphan it: the next question continues it, and the
  interrupted answer links it); `chrome.storage.session` its pinned tab id (`gptOwnTabId`) and frame
  cooldown/rebuild flags (`…:chatgpt`). The IndexedDB is opened at whatever version it has; if its
  store is missing (something opened `arena-ask` without a version first), it is rebuilt one version
  up instead of every read failing (which would read the mode as locked for good; verified live).
- **Never logged**: cookies, tokens, org ids, account ids, conversation ids, message content. No
  telemetry, no third-party servers. (A ChatGPT answer's log line lists the kinds of messages its
  stream carried, e.g. `assistant:all:text:final`, names only.)
- **Permissions**: `storage` and `declarativeNetRequest`, plus `offscreen` on Chrome. Hosts are
  `https://claude.ai/*`, `https://chatgpt.com/*` and `https://learn.arena.education/*` only.
- **What the gate guarantees**: a question goes out only after a trusted Send of yours (as above),
  once, within 60 s, from the chapter the page was loaded for, with the box holding only text your
  own editing produced since your last question: your keystrokes applied where your keystroke
  found the caret or selection, your pastes, your IME input, drops from outside the page, and
  undo/redo among those.
- **Accepted risks** (what it does not guarantee): scripts on learn.arena.education run in the same
  world as ARENA's own code, so they can:
  - read the answers ARENA shows (it's their page) and supply or alter the context ARENA builds (it
    is page data either way); they can change the model the dropdown shows, but a Send then refuses
    until you pick it again, and they can't send your question to another provider than the one
    you picked;
  - choose what you paste: a page `copy`/`cut` handler, or its own copy buttons
    (`navigator.clipboard`), can put any text on your clipboard. The gate proves you pasted it, not
    who wrote it; you see it in the box before you send it;
  - make an unintended Send land on the real button, so the text you have typed so far goes out
    early: move the button under your pointer, cover it with something that ignores the pointer
    (`pointer-events: none`) or paint it transparent (the gate checks the button's size, viewport,
    visibility and opacity, not what you actually see), or put the focus on it as your own Tab moves
    focus (you see the focus ring on it);
  - call undo/redo (`execCommand`) to move the box between states you typed since your last
    question.

  They can't send a question you didn't type, rewrite or reorder the one you typed, or send it
  again later. The hidden claude.ai frame runs without claude.ai's CSP (only that frame, only loaded
  by this extension).

- **Full mode, what a malicious script on learn.arena.education can do**: it can't send a question
  you didn't type (the gate is the same in both modes). It **can** plant instructions in what ARENA
  hands over with your question: the lesson context ARENA builds and the chat history ARENA saved
  in `localStorage` (page data either way). They ride along with **your** next question, and the
  script reads the answer from the page. In full mode that answer can contain personal data: your
  memory, profile preferences and past chats, and whatever read tools return (web pages; connector
  data if claude.ai ever offers connectors to these chats). Read tools can also carry data out: a
  `web_fetch` or `web_search` request goes to a URL or query an injected instruction may choose.
  What ARENA Ask does to keep that small:
  - the context attachment starts by saying it is page-supplied reference text, not instructions;
  - the earlier ARENA chat is one escaped element per message, and only a user message whose text
    matches a question the bridge itself forwarded after a trusted Send (recorded by the background,
    per chapter) is marked `from="me"`; every other message (answers, questions sent with other
    models, anything planted) is `from="page"`, under a preface saying the page can change it. A
    planted `</earlier_arena_chat>`, `<message from="me">` or "User:" line is inert text;
  - the chapter title is quoted as the page's, one line, at most 80 characters, escaped;
  - nothing can **change** anything or run code from the hidden frame: code execution is off in
    every full-mode chat (confirmed before anything is sent), and every side-effecting tool call
    (send, create, update, delete, write, post, draft, book, move, share, invite, memory edits,
    ending the chat, code and file tools, other connectors, anything unknown) is stopped at its
    start and handed off to you on claude.ai with a note that says what the stop achieved and
    "Only approve this if you asked for it — text on the ARENA page can influence Claude."
  The limits: injection is made harder, not impossible (a model can still follow page text); the
  guard is a classifier over tool names and a stop after the call's start (see "Full mode: tools");
  and **memory**: claude.ai builds its memory from your chats, so text from an ARENA page that
  ends up in a full-mode chat (lesson context, planted history, an answer shaped by them) may be
  summarised into your claude.ai memory like any other chat, without any tool call ARENA Ask could
  stop. Review your memory in claude.ai's settings if a page looks off. If any of that matters for
  a session, switch to locked mode: no memory, past chats, preferences, connectors or web search,
  and any tool call stops the answer at once (claude.ai may already have run that one call).
- **Mode and account**: the mode and the pinned org live only in the background's IndexedDB and
  change only through the background: from the Options page (whose settings messages it accepts
  only from that page) or its own console (see "Modes"); content scripts, which can write
  `chrome.storage.local`, can't switch full mode on or move it to another account. Full mode refuses
  team/enterprise orgs.
