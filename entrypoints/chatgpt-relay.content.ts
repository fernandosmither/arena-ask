import type { Browser } from 'wxt/browser';
import { BUILD_EXTENSION_ID } from '@/lib/build-id';
import { ext } from '@/lib/ext';
import { TAB_MARK } from '@/lib/gpt-channel';
import { openPageLink, runGptAsk, type GptRelayEnv } from '@/lib/gpt-relay';
import { GPT_MAX_HOPS, MSG_GPT_LOGGED_OUT, MSG_GPT_OWN_TAB, MSG_WAKE, PORT_RELAY_FRAME_GPT, PORT_RELAY_GPT, PROTOCOL_VERSION, humanErrorFor, type StreamEvent } from '@/lib/protocol';
import { ID_RE, validateGptRelayAsk } from '@/lib/validate';

/**
 * My ChatGPT's relay, in the isolated world of chatgpt.com. It does anything only in ARENA Ask's own
 * chatgpt.com: the invisible frame in its offscreen document (this frame's only ancestor is this
 * extension, and this build's MAIN-world script recognises it too) or its pinned tab (a top-level
 * document carrying the tab marker, TAB_MARK, and confirmed by the background). The owner's own
 * chatgpt.com tabs and chatgpt.com framed anywhere else are left alone: no channel, no messages.
 *
 * At document_start it opens the channel to the MAIN world (lib/gpt-channel.ts); once the page has
 * parsed, it serves one question per port with lib/gpt-relay.ts (same port protocol as claude.ai's
 * relay, plus `navigating`). One document serves question after question: the relay moves the app
 * between chats with the app's own router, and reloads the page only when that doesn't work.
 */
export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  allFrames: true,
  runAt: 'document_start',
  noScriptStartedPostMessage: true,
  main() {
    try {
      start();
    } catch (e) {
      console.warn('[arena-ask] ChatGPT relay failed to start', e);
    }
  },
});

type Port = Browser.runtime.Port;

function extensionOrigin(): string {
  return new URL(ext().runtime.getURL('/')).origin;
}

/** True only when this frame's direct (and only) ancestor is one of our extension pages. */
function framedByUs(): boolean {
  try {
    const ao = location.ancestorOrigins; // Chrome; absent in Firefox (which has no offscreen API)
    return !!ao && ao.length === 1 && ao[0] === extensionOrigin();
  } catch {
    return false;
  }
}

/** A top-level document ARENA Ask loaded (the fragment) or marked (window.name) as its own tab. */
function marked(): boolean {
  try {
    return location.hash === `#${TAB_MARK}` || window.name === TAB_MARK;
  } catch {
    return false;
  }
}

function start() {
  const top = window.top === window;
  const framed = !top && framedByUs();
  if (!top && !framed) return; // chatgpt.com framed by anyone else: nothing to do
  if (framed && BUILD_EXTENSION_ID !== ext().runtime.id) {
    // The MAIN world recognises our frame by the id compiled into this build: with another id it
    // stays inert, so this frame can't be driven (the background falls back to the pinned tab).
    console.warn('[arena-ask] this build expects another extension id; My ChatGPT uses its pinned tab (STORE_LISTING.md, "Chrome Web Store: the extension id")');
    return;
  }
  const isMarked = framed || marked();
  // Only where the MAIN world listens (our frame, or a marked tab): elsewhere a handshake would reach page scripts.
  const link = isMarked ? openPageLink(window) : null;
  let served: ReturnType<GptRelayEnv['served']> = null;
  let busy = false;
  let active = false;
  /** This page is being replaced (navigate): it serves nothing more. */
  let leaving = false;
  const ports = new Set<Port>();
  let loggedOutReported = false;
  /** Replace this page with chatgpt.com at `path` (only our own chat paths), as ARENA Ask's page. */
  const reloadAt = (path: string) => {
    if (path !== '/' && !/^\/c\/[0-9a-f-]{36}$/i.test(path)) return;
    // Nothing may reach this document any more: close every port it has (after the `navigating`
    // event has gone out), so the next question only ever goes to the new page.
    leaving = true;
    setTimeout(() => {
      for (const p of ports) {
        try {
          p.disconnect();
        } catch {
          /* gone */
        }
      }
      ports.clear();
      if (top) {
        try {
          window.name = TAB_MARK;
        } catch {
          /* ignore */
        }
      }
      location.replace(`https://chatgpt.com${path}${top ? `#${TAB_MARK}` : ''}`);
    }, 30);
  };

  // A 401 while no question is running: tell the background (it drops the frame). While one runs,
  // the question itself reports it.
  link?.on((m) => {
    if (m.t !== 'auth-401' || busy || loggedOutReported || !active) return;
    loggedOutReported = true;
    try {
      void ext()
        .runtime.sendMessage({ type: MSG_GPT_LOGGED_OUT })
        .catch(() => {});
    } catch {
      /* extension reloaded */
    }
  });

  const activate = () => {
    if (active) return;
    active = true;
    link?.send({ t: 'activate' });
  };

  const serve = (port: Port, nonce?: string) => {
    if (leaving) return port.disconnect();
    ports.add(port);
    const ac = new AbortController();
    let closed = false;
    let asked = false;
    const send = (ev: StreamEvent) => {
      if (closed) return;
      try {
        port.postMessage(ev);
      } catch {
        closed = true;
        ac.abort();
      }
    };
    port.onDisconnect.addListener(() => {
      closed = true;
      ports.delete(port);
      ac.abort();
    });
    port.onMessage.addListener((m: unknown) => {
      if (leaving) return port.disconnect();
      if (asked || busy) return send({ type: 'error', code: 'busy', message: humanErrorFor('chatgpt', 'busy') });
      const req = validateGptRelayAsk(m);
      if (!req) return send({ type: 'error', code: 'invalid', message: humanErrorFor('chatgpt', 'invalid', '(relay)') });
      asked = true;
      if (!link) {
        // ARENA Ask's own tab, loaded without its marker (e.g. chatgpt.com reloaded itself): the
        // MAIN world isn't guarding it. Reload it as ARENA Ask's page first.
        if (req.hops >= GPT_MAX_HOPS) return send({ type: 'error', code: 'internal', message: humanErrorFor('chatgpt', 'internal', "(chatgpt.com's page script isn't active in ARENA Ask's tab)") });
        send({ type: 'navigating' });
        return reloadAt('/');
      }
      busy = true;
      const env: GptRelayEnv = {
        link,
        served: () => served,
        noteServed: (s) => {
          served = s;
        },
        navigate: reloadAt,
      };
      void runGptAsk(req, send, ac.signal, env).finally(() => {
        busy = false;
      });
    });
    send({ type: 'hello', v: PROTOCOL_VERSION, ...(nonce ? { nonce } : {}) });
  };

  if (framed) {
    activate();
    const origin = extensionOrigin();
    const servedNonces = new Set<string>();
    let lastPlain = 0;
    const connect = (nonce?: string) => {
      if (leaving) return;
      if (nonce) {
        if (servedNonces.has(nonce)) return;
        servedNonces.add(nonce);
        if (servedNonces.size > 256) servedNonces.delete(servedNonces.values().next().value!);
      } else {
        const now = Date.now();
        if (now - lastPlain < 250) return;
        lastPlain = now;
      }
      try {
        serve(ext().runtime.connect({ name: PORT_RELAY_FRAME_GPT }), nonce);
      } catch {
        /* extension reloaded under us */
      }
    };
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent || e.origin !== origin) return;
      const d = e.data as { type?: unknown; nonce?: unknown } | null;
      if (d?.type !== MSG_WAKE) return;
      if (document.readyState === 'loading') return; // not ready yet: the wake is re-sent
      connect(typeof d.nonce === 'string' && ID_RE.test(d.nonce) ? d.nonce : undefined);
    });
    const onReady = () => connect();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
    else onReady();
    return;
  }

  // Top-level tab: only ARENA Ask's own pinned tab is ever driven.
  if (isMarked) {
    try {
      void ext()
        .runtime.sendMessage({ type: MSG_GPT_OWN_TAB })
        .then((r: unknown) => {
          if ((r as { own?: unknown } | null)?.own === true) activate();
        })
        .catch(() => {});
    } catch {
      /* extension reloaded */
    }
  }
  ext().runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_RELAY_GPT) return;
    // Only extension contexts can reach a content script's onConnect (tabs.connect); still, only
    // this extension's background, which connects to its own pinned tab only.
    const s = port.sender;
    if (!s || s.id !== ext().runtime.id || s.tab) return port.disconnect();
    activate();
    const go = () => serve(port);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  });
}
