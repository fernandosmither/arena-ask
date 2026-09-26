/**
 * This build's Chrome extension id (wxt.config.ts: derived from the manifest `key`, or the store
 * id for a store build). Used where extension APIs don't exist: chatgpt.com's MAIN world recognises
 * the invisible frame this extension hosts by it. Empty outside a WXT build (tests).
 */
declare const __ARENA_ASK_EXTENSION_ID__: string | undefined;

export const BUILD_EXTENSION_ID: string =
  typeof __ARENA_ASK_EXTENSION_ID__ === 'string' && /^[a-p]{32}$/.test(__ARENA_ASK_EXTENSION_ID__) ? __ARENA_ASK_EXTENSION_ID__ : '';
