import { describe, expect, it } from 'vitest';
import {
  PLAIN_CLASS,
  RENDER_LIMITS,
  escapeHtml,
  isTableSep,
  parseHeading,
  renderInline,
  renderMarkdown,
  safeHttpUrl,
} from './markdown';
import { sanitizeToFragment } from './sanitize';

/** Render then sanitize into a detached container (what the extension actually inserts). */
function dom(md: string): HTMLDivElement {
  const div = document.createElement('div');
  div.appendChild(sanitizeToFragment(renderMarkdown(md), document));
  return div;
}

/** Every element + attribute in the rendered DOM, for "nothing dangerous got through" checks. */
function inventory(root: Element): { tags: Set<string>; attrs: string[] } {
  const tags = new Set<string>();
  const attrs: string[] = [];
  for (const el of root.querySelectorAll('*')) {
    tags.add(el.tagName.toLowerCase());
    for (const a of el.attributes) attrs.push(`${el.tagName.toLowerCase()}[${a.name}=${a.value}]`);
  }
  return { tags, attrs };
}

const SAFE_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

function expectSafe(md: string) {
  const html = renderMarkdown(md);
  expect(html).not.toMatch(/<(script|img|iframe|svg|style|object|embed|math|input|form)/i);
  // every "<" of model text is escaped, so "<…>" below is always a tag the renderer generated
  expect(html).not.toMatch(/<[^>]*\son\w+\s*=/i); // no event-handler attributes
  expect(html).not.toMatch(/<[^>]*\sstyle\s*=/i);
  expect(html).not.toMatch(/href="(?!https?:\/\/)/i); // every href is absolute http(s)
  const { tags, attrs } = inventory(dom(md));
  for (const t of tags) expect(SAFE_TAGS.has(t)).toBe(true);
  for (const a of attrs) {
    expect(a).not.toMatch(/\[on/i);
    expect(a).not.toMatch(/\[style=/i);
    if (a.startsWith('a[href=')) expect(a).toMatch(/^a\[href=https?:\/\//);
  }
}

describe('XSS: model text can never become markup', () => {
  const cases: [string, string][] = [
    ['script tag', '<script>alert(1)</script>'],
    ['script inside a paragraph', 'Hello <script>fetch("//evil")</script> world'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['svg onload', '<svg/onload=alert(1)>'],
    ['iframe', '<iframe src="javascript:alert(1)"></iframe>'],
    ['javascript: link', '[click me](javascript:alert(1))'],
    ['JaVaScRiPt: with entities', '[x](JaVaScRiPt:alert(1)) [y](&#106;avascript:alert(1))'],
    ['data: link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['vbscript: link', '[x](vbscript:msgbox(1))'],
    ['relative / protocol-relative link', '[x](/logout) [y](//evil.example/x)'],
    ['attribute injection via link url', '[x](https://ok.example/"onmouseover="alert(1))'],
    ['attribute injection via title', '[x](https://ok.example/ "a" onmouseover="alert(1)")'],
    ['quote breakout in bare url', 'see https://ok.example/?q="><script>alert(1)</script>'],
    ['html in link text', '[<img src=x onerror=alert(1)>](https://ok.example/)'],
    ['html in code span', '`<script>alert(1)</script>`'],
    ['html in code fence', '```html\n<script>alert(1)</script>\n```'],
    ['injection via code fence language', '```"><script>alert(1)</script>\nx\n```'],
    ['html in heading', '# <b onclick=alert(1)>hi</b>'],
    ['html in list item', '- <a href="javascript:alert(1)">x</a>'],
    ['html in table cell', '| a | b |\n|---|---|\n| <script>x</script> | <img src=x onerror=y> |'],
    ['html in blockquote', '> <style>*{display:none}</style>'],
    ['NUL placeholder spoofing', 'a \u00000\u0000 b [x](https://ok.example/) \u00001\u0000'],
    ['markdown image', '![x](https://evil.example/x.png)'],
    // script tags, obfuscated
    ['mixed-case script', '<ScRiPt>alert(1)</sCrIpT>'],
    ['script with newline in tag', '<script\n>alert(1)</script\n>'],
    ['nested script tags', '<scr<script>ipt>alert(1)</scr</script>ipt>'],
    ['script in heading, list, quote and table at once', '# <script>a</script>\n- <script>b</script>\n> <script>c</script>\n\n|<script>d</script>|\n|-|'],
    // event-handler attributes
    ['div onmouseover', '<div onmouseover="alert(1)">x</div>'],
    ['a with onclick', '<a href="https://ok.example/" onclick="alert(1)">x</a>'],
    ['details ontoggle', '<details open ontoggle=alert(1)>'],
    ['body onload', '<body onload=alert(1)>'],
    ['handler text after an autolink', 'https://ok.example/ onmouseover=alert(1)'],
    // javascript: / data: / vbscript: links: case, entities, whitespace, control characters
    ['JAVASCRIPT: upper case', '[x](JAVASCRIPT:alert(1))'],
    ['javascript: after spaces / newline', '[x](   javascript:alert(1)) [y](\njavascript:alert(1))'],
    ['javascript: with tab / nbsp inside', '[x](java\tscript:alert(1)) [y](\u00a0javascript:alert(1))'],
    ['hex entity javascript:', '[x](&#x6A;avascript:alert(1)) [y](&#X6a;AVASCRIPT:alert(1))'],
    ['decimal entities without semicolons', '[x](&#106&#97&#118&#97&#115&#99&#114&#105&#112&#116&#58alert(1))'],
    ['entity-encoded tab / colon', '[x](jav&#x09;ascript:alert(1)) [y](javascript&colon;alert(1))'],
    ['DATA: upper case', '[x](DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['data: svg with onload', '[x](data:image/svg+xml,<svg onload=alert(1)>)'],
    ['VbScRiPt: mixed case and entity', '[x](VbScRiPt:msgbox(1)) [y](&#118;bscript:msgbox(1))'],
    ['bare javascript: / data: text', 'javascript:alert(1) JaVaScRiPt://x data:text/html,<script>x</script>'],
    ['angle-bracket autolink', '<javascript:alert(1)> <https://ok.example/>'],
    ['link inside link text', '[[x](javascript:alert(1))](https://ok.example/)'],
    ['https link with javascript: title', '[x](https://ok.example/ "javascript:alert(1)")'],
    // nested / tricky fences
    ['nested fences with script', '````\n```\n<script>alert(1)</script>\n```\n````'],
    ['shorter fence closed by longer', '```\n````\n<img src=x onerror=alert(1)>\n```'],
    ['fence in blockquote', '> ```\n> <script>alert(1)</script>\n> ```'],
    ['fence in list item', '- ```\n  <script>alert(1)</script>\n  ```'],
    ['tilde fence info breakout', '~~~"><script>alert(1)</script>\nx\n~~~'],
    ['fence info with attributes', '```js onmouseover=alert(1) class="x"\nx\n```'],
    // attribute breakouts
    ['pre-escaped quote in link url', '[x](https://ok.example/?a=1&quot;onmouseover=alert(1))'],
    ["single-quote breakout in link url", "[x](https://ok.example/'onmouseover='alert(1))"],
    ['quote breakout in bare url query', 'https://ok.example/?a="onmouseover="alert(1)'],
    ['quote breakout in table cell and alignment row', '| " onclick="x |\n|:-:|\n| \' onclick=\'x |'],
    ['quote breakout in heading', '# heading " onclick="x'],
    ['huge ordered-list start', '999999999. x\n1000000000. y'],
    ['backslash-escaped markup', '\\<script\\>alert(1)\\</script\\>'],
  ];
  for (const [name, md] of cases) {
    it(name, () => expectSafe(md));
  }

  it('shows the literal text of stripped markup instead of dropping it', () => {
    expect(dom('<script>alert(1)</script>').textContent).toBe('<script>alert(1)</script>');
    expect(dom('`<b>x</b>`').querySelector('code')!.textContent).toBe('<b>x</b>');
  });

  it('drops the href of a javascript: link but keeps its text', () => {
    const d = dom('[click me](javascript:alert(1))');
    expect(d.querySelector('a')).toBeNull();
    expect(d.textContent).toContain('click me');
  });

  it('keeps an injected quote inside the href (no attribute breakout)', () => {
    const a = dom('[x](https://ok.example/"onmouseover="alert(1))').querySelector('a');
    if (a) {
      expect(a.getAttribute('onmouseover')).toBeNull();
      expect(a.getAttribute('href')!.startsWith('https://ok.example/')).toBe(true);
    }
  });
});

describe('sanitizer (defense in depth, independent of the renderer)', () => {
  it('drops dangerous elements with their content and unwraps unknown ones', () => {
    const div = document.createElement('div');
    div.appendChild(
      sanitizeToFragment(
        '<p onclick="x()">a<script>evil()</script><img src=x onerror=y><font color=red>b</font><iframe></iframe></p>',
        document,
      ),
    );
    expect(div.innerHTML).toBe('<p>ab</p>');
  });

  it('allows only http(s) hrefs and forces target/rel', () => {
    const div = document.createElement('div');
    div.appendChild(
      sanitizeToFragment('<a href="javascript:alert(1)">j</a><a href="https://a.example/x" rel="opener" style="x">h</a>', document),
    );
    const [j, h] = div.querySelectorAll('a');
    expect(j.hasAttribute('href')).toBe(false);
    expect(h.getAttribute('href')).toBe('https://a.example/x');
    expect(h.getAttribute('rel')).toBe('noopener noreferrer');
    expect(h.getAttribute('target')).toBe('_blank');
    expect(h.hasAttribute('style')).toBe(false);
  });

  it('keeps only known classes', () => {
    const div = document.createElement('div');
    div.appendChild(sanitizeToFragment('<div class="codehilite evil"><pre><code class="language-py x">1</code></pre></div>', document));
    expect(div.innerHTML).toBe('<div class="codehilite"><pre><code>1</code></pre></div>');
  });
});

describe('markdown rendering', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('renders paragraphs with soft line breaks', () => {
    expect(renderMarkdown('one\ntwo\n\nthree')).toBe('<p>one<br>two</p>\n<p>three</p>');
  });

  it('renders headings, bold, italic, strikethrough and inline code', () => {
    expect(renderMarkdown('## Title')).toBe('<h2>Title</h2>');
    expect(renderInline('**b** and *i* and _j_ and ~~s~~ and `c*d*`')).toBe(
      '<strong>b</strong> and <em>i</em> and <em>j</em> and <del>s</del> and <code>c*d*</code>',
    );
  });

  it('leaves Python-ish text alone (dunders, snake_case, *args, arithmetic)', () => {
    expect(renderInline('the __init__ method of my_var_name')).toBe('the __init__ method of my_var_name');
    expect(renderInline('def f(*args, **kwargs): return 2*3*4')).toBe('def f(*args, **kwargs): return 2*3*4');
    expect(renderInline('a * b * c')).toBe('a * b * c');
  });

  it('renders fenced code with language class, preserving content verbatim', () => {
    const html = renderMarkdown('```python\ndef f(x):\n    return x < 2 and "a" & 1\n```');
    expect(html).toBe(
      '<div class="codehilite arena-ask-code"><pre><code class="language-python">def f(x):\n    return x &lt; 2 and &quot;a&quot; &amp; 1</code></pre></div>',
    );
  });

  it('handles nested code fences (a longer outer fence contains a shorter one)', () => {
    const md = '````markdown\nHere:\n```py\nprint(1)\n```\n````\nafter';
    const d = dom(md);
    const codes = d.querySelectorAll('pre code');
    expect(codes).toHaveLength(1);
    expect(codes[0].textContent).toBe('Here:\n```py\nprint(1)\n```');
    expect(d.querySelector('p')!.textContent).toBe('after');
  });

  it('handles ~~~ fences containing ``` and an unclosed fence at the end', () => {
    expect(dom('~~~\n```\nx\n```\n~~~').querySelector('code')!.textContent).toBe('```\nx\n```');
    expect(dom('```js\nlet a = 1;').querySelector('code')!.textContent).toBe('let a = 1;');
  });

  it('does not treat markdown inside code as markup', () => {
    const d = dom('```\n**not bold** [x](https://a.example)\n```');
    expect(d.querySelector('strong, a')).toBeNull();
  });

  it('renders links (http/https only) with rel=noopener noreferrer and target=_blank', () => {
    const a = dom('see [the docs](https://pytorch.org/docs/stable/index.html)').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://pytorch.org/docs/stable/index.html');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.textContent).toBe('the docs');
  });

  it('autolinks bare URLs without swallowing trailing punctuation', () => {
    const d = dom('Read https://arxiv.org/abs/2209.10652. Then (https://a.example/x).');
    const links = [...d.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://arxiv.org/abs/2209.10652', 'https://a.example/x']);
    expect(d.textContent).toBe('Read https://arxiv.org/abs/2209.10652. Then (https://a.example/x).');
  });

  it('keeps & in URLs correct', () => {
    const a = dom('[q](https://a.example/?a=1&b=2)').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://a.example/?a=1&b=2');
  });

  it('renders bullet and ordered lists, nested by indentation', () => {
    const d = dom('- one\n- two\n  - two.a\n  - two.b\n- three\n\n3. c\n4. d');
    const ul = d.querySelector('ul')!;
    expect([...ul.children].map((li) => li.firstChild!.textContent)).toEqual(['one', 'two', 'three']);
    expect(ul.querySelectorAll(':scope li ul li')).toHaveLength(2);
    const ol = d.querySelector('ol')!;
    expect(ol.getAttribute('start')).toBe('3');
    expect(ol.querySelectorAll('li')).toHaveLength(2);
  });

  it('lets a list start right after a paragraph line', () => {
    const d = dom('Steps:\n1. first\n2. second');
    expect(d.querySelector('p')!.textContent).toBe('Steps:');
    expect(d.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('keeps code blocks inside list items', () => {
    const d = dom('1. Run:\n\n   ```bash\n   pip install torch\n   ```\n2. Done');
    expect(d.querySelectorAll('ol > li')).toHaveLength(2);
    expect(d.querySelector('ol li code')!.textContent).toBe('pip install torch');
  });

  it('renders blockquotes and horizontal rules', () => {
    const d = dom('> quoted **text**\n\n---\n\nafter');
    expect(d.querySelector('blockquote strong')!.textContent).toBe('text');
    expect(d.querySelector('hr')).not.toBeNull();
  });

  it('renders GFM tables with alignment', () => {
    const d = dom('| shape | meaning |\n|:--|--:|\n| `(b, s)` | batch, seq |\n| `d` | model |');
    expect([...d.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['shape', 'meaning']);
    expect(d.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(d.querySelector('td code')!.textContent).toBe('(b, s)');
    expect(d.querySelector('th')!.getAttribute('align')).toBe('left');
  });

  it('supports backslash escapes', () => {
    expect(renderInline('\\*not italic\\*')).toBe('*not italic*');
  });

  it('never throws on odd input', () => {
    for (const s of ['', '```', '[', '](', '* ', '#', '|', '> ', '1.', '`', '``` ```', '- \n  - \n    - ', '\r\n\r\n']) {
      expect(() => renderMarkdown(s)).not.toThrow();
    }
  });
});

describe('safeHttpUrl', () => {
  it('accepts only absolute http(s) URLs', () => {
    expect(safeHttpUrl('https://a.example/x?y=1')).toBe('https://a.example/x?y=1');
    expect(safeHttpUrl('HTTP://A.EXAMPLE')).toBe('http://a.example/');
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', '/x', '//a.example', 'ftp://a.example', 'mailto:a@b.c', '', null]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
});

describe('XSS: seeded fuzz over payload fragments', () => {
  const parts = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg/onload=alert(1)>', "'-alert(1)-'",
    '[x](javascript:alert(1))', '[x](&#106;avascript:alert(1))', '[x](data:text/html,<b>x</b>)', '[x](vbscript:x)',
    '[x](https://ok.example/"onmouseover="alert(1))', 'https://ok.example/?q="><script>x</script>', '`<b>`',
    '```', '````', '~~~', '\n', '\n\n', '# ', '- ', '1. ', '> ', '| a | b |\n|---|---|\n', '|', '**', '*', '_', '~~',
    '[', ']', '(', ')', '"', '&', '&quot;', '\\', '\u0000', '\u00001\u0000', ' ', 'text',
  ];
  let seed = 20260925;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
  it('300 random combinations render safely', () => {
    for (let t = 0; t < 300; t++) {
      let md = '';
      for (let k = 1 + Math.floor(rnd() * 12); k > 0; k--) md += parts[Math.floor(rnd() * parts.length)];
      expectSafe(md);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Cost: model output is untrusted and re-rendered on every page load, so no input may be slow.

/** Every guard off: these timings measure the parser itself, not the plain-text fallback. */
const NO_GUARD = { maxChars: Infinity, maxElements: Infinity, maxHtmlChars: Infinity, timeBudgetMs: Infinity };
const LIMIT_MS = 200;

/** Best of two runs (absorbs a GC pause) of `fn`, with its output. */
function timed(fn: () => string): { ms: number; html: string } {
  let ms = Infinity;
  let html = '';
  for (let k = 0; k < 2; k++) {
    const t0 = performance.now();
    html = fn();
    ms = Math.min(ms, performance.now() - t0);
  }
  return { ms, html };
}

describe(`adversarial inputs render in < ${LIMIT_MS} ms`, () => {
  const r = (s: string, n: number) => s.repeat(n);
  // [name, input, note]; the note is the old renderer's time on the same input (M-series Mac).
  const cases: [string, string, string][] = [
    ['heading + long whitespace run', '# a' + r(' ', 100_000) + 'b', 'was 11.6 s'],
    ['heading + space/tab run + closing #', '## a' + r(' \t', 50_000) + 'b #', 'was 12.3 s'],
    ['bare URL + long punctuation run', 'http://a' + r('.', 100_000) + 'x', 'was 5.9 s'],
    ['bare URL + ")." run', 'see https://a.example/' + r(').', 50_000) + 'x', 'was 7.0 s'],
    ['table separator + long whitespace run', 'a|b\n|-' + r(' ', 100_000) + 'x', 'was 5.9 s'],
    ['unmatched "[" x160k', r('[', 160_000), 'was 15.0 s'],
    ['"[" x100k sharing one "](…"', r('[', 100_000) + 'a](' + r('x', 60_000), 'was 15.8 s'],
    ['link + long whitespace before url', '[a](' + r(' ', 100_000) + 'x', 'was 11.0 s'],
    ['unclosed link titles', r('[a](u "x ', 20_000), 'was 1.8 s'],
    ['empty-url link titles', r('[a]( "b c" ', 15_000), 'was 2.2 s'],
    ['link titles + long whitespace', r('[a](u "x', 5_000) + '""' + r(' ', 100_000) + 'x', 'was 0.8 s'],
    ['unclosed ** runs', r('**a ', 40_000), 'was 1.9 s'],
    ['unclosed ~~ runs', r('~~a ', 40_000), 'was 1.8 s'],
    ['list + 100k blank lines + list', '- a' + r('\n', 100_000) + '- b', 'was > 30 s'],
    ['list marker + spaces + U+2028', '-' + r(' ', 60_000) + ' ' + r('x', 60_000), 'was ~13 s at this size'],
    ['backtick fence run + U+2028', r('`', 60_000) + ' ' + r('x', 60_000), 'was ~13 s at this size'],
    ['code-span runs of every length', (() => { let s = ''; for (let k = 1; s.length < 150_000; k++) s += r('`', k) + 'x'; return s; })(), ''],
    ['unclosed * and _ runs', r('*a ', 30_000) + r('_a ', 30_000), ''],
    ['star / tilde / backtick / hash / quote runs', r('*', 40_000) + '\n' + r('~', 40_000) + '\n' + r('`', 40_000) + '\n' + r('#', 20_000) + '\n' + r('>', 20_000), ''],
    ['hr-like line', r('- ', 60_000) + 'x', ''],
    ['url with 100k "("', '[a](http://x' + r('(', 100_000), ''],
    ['link chains', '[a](u' + r('[a](v)', 25_000) + ' x', ''],
    ['deeply nested lists', (() => { let s = ''; while (s.length < 150_000) s += r('  ', (s.length / 7) % 40) + '- item\n'; return s; })(), ''],
    ['nested blockquotes', r('> ', 20_000) + 'x\n' + r('>> x\n', 20_000), ''],
    ['many bare URLs', r('http://a.b/ ', 12_000), ''],
    ['many escapes', r('\\*', 75_000), ''],
  ];
  for (const [name, src, was] of cases) {
    it(`${name} (${src.length.toLocaleString('en-US')} chars${was ? `; ${was}` : ''})`, () => {
      const raw = timed(() => renderMarkdown(src, NO_GUARD));
      expect(raw.ms).toBeLessThan(LIMIT_MS);
      expect(raw.html).not.toContain(PLAIN_CLASS); // really parsed, not the fallback
      expect(timed(() => renderMarkdown(src)).ms).toBeLessThan(LIMIT_MS);
    });
  }

  it('a realistic 95k-char answer still renders as markdown, quickly', () => {
    const block =
      '## Section\n\nSome **bold** text with `code`, a [link](https://a.example/x) and *italics*.\n\n' +
      '- item one\n- item two with https://b.example/path.\n  - nested\n\n```python\ndef f(x):\n    return x * 2\n```\n\n' +
      '| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n';
    const src = block.repeat(Math.floor(95_000 / block.length));
    const { ms, html } = timed(() => renderMarkdown(src));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(html).not.toContain(PLAIN_CLASS);
    expect(html.match(/<table>/g)!.length).toBe(Math.floor(95_000 / block.length));
  });
});

describe('table caps (a 12 KB table used to become 36 MB of HTML)', () => {
  const table = (cols: number, rows: number, cell = '') =>
    ['|' + 'h|'.repeat(cols), '|' + '-|'.repeat(cols), ...Array.from({ length: rows }, () => '|' + `${cell}|`.repeat(cols))].join('\n');

  it(`caps the amplification case: ${RENDER_LIMITS.tableCols + 1}+ columns render as plain text`, () => {
    const src = '|' + 'a|'.repeat(2000) + '\n|' + '-|'.repeat(2000) + '\n' + '|\n'.repeat(2000);
    const { ms, html } = timed(() => renderMarkdown(src));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(html.length).toBeLessThan(2 * src.length);
    expect(html).not.toContain('<td');
    const d = dom(src);
    expect(d.querySelector('table')).toBeNull();
    expect(d.querySelector('p em')!.textContent).toMatch(/2,000 columns \(the limit is 50\)/);
    expect(d.querySelector(`.${PLAIN_CLASS} pre`)!.textContent).toBe(src.replace(/\n$/, ''));
  });

  it(`renders exactly ${RENDER_LIMITS.tableCols} columns as a table`, () => {
    const d = dom(table(RENDER_LIMITS.tableCols, 2, 'x'));
    expect(d.querySelectorAll('th')).toHaveLength(RENDER_LIMITS.tableCols);
    expect(d.querySelectorAll('td')).toHaveLength(2 * RENDER_LIMITS.tableCols);
    expect(d.querySelector(`.${PLAIN_CLASS}`)).toBeNull();
  });

  it(`renders at most ${RENDER_LIMITS.tableRows} rows; the rest is plain text with a note`, () => {
    const src = table(2, 600, 'x') + '\n\nafter';
    const d = dom(src);
    expect(d.querySelectorAll('tbody tr')).toHaveLength(RENDER_LIMITS.tableRows);
    expect(d.querySelector('p em')!.textContent).toBe('Table truncated after 500 rows; the remaining 100 rows are shown as plain text.');
    expect(d.querySelector(`.${PLAIN_CLASS} pre`)!.textContent).toBe(Array(100).fill('|x|x|').join('\n'));
    expect([...d.querySelectorAll('p')].pop()!.textContent).toBe('after'); // parsing resumes after the table
  });

  it(`renders at most ${RENDER_LIMITS.tableCells.toLocaleString('en-US')} cells`, () => {
    const html = renderMarkdown(table(50, 400));
    const cells = (html.match(/<t[dh][ >]/g) ?? []).length;
    expect(cells).toBeLessThanOrEqual(RENDER_LIMITS.tableCells);
    expect(cells).toBe(50 + 199 * 50);
    expect(html).toContain('the remaining 201 rows are shown as plain text');
  });

  it('pads short rows only up to the (capped) header width, and ignores extra cells', () => {
    const d = dom('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |');
    expect([...d.querySelectorAll('tbody tr')].map((tr) => tr.children.length)).toEqual([3, 3]);
  });

  it('caps are configurable, and the plain-text remainder stays escaped', () => {
    const src = '| a |\n|---|\n| 1 |\n| <script>alert(1)</script> |';
    const d = dom(src);
    expect(d.querySelectorAll('tbody tr')).toHaveLength(2);
    const html = renderMarkdown(src, { tableRows: 1 });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script');
    expect(html).toContain('the remaining 1 row is shown as plain text');
  });
});

describe('plain-text fallback', () => {
  it(`shows answers over ${RENDER_LIMITS.maxChars.toLocaleString('en-US')} chars as escaped plain text, keeping line breaks`, () => {
    const body = '# Title\r\n\r\n<script>alert(1)</script> **not bold**\n' + 'x'.repeat(RENDER_LIMITS.maxChars);
    const { ms, html } = timed(() => renderMarkdown(body));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(html).not.toMatch(/<(script|h1|strong)/);
    const d = dom(body);
    expect(d.querySelector('p em')!.textContent).toBe(
      `This answer is too long to format (${body.replace(/\r\n/g, '\n').length.toLocaleString('en-US')} characters), so it is shown as plain text.`,
    );
    const pre = d.querySelector(`div.codehilite.arena-ask-code.${PLAIN_CLASS} > pre > code`)!;
    expect(pre.textContent).toBe(body.replace(/\r\n/g, '\n'));
    expect(pre.children).toHaveLength(0);
  });

  it('keeps an answer at the limit as markdown', () => {
    const md = '**b**\n' + 'x'.repeat(RENDER_LIMITS.maxChars - 6);
    expect(renderMarkdown(md)).toMatch(/^<p><strong>b<\/strong><br>x/);
  });

  it('falls back when the output has too many elements, or too much HTML', () => {
    const md = '*a* '.repeat(50);
    expect(renderMarkdown(md)).toContain('<em>');
    expect(renderMarkdown(md, { maxElements: 20 })).toContain(PLAIN_CLASS);
    expect(renderMarkdown(md, { maxHtmlChars: 100 })).toContain('too large to format');
    // a legitimately long answer made of tiny elements trips the element budget
    expect(renderMarkdown('a\n'.repeat(45_000))).toContain(PLAIN_CLASS);
  });

  it('falls back when the time budget is spent', () => {
    const html = renderMarkdown('# hi\n\n' + '- **x**\n'.repeat(200), { timeBudgetMs: -1 });
    expect(html).toContain('too complex to format');
    expect(html).not.toContain('<h1>');
    expect(dom('# hi').querySelector('h1')).not.toBeNull(); // the default budget is ample
  });

  it('is safe whatever the text contains', () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>[x](javascript:alert(1))\u0000"\'&';
    const md = payload + '\n' + 'y'.repeat(RENDER_LIMITS.maxChars);
    expectSafe(md);
    const code = dom(md).querySelector('code')!;
    expect(code.textContent!.startsWith(payload.replace('\u0000', ''))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The linear rewrites must keep the original regexes' meaning. These are the old rules, verbatim.

const OLD_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const OLD_TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Every string over `alphabet` up to `maxLen` chars. */
function* allStrings(alphabet: string[], maxLen: number): Generator<string> {
  let layer = [''];
  yield '';
  for (let n = 1; n <= maxLen; n++) {
    const next: string[] = [];
    for (const p of layer) for (const c of alphabet) next.push(p + c);
    yield* next;
    layer = next;
  }
}

describe('linear rewrites match the regexes they replace', () => {
  it('parseHeading ≡ the old HEADING regex (all strings over " \\t#a" up to 8 chars)', () => {
    let n = 0;
    for (const s of allStrings([' ', '\t', '#', 'a'], 8)) {
      const m = OLD_HEADING.exec(s);
      expect(parseHeading(s), JSON.stringify(s)).toEqual(m ? { level: m[1].length, text: m[2] } : null);
      n++;
    }
    expect(n).toBeGreaterThan(80_000);
  });

  it('parseHeading examples', () => {
    expect(parseHeading('## Title ##')).toEqual({ level: 2, text: 'Title' });
    expect(parseHeading('# C#')).toEqual({ level: 1, text: 'C#' });
    expect(parseHeading('#  ###')).toEqual({ level: 1, text: '###' });
    expect(parseHeading('   ###### six')).toEqual({ level: 6, text: 'six' });
    for (const no of ['#', '#x', '####### seven', '    # four spaces', '']) expect(parseHeading(no)).toBeNull();
  });

  it('isTableSep ≡ the old TABLE_SEP regex (all strings over " \\t|:-x" up to 7 chars)', () => {
    let n = 0;
    for (const s of allStrings([' ', '\t', '|', ':', '-', 'x'], 7)) {
      if (isTableSep(s) !== OLD_TABLE_SEP.test(s)) expect.fail(`isTableSep(${JSON.stringify(s)})`);
      n++;
    }
    expect(n).toBeGreaterThan(300_000);
  });

  it('renderInline ≡ the old regex pipeline on link / emphasis / code-span edge cases', () => {
    for (const s of [
      '[a]( "b c")', // empty url + title: the old regex backtracked `\(\s*` to read this as a link
      '[a](https://x.io "t") [b](https://x.io "t" ) [c](https://x.io  "a) b")',
      '[a](https://x.io/(y)z) [b](https://x.io/(y) [c](https://x.io/((y)))',
      '[a](\nhttps://x.io\n) [b](https://x.io "t\nu")',
      '[[a](https://x.io)] [a]]( [] [](https://x.io) [a] (https://x.io)',
      '[a][b](https://x.io) [a]\n[b](https://x.io) [a](https://x.io/(y ) [a](https://x.io/(y z))',
      '**a** **a ** ** a** ****a**** **a**b** ~~a~~ ~~ a~~ ~~a~~~~',
      '`a` ``a`` ` a ` `` ` `` ```a`` `a`` `` `\n` `',
      'https://x.io/a_b_. (https://x.io/a). https://x.io/a&quot;b https://x.io/*a*',
    ]) {
      expect(renderInline(s), JSON.stringify(s)).toBe(legacyInline(s));
    }
  });

  it('renderInline ≡ the old regex pipeline (20k seeded random inputs)', () => {
    const toks = [
      '[', ']', '](', '(', ')', ' ', '\n', '\t', '"', "'", '&', '<', 'a', 'b_c', 'http://a.b/c', 'https://c.d/(e)', '.', ',',
      '*', '**', '_', '~', '~~', '`', '``', '\\', 'javascript:x', '&quot;', ' ', ' ', '!', ':',
    ];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    for (let t = 0; t < 20_000; t++) {
      let s = '';
      for (let k = 1 + Math.floor(rnd() * 30); k > 0; k--) s += toks[Math.floor(rnd() * toks.length)];
      if (renderInline(s) !== legacyInline(s)) expect(renderInline(s), JSON.stringify(s)).toBe(legacyInline(s));
    }
  });
});

/** The previous inline pipeline (quadratic on adversarial input; fine on these tiny strings). */
function legacyInline(src: string): string {
  const unescape = (x: string) =>
    x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const emph = (x: string) =>
    x
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('`', i);
    if (open < 0) break;
    let n = open;
    while (src[n] === '`') n++;
    const run = n - open;
    let close = -1;
    for (let j = n; j < src.length; ) {
      const k = src.indexOf('`', j);
      if (k < 0) break;
      let e = k;
      while (src[e] === '`') e++;
      if (e - k === run) {
        close = k;
        break;
      }
      j = e;
    }
    if (close < 0) {
      out += src.slice(i, n);
      i = n;
      continue;
    }
    let code = src.slice(n, close).replace(/\n/g, ' ');
    if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
    out += src.slice(i, open) + hold(`<code>${escapeHtml(code)}</code>`);
    i = close + run;
  }
  let s = out + src.slice(i);
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, ch: string) => hold(escapeHtml(ch)));
  s = escapeHtml(s);
  s = s.replace(
    /\[([^\]\n]+)\]\(\s*([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+&quot;[^\n]*?&quot;)?\s*\)/g,
    (_, text: string, url: string) => {
      const href = safeHttpUrl(unescape(url));
      if (!href) return text;
      return hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${emph(text)}</a>`);
    },
  );
  s = s.replace(/\bhttps?:\/\/[^\s<>\u0000]+/gi, (m: string) => {
    let url = m;
    const cut = url.search(/&(?:quot|#39|lt|gt);/);
    if (cut >= 0) url = url.slice(0, cut);
    const trail = /[.,;:!?)\]*_~]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    const href = safeHttpUrl(unescape(url));
    if (!href) return m;
    return hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${url}</a>`) + m.slice(url.length);
  });
  s = emph(s).replace(/\n/g, '<br>');
  for (let k = 0; k < 4 && s.includes('\u0000'); k++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => slots[+n] ?? '');
  return s.replace(/\u0000/g, '');
}
