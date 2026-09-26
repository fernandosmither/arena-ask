import { createHash } from 'node:crypto';
import { defineConfig } from 'wxt';

/**
 * The extension's fixed identity (Chrome). chatgpt.com's MAIN-world script (lib/gpt-page.ts) has
 * no extension APIs, so it recognises the invisible frame this extension hosts by the extension id
 * compiled into it (`__ARENA_ASK_EXTENSION_ID__`). A fixed manifest `key` makes that id the same for
 * every unpacked install: `oaancmehenbnfoofmlhodjkmbgejgaoe` for this public key (no private key is
 * needed or kept; Chrome derives the id from the public key).
 *
 * Chrome Web Store build: the store assigns its own id and doesn't take a `key` in the upload, so
 * `pnpm zip:store` (scripts/zip-store.mjs) builds it with `ARENA_ASK_STORE_BUILD=1
 * ARENA_ASK_EXTENSION_ID=<the store item's id>`: the key is left out, the id constant is the
 * store's, and the build goes to `.output/store/` (so it never replaces the unpacked dev build in
 * `.output/chrome-mv3`). Another fixed key: `ARENA_ASK_MANIFEST_KEY=<base64 SPKI>` (the id is
 * derived from it). See STORE_LISTING.md "Chrome Web Store: the extension id".
 *
 * Firefox builds never carry a Chrome id (the constant is empty there: Firefox has no offscreen
 * frame for it to recognise), so they are the same whatever the environment, and AMO's reviewers
 * can reproduce them from the sources zip with `pnpm zip:firefox`.
 */
const MANIFEST_KEY =
  process.env.ARENA_ASK_MANIFEST_KEY ||
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAno0A/oqH65JdD7j8b0piu99Ely+qjJlep/tGifajRC9fUdONn6YJcdPLUop1YYNVXk/7deJvhdb2/3DSvYVrKTE4HgJzEV50pGj7fnLvj+aBdCPgqeWGh9hH+orC5m7qBSKoE8IXndJ3dyMaQwJC4frAHBsUelz2nKq75tnkix2w81TJEbr/yjxx6FgPTmBQ5C5ER10JR+TR9ABumfyC+u/LGXYa25MiEJKQBAuqfTSWZcjKTICOeXMCYZZJyz4R4ss37YNmFs4ySAuobga8/Qneyvvgo8qmILw4Yl1OLRJ8j7zGUYU4K/pIP5KJtWuXiUV2JQOlDaMu3zPsWeTIowIDAQAB';
const STORE_BUILD = process.env.ARENA_ASK_STORE_BUILD === '1';

/** Chrome's id for a public key: sha256 of the DER key, first 32 hex digits mapped 0-f → a-p. */
function idFromKey(b64: string): string {
  const hex = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  return [...hex.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
const KEY_ID = idFromKey(MANIFEST_KEY);
// The store's id only in a store build (which carries no key). Any other build keeps the manifest
// key, so Chrome gives it the key's id: a leftover ARENA_ASK_EXTENSION_ID in the shell must not
// compile in an id the build doesn't have, so it's ignored there (with a warning).
const EXTENSION_ID = STORE_BUILD ? (process.env.ARENA_ASK_EXTENSION_ID ?? '').trim() : KEY_ID;
if (STORE_BUILD && !EXTENSION_ID) throw new Error('ARENA_ASK_STORE_BUILD=1 needs ARENA_ASK_EXTENSION_ID (the store id)');
if (!/^[a-p]{32}$/.test(EXTENSION_ID)) throw new Error(`ARENA_ASK_EXTENSION_ID is not a Chrome extension id: ${EXTENSION_ID}`);
if (!STORE_BUILD && process.env.ARENA_ASK_EXTENSION_ID && process.env.ARENA_ASK_EXTENSION_ID.trim() !== KEY_ID) {
  console.warn(`[arena-ask] ignoring ARENA_ASK_EXTENSION_ID: not a store build (ARENA_ASK_STORE_BUILD=1 isn't set); this build's id is ${KEY_ID}, from its manifest key`);
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  // MV3 on every browser (WXT defaults Firefox to MV2). `world: 'MAIN'` content scripts need MV3.
  manifestVersion: 3,
  // Store builds (Chrome, no manifest key) go to their own folder: see scripts/zip-store.mjs.
  ...(STORE_BUILD ? { outDir: '.output/store' } : {}),
  vite: ({ browser }) => ({
    define: { __ARENA_ASK_EXTENSION_ID__: JSON.stringify(browser === 'firefox' ? '' : EXTENSION_ID) },
  }),
  zip: {
    // AMO's sources zip: code, config, lockfile and docs; not the listing screenshots.
    excludeSources: ['store-assets/**'],
  },
  manifest: ({ browser }) => ({
    // The listing title too (Chrome Web Store ≤ 75 characters, AMO ≤ 50): unofficial, up front.
    name: 'ARENA Ask (unofficial)',
    // ≤ 132 characters (Chrome Web Store).
    description:
      'Unofficial: use your own Claude or ChatGPT subscription in the "Ask a Question" box on learn.arena.education.',
    // Chrome: an invisible offscreen document frames claude.ai / chatgpt.com (the preferred
    // transport); session declarativeNetRequest rules let those frames load and keep chatgpt.com's
    // sign-out away from ARENA Ask's own frame and tab. Firefox has no offscreen documents and uses
    // pinned tabs instead; it still uses a session rule for the ChatGPT tab's sign-out block.
    permissions: browser === 'firefox' ? ['storage', 'declarativeNetRequest'] : ['storage', 'offscreen', 'declarativeNetRequest'],
    host_permissions: ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://learn.arena.education/*'],
    ...(browser === 'firefox'
      ? {
          // Stable add-on id; MV3 `world: "MAIN"` content scripts need Firefox 128+. Firefox's data
          // consent (Mozilla counts anything handled outside the add-on or the browser, whoever
          // receives it): the course material and ARENA chat (website content) and your questions
          // and the answers (personal communications) go to the service you picked; nothing goes to
          // the developer. See STORE_LISTING.md "Data disclosures".
          browser_specific_settings: {
            gecko: {
              id: 'arena-ask@fdosmith.dev',
              strict_min_version: '128.0',
              data_collection_permissions: { required: ['websiteContent', 'personalCommunications'] },
            },
          },
        }
      : { minimum_chrome_version: '116', ...(STORE_BUILD ? {} : { key: MANIFEST_KEY }) }),
  }),
});
