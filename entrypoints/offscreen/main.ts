import { ext } from '@/lib/ext';
import { MSG_DROP_FRAME, MSG_OFFSCREEN_IDLE, MSG_RELOAD_FRAME, MSG_WAKE, OFFSCREEN_IDLE_MS } from '@/lib/protocol';
import { isProviderId, providerById, type ProviderId } from '@/lib/provider';
import { ID_RE } from '@/lib/validate';

/**
 * Offscreen document: hosts the invisible claude.ai and chatgpt.com frames, each created on its
 * provider's first wake. It forwards the background's wake-ups (each carrying the waiting ask's
 * nonce) to the frame (a framed page can't be reached by tab id), reloads or removes a frame on
 * request, and asks the background to close it after OFFSCREEN_IDLE_MS without a question.
 */
const frames = new Map<ProviderId, HTMLIFrameElement>();
/** Frames whose provider page has loaded (a wake before that would target a still-blank document). */
const loaded = new WeakSet<HTMLIFrameElement>();
let lastUse = Date.now();

/** The frame shows a document of our own origin (its initial about:blank): not the provider's page yet. */
function stillBlank(f: HTMLIFrameElement): boolean {
  try {
    void f.contentWindow?.location.href; // readable only while same-origin with this document
    return true;
  } catch {
    return false;
  }
}

function frameFor(p: ProviderId, create: boolean): HTMLIFrameElement | null {
  let f = frames.get(p) ?? null;
  if (!f && create) {
    f = document.createElement('iframe');
    f.id = `relay-${p}`;
    f.width = '1024';
    f.height = '768';
    f.src = providerById(p).newTabUrl;
    document.body.appendChild(f);
    frames.set(p, f);
    // A hidden document never renders on its own: lay it out now, or the frame's page gets a 0×0
    // viewport (chatgpt.com's composer then takes no input). Again once the frame has loaded.
    void f.offsetWidth;
    f.addEventListener('load', () => {
      void f!.offsetWidth;
      loaded.add(f!);
    });
  }
  return f;
}

ext().runtime.onMessage.addListener((msg: unknown, sender) => {
  if (sender.id !== ext().runtime.id || sender.tab) return undefined; // the background only
  const m = msg as { type?: unknown; nonce?: unknown; provider?: unknown } | null;
  const p: ProviderId = m?.provider === undefined ? 'claude' : isProviderId(m?.provider) ? m.provider : ('' as ProviderId);
  if (!isProviderId(p)) return undefined;
  if (m?.type === MSG_WAKE) {
    lastUse = Date.now();
    const nonce = typeof m.nonce === 'string' && ID_RE.test(m.nonce) ? m.nonce : undefined;
    const f = frameFor(p, true);
    // Only once the provider's page is there (the wake is re-sent until then, and the frame's relay
    // connects on its own once parsed): posting to a still-blank frame fails its origin check.
    if (f && loaded.has(f) && !stillBlank(f)) {
      try {
        f.contentWindow?.postMessage({ type: MSG_WAKE, ...(nonce ? { nonce } : {}) }, providerById(p).origin);
      } catch {
        /* navigating */
      }
    }
  } else if (m?.type === MSG_RELOAD_FRAME) {
    lastUse = Date.now();
    const f = frameFor(p, false);
    if (f) {
      loaded.delete(f);
      f.src = providerById(p).newTabUrl;
    }
  } else if (m?.type === MSG_DROP_FRAME) {
    frameFor(p, false)?.remove();
    frames.delete(p);
  }
  return undefined;
});

setInterval(() => {
  if (Date.now() - lastUse > OFFSCREEN_IDLE_MS) {
    ext()
      .runtime.sendMessage({ type: MSG_OFFSCREEN_IDLE })
      .catch(() => {});
  }
}, 60_000);
