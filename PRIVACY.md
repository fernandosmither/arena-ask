# Privacy Policy: ARENA Ask

_Last updated: 2026-09-26_

ARENA Ask is a browser extension that answers the "Ask a Question" box on
**learn.arena.education** with your own **claude.ai** or **chatgpt.com** account. This policy
explains exactly what it does and doesn't do with your data. ARENA Ask is unofficial and not
affiliated with Anthropic, OpenAI or ARENA.

## Short version

**ARENA Ask collects nothing for its developer. It has no servers, no analytics and no telemetry,
and it loads no remote code.** Data moves only inside your browser and between your browser and
the three sites it works with:

- **learn.arena.education**, where it reads the question you typed, the course context ARENA's
  page builds and ARENA's saved chat for the chapter, and shows the answer;
- **claude.ai** or **chatgpt.com** (whichever you pick), where it sends your question with that
  context, using **your own** logged-in session, exactly as if you had asked there yourself.

The developer never receives any of it.

## What ARENA Ask sends, and to whom

When you ask a question with **My Claude** or **My ChatGPT**, ARENA Ask sends to that service, from
your browser and with your existing session:

- your question;
- the course material ARENA's page assembled for the question (the sections you selected);
- the chapter's earlier ARENA chat (for context), and the chapter's title.

The question becomes an ordinary chat in **your** claude.ai or ChatGPT account (on claude.ai named
`ARENA · <chapter>`), where you can see, continue or delete it. What happens to it there is
governed by that service's own terms and privacy policy, as for any chat you start yourself. In
the default "full account" mode, those chats behave like your other chats: the service's memory,
past-chat search and preferences apply.

To do its job, ARENA Ask also reads, **inside** those sites and only as needed:

- which account the page is signed in to, to confirm it is a personal account and the one the
  extension was first used with (only a yes/no or a one-way hash tag of the id leaves the site;
  the one exception is the claude.ai organization id full mode is pinned to, which is kept in the
  extension's own storage and used only in requests to claude.ai);
- on claude.ai, whether your account has memory switched on (one yes/no), and the chat it created,
  to confirm its settings and whether a stopped action ran;
- on chatgpt.com, the chat it is using, to confirm it is a plain chat and whether a stopped action
  ran;
- on claude.ai, the page's `document.cookie` (the cookies claude.ai's own scripts can see), of which
  it keeps only `lastActiveOrg`, the id of the organization claude.ai has selected, to address its
  requests to claude.ai; the rest is discarded at once. Your login travels in the cookies the
  browser itself attaches to those same-site requests;
- on chatgpt.com, the session's access token, from chatgpt.com's own `/api/auth/session` (as
  chatgpt.com's web app does), sent only as the `Authorization` header of ARENA Ask's own requests
  to chatgpt.com (the account check, and reading or marking the chapter's chat). It never leaves
  chatgpt.com's page for anywhere else, and is never stored or logged.

Questions you ask with My Claude or My ChatGPT are **not** sent to ARENA's server: ARENA Ask
answers the page's request itself. (ARENA's page still loads the course material from ARENA's own
server, as it always does.)

## What ARENA Ask stores, and where

Everything is stored **locally in your browser** and never transmitted to the developer:

- **The extension's own database** (IndexedDB, not reachable by websites): for each ARENA chapter
  and service, the id of its claude.ai / ChatGPT chat, the last message id, a hash of the context
  sent, and markers for questions that were stopped; one-way hashes (not the text) of up to 256
  questions you sent per chapter, so that only your own questions are later presented as yours;
  your settings: the access mode and the ChatGPT memory switch (Options page) and, only if you set
  them in the extension's service-worker console, a ChatGPT model override and ChatGPT
  request-body changes (request fields to leave out, tool ids to mark disabled, the request's
  "don't remember" flag); the claude.ai organization and a hash tag of the ChatGPT account each
  service is pinned to; and the ids of the private ARENA project(s) locked mode created on
  claude.ai.
- **Extension storage** (`storage.local`): for each chapter, a map from a hash of each answer to
  its chat id and the usage percentage shown under it (so the footer survives a reload); the model
  you last picked in ARENA's dropdown; debug switches, if you set any.
- **Session storage** (`storage.session`, cleared when the browser closes): which tab or hidden
  frame is serving questions, and short pauses after errors.

ARENA's own page keeps its chat history in your browser's localStorage, as it does for ARENA's
built-in models; answers from Claude or ChatGPT are saved there by ARENA's code like any other.
ARENA Ask doesn't send that history anywhere except, as context, to the service you picked.

ARENA Ask never logs cookies, tokens, account or chat ids, or message content.

## What ARENA Ask does **not** do

- No data is sold, or transferred to anyone other than the AI service you chose for your question.
- No data is used for advertising, profiling, creditworthiness or anything unrelated to answering
  your question.
- No analytics, tracking, fingerprinting or crash reporting.
- No remote code: all of the extension's code ships in the package.
- No access to other websites: it runs only on learn.arena.education, claude.ai and chatgpt.com,
  and on the latter two it does nothing in your own tabs except when you ask a question (and, for
  chatgpt.com, never in tabs you opened yourself).

## Permissions

- **`storage`**: the local state and settings above.
- **`offscreen`** (Chrome): an invisible extension page that hosts claude.ai / chatgpt.com, so
  your question can be answered without opening a visible tab.
- **`declarativeNetRequest`**: temporary, session-only rules that let that invisible page load
  claude.ai / chatgpt.com (only frames the extension itself loads), and that block chatgpt.com's
  sign-out requests there, so a hidden page can't sign you out of ChatGPT.
- **Host access** to `https://learn.arena.education/*` (to work in the "Ask a Question" box),
  `https://claude.ai/*` and `https://chatgpt.com/*` (to ask your question there with your session).

## Removing your data

- **Options page → Forget pinned account** removes a service's pinned account.
- **ARENA's "Clear chat history"** makes ARENA Ask forget that chapter's chats and recorded
  questions (the chats themselves stay in your claude.ai / ChatGPT account; delete them there).
- **Uninstalling** the extension removes everything it stored.
- Chats and any memories the services created are in your claude.ai / ChatGPT account, under your
  control there.

## Changes

Changes to this policy are published in the extension's source repository with a new date above.

## Contact

Questions or concerns: open an issue at <https://github.com/fernandosmither/arena-ask/issues>.
Source code: <https://github.com/fernandosmither/arena-ask>.
