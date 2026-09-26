import { TEXT_HASH_RE } from './hash';
import { TRANSPORTS, type Transport } from './protocol';
import { UUID_RE } from './uuid';

/**
 * Per-answer metadata for Claude bubbles, so ARENA's history (re-rendered from localStorage as
 * plain text on every page load) can be re-enhanced: keyed by answer position + conversation + text hash (see meta-store.ts), stored in
 * chrome.storage.local under `meta.v1.<chapterKey>`.
 */
export interface BubbleMeta {
  /** claude.ai conversation uuid (null if unknown). */
  c: string | null;
  /** 5-hour usage utilization reported with this answer. */
  u: number | null;
  /** 7-day usage utilization. */
  w: number | null;
  /** When the answer completed (ms). */
  t: number;
  /** Transport that carried it (shown as data-via, for QA). */
  v?: Transport;
  /** The provider, when not Claude (`g` = ChatGPT: the footer links to chatgpt.com). */
  p?: 'g';
  /** The model that answered, when the provider said (shown in the footer). */
  m?: string;
}

export const META_MAX = 300;

const num = (x: unknown) => (x === null ? null : typeof x === 'number' && Number.isFinite(x) ? x : undefined);

export function parseMetaEntry(x: unknown): BubbleMeta | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const c = o.c === null ? null : typeof o.c === 'string' && UUID_RE.test(o.c) ? o.c : undefined;
  const u = num(o.u);
  const w = num(o.w);
  if (c === undefined || u === undefined || w === undefined) return null;
  if (typeof o.t !== 'number' || !Number.isFinite(o.t)) return null;
  const m: BubbleMeta = { c, u, w, t: o.t };
  if (typeof o.v === 'string' && (TRANSPORTS as readonly string[]).includes(o.v)) m.v = o.v as Transport;
  if (o.p === 'g') m.p = 'g';
  if (typeof o.m === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(o.m)) m.m = o.m;
  return m;
}

/** Validate a stored map; drop anything malformed. */
export function parseMetaMap(x: unknown): Map<string, BubbleMeta> {
  const out = new Map<string, BubbleMeta>();
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    const m = TEXT_HASH_RE.test(k) ? parseMetaEntry(v) : null;
    if (m) out.set(k, m);
  }
  return out;
}

/** Keep the newest `max` entries. */
export function pruneMeta(map: Map<string, BubbleMeta>, max = META_MAX): Map<string, BubbleMeta> {
  if (map.size <= max) return map;
  return new Map([...map.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, max));
}
