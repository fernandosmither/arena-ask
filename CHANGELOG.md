# Changelog

All notable changes to ARENA Ask. Versions follow [semantic versioning](https://semver.org).

## 1.0.2 (2026-09-26)

### Changed

- Version bump only, for the first public Firefox Add-ons listing (1.0.0 and 1.0.1 were used for
  self-distributed signed builds). No functional changes.

## 1.0.1 (2026-09-26)

### Changed

- The Claude footer shows both usage limits claude.ai reports with an answer, e.g.
  `Open in claude.ai ↗  7d 74% · 5h 4%`: the one closest to its limit comes first, a figure turns
  amber from 80% and red from 95% (in ARENA's light and dark themes), and the tooltip explains
  both. A window claude.ai didn't report is left out. 1.0.0 showed only the 5-hour figure, with
  the 7-day one in the tooltip, so "5h: 4%" could be read as a cut-off 74%.
- A Send while ARENA's dropdown shows a model other than the one you picked is refused with
  "… Pick the model again, then send." (was "Pick My Claude or My ChatGPT in the dropdown again").

### Fixed

- A page script that moved the dropdown's `id` to a select of its own (keeping ARENA's real one in
  the page, hidden) could show you one model while your question went to the one the real
  dropdown held. A Send now also needs ARENA's dropdown to be the page's only `#chat-model` and
  not hidden.
- A Send refused for its model now also voids an earlier, still pending Send of the same question
  (a page holding back ARENA's first request could otherwise still send it under the first Send's
  model).
- An answer whose own footer data was missing (never recorded, or pruned after 300 answers in a
  chapter) could borrow the footer of the same text at another position: an "ok" from ARENA's own
  model or from ChatGPT could get Claude's link and usage. Footers now only come from the answer's
  own position.

### Checked

- Which service answers after a reload: the model the extension restores in the dropdown (your
  last pick, from its own storage) is the one the next question goes to, and a dropdown a script
  changed is refused, not routed to the other service. Verified live and with new tests. "My
  ChatGPT" in the dropdown next to an "Open in claude.ai" footer is an earlier Claude answer: each
  answer keeps the footer of the service that answered it (now said in the README).
- A ChatGPT footer never shows a usage figure.

## 1.0.0 (2026-09-26)

First public release: open source (MIT), for the Chrome Web Store and Firefox Add-ons.

### Added

- **My Claude (Opus 5.5)** and **My ChatGPT** in the model menu of ARENA's "Ask a Question" box on
  learn.arena.education, answered from your own claude.ai / chatgpt.com account and streamed into
  ARENA's bubble, with markdown rendering, copy buttons and an "Open in claude.ai / ChatGPT ↗"
  footer (Claude: 5-hour usage; ChatGPT: the model that answered).
- One chat per ARENA chapter and service, continued by follow-ups; ARENA's "Clear chat history"
  starts a new one. The ARENA context is attached as page-supplied reference material.
- **Full account access** (the default): memory, past chats, preferences and web search, as in a
  new chat you'd start yourself; code execution off in Claude's chats. Read-only tools run with a
  status line; actions are stopped at their start and handed off to claude.ai / ChatGPT for your
  approval (they may already have started), with a note that says what the stop achieved.
- **Locked mode** for Claude: a plain tutor in a private ARENA project with memory, past chats,
  web search, connectors and code execution off (verified before anything is sent) and profile
  preferences turned off when the chat is created; a few built-in helper tools remain, and any tool
  call ends the answer.
- **Options page** (an ordinary extension options page, no popup or side panel): Claude access
  (Full / Locked), "Don't let ARENA chats write to ChatGPT memory" (off by default), "Forget pinned
  account" for each service, and a plain-language note on the risks. Settings changes are accepted
  only from the Options page itself.
- **Trusted-Send gate**: a question goes out only after your own Send, once, with the text your own
  typing or pasting produced, for the chapter and model you picked. Nothing runs on ARENA's
  pull-request previews.
- Full-mode Claude and My ChatGPT each pinned to the account of their first question (personal
  accounts only; team and enterprise accounts are refused). Locked mode uses the active claude.ai
  account.
- ChatGPT safety: a send guard checks the request chatgpt.com's page is about to send; sign-out
  requests are blocked in ARENA Ask's own chatgpt.com frame and tab; the answer stream is parsed
  fail-closed (only visible answer text reaches ARENA).
- Chrome: an invisible offscreen page hosts claude.ai / chatgpt.com, with tab fallbacks. Firefox
  (128+): tabs.
- `pnpm zip:store`: checked Chrome Web Store, Firefox and AMO-sources packages.
- Documentation: README, PRIVACY.md, STORE_LISTING.md, docs/DESIGN.md, docs/TESTING.md.

### Known limitations

- Depends on claude.ai's and chatgpt.com's internal web interfaces and on ARENA's page; see the
  README's "Limitations and fragile points".
- Handed-off actions may already have started (Claude) or run (ChatGPT, whose Stop was seen to land
  about 2 s late).
- Firefox has had far less live testing than Chrome.
