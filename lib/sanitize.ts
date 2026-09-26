import { PLAIN_CLASS, safeHttpUrl } from './markdown';

/**
 * Allowlist sanitizer: parses HTML in an inert document (DOMParser: no scripts run, no resources
 * load) and rebuilds it node by node in the target document, keeping only known tags and a few
 * validated attributes. Unknown elements are unwrapped (their text kept); dangerous ones are
 * dropped with their contents. Nothing from the input is adopted: every node is freshly created.
 */

const ALLOWED = new Set([
  'P', 'BR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'DIV', 'SPAN',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'A',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
]);

const DROP = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH',
  'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'OPTION', 'IMG', 'VIDEO',
  'AUDIO', 'SOURCE', 'TITLE', 'HEAD',
]);

const DIV_CLASSES = new Set(['codehilite', 'arena-ask-code', 'arena-ask-table', PLAIN_CLASS]);
const MAX_DEPTH = 64;

export function sanitizeToFragment(html: string, doc: Document): DocumentFragment {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const frag = doc.createDocumentFragment();
  copyChildren(parsed.body, frag, doc, 0);
  return frag;
}

function copyChildren(src: Node, dst: Node, doc: Document, depth: number): void {
  for (const n of Array.from(src.childNodes)) {
    if (n.nodeType === 3) {
      dst.appendChild(doc.createTextNode(n.nodeValue ?? ''));
      continue;
    }
    if (n.nodeType !== 1) continue; // comments, processing instructions…
    const el = n as Element;
    const tag = el.tagName.toUpperCase();
    if (DROP.has(tag)) continue;
    if (!ALLOWED.has(tag) || depth >= MAX_DEPTH) {
      copyChildren(el, dst, doc, depth + 1); // unwrap: keep the text, lose the element
      continue;
    }
    const out = doc.createElement(tag.toLowerCase());
    copyAttributes(el, out, tag);
    copyChildren(el, out, doc, depth + 1);
    dst.appendChild(out);
  }
}

function copyAttributes(src: Element, dst: Element, tag: string): void {
  switch (tag) {
    case 'A': {
      const href = safeHttpUrl(src.getAttribute('href'));
      if (href) {
        dst.setAttribute('href', href);
        dst.setAttribute('target', '_blank');
        dst.setAttribute('rel', 'noopener noreferrer');
      }
      break;
    }
    case 'CODE': {
      const c = src.getAttribute('class');
      if (c && /^language-[\w+#.-]{1,32}$/.test(c)) dst.setAttribute('class', c);
      break;
    }
    case 'DIV': {
      const c = (src.getAttribute('class') || '').split(/\s+/).filter((x) => DIV_CLASSES.has(x));
      if (c.length) dst.setAttribute('class', c.join(' '));
      break;
    }
    case 'OL': {
      const s = src.getAttribute('start');
      if (s && /^\d{1,9}$/.test(s)) dst.setAttribute('start', s);
      break;
    }
    case 'TH':
    case 'TD': {
      const a = src.getAttribute('align');
      if (a && /^(left|right|center)$/.test(a)) dst.setAttribute('align', a);
      break;
    }
  }
}
