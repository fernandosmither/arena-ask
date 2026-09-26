/**
 * Every ARENA-internal DOM selector, endpoint path and storage-key format the extension depends on,
 * in one place.
 *
 * Source: github.com/callummcdougall/arena-heroku `pages/static/js/right-sidebar.js` +
 * `pages/templates/base.html` (the site is migrating to github.com/ARENA-education/ARENA_materials
 * `infrastructure/core/django_run`, which currently has the same ids). If ARENA Ask stops working
 * after an ARENA update, the fix almost always lives here.
 */

export const ARENA_ORIGIN = 'https://learn.arena.education';

/**
 * ARENA serves pull-request previews on its own origin (`/pr-preview/…`, `/preview/…`) that render
 * untrusted PR markdown. No ARENA Ask script runs there, and the background refuses asks from them.
 */
export const ARENA_EXCLUDE_MATCHES = [
  'https://learn.arena.education/pr-preview/*',
  'https://learn.arena.education/preview/*',
];
const PREVIEW_PATH_RE = /^\/(pr-preview|preview)(\/|$)/;

/**
 * A URL path as ARENA's server would route it, for matching only: percent-escapes of ASCII
 * characters decoded (repeatedly, so `%2570` → `%70` → `p`; malformed or non-ASCII escapes are left
 * alone), backslashes as slashes, repeated slashes collapsed, lowercased. The manifest's
 * exclude_matches only see the literal path, so `/%70review/` or `/PR-Preview/` must be caught here.
 */
export function normalizedPath(pathname: string): string {
  let p = pathname;
  for (let i = 0; i < 5; i++) {
    const d = p.replace(/%([0-9a-fA-F]{2})/g, (m, h: string) => {
      const c = parseInt(h, 16);
      return c < 0x80 ? String.fromCharCode(c) : m;
    });
    if (d === p) break;
    p = d;
  }
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

/** True for a URL on ARENA's origin that is not a PR/preview page. */
export function isArenaCoursePage(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.origin === ARENA_ORIGIN && !PREVIEW_PATH_RE.test(normalizedPath(u.pathname));
}

/** The chapter segment of an ARENA path (`/chapter0_fundamentals/01_ray_tracing/` → `chapter0_fundamentals`). */
export function chapterPathOf(pathname: string): string {
  return normalizedPath(pathname).split('/')[1] ?? '';
}

export const ARENA_SEL = {
  /** `<select>` whose options are the models ARENA's own code accepts. */
  modelSelect: '#chat-model',
  /** The question textarea. */
  input: '#chat-input',
  /** The send button. */
  sendBtn: '#chat-send-btn',
  /** The message list; ARENA appends `.chat-message.{user|assistant}` bubbles here. */
  messages: '#chat-messages',
  /** "Clear chat history" — wipes ARENA's localStorage history for the chapter. */
  clearBtn: '#chat-clear-btn',
  /** An assistant bubble (ARENA renders it with `textContent`, so it holds plain text). */
  assistantBubble: '.chat-message.assistant',
  /** Class ARENA adds to a bubble that shows an error instead of an answer. */
  errorClass: 'error',
  /** `<script type="application/json">` with `{id, title, short_title, sections, …}` on chapter pages. */
  chapterData: '#chapter-data',
} as const;

/** ARENA's chat endpoint. Its code does `fetch('/api/chat/', {method:'POST', body: JSON.stringify({messages, context, model})})`. */
export const ARENA_CHAT_PATH = '/api/chat/';

/** The localStorage key ARENA keeps a chapter's chat history under (`[{role, content}]`). */
export function arenaHistoryKey(chapterId: string | null): string {
  return chapterId ? `arena_chat_${chapterId}` : 'arena_chat_static';
}

export interface ArenaChapter {
  /** ARENA's own chapter id (null on non-chapter pages, where ARENA uses the "static" history). */
  id: string | null;
  /** Human title for naming the claude.ai conversation. */
  title: string;
}

/** ARENA's chapter pages live under their chapter id: `/chapter0_fundamentals/…`. */
const CHAPTER_PATH_RE = /^chapter\d/;

/**
 * Does a chapter read from `#chapter-data` (which any page script can rewrite) belong to the page
 * whose URL chapter segment is `chapterPath` (`chapterPathOf`)? A chapter page's id is that segment;
 * a page without chapter data (home, planner, setup, FAQ: ARENA's "static" chat) must not be under
 * a chapter path.
 */
export function chapterMatchesPath(chapter: ArenaChapter, chapterPath: string): boolean {
  if (chapter.id === null) return !CHAPTER_PATH_RE.test(chapterPath);
  return normalizedPath(chapter.id) === chapterPath;
}

/** Read the current chapter from `#chapter-data`. Never throws. */
export function readChapter(doc: Document): ArenaChapter {
  const el = doc.querySelector(ARENA_SEL.chapterData);
  if (!el) return { id: null, title: 'Course (general)' };
  try {
    const d = JSON.parse(el.textContent || '') as Record<string, unknown>;
    const id = typeof d.id === 'string' && d.id ? d.id : null;
    const title =
      (typeof d.title === 'string' && d.title.trim()) ||
      (typeof d.short_title === 'string' && d.short_title.trim()) ||
      id ||
      'Course (general)';
    // Page-controlled: one line, capped (the relay escapes it again before quoting it to Claude).
    return { id, title: title.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Course (general)' };
  } catch {
    return { id: null, title: 'Course (general)' };
  }
}
