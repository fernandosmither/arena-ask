// `pnpm zip:store`: the three files the stores take, checked, in .output/store/:
//
//   arena-ask-<version>-chrome.zip    Chrome Web Store: no manifest `key`, the store's id compiled in
//   arena-ask-<version>-firefox.zip   Firefox Add-ons (AMO)
//   arena-ask-<version>-sources.zip   AMO "source code" upload (reviewers rebuild with `pnpm zip:firefox`)
//
// Needs the Chrome Web Store item's id: ARENA_ASK_EXTENSION_ID=<32 letters a-p> pnpm zip:store.
// chatgpt.com's MAIN-world script recognises ARENA Ask's hidden frame by that id (wxt.config.ts), and
// the store only tells you the id once the item exists. So, the first time:
//
//   pnpm zip:store --draft   → .output/store/arena-ask-<version>-chrome-draft.zip (placeholder id);
//                              upload it ONLY to create the item (never submit it), copy the item's id,
//   ARENA_ASK_EXTENSION_ID=<that id> pnpm zip:store   → upload this chrome.zip instead, then submit.
//
// The Firefox zips are built without any of the ARENA_ASK_* variables, exactly like `pnpm zip:firefox`
// from a clean checkout (Firefox builds never carry a Chrome id). Zero dependencies (Node built-ins).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outBase = path.join(root, '.output');
const storeDir = path.join(outBase, 'store');
const draft = process.argv.includes('--draft');
const PLACEHOLDER_ID = 'a'.repeat(32);
/** The id of unpacked builds (derived from the manifest key in wxt.config.ts). */
const UNPACKED_ID = 'oaancmehenbnfoofmlhodjkmbgejgaoe';
const ID_RE = /^[a-p]{32}$/;

const die = (msg) => {
  console.error(`\nzip:store: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

const { version, name } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const id = draft ? PLACEHOLDER_ID : (process.env.ARENA_ASK_EXTENSION_ID || '').trim();
if (!draft) {
  if (!id)
    die(
      'set ARENA_ASK_EXTENSION_ID to the Chrome Web Store item\'s id.\n' +
        "  No item yet? Run `pnpm zip:store --draft`, upload that zip to create the item (don't submit it),\n" +
        '  then rerun with the id the dashboard shows. See STORE_LISTING.md.',
    );
  if (!ID_RE.test(id)) die(`ARENA_ASK_EXTENSION_ID is not a Chrome extension id (32 letters a-p): ${id}`);
  if (id === PLACEHOLDER_ID) die('that is the --draft placeholder id, not the store item\'s id');
  if (id === UNPACKED_ID) die("that is the unpacked build's id (from the manifest key), not the store item's id");
}

/** Run `wxt <args>` with a clean ARENA_ASK_* environment plus `extra`. */
function wxt(args, extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ARENA_ASK_')) delete env[k];
  Object.assign(env, extra);
  const r = spawnSync('pnpm', ['exec', 'wxt', ...args], { cwd: root, stdio: 'inherit', env });
  if (r.status !== 0) die(`\`wxt ${args.join(' ')}\` failed`);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
/** Every file under `dir`, as [relative path, contents]. */
function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath ?? e.path, e.name);
    out.push([path.relative(dir, abs), fs.readFileSync(abs)]);
  }
  return out;
}
const containing = (dir, needle) => filesUnder(dir).filter(([, buf]) => buf.includes(needle)).map(([p]) => p);
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function checkCommonManifest(m, browser) {
  if (m.manifest_version !== 3) die(`${browser}: not MV3`);
  if (m.version !== version) die(`${browser}: manifest version ${m.version} != package.json ${version}`);
  if (m.key !== undefined) die(`${browser}: the manifest has a \`key\``);
  if (!m.options_ui || m.options_ui.page !== 'options.html' || m.options_ui.open_in_tab !== true) die(`${browser}: options_ui missing or not open_in_tab`);
  const hosts = ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://learn.arena.education/*'];
  if (JSON.stringify(m.host_permissions) !== JSON.stringify(hosts)) die(`${browser}: unexpected host_permissions ${JSON.stringify(m.host_permissions)}`);
  const perms = browser === 'firefox' ? ['storage', 'declarativeNetRequest'] : ['storage', 'offscreen', 'declarativeNetRequest'];
  if (JSON.stringify(m.permissions) !== JSON.stringify(perms)) die(`${browser}: unexpected permissions ${JSON.stringify(m.permissions)}`);
  if (m.description.length > 132) die(`${browser}: description over 132 characters`);
  if (m.name !== 'ARENA Ask (unofficial)' || m.name.length > 50) die(`${browser}: manifest name must be "ARENA Ask (unofficial)" (AMO ≤ 50, CWS ≤ 75 characters)`);
}

fs.mkdirSync(storeDir, { recursive: true });

// ---- Chrome Web Store
console.log(`\n▸ Chrome Web Store build (${draft ? 'DRAFT, placeholder id' : `id ${id}`})`);
wxt(['zip', '-b', 'chrome'], { ARENA_ASK_STORE_BUILD: '1', ARENA_ASK_EXTENSION_ID: id });
const chromeDir = path.join(storeDir, 'chrome-mv3');
const cm = readJson(path.join(chromeDir, 'manifest.json'));
checkCommonManifest(cm, 'chrome');
ok('manifest: name, MV3, version, permissions, hosts, options_ui; no `key`');
const withId = containing(chromeDir, id);
if (!withId.some((p) => p.includes('chatgpt-page'))) die(`the store id isn't compiled into chatgpt.com's MAIN-world script (found in: ${withId.join(', ') || 'nothing'})`);
ok(`store id compiled into ${withId.filter((p) => p.endsWith('.js')).join(', ')}`);
const withUnpacked = containing(chromeDir, UNPACKED_ID);
if (withUnpacked.length) die(`the unpacked id is still in the store build: ${withUnpacked.join(', ')}`);
ok("the unpacked build's id appears nowhere");
const chromeZipBuilt = path.join(storeDir, `${name}-${version}-chrome.zip`);
if (!fs.existsSync(chromeZipBuilt)) die(`expected ${chromeZipBuilt}`);
let chromeZip = chromeZipBuilt;
if (draft) {
  chromeZip = path.join(storeDir, `${name}-${version}-chrome-draft.zip`);
  fs.renameSync(chromeZipBuilt, chromeZip);
}

const outputs = [[draft ? 'Chrome Web Store (DRAFT: only to create the item; never submit)' : 'Chrome Web Store', chromeZip]];

// ---- Firefox Add-ons (not for a draft: AMO needs no id from us)
if (!draft) {
  console.log('\n▸ Firefox Add-ons build + sources');
  wxt(['zip', '-b', 'firefox'], {});
  const ffDir = path.join(outBase, 'firefox-mv3');
  const fm = readJson(path.join(ffDir, 'manifest.json'));
  checkCommonManifest(fm, 'firefox');
  const g = fm.browser_specific_settings?.gecko;
  if (g?.id !== 'arena-ask@fdosmith.dev') die('firefox: gecko id');
  if (g?.strict_min_version !== '128.0') die('firefox: strict_min_version must be 128.0 (MV3 world: MAIN content scripts)');
  if (JSON.stringify(g?.data_collection_permissions) !== JSON.stringify({ required: ['websiteContent', 'personalCommunications'] })) {
    die('firefox: data_collection_permissions must be { required: [websiteContent, personalCommunications] } (STORE_LISTING.md)');
  }
  if (!Array.isArray(fm.background?.scripts)) die('firefox: background.scripts');
  ok('manifest: gecko id, strict_min_version 128.0, data_collection_permissions (websiteContent, personalCommunications), background.scripts');
  for (const x of [id, UNPACKED_ID]) {
    const hits = containing(ffDir, x);
    if (hits.length) die(`firefox: a Chrome id is compiled in (${hits.join(', ')})`);
  }
  ok('no Chrome id compiled in (reproducible from the sources zip)');
  for (const kind of ['firefox', 'sources']) {
    const built = path.join(outBase, `${name}-${version}-${kind}.zip`);
    if (!fs.existsSync(built)) die(`expected ${built}`);
    const dest = path.join(storeDir, path.basename(built));
    fs.renameSync(built, dest);
    outputs.push([kind === 'firefox' ? 'Firefox Add-ons' : 'Firefox Add-ons source code', dest]);
  }
}

console.log('\n▸ Ready to upload');
for (const [what, p] of outputs) {
  console.log(`  ${what}\n    ${path.relative(root, p)}  (${(fs.statSync(p).size / 1024).toFixed(1)} kB, sha256 ${sha256(p).slice(0, 16)}…)`);
}
if (draft) console.log('\n  Next: create the item with the draft zip, copy its id, then `ARENA_ASK_EXTENSION_ID=<id> pnpm zip:store`.');
