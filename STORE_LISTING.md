# Store listing and submission

Everything needed to publish ARENA Ask on the **Chrome Web Store** (CWS) and **Firefox Add-ons**
(AMO): how to build the packages, the submission steps, the listing text to paste, the permission
justifications and the data disclosures.

- [The packages](#the-packages)
- [Chrome Web Store: the extension id](#chrome-web-store-the-extension-id)
- [Chrome Web Store: submission steps](#chrome-web-store-submission-steps)
- [Firefox Add-ons: submission steps](#firefox-add-ons-submission-steps)
- [Listing text](#listing-text)
- [Permission justifications](#permission-justifications)
- [Remote code](#remote-code)
- [Data disclosures](#data-disclosures)
- [Notes for reviewers](#notes-for-reviewers)
- [Images](#images)
- [Things a reviewer may question](#things-a-reviewer-may-question)

## The packages

```bash
pnpm install --frozen-lockfile
ARENA_ASK_EXTENSION_ID=<the Chrome Web Store item's id> pnpm zip:store
```

`pnpm zip:store` (`scripts/zip-store.mjs`) builds and checks three files in `.output/store/`:

| File | Upload to |
|---|---|
| `arena-ask-1.0.0-chrome.zip` | CWS: the package (no manifest `key`; the store's id compiled in) |
| `arena-ask-1.0.0-firefox.zip` | AMO: the add-on |
| `arena-ask-1.0.0-sources.zip` | AMO: "source code" (reviewers rebuild with `pnpm zip:firefox`) |

It checks the manifests (MV3, version, permissions, host permissions, options page, no `key`;
Firefox: gecko id `arena-ask@fdosmith.dev`, `strict_min_version` 128.0, data-collection
declaration), that the store id is compiled into the Chrome build and the unpacked build's id isn't,
and that no Chrome id is compiled into the Firefox build (so AMO's rebuild from source matches). The
Chrome store build goes to `.output/store/chrome-mv3/`, so an unpacked install from
`.output/chrome-mv3` keeps its own key and id.

## Chrome Web Store: the extension id

**The chicken and egg.** My ChatGPT's script inside chatgpt.com has no extension APIs; it recognises
ARENA Ask's invisible chatgpt.com frame by the extension id compiled into the build. Unpacked builds
get a fixed id from the manifest `key` in `wxt.config.ts`. The Chrome Web Store doesn't take a `key`
and assigns its own id, and it tells you that id only once the item exists. So:

1. `pnpm zip:store --draft` builds `.output/store/arena-ask-1.0.0-chrome-draft.zip` with a
   placeholder id. Upload it **only to create the item**. Never submit it for review.
2. Copy the item's id from the dashboard (the 32-letter id in the item's URL and on its
   "Package" page).
3. `ARENA_ASK_EXTENSION_ID=<that id> pnpm zip:store` builds the real package. Upload
   `arena-ask-1.0.0-chrome.zip` as a new package for the same item, then submit.

The id never changes for the life of the item, so later versions only need step 3 (keep the id in
your shell history or a note). `ARENA_ASK_EXTENSION_ID` counts only in a store build
(`ARENA_ASK_STORE_BUILD=1`, which `pnpm zip:store` sets): any other build (`pnpm build`, `pnpm zip`)
keeps the manifest key and ignores the variable with a warning, so a value left in the shell can't
give it an id it doesn't have. A store build with a wrong id is not harmless: the chatgpt.com script
doesn't recognise ARENA Ask's own frame (it waits for the isolated relay instead), the background
logs "this build expects another extension id", and My ChatGPT falls back to its pinned chatgpt.com
tab; and if that wrong id belongs to another extension that frames chatgpt.com, the script would
take that extension's frame for ARENA Ask's. Only ever build with the id the dashboard shows, and
check it after publishing (below).

After the listing is live: install it from the store, open the extension's service worker console
(`chrome://extensions` → ARENA Ask → "service worker") and check that there is **no** "this build
expects another extension id" warning.

## Chrome Web Store: submission steps

1. **Developer account** (one-time): <https://chrome.google.com/webstore/devconsole>, sign in, pay the
   one-time registration fee, set the publisher name (Fernando Smith) and verify the contact email.
2. **Create the item**: *New item* → upload `arena-ask-1.0.0-chrome-draft.zip` (see above). Copy
   the item id.
3. **Real package**: `ARENA_ASK_EXTENSION_ID=<id> pnpm zip:store`, then *Package* → *Upload new
   package* → `.output/store/arena-ask-1.0.0-chrome.zip`.
4. **Store listing** tab: description, category, language (from [Listing text](#listing-text));
   store icon `public/icon/128.png`; screenshots `store-assets/1-my-claude.png`,
   `2-my-chatgpt.png`, `3-options.png`; small promo tile `store-assets/promo-small-440x280.png`;
   homepage and support URLs (the GitHub repository and its issues page).
5. **Privacy** tab: the single purpose, one justification per permission and host permission
   ([Permission justifications](#permission-justifications)), "No, I am not using remote code",
   the data-usage boxes and the three certifications ([Data disclosures](#data-disclosures)), and
   the privacy policy URL: `https://github.com/fernandosmither/arena-ask/blob/main/PRIVACY.md`.
6. **Distribution**: Public; all regions.
7. **Submit for review.** Optionally tick "defer publishing" to publish by hand after approval.
   Paste [Notes for reviewers](#notes-for-reviewers) if the form offers a field for them.
8. When it's live: put the store link in README.md ("Install") and check the id (above).

## Firefox Add-ons: submission steps

1. **Account**: <https://addons.mozilla.org/developers/>, sign in with a Firefox account, accept the
   developer agreement.
2. **Packages**: the same `pnpm zip:store` run made `arena-ask-1.0.0-firefox.zip` and
   `arena-ask-1.0.0-sources.zip` (AMO needs no id from us: the add-on id is
   `arena-ask@fdosmith.dev`, fixed in the manifest).
3. **Submit a New Add-on** → *On this site* (listed) → upload `arena-ask-1.0.0-firefox.zip`.
   Compatible platforms: **Firefox for desktop** only (untested on Android).
4. **Source code**: answer *Yes* (the package is bundled by WXT/Vite) and upload
   `arena-ask-1.0.0-sources.zip`. Paste [Notes for reviewers](#notes-for-reviewers) into
   *Notes to reviewer*; the build steps are also in the README ("Building from source").
5. **Describe the add-on**: name, summary, description, categories, tags, support site, license
   **MIT**, privacy policy (paste PRIVACY.md), from [Listing text](#listing-text).
6. **Images**: the same three screenshots. The icon comes from the manifest.
7. Submit. After approval, put the AMO link in README.md.

Before submitting, give the Firefox build a smoke test in a real Firefox (128+): *Load Temporary
Add-on* from `.output/firefox-mv3/manifest.json`, allow the three sites in `about:addons`, ask one
question with each service. Firefox has had far less live testing than Chrome (see README,
"Browsers").

## Listing text

### Name (CWS and AMO; also the manifest name)

ARENA Ask (unofficial)

### Short description (CWS "summary", 132 characters max; also the manifest description)

Unofficial: use your own Claude or ChatGPT subscription in the "Ask a Question" box on learn.arena.education.

### AMO summary (250 characters max)

Unofficial: answer the "Ask a Question" box on learn.arena.education with your own Claude or ChatGPT account. Answers stream into ARENA's own box; actions are handed to you to approve. No servers, no telemetry.

### Long description (CWS; plain text. AMO accepts the same text.)

```
ARENA Ask answers the "Ask a Question" box on learn.arena.education (the ARENA AI-safety curriculum) with your own Claude or ChatGPT subscription.

Unofficial: not affiliated with, endorsed by or supported by Anthropic, OpenAI or ARENA.

HOW TO USE
1. Sign in to claude.ai and/or chatgpt.com in this browser.
2. Open a chapter on learn.arena.education.
3. In the "Ask a Question" box, pick "My Claude (Opus 5.5)" or "My ChatGPT" in the model menu, and ask as usual.

ARENA's own page builds the context (the sections you selected, with or without solutions). The answer streams into ARENA's bubble from your account, rendered as markdown, with a link to open the chat in claude.ai or ChatGPT and, for Claude, your 5-hour usage.

WHAT YOU GET
• One chat per ARENA chapter, in your own claude.ai / ChatGPT history. Follow-ups continue it; ARENA's "Clear chat history" starts a new one.
• Full account access by default: your memory, past chats, preferences and web search apply, like a chat you'd start yourself. Tools that only read run; anything that would change something (send an email, create an event, save a memory, run code) is stopped and handed to you to approve in claude.ai or ChatGPT (it may already have started).
• Locked mode for Claude (in the Options page): a plain tutor in a private project, with no connectors, memory, past chats, preferences, web search or code execution; a few built-in helper tools remain, and a call to one ends the answer.
• Only questions you typed: a question goes out only after you press Send yourself, with the text you typed or pasted. Scripts on the page can't send questions of their own.

BEFORE YOU RELY ON IT
Anything on learn.arena.education (lesson text, the page's scripts, its saved chat) travels with your question, so it can steer the answer, and the page can read the answer. In full mode that answer can draw on your memory and past chats. Actions are stopped and handed to you, but stopping isn't instant: with Claude they may already have started, and with ChatGPT they may already have run (its Stop was seen to land about 2 seconds late). Only approve actions you asked for. The Options page explains this and lets you switch Claude to Locked.

PRIVACY
No servers, no analytics, no telemetry, no remote code. Your question and the course context go only to the service you picked, from your browser, with your own session. A little state (each chapter's chat id, your settings) is kept locally. Privacy policy: https://github.com/fernandosmither/arena-ask/blob/main/PRIVACY.md

OPEN SOURCE
MIT-licensed. Source, documentation and the full security model: https://github.com/fernandosmither/arena-ask

ARENA Ask relies on claude.ai's and chatgpt.com's internal web interfaces and on ARENA's page, which can change without notice; if something breaks, it refuses rather than guesses, and an update will follow.
```

### Category and tags

- CWS category: **Education** (Productivity → Education). Language: English.
- AMO categories: **Other**. Tags: `ai`, `claude`, `chatgpt`, `education`, `arena`.

### Single purpose (CWS)

```
ARENA Ask has a single purpose: to answer the "Ask a Question" box on learn.arena.education with the user's own Claude (claude.ai) or ChatGPT (chatgpt.com) account, streaming the answer into that box. Everything it does (the model options it adds to the box, the invisible claude.ai/chatgpt.com page it hosts to ask the question with the user's session, the Options page for its settings) serves that purpose.
```

## Permission justifications

Paste each into the CWS *Privacy* tab (AMO asks for none, but the same text works in the reviewer
notes).

**storage**

```
Stores the extension's local state and settings in the browser: for each ARENA chapter, the id of its claude.ai/ChatGPT chat so follow-up questions continue it; the model the user picked in ARENA's dropdown; the user's settings (access mode, ChatGPT memory option, pinned accounts); per-answer footer data (chat link, usage figure). Nothing is sent to the developer.
```

**offscreen**

```
Hosts an invisible extension page in which claude.ai and chatgpt.com are loaded (as iframes) with the user's own session. The extension's content script runs inside those pages and asks the user's question there, same-origin, so the answer can stream into ARENA's box without opening and switching to a visible claude.ai or chatgpt.com tab. The page is created on the first question and closed after 10 idle minutes.
```

**declarativeNetRequest**

```
Session-only rules, installed only while needed: (1) remove X-Frame-Options and Content-Security-Policy from claude.ai and chatgpt.com responses, restricted to sub-frames outside any tab (tabId -1) loaded by this extension (or, inside its chatgpt.com frame, by chatgpt.com's own navigation), so the extension's invisible offscreen page can load them; the user's own tabs and any other site framing claude.ai/chatgpt.com are unaffected; (2) block chatgpt.com's sign-out requests (/api/auth/signout, /auth/logout) from the extension's own invisible chatgpt.com frame and its own pinned tab, because chatgpt.com's code signs the user out of every tab when a hidden page of it sees an expired token.
```

**Host permission: https://learn.arena.education/\***

```
The extension works inside ARENA's "Ask a Question" box: it adds "My Claude" and "My ChatGPT" to the box's model menu, answers the page's chat request for those models itself, verifies that the question was typed and sent by the user, and renders the answer. It does not run on ARENA's pull-request preview pages.
```

**Host permission: https://claude.ai/\***

```
To ask the user's question with their own claude.ai session: the extension's content script runs inside claude.ai (in the invisible offscreen frame, or a claude.ai tab) and calls claude.ai's own web API same-origin to create or continue the chapter's chat and stream the answer. The browser attaches the user's claude.ai session cookies to those requests itself. Inside claude.ai's page the script reads document.cookie (the cookies claude.ai's own scripts can see) and keeps only lastActiveOrg, the id of the organization claude.ai has selected (not a credential), to address its requests to claude.ai; the rest is discarded at once. Nothing from it is logged or sent elsewhere; the only account id stored (locally) is the organization id full mode is pinned to, used only in requests to claude.ai.
```

**Host permission: https://chatgpt.com/\***

```
To ask the user's question with their own ChatGPT session: the extension's content script runs inside chatgpt.com (in the invisible offscreen frame, or a pinned tab it opens) and drives chatgpt.com's own page: it types the question into the composer, presses Send, checks the outgoing request and streams the answer back. In the user's own chatgpt.com tabs it does nothing. Inside its chatgpt.com page it reads the session's access token from chatgpt.com's own /api/auth/session (as chatgpt.com's web app does) and sends it only as the Authorization header of its own requests to chatgpt.com: the account check, and reading or marking the chapter's chat. The token never leaves chatgpt.com's page for anywhere else, and is never stored or logged.
```

## Remote code

**No.** All code ships in the package (TypeScript bundled at build time by WXT/Vite). The extension
evaluates no strings as code and loads no scripts from the network. The pages it hosts invisibly
are claude.ai and chatgpt.com themselves, which run their own code as they would in a tab.

## Data disclosures

### Chrome Web Store (*Privacy* tab)

"What user data do you plan to collect from users now or in the future?" ARENA Ask sends nothing to
its developer, but it does send data off the device, to the AI service the user picked, at the
user's request. Disclose that plainly. Tick these three:

- **Website content**: the course material ARENA's page assembles and the chapter's saved ARENA
  chat are sent, with the question, to claude.ai or chatgpt.com (whichever the user picked), from
  the user's browser with the user's own session, only when the user sends a question.
- **Personal communications**: the user's questions and the answers, exchanged with the user's own
  claude.ai or ChatGPT account (they become ordinary chats in that account).
- **User activity**: keystrokes, pastes and clicks in ARENA's question box are watched on the device
  to make sure a question was typed and sent by the user; none of that is transmitted, only the
  resulting question.

Leave the rest unticked (personally identifiable information, health, financial, authentication,
location, web history). About authentication, precisely: ARENA Ask has no login of its own and
sends no credential to anyone but the site it belongs to. Inside chatgpt.com's page it reads the
session's access token (from chatgpt.com's `/api/auth/session`, as chatgpt.com's web app does) and
sends it only as the `Authorization` header of its own requests to chatgpt.com; inside claude.ai's
page it reads `document.cookie` and keeps only `lastActiveOrg` (the selected organization's id, not
a credential) to address its requests to claude.ai, discarding the rest. Neither is logged or sent
anywhere else, and the token is never stored. If a reviewer counts the token as authentication
information, tick that box too with this explanation.

Limited use, for the form's statements: the data is used only to answer the question the user sent
in ARENA's box (the single purpose); it goes only to the AI service the user picked, from the user's
browser; the developer never receives it, so it is never sold, used for advertising, profiling or
creditworthiness, or read by anyone at the developer's end.

Certify all three: data is not sold or transferred to third parties outside the approved use cases
(here: sending the question to the service the user chose, to provide the single purpose); not used
or transferred for purposes unrelated to the single purpose; not used or transferred to determine
creditworthiness or for lending.

### Firefox (`data_collection_permissions`)

The Firefox manifest declares `data_collection_permissions: { required: ["websiteContent",
"personalCommunications"] }`, and `pnpm zip:store` checks it. Mozilla defines data transmission as
"any data collected, used, transferred, shared, or handled outside the add-on or the local browser",
with no carve-out for a service the user picked, and both apply: the course material and ARENA chat
(`websiteContent`) and the user's questions and the answers (`personalCommunications`) leave the
browser for claude.ai or chatgpt.com. Firefox shows both at install. `websiteContent` also covers,
in Mozilla's words, "cookies ... and request and response information": the access token and the
`lastActiveOrg` cookie above are read in the site's own page and sent back only to that site. Not
declared: `websiteActivity` (the keystrokes and clicks the gate watches never leave the device; only
the question does, as a personal communication) and `authenticationInfo` (Mozilla's examples are
passwords, usernames, PINs and the add-on's own account registration; ARENA Ask has none).

## Notes for reviewers

```
ARENA Ask answers the "Ask a Question" box on learn.arena.education with the user's own claude.ai or chatgpt.com account. It has no servers and sends nothing to its developer.

How to test: sign in to claude.ai and/or chatgpt.com, open https://learn.arena.education/chapter0_fundamentals/01_ray_tracing/, in the "Ask a Question" box (right sidebar) pick "My Claude (Opus 5.5)" or "My ChatGPT", type a question and press Send. On Firefox, first allow the three sites in about:addons → ARENA Ask → Permissions. Settings: about:addons → ARENA Ask → Options.

Why the content scripts in the MAIN world: (1) on learn.arena.education, ARENA's page calls fetch('/api/chat/') itself; a MAIN-world script wraps window.fetch to answer only POST /api/chat/ for the extension's two model values, with a stream the extension produces (it holds no secrets and has no extension APIs). (2) On chatgpt.com, a MAIN-world script is active only in the extension's own invisible frame or its own marked tab (inert in the user's tabs); it checks the conversation request chatgpt.com's page is about to send and passes the answer stream to the isolated content script.

Why declarativeNetRequest: session rules let the extension's own offscreen page frame claude.ai/chatgpt.com (tabId -1, initiator = this extension only) and block chatgpt.com's sign-out endpoints in the extension's own frame/tab (chatgpt.com's code otherwise signs the user out everywhere when a hidden page sees a 401).

Undocumented APIs: the extension uses claude.ai's own web API (same-origin, the user's session) and drives chatgpt.com's own page UI.

Credentials: no passwords. Inside claude.ai's page the content script reads document.cookie and keeps only lastActiveOrg (the selected organization's id) to address claude.ai's API, discarding the rest; the browser attaches the session cookies to those same-origin requests itself. Inside chatgpt.com's page it reads the session's access token from chatgpt.com's /api/auth/session and sends it only as the Authorization header of its requests to chatgpt.com's own API (the account check, reading or marking the chapter's chat). The token is never stored; the organization id is stored only as full mode's pinned account (locally, used only in requests to claude.ai). Neither is logged or sent anywhere else.

Build from source: Node.js 22.12+ (built with 24.15.0), pnpm 10 (built with 10.34.3).
  pnpm install --frozen-lockfile
  pnpm zip:firefox
Output: .output/firefox-mv3/ and .output/arena-ask-1.0.0-firefox.zip (identical to the submitted package). No code is downloaded at build or run time. pnpm 10 may warn that it ignored the build scripts of esbuild and spawn-sync; the build doesn't need them.

Source and documentation: https://github.com/fernandosmither/arena-ask (README, docs/DESIGN.md for the security model).
```

## Images

| File | Size | Use |
|---|---|---|
| `public/icon/128.png` | 128×128 | CWS store icon (AMO takes the manifest icons) |
| `store-assets/1-my-claude.png` | 1280×800 | Screenshot 1: My Claude answering "Explain what intersect_ray_1d checks, in two sentences." in ARENA's box (Ray Tracing chapter), with the "Open in claude.ai ↗" footer |
| `store-assets/2-my-chatgpt.png` | 1280×800 | Screenshot 2: My ChatGPT answering the same question, with the "Open in ChatGPT ↗" footer |
| `store-assets/3-options.png` | 1280×800 | Screenshot 3: the Options page (access mode, ChatGPT memory, pinned accounts, the risk note) |
| `store-assets/promo-small-440x280.png` | 440×280 | CWS small promo tile (required); source `promo-small.svg` |

All three screenshots were checked for personal data: no account names, emails or personal memory
content (only a usage percentage). Suggested captions, in order: "Answers stream into ARENA's own
box from your claude.ai account", "Or from your ChatGPT account", "Full or locked access, memory and
account settings, and an honest note on the risks".

Worth adding later (not captured, each needs a live action): a handed-off action ("Claude wants to
… — open this chat in claude.ai to approve ↗"), and a locked-mode answer. The marquee tile
(1400×560) is optional.

To retake the screenshots, follow [docs/TESTING.md, Store screenshots](docs/TESTING.md#store-screenshots).
To re-render the promo tile after editing `promo-small.svg` (uses the `@resvg/resvg-js` dev
dependency and the system fonts Georgia and Helvetica):

```bash
node -e "const {Resvg}=require('@resvg/resvg-js'),fs=require('fs');fs.writeFileSync('store-assets/promo-small-440x280.png',new Resvg(fs.readFileSync('store-assets/promo-small.svg','utf8'),{font:{loadSystemFonts:true,defaultFontFamily:'Helvetica'}}).render().asPng())"
```

## Things a reviewer may question

- **The name uses "ARENA".** The listing name says "(unofficial)", and the summary, the
  description's second line, the Options page and the README all say it is unofficial and not
  affiliated. If a store objects to the name, rename it to something descriptive that doesn't lead
  with ARENA.
- **Header rules on claude.ai / chatgpt.com.** Scoped to frames the extension itself loads outside
  tabs; see the declarativeNetRequest justification.
- **Internal APIs of claude.ai and chatgpt.com.** The extension acts only with the user's own
  session, at the user's request, like the user in a tab. It reads what those sites' own web apps
  read (chatgpt.com's access token, claude.ai's `lastActiveOrg` cookie) inside their pages and
  sends it only back to the same site; see [Data disclosures](#data-disclosures).
- **Firefox data-collection declaration**: website content and personal communications, required
  (see [Data disclosures](#data-disclosures)).
