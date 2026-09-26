import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_MODEL_PREF_KEY, dropLegacyModelPref, ensureModelOptions } from './arena-ui';
import { FOOTER_CLASS, STATE_ATTR, STATUS_CLASS, clearStatus, enhanceBubble, injectStyles, scanBubbles, setStatus } from './enhance';
import { textHash } from './hash';
import { META_MAX, parseMetaMap, pruneMeta, type BubbleMeta } from './meta';

const CONV = '11111111-2222-4333-8444-555555555555';
const ANSWER = '**Einsum** sums products.\n\n```python\nt.einsum("ij,jk->ik", a, b)\n```';
const meta = (over: Partial<BubbleMeta> = {}): BubbleMeta => ({ c: CONV, u: 0.234, w: 0.5, t: 1, v: 'offscreenFrame', ...over });

function arenaChat(...bubbles: [string, string, string?][]) {
  document.body.innerHTML = `<div class="chat-messages" id="chat-messages"></div>`;
  const box = document.getElementById('chat-messages')!;
  for (const [role, text, extra] of bubbles) {
    const el = document.createElement('div');
    el.className = `chat-message ${role}${extra ? ` ${extra}` : ''}`;
    el.textContent = text; // exactly how ARENA renders
    box.appendChild(el);
  }
  return box;
}

describe('enhanceBubble / scanBubbles', () => {
  it('renders a recorded Claude answer as markdown with a copy button and a footer', () => {
    const box = arenaChat(['user', 'q'], ['assistant', ANSWER]);
    const seen = new WeakMap<Element, string>();
    const n = scanBubbles(document, (h) => (h === textHash(ANSWER) ? meta() : undefined), seen);
    expect(n).toBe(1);
    const bubble = box.querySelector<HTMLElement>('.chat-message.assistant')!;
    expect(bubble.getAttribute(STATE_ATTR)).toBe('done');
    expect(bubble.querySelector('strong')!.textContent).toBe('Einsum');
    expect(bubble.querySelector('.codehilite pre code')!.textContent).toBe('t.einsum("ij,jk->ik", a, b)');
    expect(bubble.querySelector('.codehilite .code-copy-button')).not.toBeNull();

    const footer = bubble.nextElementSibling as HTMLElement;
    expect(footer.classList.contains(FOOTER_CLASS)).toBe(true);
    expect(footer.getAttribute('data-via')).toBe('offscreenFrame');
    const a = footer.querySelector('a')!;
    expect(a.href).toBe(`https://claude.ai/chat/${CONV}`);
    expect(a.rel).toBe('noopener noreferrer');
    expect(a.textContent).toBe('Open in claude.ai ↗');
    expect(footer.textContent).toContain('5h: 23%');
  });

  it('leaves other models’ answers, error bubbles and in-flight bubbles alone', () => {
    const box = arenaChat(
      ['assistant', 'a GPT answer'], // no recorded metadata
      ['assistant', 'Error: nope', 'error'], // ARENA error bubble
      ['assistant', ANSWER], // still streaming
    );
    (box.lastElementChild as HTMLElement).setAttribute(STATE_ATTR, 'streaming');
    const lookup = (h: string) => (h === textHash(ANSWER) || h === textHash('Error: nope') ? meta() : undefined);
    expect(scanBubbles(document, lookup, new WeakMap())).toBe(0);
    expect(box.firstElementChild!.hasAttribute(STATE_ATTR)).toBe(false);
    expect(box.querySelector(`.${FOOTER_CLASS}`)).toBeNull();
  });

  it('is idempotent and never duplicates footers', () => {
    const box = arenaChat(['assistant', ANSWER]);
    const seen = new WeakMap<Element, string>();
    const lookup = () => meta();
    scanBubbles(document, lookup, seen);
    scanBubbles(document, lookup, seen);
    const bubble = box.querySelector<HTMLElement>('.chat-message')!;
    enhanceBubble(bubble, ANSWER, meta()); // re-enhancing replaces the footer
    expect(box.querySelectorAll(`.${FOOTER_CLASS}`)).toHaveLength(1);
    expect(box.querySelectorAll('.code-copy-button')).toHaveLength(1);
  });

  it('re-applies after ARENA re-renders its history from localStorage (fresh elements, same text)', () => {
    arenaChat(['user', 'q'], ['assistant', ANSWER]);
    const lookup = (h: string) => (h === textHash(ANSWER) ? meta() : undefined);
    scanBubbles(document, lookup, new WeakMap());
    const box = arenaChat(['user', 'q'], ['assistant', ANSWER]); // renderChatHistory(): innerHTML = '' + textContent
    expect(scanBubbles(document, lookup, new WeakMap())).toBe(1);
    expect(box.querySelector(`.${FOOTER_CLASS} a`)).not.toBeNull();
  });

  it('omits the link without a conversation id and the usage without a number', () => {
    const box = arenaChat(['assistant', 'x']);
    enhanceBubble(box.firstElementChild as HTMLElement, 'x', meta({ c: null, u: null }));
    const footer = box.querySelector(`.${FOOTER_CLASS}`)!;
    expect(footer.querySelector('a')).toBeNull();
    expect(footer.textContent).toBe('');
  });

  it('never executes or keeps markup from the answer text', () => {
    const evil = 'hi <img src=x onerror="window.__pwned=1"> [x](javascript:alert(1)) <script>window.__pwned=2</script>';
    const box = arenaChat(['assistant', evil]);
    enhanceBubble(box.firstElementChild as HTMLElement, evil, meta());
    expect(box.querySelector('img, script, [onerror]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect([...box.querySelectorAll('a')].every((a) => a.href.startsWith('https://'))).toBe(true);
  });

  it('injects its stylesheet once', () => {
    injectStyles(document);
    injectStyles(document);
    expect(document.querySelectorAll('#arena-ask-style')).toHaveLength(1);
  });
});

describe('tool status line (full mode)', () => {
  it('sits under the bubble (not in it, so ARENA neither wipes nor saves it), is replaced, and goes away', () => {
    const box = arenaChat(['user', 'q'], ['assistant', '...']);
    const bubble = box.querySelector<HTMLElement>('.chat-message.assistant')!;
    setStatus(bubble, 'Searching past chats…');
    expect(bubble.textContent).toBe('...');
    const line = bubble.nextElementSibling as HTMLElement;
    expect(line.className).toBe(STATUS_CLASS);
    expect(line.innerHTML).toBe('<em>Searching past chats…</em>');
    expect(line.getAttribute('role')).toBe('status');
    setStatus(bubble, 'Using <b>Gmail</b>…'); // text, never markup
    expect(box.querySelectorAll(`.${STATUS_CLASS}`)).toHaveLength(1);
    expect(line.textContent).toBe('Using <b>Gmail</b>…');
    expect(line.querySelector('b')).toBeNull();
    bubble.textContent = 'The answer'; // ARENA streaming text into the bubble leaves it alone
    expect(bubble.nextElementSibling).toBe(line);
    clearStatus(bubble);
    expect(box.querySelector(`.${STATUS_CLASS}`)).toBeNull();
    clearStatus(bubble); // idempotent
    setStatus(null, 'x'); // no bubble: nothing to do
  });

  it('enhancing the finished answer removes the status line and puts the footer right after the bubble', () => {
    const box = arenaChat(['user', 'q'], ['assistant', ANSWER]);
    const bubble = box.querySelector<HTMLElement>('.chat-message.assistant')!;
    setStatus(bubble, 'Running code…');
    enhanceBubble(bubble, ANSWER, meta());
    expect(box.querySelector(`.${STATUS_CLASS}`)).toBeNull();
    expect(bubble.nextElementSibling!.classList.contains(FOOTER_CLASS)).toBe(true);
  });
});

describe('bubble metadata store helpers', () => {
  it('validates stored entries and drops junk', () => {
    const h = textHash('a');
    const m = parseMetaMap({ [h]: meta(), 'bad-key': meta(), [textHash('b')]: { c: 'javascript:alert(1)', u: 0, w: 0, t: 1 } });
    expect([...m.keys()]).toEqual([h]);
    expect(parseMetaMap(null).size).toBe(0);
  });

  it('keeps the newest entries', () => {
    const m = new Map<string, BubbleMeta>();
    for (let i = 0; i < META_MAX + 20; i++) m.set(textHash(String(i)), meta({ t: i }));
    const p = pruneMeta(m);
    expect(p.size).toBe(META_MAX);
    expect(p.has(textHash(String(META_MAX + 19)))).toBe(true);
    expect(p.has(textHash('0'))).toBe(false);
  });
});

describe('ensureModelOptions', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `<select id="chat-model"><option value="gpt-4.1-mini" selected>gpt-4.1-mini</option><option value="gpt-4o-mini">gpt-4o-mini</option></select>`;
  });

  it('adds "My Claude (Opus 5.5)" and "My ChatGPT" once', () => {
    ensureModelOptions(document);
    ensureModelOptions(document);
    const opts = [...document.querySelectorAll<HTMLOptionElement>('#chat-model option')];
    expect(opts.map((o) => o.value)).toEqual(['gpt-4.1-mini', 'gpt-4o-mini', 'my-claude', 'my-chatgpt']);
    expect(opts[2].textContent).toBe('My Claude (Opus 5.5)');
    expect(opts[3].textContent).toBe('My ChatGPT');
  });

  it("restores the remembered choice the caller passes (the extension's own storage) and says so", () => {
    const restored: string[] = [];
    const sel = ensureModelOptions(document, undefined, 'my-chatgpt', (v) => restored.push(v))!;
    expect(sel.value).toBe('my-chatgpt');
    expect(restored).toEqual(['my-chatgpt']);
    // once per select element
    sel.value = 'gpt-4o-mini';
    ensureModelOptions(document, undefined, 'my-chatgpt', (v) => restored.push(v));
    expect(sel.value).toBe('gpt-4o-mini');
    expect(restored).toEqual(['my-chatgpt']);
  });

  it("never reads the page's localStorage (page scripts can write it)", () => {
    localStorage.setItem(LEGACY_MODEL_PREF_KEY, 'my-chatgpt');
    expect(ensureModelOptions(document)!.value).toBe('gpt-4.1-mini');
    dropLegacyModelPref();
    expect(localStorage.getItem(LEGACY_MODEL_PREF_KEY)).toBeNull();
  });

  it('re-adds the option (and the remembered selection) if ARENA re-renders the options', () => {
    const sel = ensureModelOptions(document, undefined, 'my-claude')!;
    expect(sel.value).toBe('my-claude');
    sel.innerHTML = '<option value="gpt-4.1-mini" selected>gpt-4.1-mini</option>';
    ensureModelOptions(document, undefined, 'my-claude');
    expect(sel.value).toBe('my-claude');
  });
});

