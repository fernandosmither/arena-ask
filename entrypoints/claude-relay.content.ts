import { ext } from '@/lib/ext';
import { MSG_WAKE, PORT_RELAY, PORT_RELAY_FRAME } from '@/lib/protocol';
import { serveRelayPort } from '@/lib/relay-port';
import { ID_RE } from '@/lib/validate';

/**
 * The relay: runs inside claude.ai so every API call is same-origin with the user's own session
 * (session cookie, Cloudflare clearance, native Origin). Two modes, same port protocol:
 *
 * - top-level claude.ai tab: waits for the background's chrome.tabs.connect("relay").
 * - claude.ai frame inside OUR offscreen document: a framed page has no tab id, so it connects to
 *   the background itself ("relay-frame") on load and once per wake (nonce) from the offscreen page.
 *
 * In any other frame (claude.ai's own iframes, or a third party embedding claude.ai) it does nothing.
 */
export default defineContentScript({
  matches: ['https://claude.ai/*'],
  allFrames: true,
  runAt: 'document_idle',
  noScriptStartedPostMessage: true,
  main() {
    try {
      if (window.top === window) startTabRelay();
      else startFrameRelay();
    } catch (e) {
      console.warn('[arena-ask] relay failed to start', e);
    }
  },
});

function startTabRelay() {
  const api = ext();
  api.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_RELAY) return;
    // Only extension contexts can reach a content script's onConnect (via tabs.connect); still,
    // refuse anything that isn't this extension's background.
    const s = port.sender;
    if (!s || s.id !== api.runtime.id || s.tab) return port.disconnect();
    serveRelayPort(port);
  });
}

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

/**
 * One port per wake: each waiting ask wakes the frame with its own nonce (re-sent until it gets a
 * port), so several asks can run in this frame at once. Repeated wakes for a nonce are ignored.
 */
function startFrameRelay() {
  if (!framedByUs()) return;
  const origin = extensionOrigin();
  const served = new Set<string>();
  let lastPlain = 0;
  const connect = (nonce?: string) => {
    if (nonce) {
      if (served.has(nonce)) return;
      served.add(nonce);
      if (served.size > 256) served.delete(served.values().next().value!);
    } else {
      const now = Date.now();
      if (now - lastPlain < 250) return;
      lastPlain = now;
    }
    try {
      serveRelayPort(ext().runtime.connect({ name: PORT_RELAY_FRAME }), { nonce, frame: true });
    } catch {
      /* extension reloaded under us: nothing to serve */
    }
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== origin) return;
    const d = e.data as { type?: unknown; nonce?: unknown } | null;
    if (d?.type !== MSG_WAKE) return;
    connect(typeof d.nonce === 'string' && ID_RE.test(d.nonce) ? d.nonce : undefined);
  });
  connect();
}
