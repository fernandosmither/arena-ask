import { ARENA_SEL } from './arena-selectors';
import { ext } from './ext';
import { TEXT_HASH_RE } from './hash';
import { parseMetaEntry, pruneMeta, type BubbleMeta } from './meta';
import { metaKey } from './protocol';
import { UUID_RE } from './uuid';

/**
 * Which Claude answer a metadata entry belongs to. Together with the store's chapter (the storage
 * bucket, `meta.v1.<chapterKey>`) and the entry's own conversation (`meta.c`), this identifies one
 * answer, so identical answer texts (e.g. every empty answer's fixed note) no longer share one
 * entry, one usage figure and one "Open in claude.ai" link.
 */
export interface AnswerRef {
  /** textHash() of the answer text exactly as ARENA's bubble shows it. */
  hash: string;
  /**
   * 0-based position of the answer among the chapter's assistant messages: see answerIndexOf().
   * Negative (unknown) records a hash-only entry, as before.
   */
  index: number;
}

/**
 * The answer's position among the chat's assistant bubbles, skipping ARENA's error bubbles (ARENA
 * never saves those to its history, so they are gone after a reload). ARENA re-renders its saved
 * history in order, so this is the same number before and after a reload. -1 if not in the chat.
 */
export function answerIndexOf(bubble: Element): number {
  let i = 0;
  for (const el of bubble.ownerDocument.querySelectorAll(`${ARENA_SEL.messages} ${ARENA_SEL.assistantBubble}`)) {
    if (el === bubble) return i;
    if (!el.classList.contains(ARENA_SEL.errorClass)) i++;
  }
  return -1;
}

const MAX_INDEX = 1_000_000;
const NO_CONV = '-';

/** Storage key `<index>:<conversation uuid | ->:<text hash>`; legacy entries are keyed by the bare hash. */
const entryKey = (index: number, conv: string | null, hash: string) => `${index}:${conv ?? NO_CONV}:${hash}`;

interface Slot {
  index: number; // -1 for a legacy hash-only entry
  conv: string | null;
  hash: string;
}

function parseKey(k: string): Slot | null {
  if (TEXT_HASH_RE.test(k)) return { index: -1, conv: null, hash: k };
  const parts = k.split(':');
  if (parts.length !== 3) return null;
  const [i, c, hash] = parts;
  if (!/^\d{1,7}$/.test(i) || +i > MAX_INDEX || !TEXT_HASH_RE.test(hash)) return null;
  if (c !== NO_CONV && !UUID_RE.test(c)) return null;
  return { index: +i, conv: c === NO_CONV ? null : c, hash };
}

const validIndex = (i: unknown): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i <= MAX_INDEX;

/** Validate a stored map (legacy hash keys and answer keys alike); drop anything malformed. */
export function parseStoredMeta(x: unknown): Map<string, BubbleMeta> {
  const out = new Map<string, BubbleMeta>();
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    const slot = parseKey(k);
    const m = slot ? parseMetaEntry(v) : null;
    // an answer key's conversation must be the entry's own
    if (slot && m && (slot.index < 0 || slot.conv === m.c)) out.set(k, m);
  }
  return out;
}

/** In-memory mirror of one chapter's bubble metadata, persisted to chrome.storage.local. */
export class MetaStore {
  private map = new Map<string, BubbleMeta>();
  /** text hash → keys of the entries for that text */
  private byHash = new Map<string, string[]>();
  private key: string | null = null;

  get size(): number {
    return this.map.size;
  }

  /**
   * Metadata for the answer bubble whose text hashes to `hash` and that sits at `index`
   * (answerIndexOf). In order: the entry recorded for exactly that answer (for `conv` if given,
   * else the newest); a legacy hash-only entry; the only entry for that text, if there is exactly
   * one (e.g. positions shifted). Identical texts at other positions never borrow each other's
   * entry. Without `index` (old callers) only the last two apply.
   */
  lookup = (hash: string, index?: number, conv?: string | null): BubbleMeta | undefined => {
    const keys = this.byHash.get(hash);
    if (!keys) return undefined;
    if (validIndex(index)) {
      let best: BubbleMeta | undefined;
      for (const k of keys) {
        const s = parseKey(k)!;
        if (s.index !== index) continue;
        const m = this.map.get(k)!;
        if (conv !== undefined && s.conv === conv) return m;
        if (!best || m.t > best.t) best = m;
      }
      if (best) return best;
    }
    const legacy = this.map.get(hash);
    if (legacy) return legacy;
    return keys.length === 1 ? this.map.get(keys[0]) : undefined;
  };

  async load(chapterKey: string): Promise<void> {
    this.key = chapterKey;
    this.setMap(new Map());
    try {
      const k = metaKey(chapterKey);
      const got = await ext().storage.local.get(k);
      if (this.key === chapterKey) this.setMap(parseStoredMeta(got[k]));
    } catch {
      /* storage unavailable (e.g. extension reloaded under the page): no re-enhancement */
    }
  }

  /**
   * Record one answer's metadata. Pass an AnswerRef: `{ hash: textHash(text), index:
   * answerIndexOf(bubble) }`. A bare hash (the old signature) still works but records a hash-only
   * entry, shared by every answer with the same text.
   */
  async put(chapterKey: string, answer: AnswerRef | string, meta: BubbleMeta): Promise<void> {
    const hash = typeof answer === 'string' ? answer : answer.hash;
    if (!TEXT_HASH_RE.test(hash)) return;
    const conv = meta.c !== null && UUID_RE.test(meta.c) ? meta.c : null;
    const m: BubbleMeta = { ...meta, c: conv };
    const k = typeof answer !== 'string' && validIndex(answer.index) ? entryKey(answer.index, conv, hash) : hash;
    if (this.key !== chapterKey) await this.load(chapterKey);
    this.map.set(k, m);
    this.setMap(pruneMeta(this.map));
    try {
      await ext().storage.local.set({ [metaKey(chapterKey)]: Object.fromEntries(this.map) });
    } catch {
      /* best-effort */
    }
  }

  async clear(chapterKey: string): Promise<void> {
    if (this.key === chapterKey) this.setMap(new Map());
    try {
      await ext().storage.local.remove(metaKey(chapterKey));
    } catch {
      /* best-effort */
    }
  }

  private setMap(map: Map<string, BubbleMeta>): void {
    this.map = map;
    this.byHash = new Map();
    for (const k of map.keys()) {
      const hash = parseKey(k)?.hash;
      if (!hash) continue;
      const list = this.byHash.get(hash);
      if (list) list.push(k);
      else this.byHash.set(hash, [k]);
    }
  }
}
