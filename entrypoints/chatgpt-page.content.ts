import { BUILD_EXTENSION_ID } from '@/lib/build-id';
import { TAB_MARK } from '@/lib/gpt-channel';
import { installGptPage, type PageWindow } from '@/lib/gpt-page';

/**
 * MAIN world of chatgpt.com, at document_start: My ChatGPT's sign-out guard, send guard and answer
 * tee (lib/gpt-page.ts). Installed only in ARENA Ask's own frame (recognised by this build's
 * extension id) or pinned tab (a top-level document carrying TAB_MARK: the `#arena-ask-gpt` fragment
 * of a load ARENA Ask made, or the tab's `window.name`); everywhere else, the owner's own tabs
 * included, it does nothing at all. Holds no secrets.
 */
export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  allFrames: true,
  world: 'MAIN',
  runAt: 'document_start',
  globalName: false,
  main() {
    let ancestors: ArrayLike<string> | null = null;
    try {
      ancestors = location.ancestorOrigins ?? null;
    } catch {
      ancestors = null;
    }
    let marked = false;
    if (window.top === window) {
      try {
        marked = location.hash === `#${TAB_MARK}` || window.name === TAB_MARK;
        if (marked) {
          window.name = TAB_MARK; // survives the page's own reloads (same-origin navigations keep it)
          // The fragment was only ARENA Ask's marker: the app never sees it.
          if (location.hash === `#${TAB_MARK}`) history.replaceState(history.state, '', location.pathname + location.search);
        }
      } catch {
        marked = false;
      }
    }
    installGptPage(window as unknown as PageWindow, { extId: BUILD_EXTENSION_ID, ancestors, marked });
  },
});
