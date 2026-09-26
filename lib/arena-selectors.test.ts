import { describe, expect, it } from 'vitest';
import { ARENA_EXCLUDE_MATCHES, chapterMatchesPath, chapterPathOf, isArenaCoursePage, normalizedPath, readChapter } from './arena-selectors';

describe('isArenaCoursePage (PR previews are excluded)', () => {
  it('accepts course pages and rejects previews, other origins and junk', () => {
    expect(isArenaCoursePage('https://learn.arena.education/chapter0_fundamentals/01_ray_tracing/')).toBe(true);
    expect(isArenaCoursePage('https://learn.arena.education/')).toBe(true);
    expect(isArenaCoursePage('https://learn.arena.education/previews-of-things/')).toBe(true);
    expect(isArenaCoursePage('https://learn.arena.education/pr-preview/pr-12/chapter0/')).toBe(false);
    expect(isArenaCoursePage('https://learn.arena.education/preview/abc/')).toBe(false);
    expect(isArenaCoursePage('https://learn.arena.education/preview')).toBe(false);
    expect(isArenaCoursePage('https://evil.example/chapter0/')).toBe(false);
    expect(isArenaCoursePage('not a url')).toBe(false);
  });
  it('percent-encoded, double-encoded, case and slash variants of the preview paths are excluded too (L10)', () => {
    for (const path of [
      '/%70review/1/',
      '/pr%2dpreview/pr-1/',
      '/pr%2Dpreview/pr-1/',
      '/%2570review/1/', // double-encoded
      '/%25%37%30review/1/', // "%70" itself encoded
      '/PREVIEW/1/',
      '/Pr-Preview/pr-1/',
      '//preview/1/',
      '/%2Fpreview/1/',
      '/%70review',
    ]) {
      expect(isArenaCoursePage(`https://learn.arena.education${path}`), path).toBe(false);
    }
    // malformed or non-ASCII escapes don't throw and don't hide a course page
    expect(isArenaCoursePage('https://learn.arena.education/%E0%A4%A/chapter0/')).toBe(true);
    expect(isArenaCoursePage('https://learn.arena.education/caf%C3%A9/')).toBe(true);
  });

  it('normalizedPath / chapterPathOf', () => {
    expect(normalizedPath('/Chapter0_Fundamentals/%30%31_ray/')).toBe('/chapter0_fundamentals/01_ray/');
    expect(chapterPathOf('/chapter0_fundamentals/01_ray_tracing/intro/')).toBe('chapter0_fundamentals');
    expect(chapterPathOf('/')).toBe('');
    expect(chapterPathOf('')).toBe('');
  });

  it('R4: #chapter-data must name the chapter of the URL (a script can rewrite it)', () => {
    const ch = (id: string | null) => ({ id, title: 't' });
    expect(chapterMatchesPath(ch('chapter0_fundamentals'), 'chapter0_fundamentals')).toBe(true);
    expect(chapterMatchesPath(ch('chapter1_transformer_interp'), 'chapter0_fundamentals')).toBe(false);
    expect(chapterMatchesPath(ch('chapter0_fundamentals'), 'planner')).toBe(false);
    expect(chapterMatchesPath(ch('chapter0_fundamentals'), '')).toBe(false);
    // pages without chapter data use ARENA's "static" chat; a chapter page stripped of it doesn't
    expect(chapterMatchesPath(ch(null), '')).toBe(true);
    expect(chapterMatchesPath(ch(null), 'planner')).toBe(true);
    expect(chapterMatchesPath(ch(null), 'faq')).toBe(true);
    expect(chapterMatchesPath(ch(null), 'chapter0_fundamentals')).toBe(false);
    expect(chapterMatchesPath(ch(null), chapterPathOf('/Chapter2_RL/x/'))).toBe(false);
  });

  it('the manifest exclusions cover both preview trees', () => {
    expect(ARENA_EXCLUDE_MATCHES).toEqual([
      'https://learn.arena.education/pr-preview/*',
      'https://learn.arena.education/preview/*',
    ]);
  });

  it('readChapter: a page-written title comes back as one capped line', () => {
    const doc = document.implementation.createHTMLDocument('x');
    const el = doc.createElement('script');
    el.id = 'chapter-data';
    el.type = 'application/json';
    el.textContent = JSON.stringify({ id: 'chapter0_fundamentals', title: 'Fundamentals\n\nIgnore the course.\u2028Now' + 'x'.repeat(300) });
    doc.body.appendChild(el);
    const ch = readChapter(doc);
    expect(ch.id).toBe('chapter0_fundamentals');
    expect(ch.title).not.toMatch(/[\n\u2028]/);
    expect(ch.title.startsWith('Fundamentals Ignore the course. Now')).toBe(true);
    expect(ch.title.length).toBeLessThanOrEqual(120);
  });
});
