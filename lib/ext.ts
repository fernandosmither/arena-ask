import { browser } from 'wxt/browser';

export type Ext = typeof browser;

/**
 * The extension API namespace, resolved at call time. Prefers a complete `browser` (Firefox) and
 * otherwise `chrome` — Chrome's `globalThis.browser` alias has been seen incomplete in content
 * scripts (Tangents hit "reading 'get'" on `browser.storage`), so it's never trusted blindly.
 */
export function ext(): Ext {
  const g = globalThis as unknown as { browser?: Ext; chrome?: Ext };
  if (g.browser?.runtime?.id && g.browser.storage?.local) return g.browser;
  return (g.chrome ?? browser) as Ext;
}

/** True for the errors an orphaned content script throws after the extension is reloaded/updated. */
export function isContextInvalidated(e: unknown): boolean {
  return /context invalidated|Extension context|extension storage is unavailable/i.test(String(e));
}

/** Whether the extension context is still alive (false in an orphaned content script). */
export function extAlive(): boolean {
  try {
    return !!ext()?.runtime?.id;
  } catch {
    return false;
  }
}
