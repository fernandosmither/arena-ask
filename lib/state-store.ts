import { validPatch, type BodyPatch } from './gpt-guard';
import { TYPED_HASH_RE } from './hash';
import { parseMode, type ConvState, type Mode, type ProjectRef } from './protocol';
import type { ProviderId } from './provider';
import { UUID_RE } from './uuid';
import { CHAPTER_KEY_RE, GPT_MODEL_RE, ORG_TAG_RE, validateConvState, validateProjectRef } from './validate';

/** A project this extension created; `used` once a conversation was put in it (then never deleted). */
export interface OwnProject extends ProjectRef {
  used: boolean;
}
/**
 * Projects kept track of: every unused one (a cleanup candidate: never dropped while it may still
 * exist, up to a hard bound), then the most recent used ones.
 */
const MAX_OWN_PROJECTS = 20;
const MAX_UNUSED_PROJECTS = 200;

/** Trim the ledger: drop used entries (oldest first) before any unused one. */
function trimOwn(list: OwnProject[]): OwnProject[] {
  const unused = list.filter((o) => !o.used).slice(-MAX_UNUSED_PROJECTS);
  const room = Math.max(0, MAX_OWN_PROJECTS - unused.length);
  const used = room ? list.filter((o) => o.used).slice(-room) : [];
  return list.filter((o) => unused.includes(o) || used.includes(o));
}

/**
 * Where the background keeps what decides which claude.ai conversation (and project) the relay
 * writes to: the extension origin's IndexedDB. chrome.storage.local is writable by content scripts,
 * so a compromised page context could otherwise point the relay at any conversation id; content
 * scripts' IndexedDB is the page's, so they can't reach this one. Everything read back is
 * re-validated anyway.
 */

export interface KvBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A chapter's conversation: claude.ai's under `conv:` (as before), ChatGPT's under `gpt:`. */
const convKey = (chapterKey: string, provider: ProviderId = 'claude') => (provider === 'chatgpt' ? `gpt:${chapterKey}` : `conv:${chapterKey}`);
const typedKey = (chapterKey: string) => `typed:${chapterKey}`;
const PROJECT_KEY = 'project';
const OWN_PROJECTS_KEY = 'ownProjects';
const MODE_STORE_KEY = 'mode';
const PINNED_ORG_KEY = 'pinnedOrg';
/** The ChatGPT account My ChatGPT is pinned to: its tag (the id never leaves chatgpt.com). */
const PINNED_GPT_KEY = 'pinnedGpt';
/** The owner's ChatGPT model override (absent: the page's choice). */
const GPT_MODEL_KEY = 'model:chatgpt';
/** Request-body changes the ChatGPT send guard makes (absent: DEFAULT_GPT_PATCH in the background). */
const GPT_PATCH_KEY = 'patch:chatgpt';
/** Mark ARENA Ask's ChatGPT chats "don't remember" (absent: no, the default; the owner opts in). */
const GPT_DNR_KEY = 'doNotRemember:chatgpt';
/** How many forwarded questions are remembered per chapter (ARENA forwards at most 200 messages of history). */
export const MAX_TYPED = 256;

export class StateStore {
  constructor(private readonly kv: KvBackend) {}

  async loadConv(chapterKey: string, provider: ProviderId = 'claude'): Promise<ConvState | null> {
    if (!CHAPTER_KEY_RE.test(chapterKey)) return null;
    return validateConvState(await this.kv.get(convKey(chapterKey, provider)));
  }

  async saveConv(chapterKey: string, st: ConvState, provider: ProviderId = 'claude'): Promise<void> {
    const v = validateConvState(st);
    if (!v || !CHAPTER_KEY_RE.test(chapterKey)) return;
    await this.kv.set(convKey(chapterKey, provider), v);
  }

  /** Forget the chapter's conversation (both providers' unless one is named). */
  async deleteConv(chapterKey: string, provider?: ProviderId): Promise<void> {
    if (!CHAPTER_KEY_RE.test(chapterKey)) return;
    for (const p of provider ? [provider] : (['claude', 'chatgpt'] as const)) await this.kv.delete(convKey(chapterKey, p));
  }

  /**
   * Record a question the bridge forwarded after a trusted Send (its `typedHash`): the only ARENA
   * history entries later presented to Claude as the user's own words are ones matching these.
   */
  async addTyped(chapterKey: string, hash: string): Promise<void> {
    if (!CHAPTER_KEY_RE.test(chapterKey) || !TYPED_HASH_RE.test(hash)) return;
    const list = [...(await this.loadTyped(chapterKey))].filter((h) => h !== hash);
    list.push(hash);
    await this.kv.set(typedKey(chapterKey), list.slice(-MAX_TYPED));
  }

  async loadTyped(chapterKey: string): Promise<Set<string>> {
    if (!CHAPTER_KEY_RE.test(chapterKey)) return new Set();
    const raw = await this.kv.get(typedKey(chapterKey));
    return new Set(Array.isArray(raw) ? raw.filter((h): h is string => typeof h === 'string' && TYPED_HASH_RE.test(h)) : []);
  }

  async deleteTyped(chapterKey: string): Promise<void> {
    if (!CHAPTER_KEY_RE.test(chapterKey)) return;
    await this.kv.delete(typedKey(chapterKey));
  }

  /** The mode (see MODE_KEY): absent → full; `locked`, or anything unexpected (null included) → locked. */
  async loadMode(): Promise<Mode> {
    return parseMode(await this.kv.get(MODE_STORE_KEY));
  }

  async saveMode(mode: Mode): Promise<void> {
    if (mode !== 'full' && mode !== 'locked') throw new Error('mode must be "full" or "locked"');
    await this.kv.set(MODE_STORE_KEY, mode);
  }

  /** Whether a mode was ever stored (absent = the default, full). */
  async hasMode(): Promise<boolean> {
    return (await this.kv.get(MODE_STORE_KEY)) !== undefined;
  }

  /** The claude.ai org full mode is pinned to (never leaves the extension's own contexts). */
  async loadPinnedOrg(): Promise<string | null> {
    const v = await this.kv.get(PINNED_ORG_KEY);
    return typeof v === 'string' && UUID_RE.test(v) ? v : null;
  }

  /** Pin `org` unless one is pinned already (the first full-mode use wins). */
  async pinOrgOnce(org: string): Promise<boolean> {
    if (!UUID_RE.test(org) || (await this.loadPinnedOrg())) return false;
    await this.kv.set(PINNED_ORG_KEY, org);
    return true;
  }

  async forgetPinnedOrg(): Promise<void> {
    await this.kv.delete(PINNED_ORG_KEY);
  }

  /** The ChatGPT account tag My ChatGPT is pinned to. */
  async loadPinnedGpt(): Promise<string | null> {
    const v = await this.kv.get(PINNED_GPT_KEY);
    return typeof v === 'string' && ORG_TAG_RE.test(v) ? v : null;
  }

  /** Pin a ChatGPT account tag unless one is pinned already (the first question wins). */
  async pinGptOnce(tag: string): Promise<boolean> {
    if (!ORG_TAG_RE.test(tag) || (await this.loadPinnedGpt())) return false;
    await this.kv.set(PINNED_GPT_KEY, tag);
    return true;
  }

  async forgetPinnedGpt(): Promise<void> {
    await this.kv.delete(PINNED_GPT_KEY);
  }

  /** The owner's ChatGPT model override (null: the page's own choice). */
  async loadGptModel(): Promise<string | null> {
    const v = await this.kv.get(GPT_MODEL_KEY);
    return typeof v === 'string' && GPT_MODEL_RE.test(v) ? v : null;
  }

  async saveGptModel(model: string | null): Promise<void> {
    if (model === null) return void (await this.kv.delete(GPT_MODEL_KEY));
    if (!GPT_MODEL_RE.test(model)) throw new Error('not a ChatGPT model slug');
    await this.kv.set(GPT_MODEL_KEY, model);
  }

  /**
   * Whether ARENA Ask marks its ChatGPT chats "don't remember": only when the owner turned it on
   * (stored `true`); absent (the default) or anything else → no, so ChatGPT sees the owner's saved
   * memories as in any chat.
   */
  async loadGptDoNotRemember(): Promise<boolean> {
    return (await this.kv.get(GPT_DNR_KEY)) === true;
  }

  async saveGptDoNotRemember(on: boolean): Promise<void> {
    if (on) await this.kv.set(GPT_DNR_KEY, true);
    else await this.kv.delete(GPT_DNR_KEY);
  }

  /** The stored ChatGPT request-body patch; null when none is stored (the background's default applies). */
  async loadGptPatch(): Promise<BodyPatch | null> {
    const v = await this.kv.get(GPT_PATCH_KEY);
    return v === undefined ? null : validPatch(v);
  }

  async saveGptPatch(patch: BodyPatch | null): Promise<void> {
    if (patch === null) return void (await this.kv.delete(GPT_PATCH_KEY));
    const v = validPatch(patch);
    if (!v) throw new Error('not a valid ChatGPT body patch');
    await this.kv.set(GPT_PATCH_KEY, v);
  }

  async loadProject(): Promise<ProjectRef | null> {
    return validateProjectRef(await this.kv.get(PROJECT_KEY));
  }

  async saveProject(p: ProjectRef): Promise<void> {
    const v = validateProjectRef(p);
    if (v) await this.kv.set(PROJECT_KEY, v);
  }

  /** Every project this extension created that it still keeps track of. */
  async loadOwnProjects(): Promise<OwnProject[]> {
    const raw = await this.kv.get(OWN_PROJECTS_KEY);
    if (!Array.isArray(raw)) return [];
    const out: OwnProject[] = [];
    for (const x of raw) {
      const ref = validateProjectRef(x);
      if (ref && !out.some((o) => o.uuid === ref.uuid)) out.push({ ...ref, used: (x as { used?: unknown }).used === true });
    }
    return trimOwn(out);
  }

  async saveOwnProjects(list: OwnProject[]): Promise<void> {
    const out: OwnProject[] = [];
    for (const x of list) {
      const ref = validateProjectRef(x);
      if (ref && !out.some((o) => o.uuid === ref.uuid)) out.push({ ...ref, used: x.used === true });
    }
    await this.kv.set(OWN_PROJECTS_KEY, trimOwn(out));
  }
}

/**
 * A single-object-store IndexedDB key/value backend (the background's own origin). The database is
 * opened at whatever version it has; if it lacks the store (e.g. something opened `arena-ask`
 * without a version first, which creates it empty, and a fixed-version open then never upgrades),
 * it is reopened one version up and the store created, instead of every read failing (which would
 * read the mode as locked for good).
 */
export function idbBackend(dbName = 'arena-ask', storeName = 'state', idb: IDBFactory = indexedDB): KvBackend {
  let db: Promise<IDBDatabase> | null = null;
  const openAt = (version?: number) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = version === undefined ? idb.open(dbName) : idb.open(dbName, version);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('arena-ask database upgrade blocked'));
    });
  const open = () =>
    (db ??= (async () => {
      let d = await openAt();
      if (!d.objectStoreNames.contains(storeName)) {
        const v = d.version;
        d.close();
        d = await openAt(v + 1);
      }
      d.onclose = () => (db = null);
      // Don't block a deleteDatabase / upgrade (e.g. clearing the extension's data).
      d.onversionchange = () => {
        d.close();
        db = null;
      };
      return d;
    })().catch((e) => {
      db = null;
      throw e;
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: async (key, value) => void (await run('readwrite', (s) => s.put(value, key))),
    delete: async (key) => void (await run('readwrite', (s) => s.delete(key))),
  };
}

/** In-memory backend (tests; also a fallback where IndexedDB is unavailable). */
export function memoryBackend(): KvBackend & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    delete: async (k) => void data.delete(k),
  };
}

/**
 * Remove the state v1 kept in chrome.storage.local (`conv.v1.*`, which content scripts could
 * write). The chapter's next question simply starts a new, locked-down conversation.
 */
export async function purgeLegacyState(area: {
  get(keys: null): Promise<Record<string, unknown>>;
  remove(keys: string[]): Promise<void>;
}): Promise<number> {
  const all = await area.get(null);
  const legacy = Object.keys(all).filter((k) => k.startsWith('conv.v1.') || k === 'project.v1');
  if (legacy.length) await area.remove(legacy);
  return legacy.length;
}
