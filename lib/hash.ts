/** SHA-256 of a string as lowercase hex (Web Crypto; available in pages, workers and Node). */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** cyrb53: a fast, well-mixed 53-bit string hash (public domain, bryc). Not cryptographic. */
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Synchronous identity hash for short-lived bookkeeping (which ARENA bubble is which answer, which
 * ARENA chat thread is which). 28 hex chars from two independently seeded cyrb53 runs.
 */
export function textHash(s: string): string {
  return cyrb53(s, 0).toString(16).padStart(14, '0') + cyrb53(s, 0x9e3779b9).toString(16).padStart(14, '0');
}

export const TEXT_HASH_RE = /^[0-9a-f]{28}$/;

/**
 * Identity of a question the extension forwarded from a trusted Send (ARENA's history is compared
 * against these). 32 hex chars of a domain-separated sha256 of the trimmed text.
 */
export async function typedHash(text: string): Promise<string> {
  return (await sha256Hex(`arena-ask/typed\n${text.trim()}`)).slice(0, 32);
}

export const TYPED_HASH_RE = /^[0-9a-f]{32}$/;
