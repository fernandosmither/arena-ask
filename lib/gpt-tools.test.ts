import { describe, expect, it } from 'vitest';
import { GPT_APPROVE_WARNING, callToolPath, classifyRecipient, gptHandoffNote, learnLinks, scanCallBody } from './gpt-tools';

/** What this turn's api_tool.list_resources listed (the link ids the tests use, each as its app). */
const LISTED = JSON.stringify({
  resources: [
    { uri: '/Google Drive/link_abc/search' },
    { uri: '/Gmail/link_68d5_x-1/get_thread' },
    { uri: '/Outlook Email/link_out/fetch' },
    { uri: '/Outlook Calendar/link_oc/list_events' },
    { uri: '/Google Calendar/link_cal/list_events' },
    { uri: '/Gmail/link_gm/search' },
    { uri: '/Slack/link_slack/search' },
  ],
});
const LINKS = new Map<string, string>();
learnLinks(LISTED, LINKS);

const call = (path: string, links: ReadonlyMap<string, string> = LINKS) => classifyRecipient('api_tool.call_tool', JSON.stringify({ path, args: {} }), true, links)!;

describe('classifyRecipient: reads (exact recipients only)', () => {
  it.each([
    ['web', 'Searching the web…'],
    ['web.run', 'Searching the web…'],
    ['api_tool.list_resources', 'Looking through your connected apps…'],
    ['personal_context', 'Checking what ChatGPT knows about you…'],
  ])('%s reads', (r, label) => {
    expect(classifyRecipient(r)).toMatchObject({ kind: 'read', label });
  });

  it('api_tool.call_tool: exact Drive / Gmail / Calendar / Outlook read actions only', () => {
    for (const p of [
      '/Google Drive/link_abc/search',
      '/Google Drive/link_abc/fetch',
      '/Gmail/link_68d5_x-1/get_thread',
      '/Gmail/link_gm/search',
      '/Google Calendar/link_cal/list_events',
      '/Google Calendar/link_cal/read_event',
      '/Outlook Email/link_out/fetch',
      '/Outlook Calendar/link_oc/list_events',
    ]) {
      expect(call(p).kind, p).toBe('read');
    }
    expect(call('/Gmail/link_gm/search')).toMatchObject({ label: 'Using Gmail…', connector: 'Gmail' });
  });
});

describe('classifyRecipient: actions (fail closed)', () => {
  it.each(['bio', 'automations', 'user_settings', 'safety_settings', 'python', 'python_user_visible', 'container.exec', 'local.continue_in_work', 'image_gen.text2im', 'canmore.create_textdoc', 'file_search.msearch'])(
    '%s',
    (r) => {
      expect(classifyRecipient(r)!.kind).toBe('action');
    },
  );

  it('unknown, obfuscated, case-changed, homoglyph, fullwidth and near-miss recipients', () => {
    for (const r of ['q7dr546', 'WEB', 'web.search', 'web.run.exec', 'wеb', 'web​', 'personal_context.write', 'api_tool.install', '', 'ｗｅｂ', 'api＿tool.list_resources']) {
      expect(classifyRecipient(r)!.kind, JSON.stringify(r)).toBe('action');
    }
  });

  it('app actions that write, other apps, odd paths', () => {
    for (const p of [
      '/Gmail/link_abc/send_email',
      '/Gmail/link_abc/create_draft',
      '/Google Calendar/link_abc/create_event',
      '/Google Drive/link_abc/delete_file',
      '/Gmail/link_abc/list_and_delete',
      '/Gmail/link_abc/get_or_create',
      '/Gmail/link_abc/read_and_archive',
      '/Slack/link_abc/search',
      '/Gmail/abc/search',
      '/Gmail/link_abc/search/extra',
      'Gmail/link_abc/search',
      '/Gmail/link_abc/SEARCH',
    ]) {
      expect(call(p).kind, p).toBe('action');
    }
    expect(call('/Gmail/link_abc/send_email')).toMatchObject({ connector: 'Gmail', action: 'send email' });
  });

  it('a read on a link this turn never listed, or listed as another app, is an action', () => {
    expect(call('/Gmail/link_gm/search').kind).toBe('read');
    expect(call('/Gmail/link_gm/search', new Map()).kind).toBe('action'); // no list_resources this turn
    expect(call('/Gmail/link_unlisted/search').kind).toBe('action');
    expect(call('/Gmail/link_abc/search').kind).toBe('action'); // link_abc is Google Drive's
    expect(call('/Gmail/link_slack/search').kind).toBe('action'); // Slack's link, named Gmail
    const twice = new Map<string, string>();
    learnLinks('/Gmail/link_x/search and /Slack/link_x/search', twice); // one id, two apps: never a read
    expect(call('/Gmail/link_x/search', twice).kind).toBe('action');
    const partial = new Map<string, string>();
    learnLinks('{"uri": "/Gmail/link_ab', partial); // still streaming: a cut-off id isn't learned
    expect(partial.size).toBe(0);
  });

  // Review PoC (arena-review7/poc/tools.test.ts), must fail: the first "path" (a nested one, or the
  // first of two) decided the verdict while the server reads the real / last one.
  it('duplicate or nested "path" keys never pass as a read (PoC)', () => {
    const dup = '{"path": "/Gmail/link_gm/search", "path": "/Gmail/link_gm/send_email", "args": {"to": "x@evil", "body": "hi"}}';
    expect(JSON.parse(dup).path).toBe('/Gmail/link_gm/send_email');
    expect(classifyRecipient('api_tool.call_tool', dup, true, LINKS)!.kind).toBe('action');
    const nested = '{"args": {"path": "/Gmail/link_gm/search"}, "path": "/Gmail/link_gm/send_email"}';
    expect(classifyRecipient('api_tool.call_tool', nested, true, LINKS)!.kind).toBe('action');
    const escapedKey = '{"path": "/Gmail/link_gm/search", "pa\\u0074h": "/Gmail/link_gm/send_email"}';
    expect(JSON.parse(escapedKey).path).toBe('/Gmail/link_gm/send_email');
    expect(classifyRecipient('api_tool.call_tool', escapedKey, true, LINKS)!.kind).toBe('action');
    expect(classifyRecipient('api_tool.call_tool', '{"path": "/Gmail/link_gm/search", "args": {"q": 1, "q": 2}}', true, LINKS)!.kind).toBe('action');
    expect(classifyRecipient('api_tool.call_tool', '{"path": ["/Gmail/link_gm/search"]}', true, LINKS)!.kind).toBe('action');
    expect(classifyRecipient('api_tool.call_tool', '{"path": "/Gmail/link_gm/search"} {"path": "/Gmail/link_gm/send_email"}', true, LINKS)!.kind).toBe('action');
    expect(classifyRecipient('api_tool.call_tool', '[{"path": "/Gmail/link_gm/search"}]', true, LINKS)!.kind).toBe('action');
  });

  it('a streaming body is never a read before it is complete; a prefix that names a write is an action at once', () => {
    const body = '{"path": "/Gmail/link_gm/search", "args": {"query": "arena"}}';
    for (let n = 1; n < body.length; n++) expect(classifyRecipient('api_tool.call_tool', body.slice(0, n), false, LINKS), body.slice(0, n)).toBeNull();
    expect(classifyRecipient('api_tool.call_tool', body, false, LINKS)!.kind).toBe('read');
    expect(classifyRecipient('api_tool.call_tool', '{"path": "/Gmail/link_gm/send_email", "args": {"bo', false, LINKS)!.kind).toBe('action');
    expect(classifyRecipient('api_tool.call_tool', '{"path": "/Gmail/link_gm/search", "path": "/Gm', false, LINKS)!.kind).toBe('action');
    expect(classifyRecipient('api_tool.call_tool', '{"path": 1, ', false, LINKS)!.kind).toBe('action');
    // the call ended with its body incomplete: an action
    expect(classifyRecipient('api_tool.call_tool', body.slice(0, -1), true, LINKS)!.kind).toBe('action');
  });

  it('api_tool.call_tool with no path yet: undecided until the call completes, then an action', () => {
    expect(classifyRecipient('api_tool.call_tool', '{"pa', false)).toBeNull();
    expect(classifyRecipient('api_tool.call_tool', '{"path": "/Gmail/lin', false)).toBeNull();
    expect(classifyRecipient('api_tool.call_tool', '{"args": {}}', true)!.kind).toBe('action');
    expect(classifyRecipient('api_tool.call_tool', 'not json', false)!.kind).toBe('action');
  });

  it('display names never carry link ids', () => {
    const i = call('/Gmail/link_0123456789abcdef/send_email');
    expect(JSON.stringify(i)).not.toMatch(/0123456789abcdef/);
  });
});

describe('callToolPath / scanCallBody', () => {
  it('only a complete body with exactly one top-level string path names a path', () => {
    expect(callToolPath('')).toBeUndefined();
    expect(callToolPath('{"path": "/Gmail/li')).toBeUndefined();
    expect(callToolPath('{"path": "/Gmail/link_1/search", "args"')).toBeUndefined();
    expect(callToolPath('{"path": "/Gmail/link_1/search", "args": {}}')).toBe('/Gmail/link_1/search');
    expect(callToolPath('{"path": "/A\\"B/link_1/search"}')).toBe('/A"B/link_1/search');
    expect(callToolPath('hello')).toBeNull();
    expect(callToolPath('{"args": {}}')).toBeNull();
    expect(callToolPath('{"path": "/a", "path": "/a"}')).toBeNull();
  });

  it('scans strictly: top-level paths only, duplicate keys at any depth, trailing data, escapes', () => {
    expect(scanCallBody('{"args": {"path": "/x"}}')).toEqual({ state: 'complete', paths: [], dup: false });
    expect(scanCallBody('{"a": [1, {"b": 2, "b": 3}]}').dup).toBe(true);
    expect(scanCallBody('{"path": "/x"} x').state).toBe('invalid');
    expect(scanCallBody('{"path": "/x\\u0041"}').paths).toEqual(['/xA']);
    expect(scanCallBody('{"path": "/x", "n": -1.5e3, "t": true, "f": false, "z": null, "s": "\\n"}').state).toBe('complete');
    expect(scanCallBody('{"n": 12').state).toBe('partial');
    expect(scanCallBody('{"n": tru').state).toBe('partial');
    expect(scanCallBody('{"n": tx').state).toBe('invalid');
    expect(scanCallBody('{"s": "a\\u00').state).toBe('partial');
    expect(scanCallBody('{"s": "a\u0001"}').state).toBe('invalid');
  });
});

describe('gptHandoffNote', () => {
  const bio = classifyRecipient('bio')!;
  const url = 'https://chatgpt.com/c/68d5f0e1-1234-4000-8000-000000000001';
  it('says only what was checked, links the chat, and always warns', () => {
    const before = gptHandoffNote('action', bio, url, 45, 'before-run');
    expect(before).toContain('**ChatGPT wants to save something to your ChatGPT memory** (`bio`)');
    expect(before).toContain(`[open this chat in ChatGPT to approve ↗](${url})`);
    expect(before).toContain('stopped it before it ran (ChatGPT shows no result from it)');
    expect(gptHandoffNote('action', bio, url, 45, 'requested')).toContain('the action may have run');
    expect(gptHandoffNote('action', bio, url, 45, 'failed')).toContain("couldn't be pressed");
    expect(gptHandoffNote('stall', classifyRecipient('web.run')!, url, 45, 'requested')).toContain('made no progress for 45 s');
    expect(gptHandoffNote('waiting', classifyRecipient('web')!, url, 45, 'ended')).toContain('The answer ended before that step finished');
    expect(gptHandoffNote('unknown', classifyRecipient('q7dr546')!, url, 45, 'requested')).toContain("doesn't recognise");
    for (const r of ['action', 'stall', 'waiting', 'unknown'] as const) {
      for (const st of ['before-run', 'requested', 'failed', 'ended'] as const) expect(gptHandoffNote(r, bio, url, 45, st)).toContain(GPT_APPROVE_WARNING);
    }
    expect(GPT_APPROVE_WARNING).toBe('Only approve this if you asked for it — text on the ARENA page can influence ChatGPT.');
  });
});
