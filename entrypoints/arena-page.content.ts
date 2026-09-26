import { ARENA_EXCLUDE_MATCHES, isArenaCoursePage } from '@/lib/arena-selectors';
import { installInterceptor, type InterceptWindow } from '@/lib/page-intercept';

/**
 * MAIN world of learn.arena.education: wraps window.fetch so ARENA's own chat code gets a streamed
 * answer for the "my-claude" model. Holds no secrets; see lib/page-intercept.ts.
 */
export default defineContentScript({
  matches: ['https://learn.arena.education/*'],
  excludeMatches: ARENA_EXCLUDE_MATCHES,
  world: 'MAIN',
  runAt: 'document_start',
  globalName: false,
  main() {
    if (!isArenaCoursePage(location.href)) return;
    installInterceptor(window as unknown as InterceptWindow);
  },
});
