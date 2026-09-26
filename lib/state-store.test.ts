import { describe, expect, it } from 'vitest';
import { sha256Hex, textHash, typedHash } from './hash';
import type { ConvState } from './protocol';
import { MAX_TYPED, StateStore, idbBackend, memoryBackend, purgeLegacyState } from './state-store';

const st = (over: Partial<ConvState> = {}): ConvState => ({
  v: 1,
  orgTag: '0123456789abcdef',
  convUuid: '11111111-2222-4333-8444-555555555555',
  parent: '019e954f-0000-7000-8000-000000000000',
  anchor: textHash('Q1'),
  arenaLen: 2,
  ctxHash: null,
  filed: true,
  name: 'ARENA · X',
  updatedAt: 1,
  ...over,
});
const project = { orgTag: '0123456789abcdef', uuid: '0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e' };

describe('StateStore: own projects', () => {
  it('round-trips, validates, dedupes and caps the list', async () => {
    const s = new StateStore(memoryBackend());
    expect(await s.loadOwnProjects()).toEqual([]);
    await s.saveOwnProjects([{ ...project, used: true }, { ...project, used: false }, { orgTag: 'bad', uuid: 'x', used: false } as never]);
    expect(await s.loadOwnProjects()).toEqual([{ ...project, used: true }]);
    const id = (i: number) => `0a0a0a0a-1b1b-4c2c-8d3d-${String(i).padStart(12, '0')}`;
    const many = Array.from({ length: 25 }, (_, i) => ({ orgTag: project.orgTag, uuid: id(i), used: true }));
    await s.saveOwnProjects(many);
    const got = await s.loadOwnProjects();
    expect(got).toHaveLength(20);
    expect(got.at(-1)!.uuid).toBe(many.at(-1)!.uuid);
  });

  it('R5-08: never drops an unused project (a cleanup candidate) to make room; used ones go first', async () => {
    const s = new StateStore(memoryBackend());
    const id = (i: number) => `0a0a0a0a-1b1b-4c2c-8d3d-${String(i).padStart(12, '0')}`;
    const list = Array.from({ length: 30 }, (_, i) => ({ orgTag: project.orgTag, uuid: id(i), used: i % 3 !== 0 }));
    await s.saveOwnProjects(list);
    const got = await s.loadOwnProjects();
    const unused = list.filter((o) => !o.used).map((o) => o.uuid);
    expect(got.filter((o) => !o.used).map((o) => o.uuid)).toEqual(unused); // all 10 kept, in order
    expect(got).toHaveLength(20);
    expect(got.filter((o) => o.used).map((o) => o.uuid)).toEqual(list.filter((o) => o.used).slice(-10).map((o) => o.uuid));
    // 25 unused: all kept, no used ones
    const unusedOnly = Array.from({ length: 25 }, (_, i) => ({ orgTag: project.orgTag, uuid: id(100 + i), used: false }));
    await s.saveOwnProjects([...list, ...unusedOnly]);
    const got2 = await s.loadOwnProjects();
    expect(got2.every((o) => !o.used)).toBe(true);
    expect(got2).toHaveLength(35);
  });
});

describe('StateStore', () => {
  it('round-trips conversation state per chapter and the project ref', async () => {
    const s = new StateStore(memoryBackend());
    expect(await s.loadConv('chapter0')).toBeNull();
    await s.saveConv('chapter0', st());
    await s.saveProject(project);
    expect(await s.loadConv('chapter0')).toEqual(st());
    expect(await s.loadConv('chapter1')).toBeNull();
    expect(await s.loadProject()).toEqual(project);
    await s.deleteConv('chapter0');
    expect(await s.loadConv('chapter0')).toBeNull();
  });

  it('re-validates what it reads (a tampered record is ignored) and refuses bad keys/records', async () => {
    const kv = memoryBackend();
    const s = new StateStore(kv);
    kv.data.set('conv:chapter0', { ...st(), convUuid: 'not-a-uuid' });
    kv.data.set('project', { ...project, uuid: '../../x' });
    expect(await s.loadConv('chapter0')).toBeNull();
    expect(await s.loadProject()).toBeNull();
    await s.saveConv('../x', st());
    await s.saveConv('chapter2', { ...st(), orgTag: 'an-org-id' } as ConvState);
    expect([...kv.data.keys()].sort()).toEqual(['conv:chapter0', 'project']);
  });
});

describe('StateStore: questions forwarded from a trusted Send (typed)', () => {
  const h = (k: number) => k.toString(16).padStart(32, '0');
  it('records per chapter, validates, dedupes, caps, and forgets on reset', async () => {
    const s = new StateStore(memoryBackend());
    expect(await s.loadTyped('chapter0')).toEqual(new Set());
    await s.addTyped('chapter0', h(1));
    await s.addTyped('chapter0', h(1));
    await s.addTyped('chapter1', h(2));
    await s.addTyped('chapter0', 'not-a-hash');
    await s.addTyped('bad key!', h(3));
    expect(await s.loadTyped('chapter0')).toEqual(new Set([h(1)]));
    expect(await s.loadTyped('chapter1')).toEqual(new Set([h(2)]));
    for (let k = 0; k < MAX_TYPED + 10; k++) await s.addTyped('chapter0', h(100 + k));
    const got = await s.loadTyped('chapter0');
    expect(got.size).toBe(MAX_TYPED);
    expect(got.has(h(100 + MAX_TYPED + 9))).toBe(true); // newest kept
    expect(got.has(h(1))).toBe(false); // oldest dropped
    await s.deleteTyped('chapter0');
    expect(await s.loadTyped('chapter0')).toEqual(new Set());
    expect(await s.loadTyped('chapter1')).toEqual(new Set([h(2)]));
  });

  it('typedHash: domain-separated, trimmed, 32 hex', async () => {
    expect(await typedHash('  Why einsum?\n')).toBe(await typedHash('Why einsum?'));
    expect(await typedHash('Why einsum?')).toMatch(/^[0-9a-f]{32}$/);
    expect(await typedHash('Why einsum?')).not.toBe((await sha256Hex('Why einsum?')).slice(0, 32));
  });
});

describe('StateStore: mode and pinned org (the background\'s own IndexedDB)', () => {
  it('mode: absent → full; stored full/locked; anything unexpected → locked', async () => {
    const kv = memoryBackend();
    const s = new StateStore(kv);
    expect(await s.hasMode()).toBe(false);
    expect(await s.loadMode()).toBe('full');
    await s.saveMode('locked');
    expect(await s.loadMode()).toBe('locked');
    expect(await s.hasMode()).toBe(true);
    await s.saveMode('full');
    expect(await s.loadMode()).toBe('full');
    await expect(s.saveMode('open' as never)).rejects.toThrow();
    for (const v of [null, 'FULL', 1, {}]) {
      kv.data.set('mode', v);
      expect(await s.loadMode(), JSON.stringify(v)).toBe('locked');
    }
  });

  it('pinned org: validated, first pin wins, forgettable', async () => {
    const s = new StateStore(memoryBackend());
    const a = '12121212-3434-4565-8787-909090909090';
    const b = '56565656-7878-4989-8a8a-bcbcbcbcbcbc';
    expect(await s.loadPinnedOrg()).toBeNull();
    expect(await s.pinOrgOnce('nope')).toBe(false);
    expect(await s.pinOrgOnce(a)).toBe(true);
    expect(await s.pinOrgOnce(b)).toBe(false);
    expect(await s.loadPinnedOrg()).toBe(a);
    await s.forgetPinnedOrg();
    expect(await s.loadPinnedOrg()).toBeNull();
    expect(await s.pinOrgOnce(b)).toBe(true);
    expect(await s.loadPinnedOrg()).toBe(b);
  });
});

describe('purgeLegacyState', () => {
  it('removes v1 conversation state from chrome.storage.local and keeps everything else', async () => {
    const data: Record<string, unknown> = {
      'conv.v1.chapter0': st(),
      'conv.v1.static': st(),
      'project.v1': project,
      'meta.v1.chapter0': {},
      'arenaAsk.debug.disableOffscreen': true,
    };
    const area = {
      get: async () => ({ ...data }),
      remove: async (keys: string[]) => keys.forEach((k) => delete data[k]),
    };
    expect(await purgeLegacyState(area)).toBe(3);
    expect(Object.keys(data).sort()).toEqual(['arenaAsk.debug.disableOffscreen', 'meta.v1.chapter0']);
    expect(await purgeLegacyState(area)).toBe(0);
  });
});

describe('StateStore: My ChatGPT', () => {
  it("keeps each provider's chat per chapter apart; clearing the chapter forgets both", async () => {
    const s = new StateStore(memoryBackend());
    await s.saveConv('chapter0', st());
    await s.saveConv('chapter0', st({ convUuid: '22222222-2222-4333-8444-555555555555', mode: 'full' }), 'chatgpt');
    expect((await s.loadConv('chapter0'))!.convUuid).toBe('11111111-2222-4333-8444-555555555555');
    expect((await s.loadConv('chapter0', 'chatgpt'))!.convUuid).toBe('22222222-2222-4333-8444-555555555555');
    await s.deleteConv('chapter0', 'chatgpt');
    expect(await s.loadConv('chapter0', 'chatgpt')).toBeNull();
    expect(await s.loadConv('chapter0')).not.toBeNull();
    await s.saveConv('chapter0', st({ mode: 'full' }), 'chatgpt');
    await s.deleteConv('chapter0');
    expect(await s.loadConv('chapter0')).toBeNull();
    expect(await s.loadConv('chapter0', 'chatgpt')).toBeNull();
  });

  it('model override, body patch and the "don\'t remember" switch: validated, with defaults', async () => {
    const kv = memoryBackend();
    const s = new StateStore(kv);
    expect(await s.loadGptModel()).toBeNull();
    await s.saveGptModel('gpt-5-6-thinking');
    expect(await s.loadGptModel()).toBe('gpt-5-6-thinking');
    await expect(s.saveGptModel('Robert"); DROP')).rejects.toThrow();
    await s.saveGptModel(null);
    expect(await s.loadGptModel()).toBeNull();
    expect(await s.loadGptPatch()).toBeNull();
    await s.saveGptPatch({ drop: ['local_function_names'] });
    expect(await s.loadGptPatch()).toEqual({ drop: ['local_function_names'] });
    kv.data.set('patch:chatgpt', { drop: ['messages'] });
    expect(await s.loadGptPatch()).toBeNull(); // tampered: ignored (the default applies)
    // "Don't remember" is off unless the owner turned it on (so ChatGPT sees their saved memories).
    expect(await s.loadGptDoNotRemember()).toBe(false);
    await s.saveGptDoNotRemember(true);
    expect(kv.data.get('doNotRemember:chatgpt')).toBe(true);
    expect(await s.loadGptDoNotRemember()).toBe(true);
    await s.saveGptDoNotRemember(false);
    expect(kv.data.has('doNotRemember:chatgpt')).toBe(false);
    expect(await s.loadGptDoNotRemember()).toBe(false);
    kv.data.set('doNotRemember:chatgpt', 'yes');
    expect(await s.loadGptDoNotRemember()).toBe(false); // only an explicit true turns it on
    kv.data.set('doNotRemember:chatgpt', false); // what older builds stored to turn it off
    expect(await s.loadGptDoNotRemember()).toBe(false);
  });
});

/** A minimal in-memory IndexedDB (open with/without a version, upgrades, one-request transactions). */
function fakeIdb() {
  type Store = Map<string, unknown>;
  const dbs = new Map<string, { version: number; stores: Map<string, Store> }>();
  const later = (fn: () => void) => setTimeout(fn, 0);
  const handle = (name: string) => {
    const rec = dbs.get(name)!;
    const d = {
      get version() {
        return rec.version;
      },
      objectStoreNames: { contains: (s: string) => rec.stores.has(s) },
      createObjectStore: (s: string) => rec.stores.set(s, new Map()),
      close: () => {},
      onclose: null as unknown,
      onversionchange: null as unknown,
      transaction(storeName: string) {
        const store = rec.stores.get(storeName);
        if (!store) throw new DOMException('One of the specified object stores was not found.', 'NotFoundError');
        const tx = { oncomplete: null as null | (() => void), onerror: null, onabort: null, error: null, objectStore: () => os };
        const reqOf = (fn: () => unknown) => {
          const r = { result: undefined as unknown };
          later(() => {
            r.result = fn();
            tx.oncomplete?.();
          });
          return r;
        };
        const os = {
          get: (k: string) => reqOf(() => structuredClone(store.get(k))),
          put: (v: unknown, k: string) => reqOf(() => void store.set(k, structuredClone(v))),
          delete: (k: string) => reqOf(() => void store.delete(k)),
        };
        return tx;
      },
    };
    return d;
  };
  const factory = {
    opened: [] as (number | undefined)[],
    open(name: string, version?: number) {
      factory.opened.push(version);
      const req = { result: null as unknown, error: null as unknown, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null as null | (() => void), onblocked: null };
      later(() => {
        let rec = dbs.get(name);
        const want = version ?? rec?.version ?? 1;
        if (rec && want < rec.version) {
          req.error = new DOMException('lower version', 'VersionError');
          return req.onerror?.();
        }
        const upgrade = !rec || want > rec.version;
        if (!rec) dbs.set(name, (rec = { version: want, stores: new Map() }));
        rec.version = want;
        req.result = handle(name);
        if (upgrade) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory, dbs };
}

describe('idbBackend', () => {
  it('creates its store on first use and keeps values', async () => {
    const { factory } = fakeIdb();
    const kv = idbBackend('arena-ask', 'state', factory as unknown as IDBFactory);
    await kv.set('mode', 'full');
    expect(await kv.get('mode')).toBe('full');
  });

  it('a database someone opened without a version (so it has no store) is rebuilt, not read as locked for good', async () => {
    const { factory, dbs } = fakeIdb();
    dbs.set('arena-ask', { version: 1, stores: new Map() }); // e.g. indexedDB.open('arena-ask') from a console
    const kv = idbBackend('arena-ask', 'state', factory as unknown as IDBFactory);
    const store = new StateStore(kv);
    await store.saveMode('full');
    expect(await store.loadMode()).toBe('full');
    expect(dbs.get('arena-ask')!.version).toBe(2);
    expect(dbs.get('arena-ask')!.stores.has('state')).toBe(true);
    expect(factory.opened).toEqual([undefined, 2]);
  });
});
