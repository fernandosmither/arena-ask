import { ARENA_SEL } from './arena-selectors';
import { textHash } from './hash';
import { answerIndexOf } from './meta-store';
import { renderMarkdown } from './markdown';
import type { BubbleMeta } from './meta';
import { CHATGPT, CLAUDE } from './provider';
import { sanitizeToFragment } from './sanitize';
import { utilizationPercent } from './sse';
import { UUID_RE } from './uuid';

/**
 * Turns a finished Claude or ChatGPT answer (plain text in ARENA's bubble) into rendered markdown plus
 * a small footer ("Open in claude.ai ↗ · 5h: N%", "Open in ChatGPT ↗ · <model>"). ARENA's own
 * history/rendering is left alone: we only rewrite bubbles whose text hash matches an answer we recorded.
 */

/** 'streaming' while an answer is arriving; 'done' once enhanced. */
export const STATE_ATTR = 'data-arena-ask';
export const FOOTER_CLASS = 'arena-ask-meta';
/** The line under a bubble while a tool runs (full mode): not part of the answer ARENA saves. */
export const STATUS_CLASS = 'arena-ask-status';

/**
 * Show `text` ("Searching past chats…") in italics right under the answer's bubble, replacing any
 * earlier status line. A sibling of the bubble, not inside it: ARENA rewrites the bubble's text as
 * the answer streams and saves that text, and a status line must be neither wiped nor saved.
 */
export function setStatus(bubble: HTMLElement | null, text: string): void {
  if (!bubble?.isConnected) return;
  const doc = bubble.ownerDocument;
  let el = bubble.nextElementSibling;
  if (!el?.classList.contains(STATUS_CLASS)) {
    el = doc.createElement('div');
    el.className = STATUS_CLASS;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    bubble.after(el);
  }
  const em = doc.createElement('em');
  em.textContent = text;
  el.replaceChildren(em);
}

/** Remove the status line under `bubble`, if any. */
export function clearStatus(bubble: HTMLElement | null): void {
  const next = bubble?.nextElementSibling;
  if (next?.classList.contains(STATUS_CLASS)) next.remove();
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(doc: Document, kind: 'copy' | 'check'): SVGSVGElement {
  const s = doc.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    s.setAttribute(k, v);
  const add = (tag: string, attrs: Record<string, string>) => {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    s.appendChild(el);
  };
  if (kind === 'copy') {
    add('rect', { x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' });
    add('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' });
  } else {
    add('polyline', { points: '20 6 9 17 4 12' });
  }
  return s;
}

/** A copy button on each code block, matching ARENA's own `.code-copy-button`. */
export function addCopyButtons(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const block of root.querySelectorAll<HTMLElement>('.codehilite')) {
    if (block.querySelector('.code-copy-button')) continue;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-button';
    btn.title = 'Copy code';
    btn.setAttribute('aria-label', 'Copy code');
    btn.appendChild(svg(doc, 'copy'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = block.querySelector('pre')?.textContent ?? '';
      navigator.clipboard
        ?.writeText(code)
        .then(() => {
          btn.classList.add('copied');
          btn.replaceChildren(svg(doc, 'check'));
          setTimeout(() => {
            btn.classList.remove('copied');
            btn.replaceChildren(svg(doc, 'copy'));
          }, 1500);
        })
        .catch(() => {});
    });
    block.appendChild(btn);
  }
}

export function buildFooter(doc: Document, meta: BubbleMeta): HTMLElement {
  const f = doc.createElement('div');
  f.className = FOOTER_CLASS;
  if (meta.v) f.setAttribute('data-via', meta.v);
  const site = meta.p === 'g' ? CHATGPT : CLAUDE;
  if (meta.c && UUID_RE.test(meta.c)) {
    const a = doc.createElement('a');
    a.href = site.chatUrl(meta.c);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = site.openLabel;
    f.appendChild(a);
  }
  if (meta.m && /^[A-Za-z0-9._-]{1,64}$/.test(meta.m)) {
    const s = doc.createElement('span');
    s.className = 'arena-ask-model';
    s.textContent = `· ${meta.m}`;
    s.title = `The ${site.name} model that answered`;
    f.appendChild(s);
  }
  const p5 = site === CLAUDE ? utilizationPercent(meta.u) : null;
  if (p5 !== null) {
    const s = doc.createElement('span');
    s.className = 'arena-ask-usage';
    s.textContent = `5h: ${p5}%`;
    const p7 = utilizationPercent(meta.w);
    s.title = `Your Claude usage in the current 5-hour window${p7 !== null ? ` (7-day: ${p7}%)` : ''}`;
    f.appendChild(s);
  }
  return f;
}

/** Render `raw` (the answer text) into the bubble and put the footer right after it. */
export function enhanceBubble(el: HTMLElement, raw: string, meta: BubbleMeta | null): void {
  const doc = el.ownerDocument;
  clearStatus(el);
  el.replaceChildren(sanitizeToFragment(renderMarkdown(raw), doc));
  el.classList.add('arena-ask-md');
  el.setAttribute(STATE_ATTR, 'done');
  addCopyButtons(el);
  const next = el.nextElementSibling;
  if (next?.classList.contains(FOOTER_CLASS)) next.remove();
  if (meta) el.after(buildFooter(doc, meta));
}

/**
 * Enhance every not-yet-enhanced assistant bubble whose exact text is a recorded Claude answer
 * (covers ARENA re-rendering its history from localStorage on reload). `seen` skips bubbles whose
 * text hasn't changed since the last scan, so streaming updates stay cheap.
 */
export function scanBubbles(
  root: ParentNode,
  lookup: (hash: string, index: number) => BubbleMeta | undefined,
  seen: WeakMap<Element, string>,
): number {
  let n = 0;
  for (const el of root.querySelectorAll<HTMLElement>(`${ARENA_SEL.messages} ${ARENA_SEL.assistantBubble}`)) {
    if (el.hasAttribute(STATE_ATTR) || el.classList.contains(ARENA_SEL.errorClass)) continue;
    const text = el.textContent ?? '';
    if (!text || seen.get(el) === text) continue;
    seen.set(el, text);
    const meta = lookup(textHash(text), answerIndexOf(el));
    if (meta) {
      enhanceBubble(el, text, meta);
      n++;
    }
  }
  return n;
}

const STYLE_ID = 'arena-ask-style';

/** Scoped styles, using ARENA's CSS variables (with fallbacks) so light/dark themes both work. */
export const STYLES = `
#chat-messages .chat-message.assistant[data-arena-ask="streaming"] { white-space: pre-wrap; }
.chat-message.arena-ask-md { white-space: normal; }
.arena-ask-md .arena-ask-plain pre { white-space: pre-wrap; word-break: break-word; }
.arena-ask-md > :first-child { margin-top: 0; }
.arena-ask-md > :last-child { margin-bottom: 0; }
.arena-ask-md p, .arena-ask-md ul, .arena-ask-md ol, .arena-ask-md blockquote,
.arena-ask-md h1, .arena-ask-md h2, .arena-ask-md h3, .arena-ask-md h4, .arena-ask-md h5, .arena-ask-md h6 { margin: 0.45em 0; }
.arena-ask-md h1 { font-size: 1.15em; } .arena-ask-md h2 { font-size: 1.08em; }
.arena-ask-md h3, .arena-ask-md h4, .arena-ask-md h5, .arena-ask-md h6 { font-size: 1em; }
.arena-ask-md h1, .arena-ask-md h2, .arena-ask-md h3, .arena-ask-md h4, .arena-ask-md h5, .arena-ask-md h6 { font-weight: 600; line-height: 1.35; }
.arena-ask-md ul, .arena-ask-md ol { padding-left: 1.3em; }
.arena-ask-md li + li { margin-top: 0.15em; }
.arena-ask-md li > ul, .arena-ask-md li > ol { margin: 0.15em 0; }
.arena-ask-md a { color: var(--color-primary, #3b82f6); text-decoration: underline; text-underline-offset: 2px; }
.arena-ask-md code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.88em; padding: 0.1em 0.3em;
  background: var(--color-bg-secondary, rgba(127,127,127,.12)); border-radius: var(--radius-sm, 4px); word-break: break-word; }
.arena-ask-md .codehilite { margin: 0.5em 0; padding: 0.6em 0.7em; overflow-x: auto; }
.arena-ask-md .codehilite pre { margin: 0; }
.arena-ask-md .codehilite code { padding: 0; background: none; font-size: 0.82rem; word-break: normal; }
.arena-ask-md .code-copy-button { top: 0.35em; right: 0.35em; }
.arena-ask-md blockquote { padding-left: 0.7em; border-left: 3px solid var(--color-border, rgba(127,127,127,.35));
  color: var(--color-text-secondary, inherit); }
.arena-ask-md hr { border: 0; border-top: 1px solid var(--color-border, rgba(127,127,127,.35)); margin: 0.7em 0; }
.arena-ask-md .arena-ask-table { overflow-x: auto; margin: 0.5em 0; }
.arena-ask-md table { border-collapse: collapse; font-size: 0.95em; }
.arena-ask-md th, .arena-ask-md td { border: 1px solid var(--color-border, rgba(127,127,127,.35)); padding: 0.25em 0.5em; vertical-align: top; }
.arena-ask-md th { font-weight: 600; background: var(--color-bg-secondary, rgba(127,127,127,.08)); }
.${FOOTER_CLASS} { align-self: flex-start; display: flex; flex-wrap: wrap; gap: 0.35em 0.9em; margin-top: calc(-1 * var(--spacing-sm, 0.5rem) + 3px);
  padding: 0 var(--spacing-md, 1rem); font-size: 0.6875rem; line-height: 1.4; color: var(--color-text-muted, #888); }
.${STATUS_CLASS} { align-self: flex-start; margin-top: calc(-1 * var(--spacing-sm, 0.5rem) + 3px); padding: 0 var(--spacing-md, 1rem);
  font-size: 0.75rem; line-height: 1.4; color: var(--color-text-muted, #888); }
.${FOOTER_CLASS} a { color: inherit; text-decoration: none; }
.${FOOTER_CLASS} a:hover { color: var(--color-text, inherit); text-decoration: underline; }
`;

export function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLES;
  (doc.head || doc.documentElement).appendChild(st);
}
