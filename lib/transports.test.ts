import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG_RELOAD_FRAME, MSG_WAKE, PROTOCOL_VERSION } from './protocol';

// A small fake of the Chrome APIs lib/transports.ts uses, with a scripted claude.ai frame/tab relay.

type Fn = (...a: unknown[]) => void;
class Ev {
  ls = new Set<Fn>();
  addListener = (f: Fn) => void this.ls.add(f);
  removeListener = (f: Fn) => void this.ls.delete(f);
  emit = (...a: unknown[]) => [...this.ls].forEach((f) => f(...a));
}
interface FakePort {
  name: string;
  onMessage: Ev;
  onDisconnect: Ev;
  postMessage(m: unknown): void;
  disconnect(): void;
  closed: boolean;
}
function portPair(name: string): [FakePort, FakePort] {
  const mk = (): FakePort => ({ name, onMessage: new Ev(), onDisconnect: new Ev(), closed: false, postMessage: () => {}, disconnect: () => {} });
  const a = mk();
  const b = mk();
  const wire = (x: FakePort, y: FakePort) => {
    x.postMessage = (m) => {
      if (x.closed) throw new Error('disconnected port');
      queueMicrotask(() => !y.closed && y.onMessage.emit(structuredClone(m)));
    };
    x.disconnect = () => {
      if (x.closed) return;
      x.closed = y.closed = true;
      queueMicrotask(() => y.onDisconnect.emit());
    };
  };
  wire(a, b);
  wire(b, a);
  return [a, b];
}

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

function fakeChrome() {
  const session: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  const st = {
    doc: false,
    created: 0,
    closed: 0,
    reloads: 0,
    rules: [] as { id: number; condition: Record<string, unknown> }[],
    /** The frame answers a wake with this delay (ms); null = it never answers. */
    frameDelay: 5 as number | null,
    /** Per-nonce override: ignore these wakes. */
    ignoreNonce: new Set<string>(),
    wakes: [] as string[],
    wakeProviders: [] as string[],
    connected: [] as number[],
    offscreenMsgs: [] as { type: string; provider?: string }[],
    served: new Set<string>(),
    tabs: new Map<number, { id: number; url: string; pinned: boolean; status: string; relay: boolean; cookieStoreId?: string }>(),
    nextTab: 100,
    tabsCreated: 0,
    tabConnects: 0,
    acceptFramePort: null as null | ((p: FakePort, provider?: string) => void),
    /** Firefox: the container a tab opened without a cookieStoreId lands in. */
    newTabStore: undefined as string | undefined,
    /** Tab and rule operations, in order ("create:<url>", "rules:+4", "update:<id>:<url>", …). */
    ops: [] as string[],
    /** Make session-rule updates that add rules fail. */
    failRuleAdds: false,
  };
  const chrome = {
    runtime: {
      id: EXT_ID,
      lastError: undefined,
      getURL: (p: string) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
      getContexts: async () => (st.doc ? [{ documentUrl: 'offscreen.html' }] : []),
      sendMessage: async (m: { type: string; nonce?: string; provider?: string }) => {
        if (!st.doc) throw new Error('Could not establish connection. Receiving end does not exist.');
        st.offscreenMsgs.push({ type: m.type, provider: m.provider });
        if (m.type === MSG_RELOAD_FRAME) st.reloads++;
        if (m.type !== MSG_WAKE) return;
        st.wakes.push(m.nonce ?? '');
        st.wakeProviders.push(m.provider ?? 'claude');
        const delay = st.frameDelay;
        if (delay === null || (m.nonce && st.ignoreNonce.has(m.nonce))) return;
        if (m.nonce && st.served.has(m.nonce)) return; // the frame answers each nonce once
        if (m.nonce) st.served.add(m.nonce);
        setTimeout(() => {
          const [bg, frame] = portPair('relay-frame');
          st.acceptFramePort!(bg, m.provider);
          frame.postMessage({ type: 'hello', v: PROTOCOL_VERSION, ...(m.nonce ? { nonce: m.nonce } : {}) });
        }, delay);
      },
    },
    offscreen: {
      createDocument: async (_o?: unknown) => {
        if (st.doc) throw new Error('Only a single offscreen document may be created.');
        st.doc = true;
        st.created++;
      },
      closeDocument: async (): Promise<void> => {
        st.doc = false;
        st.closed++;
      },
    },
    declarativeNetRequest: {
      updateSessionRules: async (o: { removeRuleIds?: number[]; addRules?: { id: number; condition: Record<string, unknown> }[] }) => {
        if (o.addRules?.length && st.failRuleAdds) throw new Error('rule quota');
        if (o.addRules?.length) st.ops.push(`rules:+${o.addRules.map((r) => r.id).join(',')}`);
        st.rules = st.rules.filter((r) => !o.removeRuleIds?.includes(r.id));
        st.rules.push(...(o.addRules ?? []));
      },
    },
    storage: {
      local: { get: async (k: string) => (k in local ? { [k]: local[k] } : {}), set: async (o: object) => void Object.assign(local, o) },
      session: {
        get: async (k: string | null) => (k === null ? { ...session } : k in session ? { [k]: session[k] } : {}),
        set: async (o: object) => void Object.assign(session, o),
        remove: async (k: string) => void delete session[k],
      },
    },
    tabs: {
      query: async () => [...st.tabs.values()].filter((t) => t.url.startsWith('https://claude.ai/')),
      get: async (id: number) => {
        const t = st.tabs.get(id);
        if (!t) throw new Error('No tab');
        return { ...t };
      },
      create: async (o: { url: string; pinned: boolean; cookieStoreId?: string }) => {
        const id = st.nextTab++;
        st.tabsCreated++;
        st.ops.push(`create:${o.url}`);
        const store = o.cookieStoreId ?? st.newTabStore;
        const t = { id, url: o.url, pinned: o.pinned, status: 'loading', relay: false, ...(store ? { cookieStoreId: store } : {}) };
        st.tabs.set(id, t);
        setTimeout(() => ((t.status = 'complete'), (t.relay = true)), 1000);
        return { ...t };
      },
      reload: async () => {},
      update: async (id: number, o: { url: string }) => {
        st.ops.push(`update:${id}:${o.url}`);
        const t = st.tabs.get(id);
        if (t) t.url = o.url;
        return t ? { ...t } : undefined;
      },
      remove: async (id: number) => void st.tabs.delete(id),
      connect: (id: number) => {
        st.tabConnects++;
        st.connected.push(id);
        const [bg, tab] = portPair('relay');
        const t = st.tabs.get(id);
        if (t?.relay) queueMicrotask(() => tab.postMessage({ type: 'hello', v: PROTOCOL_VERSION }));
        else queueMicrotask(() => tab.disconnect());
        return bg;
      },
    },
  };
  return { chrome, st, session };
}

let fake: ReturnType<typeof fakeChrome>;
let T: typeof import('./transports');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  fake = fakeChrome();
  vi.stubGlobal('chrome', fake.chrome);
  vi.stubGlobal('browser', undefined);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  T = await import('./transports');
  fake.st.acceptFramePort = (p, provider) => T.acceptFramePort(p as never, provider as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('offscreen frame: several asks at once (P1-4)', () => {
  it('4 concurrent asks each get their own frame port; one document, never closed', async () => {
    const asks = Array.from({ length: 4 }, () => T.acquireRelay({ allowOffscreen: true }));
    await settle(200);
    const handles = await Promise.all(asks);
    expect(handles.map((h) => h.via)).toEqual(['offscreenFrame', 'offscreenFrame', 'offscreenFrame', 'offscreenFrame']);
    expect(new Set(handles.map((h) => h.port)).size).toBe(4);
    expect(fake.st.created).toBe(1);
    expect(fake.st.closed).toBe(0);
  });

  it('a frame that is slow to load (misses the first wakes) still serves every waiter', async () => {
    fake.st.frameDelay = null; // loading: wakes are lost
    const asks = Array.from({ length: 3 }, () => T.acquireRelay({ allowOffscreen: true }));
    await settle(2500);
    fake.st.frameDelay = 5; // loaded: re-sent wakes now answered
    await settle(1500);
    expect((await Promise.all(asks)).map((h) => h.via)).toEqual(['offscreenFrame', 'offscreenFrame', 'offscreenFrame']);
    expect(fake.st.closed).toBe(0);
  });

  it('a waiter that times out while others are on the frame falls back to a tab and disturbs nobody', async () => {
    const first = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    const h1 = await first;
    expect(h1.via).toBe('offscreenFrame'); // …and streaming: in use until released
    fake.st.tabs.set(7, { id: 7, url: 'https://claude.ai/chat/x', pinned: false, status: 'complete', relay: true });
    fake.st.frameDelay = null; // this ask's wakes go unanswered
    const second = T.acquireRelay({ allowOffscreen: true });
    await settle(25_000);
    const h = await second;
    expect(h.via).toBe('claudeTab');
    expect(fake.st.closed).toBe(0); // the in-flight ask's frame survived
    expect(fake.session.offscreenCooldownUntil).toBeUndefined(); // the frame works for others: no pause
    expect(fake.session.offscreenRebuild).toBe(true); // …but it's rebuilt once nobody uses it
    h1.release();
  });

  it('an idle frame that stopped answering is rebuilt once', async () => {
    const first = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    (await first).release();
    fake.st.frameDelay = null;
    const second = T.acquireRelay({ allowOffscreen: true });
    await settle(4_500); // FRAME_WAKE_TIMEOUT_MS on a ready frame
    fake.st.frameDelay = 5;
    await settle(1_500);
    expect((await second).via).toBe('offscreenFrame');
    expect(fake.st.closed).toBe(1);
    expect(fake.st.created).toBe(2);
  });

  it('closing for idleness waits while an ask is in flight; a reload is refused then too', async () => {
    const a = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    const h = await a;
    expect(await T.closeOffscreen('idle')).toBe(false);
    expect(await T.reloadFrame()).toBe(false);
    expect(fake.st.closed).toBe(0);
    h.release();
    h.release(); // idempotent
    expect(await T.reloadFrame()).toBe(true);
    expect(fake.st.reloads).toBe(1);
    expect(await T.closeOffscreen('idle')).toBe(true);
    expect(fake.st.closed).toBe(1);
  });

  it('after a cooldown the frame is skipped, then rebuilt on next use', async () => {
    const a = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    (await a).release();
    await T.offscreenCooldown('frame reported cloudflare', T.COOLDOWN_MS.transient);
    fake.st.tabs.set(7, { id: 7, url: 'https://claude.ai/new', pinned: false, status: 'complete', relay: true });
    const b = T.acquireRelay({ allowOffscreen: true });
    await settle(10);
    expect((await b).via).toBe('claudeTab');
    await settle(T.COOLDOWN_MS.transient);
    const c = T.acquireRelay({ allowOffscreen: true });
    await settle(100);
    expect((await c).via).toBe('offscreenFrame');
    expect(fake.st.closed).toBeGreaterThanOrEqual(1); // closed + recreated
    expect(fake.st.created).toBe(2);
  });
});

describe('offscreen lifecycle is serialized (L7)', () => {
  it('an ask arriving while the idle close is in progress is not handed a dying port or a removed rule', async () => {
    const a = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    (await a).release();
    // slow closeDocument: an ask arrives in the middle of the close
    const realClose = fake.chrome.offscreen.closeDocument;
    let finishClose!: () => void;
    fake.chrome.offscreen.closeDocument = () => new Promise<void>((r) => (finishClose = () => realClose().then(r)));
    const closing = T.closeOffscreen('idle');
    await settle(0);
    const b = T.acquireRelay({ allowOffscreen: true });
    await settle(0);
    finishClose();
    expect(await closing).toBe(true);
    await settle(200);
    const hb = await b;
    expect(hb.via).toBe('offscreenFrame');
    expect((hb.port as unknown as { closed: boolean }).closed).toBe(false);
    expect(fake.st.doc).toBe(true);
    expect(fake.st.created).toBe(2); // closed, then created again for the new ask
    expect(fake.st.rules).toHaveLength(1); // the new document has its rule
  });

  it('an ask that claims the frame while a close is awaiting backs the close off (checked again after its awaits)', async () => {
    const a = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    (await a).release();
    // the close's "is there a document?" takes a while; an ask claims the frame meanwhile
    const realCtx = fake.chrome.runtime.getContexts;
    fake.chrome.runtime.getContexts = () => new Promise((r) => setTimeout(() => r(realCtx()), 20));
    const closing = T.closeOffscreen('idle', 0, false);
    await settle(1);
    const b = T.acquireRelay({ allowOffscreen: true });
    await settle(5);
    fake.chrome.runtime.getContexts = realCtx;
    await settle(100);
    expect(await closing).toBe(false);
    const hb = await b;
    expect(hb.via).toBe('offscreenFrame');
    expect(fake.st.closed).toBe(0);
    expect(fake.session.offscreenRebuild).toBeUndefined(); // an idle close that backed off: nothing is broken
    // a failure-driven close that backs off marks the frame for a rebuild instead
    expect(await T.closeOffscreen('fallback')).toBe(false);
    expect(fake.session.offscreenRebuild).toBe(true);
    hb.release();
  });

  it('an ask that arrives just before a close still ends up with a live frame and its rule', async () => {
    const a = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    (await a).release();
    const b = T.acquireRelay({ allowOffscreen: true });
    const closing = T.closeOffscreen('idle');
    await settle(200);
    await closing;
    const hb = await b;
    expect(hb.via).toBe('offscreenFrame');
    expect((hb.port as unknown as { closed: boolean }).closed).toBe(false);
    expect(fake.st.doc).toBe(true);
    expect(fake.st.rules).toHaveLength(1);
  });

  it('a frame port is counted as in use from the moment it is handed out until released', async () => {
    const a = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    const h = await a;
    expect(await T.closeOffscreen('idle')).toBe(false);
    h.release();
    expect(await T.closeOffscreen('idle')).toBe(true);
  });
});

describe('the framing rule never outlives the offscreen document (L6)', () => {
  it('removed when the document is found missing (closed behind our back)', async () => {
    const a = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    (await a).release();
    expect(fake.st.rules).toHaveLength(1);
    fake.st.doc = false; // e.g. Chrome closed it
    await T.syncFrameRule();
    expect(fake.st.rules).toEqual([]);
  });

  it('checked whenever an ask goes to a tab without the frame', async () => {
    fake.st.rules = [{ id: 1, condition: {} }];
    fake.st.tabs.set(7, { id: 7, url: 'https://claude.ai/new', pinned: false, status: 'complete', relay: true });
    const h = T.acquireRelay({ allowOffscreen: false });
    await settle(100);
    expect((await h).via).toBe('claudeTab');
    expect(fake.st.rules).toEqual([]);
  });

  it('removed if creating the document fails', async () => {
    fake.chrome.offscreen.createDocument = async () => {
      throw new Error('boom');
    };
    fake.st.tabs.set(7, { id: 7, url: 'https://claude.ai/new', pinned: false, status: 'complete', relay: true });
    const h = T.acquireRelay({ allowOffscreen: true });
    await settle(100);
    expect((await h).via).toBe('claudeTab');
    expect(fake.st.rules).toEqual([]);
  });
});

describe('a relay that is already up, for a stop (L6)', () => {
  it('uses the ready frame, else an open claude.ai tab; never opens a tab or creates the document', async () => {
    expect(await T.acquireReadyRelay('claudeTab')).toBeNull();
    expect(fake.st.tabsCreated).toBe(0);
    expect(fake.st.created).toBe(0);
    const a = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    (await a).release();
    const p = T.acquireReadyRelay('claudeTab');
    await settle(50);
    const h = (await p)!;
    expect(h.via).toBe('offscreenFrame');
    h.release();
    // the frame itself died: only tabs
    fake.st.tabs.set(7, { id: 7, url: 'https://claude.ai/chat/x', pinned: false, status: 'complete', relay: true });
    const q = T.acquireReadyRelay('offscreenFrame');
    await settle(50);
    expect((await q)!.via).toBe('claudeTab');
    expect(fake.st.tabsCreated).toBe(0);
    expect(fake.st.created).toBe(1);
  });
});

describe('framing rule (P1-9)', () => {
  it('only claude.ai sub-frames loaded by this extension outside any tab', async () => {
    const a = T.acquireRelay({ allowOffscreen: true });
    await settle(50);
    await a;
    expect(fake.st.rules).toHaveLength(1);
    expect(fake.st.rules[0].condition).toEqual({
      requestDomains: ['claude.ai'],
      tabIds: [-1],
      resourceTypes: ['sub_frame'],
      initiatorDomains: [EXT_ID],
    });
  });

  it('a stale rule with no offscreen document is removed at startup', async () => {
    fake.st.rules = [{ id: 1, condition: {} }];
    await T.cleanupStaleFrameRules();
    expect(fake.st.rules).toEqual([]);
    fake.st.rules = [{ id: 1, condition: {} }];
    fake.st.doc = true;
    await T.cleanupStaleFrameRules();
    expect(fake.st.rules).toHaveLength(1);
  });
});

describe('claude.ai tabs (P2-13)', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { ...fake.chrome, offscreen: undefined }); // Firefox-like: tabs only
  });

  it('concurrent asks with no claude.ai tab open one pinned tab between them', async () => {
    const asks = [T.acquireRelay({ allowOffscreen: true }), T.acquireRelay({ allowOffscreen: true })];
    await settle(5_000);
    expect((await Promise.all(asks)).map((h) => h.via)).toEqual(['newTab', 'newTab']);
    expect(fake.st.tabsCreated).toBe(1);
    expect([...fake.st.tabs.values()][0].pinned).toBe(true);
  });

  it('reuses the tab it opened (never a second one), and opens a new one only after it is closed', async () => {
    const a = T.acquireRelay({ allowOffscreen: false });
    await settle(5_000);
    expect((await a).via).toBe('newTab');
    const own = [...fake.st.tabs.keys()][0];
    fake.st.tabs.get(own)!.relay = false; // its relay stopped answering
    const b = T.acquireRelay({ allowOffscreen: false });
    await settle(1_000);
    fake.st.tabs.get(own)!.relay = true;
    await settle(5_000);
    expect((await b).via).toBe('newTab');
    expect(fake.st.tabsCreated).toBe(1);
    fake.st.tabs.delete(own);
    await T.forgetTab(own);
    const c = T.acquireRelay({ allowOffscreen: false });
    await settle(5_000);
    expect((await c).via).toBe('newTab');
    expect(fake.st.tabsCreated).toBe(2);
  });
});

describe('R4: Firefox containers (cookieStoreId)', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { ...fake.chrome, offscreen: undefined }); // Firefox: tabs only
  });
  const tab = (id: number, cookieStoreId: string) =>
    fake.st.tabs.set(id, { id, url: 'https://claude.ai/chat/x', pinned: false, status: 'complete', relay: true, cookieStoreId });

  it('uses only claude.ai tabs in the ARENA tab\'s container; its own pinned tab only for the default one', async () => {
    fake.st.newTabStore = 'firefox-default';
    tab(7, 'firefox-container-2'); // another account
    const a = T.acquireRelay({ allowOffscreen: true, store: 'firefox-default' });
    await settle(5_000);
    const h = await a;
    expect(h.via).toBe('newTab');
    expect(fake.st.tabsCreated).toBe(1);
    const own = [...fake.st.tabs.values()].find((t) => t.id !== 7)!;
    expect(own.cookieStoreId).toBe('firefox-default');
    // a question from container 2 uses that container's own tab, not the pinned one
    const b = T.acquireRelay({ allowOffscreen: false, store: 'firefox-container-2' });
    await settle(50);
    expect((await b).via).toBe('claudeTab');
    expect(fake.st.tabsCreated).toBe(1);
    // and the default container reuses its pinned tab
    const c = T.acquireRelay({ allowOffscreen: false, store: 'firefox-default' });
    await settle(50);
    expect((await c).via).toBe('newTab');
    expect(fake.st.tabsCreated).toBe(1);
    // a stop for a default-container answer never goes through container 2
    fake.st.tabs.delete(own.id);
    await T.forgetTab(own.id);
    expect(await T.acquireReadyRelay('newTab', 'firefox-default')).toBeNull();
    const d = T.acquireReadyRelay('newTab', 'firefox-container-2');
    await settle(50);
    expect((await d)!.via).toBe('claudeTab');
  });

  it('another container (or a private window) with no claude.ai tab: nothing is opened, the user is asked to open claude.ai there', async () => {
    fake.st.newTabStore = 'firefox-default';
    tab(7, 'firefox-default');
    const a = T.acquireRelay({ allowOffscreen: false, store: 'firefox-container-4' }).catch((e: Error) => e);
    await settle(5_000);
    expect(await a).toBeInstanceOf(Error);
    expect(fake.st.tabsCreated).toBe(0);
    // a pinned tab that lands in another store than the question's (private window) is closed again
    fake.st.newTabStore = 'firefox-private';
    fake.st.tabs.clear();
    const b = T.acquireRelay({ allowOffscreen: false, store: 'firefox-default' }).catch((e: Error) => e);
    await settle(5_000);
    expect(await b).toBeInstanceOf(Error);
    expect(fake.st.tabsCreated).toBe(1);
    expect(fake.st.tabs.size).toBe(0);
  });

  it('Chrome: a normal window uses only normal claude.ai tabs (and the frame), incognito only incognito ones', async () => {
    fake.st.tabs.set(7, { id: 7, url: 'https://claude.ai/chat/x', pinned: false, status: 'complete', relay: true, incognito: true } as never);
    expect(T.tabStore({ incognito: true })).toBe('chrome-incognito');
    expect(T.tabStore({ incognito: false })).toBeUndefined();
    expect(T.tabStore({ cookieStoreId: 'firefox-container-1', incognito: false })).toBe('firefox-container-1');
    expect(T.tabStore({ incognito: false }, true)).toBe('unknown'); // R5-01: Firefox without a store id
    const a = T.acquireRelay({ allowOffscreen: false, store: 'chrome-incognito' });
    await settle(50);
    expect((await a).via).toBe('claudeTab');
    // a normal window's question never goes through the incognito tab: it opens its own pinned tab
    const b = T.acquireRelay({ allowOffscreen: false });
    await settle(5_000);
    expect((await b).via).toBe('newTab');
    expect(fake.st.tabsCreated).toBe(1);
  });

  it('forgetTab forgets a closed tab in every container', async () => {
    fake.st.newTabStore = 'firefox-default';
    const a = T.acquireRelay({ allowOffscreen: false, store: 'firefox-default' });
    await settle(5_000);
    await a;
    tab(9, 'firefox-container-3');
    const b = T.acquireRelay({ allowOffscreen: false, store: 'firefox-container-3' });
    await settle(50);
    await b;
    expect(Object.keys(fake.session).sort()).toEqual(['ownTabId:firefox-default', 'relayTabId:firefox-container-3', 'relayTabId:firefox-default']);
    await T.forgetTab(fake.session['ownTabId:firefox-default'] as number);
    await T.forgetTab(9);
    expect(Object.keys(fake.session)).toEqual([]);
  });
});

describe('R5-01: a Firefox tab reporting no cookie store fails closed', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { ...fake.chrome, offscreen: undefined });
  });
  it('an ARENA tab of unknown store uses no claude.ai tab and opens none', async () => {
    fake.st.tabs.set(7, { id: 7, url: 'https://claude.ai/chat/x', pinned: false, status: 'complete', relay: true });
    const a = T.acquireRelay({ allowOffscreen: true, store: 'unknown' }).catch((e: Error) => e);
    await settle(5_000);
    expect(await a).toBeInstanceOf(Error);
    expect(fake.st.tabsCreated).toBe(0);
    expect(fake.st.tabConnects).toBe(0);
    expect(await T.acquireReadyRelay('newTab', 'unknown')).toBeNull();
  });
});

describe('My ChatGPT transports', () => {
  it("its frame gets chatgpt.com's rules only (header strip + sign-out block), and wakes name it", async () => {
    const a = T.acquireRelay({ allowOffscreen: true, provider: 'chatgpt' });
    await settle(100);
    expect((await a).via).toBe('offscreenFrame');
    expect(fake.st.wakeProviders.every((p) => p === 'chatgpt')).toBe(true);
    const byId = Object.fromEntries(fake.st.rules.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual(['2', '3']);
    expect(byId[2].condition).toEqual({ requestDomains: ['chatgpt.com'], tabIds: [-1], resourceTypes: ['sub_frame'], initiatorDomains: [EXT_ID, 'chatgpt.com'] });
    expect(byId[3].condition).toMatchObject({ tabIds: [-1], regexFilter: expect.stringContaining('api/auth/signout|auth/logout') });
    expect((byId[3].condition.resourceTypes as string[]).includes('main_frame')).toBe(true);
    expect((byId[3].condition.resourceTypes as string[]).includes('xmlhttprequest')).toBe(true);
  });

  it('both frames share the document: it closes only when neither is in use, and all rules go with it', async () => {
    const g = T.acquireRelay({ allowOffscreen: true, provider: 'chatgpt' });
    await settle(100);
    const hg = await g;
    const c = T.acquireRelay({ allowOffscreen: true });
    await settle(100);
    const hc = await c;
    expect(fake.st.created).toBe(1);
    expect(fake.st.rules.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    hc.release();
    expect(await T.closeOffscreen('idle', 0, false)).toBe(false); // ChatGPT's frame is still in use
    hg.release();
    expect(await T.closeOffscreen('idle', 0, false)).toBe(true);
    expect(fake.st.rules).toEqual([]);
  });

  it('a page being replaced: its unclaimed ports are dropped, never handed to the next question', async () => {
    const a = T.acquireRelay({ allowOffscreen: true, provider: 'chatgpt' });
    await settle(100);
    const h = await a;
    h.release();
    T.drainFramePool('chatgpt');
    fake.st.frameDelay = null; // the new page hasn't connected yet
    const b = T.acquireRelay({ allowOffscreen: true, provider: 'chatgpt' });
    await settle(2_000);
    fake.st.frameDelay = 5;
    await settle(2_000);
    const hb = await b;
    expect(hb.port).not.toBe(h.port);
    expect((hb.port as unknown as { closed: boolean }).closed).toBe(false);
  });

  it("the tab fallback never uses the owner's own chatgpt.com tabs: only its own pinned tab, with a sign-out block rule", async () => {
    vi.stubGlobal('chrome', { ...fake.chrome, offscreen: undefined });
    fake.st.tabs.set(7, { id: 7, url: 'https://chatgpt.com/c/mine', pinned: false, status: 'complete', relay: true });
    const a = T.acquireRelay({ allowOffscreen: true, provider: 'chatgpt' });
    await settle(5_000);
    const h = await a;
    expect(h.via).toBe('newTab');
    expect(fake.st.connected.includes(7)).toBe(false);
    expect(fake.st.tabsCreated).toBe(1);
    const own = [...fake.st.tabs.values()].find((t) => t.id !== 7)!;
    expect(own).toMatchObject({ pinned: true, url: 'https://chatgpt.com/#arena-ask-gpt' });
    // Opened blank; its sign-out rule installed; only then chatgpt.com loaded in it (marked as ARENA Ask's).
    expect(fake.st.ops.filter((o) => o.startsWith('create') || o.startsWith('update') || o === 'rules:+4')).toEqual([
      'create:about:blank',
      'rules:+4',
      `update:${own.id}:https://chatgpt.com/#arena-ask-gpt`,
    ]);
    expect(await T.isOwnTab('chatgpt', own.id, undefined)).toBe(true);
    expect(await T.isOwnTab('chatgpt', 7, undefined)).toBe(false);
    const rule = fake.st.rules.find((r) => r.id === 4)!;
    expect(rule.condition).toMatchObject({ tabIds: [own.id] });
    // reused, not reopened
    const b = T.acquireRelay({ allowOffscreen: false, provider: 'chatgpt' });
    await settle(1_000);
    expect((await b).via).toBe('newTab');
    expect(fake.st.tabsCreated).toBe(1);
    // closed: forgotten, and its rule goes with it
    fake.st.tabs.delete(own.id);
    await T.forgetTab(own.id);
    expect(fake.st.rules.find((r) => r.id === 4)).toBeUndefined();
    expect(await T.isOwnTab('chatgpt', own.id, undefined)).toBe(false);
  });

  it('the pinned ChatGPT tab never loads chatgpt.com if its sign-out rule cannot be installed', async () => {
    vi.stubGlobal('chrome', { ...fake.chrome, offscreen: undefined });
    fake.st.failRuleAdds = true;
    const a = T.acquireRelay({ allowOffscreen: true, provider: 'chatgpt' }).catch((e: Error) => e);
    await settle(5_000);
    expect(await a).toBeInstanceOf(Error);
    expect(fake.st.ops.some((o) => o.startsWith('update'))).toBe(false);
    expect(fake.st.tabs.size).toBe(0); // the blank tab was closed again
  });

  it('no ChatGPT tab outside the default cookie store (it would have to use one of the owner\'s tabs)', async () => {
    vi.stubGlobal('chrome', { ...fake.chrome, offscreen: undefined });
    fake.st.tabs.set(7, { id: 7, url: 'https://chatgpt.com/', pinned: false, status: 'complete', relay: true, cookieStoreId: 'firefox-container-2' });
    const a = T.acquireRelay({ allowOffscreen: true, provider: 'chatgpt', store: 'firefox-container-2' }).catch((e: Error) => e);
    await settle(5_000);
    expect(await a).toBeInstanceOf(Error);
    expect(fake.st.tabsCreated).toBe(0);
    expect(fake.st.connected).toEqual([]);
  });

  it("the Claude transports are unchanged by ChatGPT's (a claude.ai tab is still used as before)", async () => {
    vi.stubGlobal('chrome', { ...fake.chrome, offscreen: undefined });
    fake.st.tabs.set(8, { id: 8, url: 'https://claude.ai/new', pinned: false, status: 'complete', relay: true });
    const a = T.acquireRelay({ allowOffscreen: false });
    await settle(100);
    expect((await a).via).toBe('claudeTab');
  });
});

// ---------------------------------------------------------------------------------------------
// Each browser rejects a whole rule that names a resource type it doesn't know (updateSessionRules
// throws), which would close the ChatGPT tab fallback. These lists are copied from the browsers'
// own schemas, independently of lib/transports.ts:
// - Firefox: `ResourceType` in toolkit/components/extensions/schemas/declarative_net_request.json at
//   FIREFOX_128_0_RELEASE (the add-on's strict_min_version; Firefox 154's list is the same plus `json`).
//   MDN: declarativeNetRequest.ResourceType.
// - Chrome: chrome.declarativeNetRequest.ResourceType (developer.chrome.com).
const FIREFOX_128_RESOURCE_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'object', 'object_subrequest', 'xmlhttprequest', 'xslt', 'ping',
  'beacon', 'xml_dtd', 'font', 'media', 'websocket', 'csp_report', 'imageset', 'web_manifest', 'speculative', 'other',
]);
const CHROME_DNR_RESOURCE_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report',
  'media', 'websocket', 'webtransport', 'webbundle', 'other',
]);
type RuleShape = { condition: { resourceTypes?: readonly string[] } };
const typesOf = (r: RuleShape) => [...(r.condition.resourceTypes ?? [])];

describe("DNR rules use only resource types the browser's schema accepts", () => {
  it('Firefox: the sign-out rule of the pinned ChatGPT tab (the only rule a Firefox build installs)', () => {
    const rule = T.gptSignoutRule(4, 7, true);
    expect(typesOf(rule).length).toBeGreaterThan(0);
    for (const t of typesOf(rule)) expect(FIREFOX_128_RESOURCE_TYPES.has(t), `Firefox has no resource type "${t}"`).toBe(true);
    // every type Firefox has: a sign-out by navigation, fetch/XHR or beacon is blocked alike
    expect(new Set(typesOf(rule))).toEqual(FIREFOX_128_RESOURCE_TYPES);
    expect(T.FIREFOX_RESOURCE_TYPES.includes('webtransport' as never) || T.FIREFOX_RESOURCE_TYPES.includes('webbundle' as never)).toBe(false);
  });

  it('Chrome: every rule (frames, sign-out in the frame and the tab)', () => {
    const rules: RuleShape[] = [T.frameRule(EXT_ID), ...T.gptFrameRules(EXT_ID), T.gptSignoutRule(4, 7, false)];
    for (const r of rules) {
      expect(typesOf(r).length).toBeGreaterThan(0);
      for (const t of typesOf(r)) expect(CHROME_DNR_RESOURCE_TYPES.has(t), `Chrome has no resource type "${t}"`).toBe(true);
    }
    expect(new Set(typesOf(T.gptSignoutRule(4, 7, false)))).toEqual(CHROME_DNR_RESOURCE_TYPES);
  });

  it('outside a Firefox build (tests, Chrome) the default is the Chrome list', () => {
    expect(typesOf(T.gptSignoutRule(4, 7))).toEqual(typesOf(T.gptSignoutRule(4, 7, false)));
  });
});
