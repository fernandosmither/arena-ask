import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFooter } from './enhance';
import { textHash } from './hash';
import { META_MAX, type BubbleMeta } from './meta';
import { MetaStore, answerIndexOf, parseStoredMeta } from './meta-store';
import { EMPTY_ANSWER_NOTE, metaKey } from './protocol';

const CHAPTER = 'chapter-1';
const C1 = '11111111-2222-4333-8444-555555555555';
const C2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const H = textHash(EMPTY_ANSWER_NOTE);
const meta = (over: Partial<BubbleMeta> = {}): BubbleMeta => ({ c: C1, u: 0.1, w: 0.2, t: 1, ...over });

/** A chrome.storage.local stand-in (MetaStore reaches it through ext()). */
let storage: Record<string, unknown>;
beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension' },
    storage: {
      local: {
        get: async (k: string) => (k in storage ? { [k]: structuredClone(storage[k]) } : {}),
        set: async (o: Record<string, unknown>) => void Object.assign(storage, structuredClone(o)),
        remove: async (k: string) => void delete storage[k],
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

async function fresh(): Promise<MetaStore> {
  const s = new MetaStore();
  await s.load(CHAPTER);
  return s;
}

describe('MetaStore: one entry per answer, not per answer text', () => {
  it('keeps identical answers (the fixed empty-answer note) apart by position and conversation', async () => {
    const store = await fresh();
    await store.put(CHAPTER, { hash: H, index: 1 }, meta({ c: C1, u: 0.1, t: 10 }));
    await store.put(CHAPTER, { hash: H, index: 4 }, meta({ c: C2, u: 0.9, t: 20 }));
    expect(store.lookup(H, 1)).toMatchObject({ c: C1, u: 0.1 });
    expect(store.lookup(H, 4)).toMatchObject({ c: C2, u: 0.9 });

    // …and after a reload (a fresh store reading chrome.storage.local)
    const reloaded = await fresh();
    expect(reloaded.size).toBe(2);
    expect(reloaded.lookup(H, 1)?.c).toBe(C1);
    expect(reloaded.lookup(H, 4)?.c).toBe(C2);
    expect(Object.keys(storage[metaKey(CHAPTER)] as object).sort()).toEqual([`1:${C1}:${H}`, `4:${C2}:${H}`]);
  });

  it('gives each identical bubble its own "Open in claude.ai" link', async () => {
    const store = await fresh();
    await store.put(CHAPTER, { hash: H, index: 0 }, meta({ c: C1 }));
    await store.put(CHAPTER, { hash: H, index: 1 }, meta({ c: C2 }));
    const links = [0, 1].map((i) => buildFooter(document, store.lookup(H, i)!).querySelector('a')!.href);
    expect(links).toEqual([`https://claude.ai/chat/${C1}`, `https://claude.ai/chat/${C2}`]);
  });

  it('never lends an entry to an identical text at another position when that is ambiguous', async () => {
    const store = await fresh();
    await store.put(CHAPTER, { hash: H, index: 1 }, meta({ c: C1 }));
    await store.put(CHAPTER, { hash: H, index: 4 }, meta({ c: C2 }));
    expect(store.lookup(H, 2)).toBeUndefined();
    expect(store.lookup(H)).toBeUndefined(); // hash-only (old callers): ambiguous too
    expect(store.lookup(textHash('something else'), 1)).toBeUndefined();
  });

  it('falls back to the only entry for a text when positions shifted', async () => {
    const store = await fresh();
    const h = textHash('a unique answer');
    await store.put(CHAPTER, { hash: h, index: 7 }, meta({ c: C2 }));
    expect(store.lookup(h, 3)?.c).toBe(C2);
    expect(store.lookup(h)?.c).toBe(C2);
  });

  it('prefers the given conversation, else the newest entry, at the same position', async () => {
    const store = await fresh();
    await store.put(CHAPTER, { hash: H, index: 2 }, meta({ c: C1, t: 30 }));
    await store.put(CHAPTER, { hash: H, index: 2 }, meta({ c: C2, t: 20 }));
    expect(store.lookup(H, 2)?.c).toBe(C1); // newest
    expect(store.lookup(H, 2, C2)?.c).toBe(C2);
    expect(store.size).toBe(2);
  });

  it('keeps answers without a conversation apart too', async () => {
    const store = await fresh();
    await store.put(CHAPTER, { hash: H, index: 0 }, meta({ c: null, u: 0.3 }));
    await store.put(CHAPTER, { hash: H, index: 1 }, meta({ c: null, u: 0.6 }));
    expect(store.lookup(H, 0)?.u).toBe(0.3);
    expect(store.lookup(H, 1)?.u).toBe(0.6);
    expect(Object.keys(storage[metaKey(CHAPTER)] as object)).toContain(`0:-:${H}`);
  });

  it('still accepts the old (chapter, hash, meta) call and old hash-keyed storage', async () => {
    storage[metaKey(CHAPTER)] = { [textHash('old answer')]: meta({ c: C1 }) };
    const store = await fresh();
    expect(store.lookup(textHash('old answer'))?.c).toBe(C1);
    expect(store.lookup(textHash('old answer'), 5)?.c).toBe(C1);

    await store.put(CHAPTER, textHash('legacy put'), meta({ c: C2 }));
    expect(store.lookup(textHash('legacy put'))?.c).toBe(C2);
    // an unknown position records a hash-only entry, like the old call
    await store.put(CHAPTER, { hash: textHash('no position'), index: -1 }, meta({ c: C2 }));
    expect(Object.keys(storage[metaKey(CHAPTER)] as object)).toContain(textHash('no position'));
  });

  it('ignores a bad hash and drops a malformed conversation id', async () => {
    const store = await fresh();
    await store.put(CHAPTER, { hash: 'not-a-hash', index: 0 }, meta());
    expect(store.size).toBe(0);
    await store.put(CHAPTER, { hash: H, index: 0 }, meta({ c: 'javascript:alert(1)' }));
    expect(store.lookup(H, 0)?.c).toBeNull();
  });

  it('clear() forgets the chapter', async () => {
    const store = await fresh();
    await store.put(CHAPTER, { hash: H, index: 0 }, meta());
    await store.clear(CHAPTER);
    expect(store.size).toBe(0);
    expect(storage[metaKey(CHAPTER)]).toBeUndefined();
    expect((await fresh()).lookup(H, 0)).toBeUndefined();
  });

  it('keeps only the newest META_MAX entries', async () => {
    const store = await fresh();
    for (let i = 0; i < META_MAX + 5; i++) await store.put(CHAPTER, { hash: H, index: i }, meta({ t: i }));
    expect(store.size).toBe(META_MAX);
    expect(store.lookup(H, 0)).toBeUndefined(); // oldest pruned (and not borrowed from another index)
    expect(store.lookup(H, META_MAX + 4)?.t).toBe(META_MAX + 4);
  });

  it('put() for another chapter loads that chapter first', async () => {
    storage[metaKey('other')] = { [`0:${C2}:${H}`]: meta({ c: C2 }) };
    const store = await fresh();
    await store.put('other', { hash: textHash('x'), index: 1 }, meta());
    expect(store.lookup(H, 0)?.c).toBe(C2);
    expect(Object.keys(storage[metaKey('other')] as object)).toHaveLength(2);
  });
});

describe('parseStoredMeta', () => {
  it('keeps valid answer keys and legacy hash keys, drops everything else', () => {
    const good = meta({ c: C1 });
    const parsed = parseStoredMeta({
      [`0:${C1}:${H}`]: good,
      [`3:-:${H}`]: meta({ c: null }),
      [H]: good,
      [`1:${C2}:${H}`]: good, // key's conversation ≠ entry's
      [`-1:${C1}:${H}`]: good,
      [`99999999:${C1}:${H}`]: good,
      [`0:not-a-uuid:${H}`]: meta({ c: null }),
      [`0:${C1}:${H}:extra`]: good,
      [`0:${C1}:xyz`]: good,
      [`2:${C1}:${H}`]: { c: C1 }, // malformed entry
    });
    expect([...parsed.keys()].sort()).toEqual([`0:${C1}:${H}`, `3:-:${H}`, H].sort());
    for (const bad of [null, undefined, 1, 'x', [good]]) expect(parseStoredMeta(bad).size).toBe(0);
    expect(parseStoredMeta(JSON.parse(`{"__proto__": ${JSON.stringify(good)}}`)).size).toBe(0);
  });
});

describe('answerIndexOf', () => {
  function chat(...bubbles: [string, string?][]) {
    document.body.innerHTML = '<div id="chat-messages"></div>';
    const box = document.getElementById('chat-messages')!;
    return bubbles.map(([role, extra]) => {
      const el = document.createElement('div');
      el.className = `chat-message ${role}${extra ? ` ${extra}` : ''}`;
      box.appendChild(el);
      return el;
    });
  }

  it('counts assistant bubbles only, skipping error bubbles ARENA does not save', () => {
    const [, a0, , err, , a1] = chat(['user'], ['assistant'], ['user'], ['assistant', 'error'], ['user'], ['assistant']);
    expect(answerIndexOf(a0)).toBe(0);
    expect(answerIndexOf(err)).toBe(1); // (never recorded: error bubbles are not answers)
    expect(answerIndexOf(a1)).toBe(1);
    // after a reload ARENA re-renders only saved messages: same index
    const [, b0, , b1] = chat(['user'], ['assistant'], ['user'], ['assistant']);
    expect([answerIndexOf(b0), answerIndexOf(b1)]).toEqual([0, 1]);
  });

  it('is -1 for a bubble outside the chat', () => {
    chat(['assistant']);
    expect(answerIndexOf(document.createElement('div'))).toBe(-1);
  });
});
