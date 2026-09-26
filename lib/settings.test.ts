import { describe, expect, it, vi } from 'vitest';
import {
  MSG_SETTINGS,
  OPTIONS_PAGE_PATH,
  isOptionsPageSender,
  routeSettingsMessage,
  validateSettingsRequest,
  type SettingsApi,
  type SettingsResponse,
} from './settings';
import { StateStore, memoryBackend } from './state-store';

const EXT = 'oaancmehenbnfoofmlhodjkmbgejgaoe';
const OTHER = 'abcdefghijklmnopabcdefghijklmnop';
const OPT = `chrome-extension://${EXT}${OPTIONS_PAGE_PATH}`;

/** An API over a real StateStore, like the background's. */
function apiOver(db = new StateStore(memoryBackend())): SettingsApi & { db: StateStore } {
  return {
    db,
    mode: () => db.loadMode(),
    setMode: (m) => db.saveMode(m),
    gptDoNotRemember: () => db.loadGptDoNotRemember(),
    setGptDoNotRemember: (on) => db.saveGptDoNotRemember(on),
    pinned: async (p) => (p === 'chatgpt' ? (await db.loadPinnedGpt()) !== null : (await db.loadPinnedOrg()) !== null),
    forgetAccount: (p) => (p === 'chatgpt' ? db.forgetPinnedGpt() : db.forgetPinnedOrg()),
  };
}

/** Run the route and wait for its (possibly async) answer; `null` = no answer at all. */
async function route(msg: unknown, sender: Parameters<typeof routeSettingsMessage>[1], api: SettingsApi, log = vi.fn()) {
  let answer: SettingsResponse | null = null;
  const sendResponse = vi.fn((r: SettingsResponse) => void (answer = r));
  const ret = routeSettingsMessage(msg, sender, sendResponse, { extId: EXT, optionsUrl: OPT, api, log });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { ret, answer: answer as SettingsResponse | null, calls: sendResponse.mock.calls.length, log };
}

const optionsSender = { id: EXT, url: OPT, origin: `chrome-extension://${EXT}` };
const contentScriptSender = {
  id: EXT,
  url: 'https://learn.arena.education/chapter0_fundamentals/01_ray_tracing/',
  origin: 'https://learn.arena.education',
  tab: { id: 7 },
  frameId: 0,
};

describe('isOptionsPageSender', () => {
  it('accepts the options page (with or without origin, query or fragment)', () => {
    expect(isOptionsPageSender(optionsSender, EXT, OPT)).toBe(true);
    expect(isOptionsPageSender({ id: EXT, url: OPT }, EXT, OPT)).toBe(true);
    expect(isOptionsPageSender({ id: EXT, url: `${OPT}?tab=1` }, EXT, OPT)).toBe(true);
    expect(isOptionsPageSender({ id: EXT, url: `${OPT}#risks` }, EXT, OPT)).toBe(true);
  });

  it('accepts Firefox (moz-extension, add-on id)', () => {
    const ff = 'moz-extension://0f0e0d0c-1b1a-4c2c-8d3d-4e4e4e4e4e4e/options.html';
    expect(isOptionsPageSender({ id: 'arena-ask@fdosmith.dev', url: ff }, 'arena-ask@fdosmith.dev', ff)).toBe(true);
  });

  it('refuses content scripts: same extension id, but a web page URL', () => {
    expect(isOptionsPageSender(contentScriptSender, EXT, OPT)).toBe(false);
    for (const url of [
      'https://claude.ai/new',
      'https://chatgpt.com/',
      `https://learn.arena.education${OPTIONS_PAGE_PATH}`,
      `https://${EXT}${OPTIONS_PAGE_PATH}`,
      `http://${EXT}${OPTIONS_PAGE_PATH}`,
    ]) {
      expect(isOptionsPageSender({ id: EXT, url }, EXT, OPT), url).toBe(false);
      expect(isOptionsPageSender({ id: EXT, url, origin: `chrome-extension://${EXT}` }, EXT, OPT), url).toBe(false);
    }
  });

  it('refuses other extension pages, other extensions and look-alike URLs', () => {
    const bad: unknown[] = [
      { id: EXT, url: `chrome-extension://${EXT}/offscreen.html` },
      { id: EXT, url: `chrome-extension://${EXT}/options.html.evil` },
      { id: EXT, url: `chrome-extension://${EXT}/options.htmlx` },
      { id: EXT, url: `chrome-extension://${EXT}/sub/options.html` },
      { id: EXT, url: `chrome-extension://${EXT}//options.html` },
      { id: EXT, url: `chrome-extension://${OTHER}/options.html` },
      { id: EXT, url: `chrome-extension://${EXT}@${OTHER}/options.html` },
      { id: EXT, url: `chrome-extension://${EXT}:80/options.html` },
      { id: EXT, url: `moz-extension://${EXT}/options.html` },
      { id: EXT, url: OPT, origin: 'https://learn.arena.education' },
      { id: EXT, url: OPT, origin: `chrome-extension://${OTHER}` },
      { id: EXT, url: OPT, origin: 'null' },
      { id: OTHER, url: OPT },
      { url: OPT },
      { id: EXT },
      { id: EXT, url: 42 },
      { id: EXT, url: 'not a url' },
      null,
      undefined,
    ];
    for (const s of bad) expect(isOptionsPageSender(s as never, EXT, OPT), JSON.stringify(s)).toBe(false);
  });

  it('refuses everything when the extension id or options URL is unknown', () => {
    expect(isOptionsPageSender({ id: '', url: OPT }, '', OPT)).toBe(false);
    expect(isOptionsPageSender(optionsSender, EXT, '')).toBe(false);
    expect(isOptionsPageSender(optionsSender, EXT, 'garbage')).toBe(false);
  });
});

describe('validateSettingsRequest', () => {
  it('accepts exactly the four operations', () => {
    expect(validateSettingsRequest({ type: MSG_SETTINGS, op: 'get' })).toEqual({ type: MSG_SETTINGS, op: 'get' });
    expect(validateSettingsRequest({ type: MSG_SETTINGS, op: 'setMode', mode: 'locked' })).toEqual({ type: MSG_SETTINGS, op: 'setMode', mode: 'locked' });
    expect(validateSettingsRequest({ type: MSG_SETTINGS, op: 'setMode', mode: 'full' })?.op).toBe('setMode');
    expect(validateSettingsRequest({ type: MSG_SETTINGS, op: 'setGptDoNotRemember', on: true })).toEqual({ type: MSG_SETTINGS, op: 'setGptDoNotRemember', on: true });
    expect(validateSettingsRequest({ type: MSG_SETTINGS, op: 'forgetAccount', provider: 'chatgpt' })).toEqual({ type: MSG_SETTINGS, op: 'forgetAccount', provider: 'chatgpt' });
    expect(validateSettingsRequest(JSON.parse(`{"type":"${MSG_SETTINGS}","op":"forgetAccount","provider":"claude"}`))?.op).toBe('forgetAccount');
  });

  it('refuses anything else', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'get',
      [MSG_SETTINGS, 'get'],
      {},
      { op: 'get' },
      { type: 'arena-ask:other', op: 'get' },
      { type: MSG_SETTINGS },
      { type: MSG_SETTINGS, op: 'set' },
      { type: MSG_SETTINGS, op: 'setModel', provider: 'chatgpt', model: 'x' },
      { type: MSG_SETTINGS, op: 'get', extra: 1 },
      { type: MSG_SETTINGS, op: 'setMode' },
      { type: MSG_SETTINGS, op: 'setMode', mode: 'FULL' },
      { type: MSG_SETTINGS, op: 'setMode', mode: null },
      { type: MSG_SETTINGS, op: 'setMode', mode: 'locked', pinnedOrg: 'x' },
      { type: MSG_SETTINGS, op: 'setGptDoNotRemember', on: 'true' },
      { type: MSG_SETTINGS, op: 'setGptDoNotRemember', on: 1 },
      { type: MSG_SETTINGS, op: 'forgetAccount' },
      { type: MSG_SETTINGS, op: 'forgetAccount', provider: 'gemini' },
      { type: MSG_SETTINGS, op: 'forgetAccount', provider: ['claude'] },
      JSON.parse(`{"type":"${MSG_SETTINGS}","op":"get","__proto__":{"op":"setMode"}}`),
      Object.assign(Object.create({ inherited: true }), { type: MSG_SETTINGS, op: 'get' }),
      new (class {
        type = MSG_SETTINGS;
        op = 'get';
      })(),
    ];
    for (const b of bad) expect(validateSettingsRequest(b), JSON.stringify(b)).toBeNull();
  });

  it('inherited keys do not count', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.type = MSG_SETTINGS;
    o.op = 'setMode';
    expect(validateSettingsRequest(o)).toBeNull(); // no own `mode`
    o.mode = 'locked';
    expect(validateSettingsRequest(o)?.op).toBe('setMode');
  });
});

describe('routeSettingsMessage', () => {
  it('leaves other messages alone', async () => {
    const api = apiOver();
    const r = await route({ type: 'reset', chapterKey: 'x' }, optionsSender, api);
    expect(r.ret).toBeUndefined();
    expect(r.calls).toBe(0);
    expect(r.log).not.toHaveBeenCalled();
  });

  it('drops settings messages from a content script, unanswered and without effect', async () => {
    const api = apiOver();
    await api.db.pinOrgOnce('11111111-2222-4333-8444-555555555555');
    for (const msg of [
      { type: MSG_SETTINGS, op: 'setMode', mode: 'locked' },
      { type: MSG_SETTINGS, op: 'setGptDoNotRemember', on: true },
      { type: MSG_SETTINGS, op: 'forgetAccount', provider: 'claude' },
      { type: MSG_SETTINGS, op: 'get' },
    ]) {
      const r = await route(msg, contentScriptSender, api);
      expect(r.ret).toBeUndefined();
      expect(r.calls).toBe(0);
      expect(r.log).toHaveBeenCalledWith('settings message refused: not from the options page');
    }
    expect(await api.db.loadMode()).toBe('full');
    expect(await api.db.hasMode()).toBe(false);
    expect(await api.db.loadGptDoNotRemember()).toBe(false);
    expect(await api.db.loadPinnedOrg()).not.toBeNull();
  });

  it('drops them from the offscreen document and from other extensions too', async () => {
    const api = apiOver();
    for (const s of [{ id: EXT, url: `chrome-extension://${EXT}/offscreen.html` }, { id: OTHER, url: `chrome-extension://${OTHER}/options.html` }, undefined]) {
      const r = await route({ type: MSG_SETTINGS, op: 'setMode', mode: 'locked' }, s, api);
      expect(r.ret).toBeUndefined();
      expect(r.calls).toBe(0);
    }
    expect(await api.db.hasMode()).toBe(false);
  });

  it('answers the options page with the defaults (full, "don\'t remember" off, nothing pinned)', async () => {
    const r = await route({ type: MSG_SETTINGS, op: 'get' }, optionsSender, apiOver());
    expect(r.ret).toBe(true);
    expect(r.answer).toEqual({ ok: true, settings: { mode: 'full', gptDoNotRemember: false, pinned: { claude: false, chatgpt: false } } });
  });

  it('applies each change from the options page and answers with the new settings', async () => {
    const api = apiOver();
    await api.db.pinOrgOnce('11111111-2222-4333-8444-555555555555');
    await api.db.pinGptOnce('0123456789abcdef');

    let r = await route({ type: MSG_SETTINGS, op: 'get' }, optionsSender, api);
    expect(r.answer).toMatchObject({ ok: true, settings: { pinned: { claude: true, chatgpt: true } } });

    r = await route({ type: MSG_SETTINGS, op: 'setMode', mode: 'locked' }, optionsSender, api);
    expect(r.answer).toMatchObject({ ok: true, settings: { mode: 'locked' } });
    expect(await api.db.loadMode()).toBe('locked');
    expect(r.log).toHaveBeenCalledWith('settings changed from the options page', { op: 'setMode' });

    r = await route({ type: MSG_SETTINGS, op: 'setGptDoNotRemember', on: true }, optionsSender, api);
    expect(r.answer).toMatchObject({ ok: true, settings: { gptDoNotRemember: true } });
    expect(await api.db.loadGptDoNotRemember()).toBe(true);

    r = await route({ type: MSG_SETTINGS, op: 'forgetAccount', provider: 'chatgpt' }, optionsSender, api);
    expect(r.answer).toMatchObject({ ok: true, settings: { pinned: { claude: true, chatgpt: false } } });
    r = await route({ type: MSG_SETTINGS, op: 'forgetAccount', provider: 'claude' }, optionsSender, api);
    expect(r.answer).toMatchObject({ ok: true, settings: { pinned: { claude: false, chatgpt: false } } });

    r = await route({ type: MSG_SETTINGS, op: 'setMode', mode: 'full' }, optionsSender, api);
    r = await route({ type: MSG_SETTINGS, op: 'setGptDoNotRemember', on: false }, optionsSender, api);
    expect(r.answer).toEqual({ ok: true, settings: { mode: 'full', gptDoNotRemember: false, pinned: { claude: false, chatgpt: false } } });
  });

  it('never sends ids back, only booleans', async () => {
    const api = apiOver();
    await api.db.pinOrgOnce('11111111-2222-4333-8444-555555555555');
    await api.db.pinGptOnce('0123456789abcdef');
    const r = await route({ type: MSG_SETTINGS, op: 'get' }, optionsSender, api);
    const s = JSON.stringify(r.answer);
    expect(s).not.toContain('11111111');
    expect(s).not.toContain('0123456789abcdef');
  });

  it('answers a malformed request from the options page with an error, changing nothing', async () => {
    const api = apiOver();
    const r = await route({ type: MSG_SETTINGS, op: 'setMode', mode: 'open' }, optionsSender, api);
    expect(r.ret).toBeUndefined();
    expect(r.answer).toEqual({ ok: false, error: 'malformed settings request' });
    expect(await api.db.hasMode()).toBe(false);
  });

  it('reports a failed write', async () => {
    const api = { ...apiOver(), setMode: () => Promise.reject(new Error('idb gone')) };
    const r = await route({ type: MSG_SETTINGS, op: 'setMode', mode: 'locked' }, optionsSender, api);
    expect(r.ret).toBe(true);
    expect(r.answer).toEqual({ ok: false, error: "couldn't save the setting" });
  });
});
