import type { Browser } from 'wxt/browser';
import { ext } from './ext';
import { MSG_PROJECT_CREATED, PROTOCOL_VERSION, humanError, type ProjectRef, type StreamEvent } from './protocol';
import { runRelayAsk, runRelayStop } from './relay';
import { validateRelayAsk, validateRelayStop } from './validate';

/**
 * Serve ONE question over a port from the background, in a claude.ai page (a top-level tab, or the
 * invisible frame in the offscreen document). The port protocol is the same for both:
 *
 *   relay → background: hello, then started?, delta* and exactly one done | error
 *   background → relay: ask   (disconnecting the port cancels the question and stops generation
 *                              on claude.ai)
 *   or, instead:        stop {convUuid, orgTag} → stopped {ok}: stop generating in a conversation
 *                              (of that account) whose own relay went away mid-answer
 *
 * One verb per port. No other verbs exist: no API passthrough, and it never reads other conversations.
 */
export function serveRelayPort(port: Browser.runtime.Port, opts: { nonce?: string; frame?: boolean } = {}): void {
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
    ac.abort(); // the asker went away: stop streaming
  });
  port.onMessage.addListener((m: unknown) => {
    if (asked) return send({ type: 'error', code: 'busy', message: humanError('busy') });
    const stop = validateRelayStop(m);
    if (stop) {
      asked = true;
      void runRelayStop(stop.convUuid, stop.orgTag, ac.signal).then((ok) => send({ type: 'stopped', ok }));
      return;
    }
    const req = validateRelayAsk(m);
    if (!req) return send({ type: 'error', code: 'invalid', message: humanError('invalid', '(relay)') });
    asked = true;
    // In the offscreen frame, a Cloudflare challenge on the first request usually clears by
    // itself within seconds: wait for it there (a tab would just show it to the user).
    void runRelayAsk(req, send, ac.signal, {
      ...(opts.frame ? { waitForOrg: (e: { code: string }) => e.code === 'cloudflare' } : {}),
      onProjectCreated: reportCreatedProject,
    });
  });
  send({ type: 'hello', v: PROTOCOL_VERSION, ...(opts.nonce ? { nonce: opts.nonce } : {}) });
}

/**
 * A project this relay just created, sent to the background as a runtime message rather than on the
 * ask's port: the port may already be closed (the question was cancelled during its first setup),
 * and an unreported project could never be cleaned up.
 */
function reportCreatedProject(project: ProjectRef): void {
  try {
    void ext()
      .runtime.sendMessage({ type: MSG_PROJECT_CREATED, project })
      .catch(() => {});
  } catch {
    /* extension reloaded under us */
  }
}
