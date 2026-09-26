/**
 * A small, deliberately conservative Markdown → HTML renderer for Claude's answers.
 *
 * Safety model: every character of model text is HTML-escaped BEFORE any markup is produced, so
 * the only tags in the output are the fixed ones generated here. Links are emitted only for
 * absolute http(s) URLs (re-validated with `URL`), always with `rel="noopener noreferrer"`.
 * The DOM insertion path additionally runs the result through an allowlist sanitizer
 * (see sanitize.ts), so a renderer bug alone cannot inject markup.
 *
 * Cost model: answers are untrusted (prompt injection through the page context is possible) and
 * are re-rendered on every page load, so rendering must stay cheap for ANY input. Every block and
 * inline rule is a linear scan or a regex without nested/adjacent unbounded quantifiers that can
 * backtrack over the same text; tables are capped; and `renderMarkdown` falls back to escaped
 * plain text for over-long input, over-large output, or a blown time budget (see RENDER_LIMITS).
 *
 * Supported: fenced code (``` / ~~~, any fence length, info string), inline code, headings,
 * paragraphs (single newlines → <br>), bold / italic / strikethrough, links + bare URL autolinks,
 * bullet / ordered lists (nested by indentation), blockquotes, horizontal rules, GFM pipe tables,
 * backslash escapes. Not supported (rendered as text): raw HTML, images, math, footnotes.
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** An absolute http(s) URL, normalized; anything else (javascript:, data:, relative…) → null. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Limits

export interface RenderLimits {
  /** Answers longer than this (chars) skip markdown and are shown as escaped plain text. */
  maxChars: number;
  /** Rendered output with more elements than this is replaced by the plain-text view. */
  maxElements: number;
  /** …as is rendered output longer than this (chars of HTML). */
  maxHtmlChars: number;
  /** Wall-clock budget for one render (ms); exceeding it falls back to the plain-text view. */
  timeBudgetMs: number;
  /** A table with more columns than this is shown as plain text. */
  tableCols: number;
  /** Body rows rendered per table; the rest of the table is shown as plain text. */
  tableRows: number;
  /** Cells (header + body) rendered per table; rows beyond it are shown as plain text. */
  tableCells: number;
}

export const RENDER_LIMITS: Readonly<RenderLimits> = Object.freeze({
  maxChars: 100_000,
  maxElements: 40_000,
  maxHtmlChars: 2_000_000,
  timeBudgetMs: 300,
  tableCols: 50,
  tableRows: 500,
  tableCells: 10_000,
});

/** Class on the plain-text block (sanitize.ts allows it), for styling. */
export const PLAIN_CLASS = 'arena-ask-plain';

const MAX_DEPTH = 8;

class BudgetExceeded extends Error {}

interface Ctx {
  lim: RenderLimits;
  deadline: number;
  ticks: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Throw BudgetExceeded once the time budget is spent (the clock is read every 32 calls). */
function tick(ctx: Ctx | undefined): void {
  if (ctx && (++ctx.ticks & 31) === 0 && now() > ctx.deadline) throw new BudgetExceeded();
}

/** 12345 → "12,345" (no Intl: its first call alone costs ~10 ms). */
const fmt = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, ',');

function note(text: string): string {
  return `<p><em>${escapeHtml(text)}</em></p>`;
}

/** Escaped text in a code-block-styled <pre>: line breaks and spacing kept, copy button added. */
function plainBlock(text: string): string {
  return `<div class="codehilite arena-ask-code ${PLAIN_CLASS}"><pre><code>${escapeHtml(text)}</code></pre></div>`;
}

/** The whole answer as escaped plain text, with a one-line note saying why. */
function renderPlain(text: string, why: string): string {
  return `${note(why)}\n${plainBlock(text)}`;
}

/** Elements in generated HTML: every "<" in it is a tag we emitted (model text is escaped). */
function countElements(html: string): number {
  let n = 0;
  for (let i = html.indexOf('<'); i >= 0; i = html.indexOf('<', i + 1)) if (html[i + 1] !== '/') n++;
  return n;
}

export function renderMarkdown(src: string, limits: Partial<RenderLimits> = {}): string {
  const lim: RenderLimits = { ...RENDER_LIMITS, ...limits };
  const text = String(src).replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  if (text.length > lim.maxChars) {
    return renderPlain(text, `This answer is too long to format (${fmt(text.length)} characters), so it is shown as plain text.`);
  }
  const ctx: Ctx = { lim, deadline: now() + lim.timeBudgetMs, ticks: 0 };
  let html: string;
  try {
    html = renderBlocks(text.split('\n'), 0, ctx);
    if (now() > ctx.deadline) throw new BudgetExceeded();
  } catch {
    // BudgetExceeded, or anything unexpected: never leave the bubble unrendered.
    return renderPlain(text, 'This answer is too complex to format, so it is shown as plain text.');
  }
  if (html.length > lim.maxHtmlChars || countElements(html) > lim.maxElements) {
    return renderPlain(text, 'This answer is too large to format, so it is shown as plain text.');
  }
  return html;
}

// ---------------------------------------------------------------------------------------------
// Blocks

// `[\s\S]` instead of `.`: `.` stops at U+2028/U+2029, and a failed `$` then backtracks the
// preceding quantifiers over the whole line (quadratic).
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})([\s\S]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])[ \t]+([\s\S]*)$/;

const isBlank = (l: string) => /^[ \t]*$/.test(l);
const isSpTab = (c: string | undefined) => c === ' ' || c === '\t';
const indentOf = (l: string) => {
  let n = 0;
  for (let i = 0; i < l.length && isSpTab(l[i]); i++) n += l[i] === '\t' ? 4 : 1;
  return n;
};

/** Remove up to `max` leading spaces (not tabs). */
function stripSpaces(l: string, max: number): string {
  let i = 0;
  while (i < max && l.charCodeAt(i) === 32) i++;
  return i ? l.slice(i) : l;
}

function isFenceOpen(line: string): RegExpExecArray | null {
  const m = FENCE_OPEN.exec(line);
  // a backtick fence's info string may not contain backticks (that's inline code instead)
  if (!m || (m[2][0] === '`' && m[3].includes('`'))) return null;
  return m;
}

/**
 * ATX heading, as `/^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/` matched it, in one pass: up to
 * 3 spaces, 1–6 #, whitespace, then the text minus trailing whitespace and one closing # run
 * (only when whitespace separates it from the text).
 */
export function parseHeading(line: string): { level: number; text: string } | null {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let j = i;
  while (line[j] === '#') j++;
  const level = j - i;
  if (level < 1 || level > 6 || !isSpTab(line[j])) return null;
  let s = j;
  while (isSpTab(line[s])) s++; // text start
  let e = line.length;
  while (e > s && isSpTab(line[e - 1])) e--; // drop trailing whitespace
  let h = e;
  while (h > s && line[h - 1] === '#') h--; // closing # run is line[h, e)
  if (h < e && h > s && isSpTab(line[h - 1])) {
    e = h;
    while (e > s && isSpTab(line[e - 1])) e--;
  }
  return { level, text: line.slice(s, e) };
}

/**
 * GFM delimiter row, as `/^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/` matched
 * it, in one pass (the regex's adjacent `[ \t]*` made a failing line quadratic).
 */
export function isTableSep(line: string): boolean {
  const n = line.length;
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  if (line[i] === '|') i++;
  for (;;) {
    while (isSpTab(line[i])) i++;
    if (line[i] === ':') i++;
    if (line[i] !== '-') return false;
    while (line[i] === '-') i++;
    if (line[i] === ':') i++;
    while (isSpTab(line[i])) i++;
    if (i === n) return true;
    if (line[i] !== '|') return false;
    i++;
    let k = i;
    while (isSpTab(line[k])) k++;
    if (k === n) return true; // trailing pipe
  }
}

function isBlockStart(line: string): boolean {
  return !!(isFenceOpen(line) || parseHeading(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line));
}

function renderBlocks(lines: string[], depth: number, ctx: Ctx): string {
  const out: string[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join('\n'), ctx)}</p>`);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    tick(ctx);
    const line = lines[i];

    const fence = isFenceOpen(line);
    if (fence) {
      flushPara();
      const indent = fence[1].length;
      const marker = fence[2];
      const lang = /^[\w+#.-]{1,32}/.exec(fence[3].trim())?.[0] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const c = FENCE_CLOSE.exec(lines[i]);
        if (c && c[1][0] === marker[0] && c[1].length >= marker.length) {
          i++;
          break;
        }
        body.push(indent ? stripSpaces(lines[i], indent) : lines[i]);
        i++;
      }
      out.push(codeBlock(body.join('\n'), lang));
      continue;
    }

    if (isBlank(line)) {
      flushPara();
      i++;
      continue;
    }

    const h = parseHeading(line);
    if (h) {
      flushPara();
      out.push(`<h${h.level}>${inline(h.text, ctx)}</h${h.level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      flushPara();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out.push(
        `<blockquote>${depth < MAX_DEPTH ? renderBlocks(inner, depth + 1, ctx) : `<p>${inline(inner.join('\n'), ctx)}</p>`}</blockquote>`,
      );
      continue;
    }

    if (LIST.test(line)) {
      flushPara();
      const r = renderList(lines, i, depth, ctx);
      out.push(r.html);
      i = r.next;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const r = renderTable(lines, i, ctx);
      if (r) {
        flushPara();
        out.push(r.html);
        i = r.next;
        continue;
      }
    }

    para.push(line.replace(/^[ \t]+/, ''));
    i++;
  }
  flushPara();
  return out.join('\n');
}

function codeBlock(code: string, lang: string): string {
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<div class="codehilite arena-ask-code"><pre><code${cls}>${escapeHtml(code)}</code></pre></div>`;
}

function renderList(lines: string[], start: number, depth: number, ctx: Ctx): { html: string; next: number } {
  const first = LIST.exec(lines[start])!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items: string[][] = [];
  let contentIndent = base + first[2].length + 1;
  let i = start;

  while (i < lines.length) {
    tick(ctx);
    const l = lines[i];
    const m = LIST.exec(l);
    if (m && m[1].length <= base + 1) {
      if (/\d/.test(m[2]) !== ordered) break; // a different list type at this level starts a new list
      items.push([m[3]]);
      contentIndent = m[1].length + m[2].length + 1;
      i++;
      continue;
    }
    if (isBlank(l)) {
      // a run of blank lines continues the list only if more of it (an item or indented content)
      // follows; the whole run is decided at once (per-line lookahead was quadratic)
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      const nm = j < lines.length ? LIST.exec(lines[j]) : null;
      const continues =
        j < lines.length &&
        (indentOf(lines[j]) > base || (!!nm && nm[1].length <= base + 1 && /\d/.test(nm[2]) === ordered));
      if (!continues) break;
      const item = items[items.length - 1];
      for (; i < j; i++) item.push('');
      continue;
    }
    if (indentOf(l) > base) {
      items[items.length - 1].push(stripSpaces(l, contentIndent));
      i++;
      continue;
    }
    if (!isBlockStart(l)) {
      items[items.length - 1].push(l.trim()); // lazy continuation of the item's paragraph
      i++;
      continue;
    }
    break;
  }

  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  const lis = items.map((item) => {
    let html =
      depth < MAX_DEPTH ? renderBlocks(item, depth + 1, ctx) : `<p>${inline(item.join('\n'), ctx)}</p>`;
    html = html.replace(/^<p>([\s\S]*?)<\/p>\n?/, '$1'); // tight item: no <p> around its first paragraph
    return `<li>${html}</li>`;
  });
  return { html: `<${tag}${startAttr}>${lis.join('')}</${tag}>`, next: i };
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/**
 * A GFM table. Body rows are padded to the header's width, so an unbounded table is an output
 * amplifier (a 12 KB answer used to become 36 MB / 4M cells): at most `tableCols` columns and
 * `tableRows` / `tableCells` are rendered; the rest is shown as plain text with a note.
 */
function renderTable(lines: string[], start: number, ctx: Ctx): { html: string; next: number } | null {
  const head = splitRow(lines[start]);
  const sep = splitRow(lines[start + 1]);
  if (head.length < 1 || sep.length !== head.length) return null;
  let end = start + 2;
  while (end < lines.length && !isBlank(lines[end]) && lines[end].includes('|')) end++;
  const { tableCols, tableRows, tableCells } = ctx.lim;
  const cols = head.length;
  if (cols > tableCols) {
    const why = `This table has ${fmt(cols)} columns (the limit is ${fmt(tableCols)}), so it is shown as plain text.`;
    return { html: `${note(why)}\n${plainBlock(lines.slice(start, end).join('\n'))}`, next: end };
  }

  const align = sep.map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '',
  );
  const cell = (tag: 'th' | 'td', text: string, k: number) =>
    `<${tag}${align[k] ? ` align="${align[k]}"` : ''}>${inline(text, ctx)}</${tag}>`;
  const maxRows = Math.max(0, Math.min(tableRows, Math.floor((tableCells - cols) / cols)));
  const shownEnd = Math.min(end, start + 2 + maxRows);
  const rows: string[] = [];
  for (let i = start + 2; i < shownEnd; i++) {
    const cells = splitRow(lines[i]);
    rows.push(`<tr>${head.map((_, k) => cell('td', cells[k] ?? '', k)).join('')}</tr>`);
  }
  const thead = `<thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>`;
  let html = `<div class="arena-ask-table"><table>${thead}<tbody>${rows.join('')}</tbody></table></div>`;
  if (shownEnd < end) {
    const rest = end - shownEnd;
    const why = `Table truncated after ${fmt(rows.length)} rows; the remaining ${fmt(rest)} ${rest === 1 ? 'row is' : 'rows are'} shown as plain text.`;
    html += `\n${note(why)}\n${plainBlock(lines.slice(shownEnd, end).join('\n'))}`;
  }
  return { html, next: end };
}

// ---------------------------------------------------------------------------------------------
// Inline

const HOLD = /\u0000(\d+)\u0000/g;

export function renderInline(src: string): string {
  return inline(src);
}

function inline(src: string, ctx?: Ctx): string {
  tick(ctx);
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  // 0. NUL is the placeholder delimiter: model text may not contain it.
  // 1. Code spans: literal content, extracted before anything else.
  let s = extractCodeSpans(src.replace(/\u0000/g, ''), (code) => hold(`<code>${escapeHtml(code)}</code>`));

  // 2. Backslash escapes: the escaped character is literal.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, ch: string) => hold(escapeHtml(ch)));

  // 3. Escape EVERYTHING that is left. From here on, `s` contains no raw markup.
  s = escapeHtml(s);

  // 4. Links [text](url "title"): only absolute http(s) URLs become anchors.
  s = replaceLinks(s, (text, url) => {
    const href = safeHttpUrl(unescapeHtml(url));
    if (!href) return text;
    return hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${emphasis(text)}</a>`);
  });

  // 5. Bare URLs.
  s = s.replace(/\bhttps?:\/\/[^\s<>\u0000]+/gi, (m: string) => {
    let url = m;
    const cut = url.search(/&(?:quot|#39|lt|gt);/);
    if (cut >= 0) url = url.slice(0, cut);
    let e = url.length; // drop trailing punctuation (a loop: `/[.,;:!?)\]*_~]+$/` was quadratic)
    while (e > 0 && TRAILING_PUNCT.has(url[e - 1])) e--;
    url = url.slice(0, e);
    const href = safeHttpUrl(unescapeHtml(url));
    if (!href) return m;
    return (
      hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${url}</a>`) +
      m.slice(url.length)
    );
  });

  // 6. Emphasis, then line breaks.
  s = emphasis(s).replace(/\n/g, '<br>');

  // 7. Restore held fragments (a link's text may itself hold code spans, hence the loop).
  for (let k = 0; k < 4 && s.includes('\u0000'); k++) s = s.replace(HOLD, (_, n: string) => slots[+n] ?? '');
  return s.replace(/\u0000/g, '');
}

const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '*', '_', '~']);

/** JS `\s` (the class the original link regex used). */
function isWs(c: number): boolean {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

const QUOT = '&quot;';
/** A link title longer than this (escaped chars) is not recognized as one. */
const MAX_TITLE = 512;

/**
 * Replace `[text](url "title")` over escaped text, with the matches of
 * `/\[([^\]\n]+)\]\(\s*([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+&quot;[^\n]*?&quot;)?\s*\)/g`
 * (titles capped at MAX_TITLE chars), in linear time. That regex rescanned the rest of the line
 * from every "[" (160k "[" froze the page for 10 s). Here every "[" before the same "]" shares
 * one "(…)" parse, and a failed parse skips all of them.
 */
function replaceLinks(s: string, make: (text: string, url: string) => string): string {
  const n = s.length;
  let out = '';
  let last = 0;
  let p = s.indexOf('[');
  while (p >= 0) {
    // q: the first "]" or newline after p; text = s[p+1, q) must be non-empty and end at "]".
    let q = p + 1;
    while (q < n && s[q] !== ']' && s[q] !== '\n') q++;
    if (q >= n) break; // no "]" or newline anywhere ahead: no later "[" can match either
    if (s[q] === ']' && q > p + 1 && s[q + 1] === '(') {
      const m = linkTail(s, q + 2);
      if (m) {
        out += s.slice(last, p) + make(s.slice(p + 1, q), m.url);
        last = m.end;
        p = s.indexOf('[', last);
        continue;
      }
    }
    // Every "[" in (p, q) has the same q, so it fails the same way: skip past q.
    p = s.indexOf('[', q + 1);
  }
  return last ? out + s.slice(last) : s;
}

/** Parse `\s*URL(?:\s+&quot;TITLE&quot;)?\s*\)` at `i` (just after "]("). */
function linkTail(s: string, i: number): { url: string; end: number } | null {
  const n = s.length;
  let u = i;
  while (u < n && isWs(s.charCodeAt(u))) u++;
  // URL: [^()\s]* with balanced one-level (…) groups. Maximal munch is the only candidate: a
  // shorter URL would be followed by a URL character or "(", which nothing after it accepts.
  let k = u;
  for (;;) {
    while (k < n && !isWs(s.charCodeAt(k)) && s[k] !== '(' && s[k] !== ')') k++;
    if (s[k] !== '(') break;
    let g = k + 1;
    while (g < n && !isWs(s.charCodeAt(g)) && s[g] !== '(' && s[g] !== ')') g++;
    if (s[g] !== ')') break;
    k = g + 1;
  }
  const url = s.slice(u, k);
  const end = titleThenParen(s, k) ?? closeParen(s, k);
  if (end !== null) return { url, end };
  // The regex could also backtrack `\(\s*` to leave the URL empty and read the spaces as the
  // title's leading `\s+` (e.g. `[a]( "b c")`).
  if (u > i) {
    const e2 = titleThenParen(s, i);
    if (e2 !== null) return { url: '', end: e2 };
  }
  return null;
}

/** `\s*\)` at i → index after ")", else null. */
function closeParen(s: string, i: number): number | null {
  while (i < s.length && isWs(s.charCodeAt(i))) i++;
  return s[i] === ')' ? i + 1 : null;
}

/** `\s+&quot;[^\n]*?&quot;\s*\)` at i → index after ")", else null. */
function titleThenParen(s: string, i: number): number | null {
  let k = i;
  while (k < s.length && isWs(s.charCodeAt(k))) k++;
  if (k === i || !s.startsWith(QUOT, k)) return null;
  const from = k + QUOT.length;
  const limit = Math.min(s.length, from + MAX_TITLE); // bounded: never rescan the rest of the line
  for (let c = from; c < limit && s[c] !== '\n'; c++) {
    if (s[c] === '&' && s.startsWith(QUOT, c)) {
      const e = closeParen(s, c + QUOT.length);
      if (e !== null) return e;
    }
  }
  return null;
}

/**
 * Bold / italic / strikethrough over already-escaped text. `__bold__` is intentionally NOT
 * supported: in ML/Python answers it mangles dunders like __init__ far more often than it helps.
 */
function emphasis(s: string): string {
  s = pairDelims(s, '**', 'strong');
  s = s
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  return pairDelims(s, '~~', 'del');
}

/**
 * `s.replace(/DD(?=\S)([\s\S]*?\S)DD/g, '<tag>$1</tag>')` for a two-char delimiter DD, in linear
 * time (the lazy regex rescanned the rest of the text from every unclosed DD). An opener is DD
 * followed by a non-space; its closer is the first DD at least one char later whose preceding
 * char is a non-space.
 */
function pairDelims(s: string, dd: string, tag: string): string {
  let out = '';
  let last = 0;
  let close = -1; // first closer at or after the current search start
  for (let p = s.indexOf(dd); p >= 0; ) {
    if (p + 2 < s.length && !isWs(s.charCodeAt(p + 2))) {
      if (close < p + 3) {
        close = s.indexOf(dd, p + 3);
        while (close >= 0 && isWs(s.charCodeAt(close - 1))) close = s.indexOf(dd, close + 1);
      }
      if (close < 0) break; // no closer after p, so none after any later opener either
      out += `${s.slice(last, p)}<${tag}>${s.slice(p + 2, close)}</${tag}>`;
      last = close + 2;
      p = s.indexOf(dd, last);
      continue;
    }
    p = s.indexOf(dd, p + 1);
  }
  return last ? out + s.slice(last) : s;
}

/**
 * Replace `code spans` (any backtick-run length, CommonMark-style) via `wrap`; other text untouched.
 * Each opening run pairs with the next run of exactly its length. Runs are indexed by length up
 * front, so finding a closer never rescans the text (unclosed runs of many different lengths used
 * to make this superlinear).
 */
function extractCodeSpans(src: string, wrap: (code: string) => string): string {
  const pos: number[] = [];
  const len: number[] = [];
  for (let i = src.indexOf('`'); i >= 0; ) {
    let e = i;
    while (src[e] === '`') e++;
    pos.push(i);
    len.push(e - i);
    i = src.indexOf('`', e);
  }
  if (!pos.length) return src;
  const byLen = new Map<number, number[]>(); // run length → run indices, ascending
  for (let r = 0; r < pos.length; r++) {
    const list = byLen.get(len[r]);
    if (list) list.push(r);
    else byLen.set(len[r], [r]);
  }
  const cursor = new Map<number, number>(); // run length → next unexamined position in its list

  let out = '';
  let i = 0; // copied up to here
  for (let r = 0; r < pos.length; r++) {
    const run = len[r];
    const list = byLen.get(run)!;
    let c = cursor.get(run) ?? 0;
    while (c < list.length && list[c] <= r) c++;
    cursor.set(run, c);
    if (c >= list.length) continue; // unmatched run: literal backticks
    const closeRun = list[c];
    const open = pos[r];
    const close = pos[closeRun];
    let code = src.slice(open + run, close).replace(/\n/g, ' ');
    if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
    out += src.slice(i, open) + wrap(code);
    i = close + run;
    r = closeRun; // continue after the closing run
  }
  return out + src.slice(i);
}
