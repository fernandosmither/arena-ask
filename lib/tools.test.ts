import { describe, expect, it } from 'vitest';
import { APPROVE_WARNING, classifyTool, handoffNote, toolTokens } from './tools';

const kind = (name: string, hints = {}) => classifyTool(name, hints).kind;

describe('classifyTool: read-style tools run', () => {
  it('claude.ai built-ins that only read, by exact identity', () => {
    for (const n of ['web_search', 'web_fetch', 'conversation_search', 'recent_chats', 'read_conversation', 'google_drive_search', 'google_drive_fetch', 'tool_search', 'list_mcp_resources', 'read_resource_link', 'fetch_sports_data', 'image_search', 'search_skills', 'search_plugins']) {
      expect(kind(n), n).toBe('read');
    }
    expect(classifyTool('conversation_search').label).toBe('Searching past chats…');
    expect(classifyTool('recent_chats').label).toBe('Looking through recent chats…');
    expect(classifyTool('web_search').label).toBe('Searching the web…');
    // claude.ai labels its own tools too (live): still built-ins
    expect(classifyTool('conversation_search', { connector: 'Search Past Conversations' })).toMatchObject({ kind: 'read', label: 'Searching past chats…' });
    expect(classifyTool('tool_search', { connector: 'Tool Search' })).toMatchObject({ kind: 'read', label: 'Looking for the right tool…' });
    expect(classifyTool('recent_chats', { connector: 'Search Past Conversations' }).kind).toBe('read');
    // whitespace-only labels carry nothing
    expect(kind('web_search', { connector: '   ' })).toBe('read');
  });

  it('a built-in name under any other identity is a connector tool: handed off', () => {
    expect(kind('recent_chats', { connector: 'Evil Connector' })).toBe('action');
    expect(kind('web_search', { connector: 'Some Connector' })).toBe('action');
    expect(kind('web_fetch', { connector: 'Evil' })).toBe('action');
    expect(kind('conversation_search', { marked: true })).toBe('action');
    expect(kind('Server:conversation_search')).toBe('action');
  });

  it('connector reads run only as exact (label, name) pairs on the allowlist', () => {
    expect(classifyTool('search_threads', { connector: 'Gmail', marked: true })).toMatchObject({ kind: 'read', label: 'Using Gmail…', connector: 'Gmail' });
    expect(classifyTool('list_events', { connector: 'Google Calendar' })).toMatchObject({ kind: 'read', connector: 'Google Calendar' });
    expect(classifyTool('read_file_content', { connector: 'Google Drive', marked: true }).kind).toBe('read');
    // a uuid namespace (claude.ai keys connector tools by server uuid) is fine
    expect(kind('0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e:get_thread', { connector: 'Gmail' })).toBe('read');
    // not on the list, another label, no label, or a named namespace: handed off
    for (const [n, h] of [
      ['send_message', { connector: 'Gmail' }],
      ['search_threads', { connector: 'Gmail2' }],
      ['search_threads', { connector: 'Gmаil' }], // Cyrillic а
      ['search_threads', { marked: true }],
      ['Gmail:search_threads', {}],
      ['mcp__gmail__get_thread', {}],
      ['Fetch_Search:fetch_url', {}],
      ['Evil:get_thread', { connector: 'Gmail' }],
    ] as [string, object][]) {
      expect(kind(n, h), `${n} ${JSON.stringify(h)}`).toBe('action');
    }
  });

  it('unknown, unlabelled claude.ai tools whose name clearly only reads', () => {
    for (const n of ['search_threads', 'get_thread', 'find_free_time', 'search_files', 'read_file_content', 'get_file_metadata', 'list_recent_files', 'download_file_content', 'browse_menu', 'show_images', 'whoami', 'ping', 'brave_search', 'goal_list', 'todo_list', 'view_memory', 'browse']) {
      expect(kind(n), n).toBe('read');
    }
  });
});

describe('classifyTool: actions are handed off (conservative)', () => {
  it('anything that sends, creates, updates, deletes, writes, posts, drafts, books, moves, shares or invites', () => {
    const actions = [
      'send_message', 'create_draft', 'update_draft', 'delete_draft', 'reply', 'forward', 'trash_message', 'untrash_thread',
      'label_message', 'mark_thread_spam', 'apply_sensitive_message_label', 'create_label',
      'create_event', 'update_event', 'delete_event', 'respond_to_event', 'gcal_create_event', 'create_gcal_event',
      'copy_file', 'share_file', 'trash_file', 'update_file', 'upload_file',
      'post_message', 'edit_post', 'save_draft', 'publish_draft', 'checkin',
      'create_booking', 'cancel_booking', 'book_room', 'move_file', 'invite_people', 'rsvp', 'add_item', 'join_group_order',
      'timeoff_request_create', 'eor_contract_sign', 'payout_withdrawal_request', 'buy_domain',
      'browser_open', 'browser_act', 'write_file', 'sendEmail', 'CreateIssue',
      // nouns that are also action verbs now count (connectors are allowlisted by exact pair instead)
      'list_drafts', 'get_post_fields', 'getRecentPosts', 'get_group_order',
    ];
    for (const n of actions) expect(kind(n), n).toBe('action');
  });

  it("claude.ai's code-execution sandbox and its file tools are handed off (code can reach the network)", () => {
    for (const n of ['repl', 'bash_tool', 'code_execution', 'create_file', 'str_replace', 'str_replace_based_edit_tool', 'view', 'present_files', 'artifacts']) {
      expect(kind(n), n).toBe('action');
      expect(kind(n, { connector: 'File Creation' }), `${n} labelled`).toBe('action');
    }
    expect(classifyTool('bash_tool', { connector: 'File Creation' })).toMatchObject({ kind: 'action', action: "run code in claude.ai's sandbox", connector: null });
    expect(kind('create_file', { connector: 'Google Drive', marked: true })).toBe('action');
    expect(kind('Google Drive:create_file')).toBe('action');
  });

  it('memory writes and ending the conversation', () => {
    expect(classifyTool('memory_user_edits')).toMatchObject({ kind: 'action', action: 'change what it remembers about you', connector: 'memory' });
    expect(kind('end_conversation')).toBe('action');
    expect(classifyTool('memory_user_edits', { connector: 'Memory' })).toMatchObject({ kind: 'action', action: 'change what it remembers about you' });
    expect(kind('memory_user_edits', { marked: true })).toBe('action');
    expect(kind('remember_fact')).toBe('action');
    expect(kind('memory')).toBe('action'); // unknown
  });

  it('a read verb combined with an action is an action; unknown names are actions', () => {
    for (const n of ['search_and_send', 'get_or_create_user', 'list_then_delete', 'fetch_and_update']) expect(kind(n), n).toBe('action');
    for (const n of ['suggest_connectors', 'whos_coming', 'linkedin_person', 'frobnicate', '', 'tool', 'constructor', '__proto__', 'toString']) {
      expect(kind(n), JSON.stringify(n)).toBe('action');
    }
  });

  it('describes the action for the handoff note', () => {
    expect(classifyTool('gcal_create_event')).toMatchObject({ action: 'create event', connector: 'Google Calendar', name: 'gcal_create_event' });
    expect(classifyTool('create_event', { connector: 'Google Calendar', marked: true })).toMatchObject({ action: 'create event', connector: 'Google Calendar' });
    expect(classifyTool('send_message', { connector: 'Gmail' })).toMatchObject({ action: 'send message', connector: 'Gmail' });
    expect(classifyTool('frobnicate')).toMatchObject({ action: 'use frobnicate', connector: null });
  });

  it('names and connector names are sanitized (no markup, no odd characters, no ids)', () => {
    const t = classifyTool('evil`](javascript:x)<b>_send', { connector: 'Gm**ail](x)<i>' });
    expect(t.kind).toBe('action');
    expect(t.name).not.toMatch(/[`()<>\[\]]/);
    expect(t.connector).not.toMatch(/[*()<>\[\]]/);
    expect(classifyTool('x'.repeat(500)).name.length).toBeLessThanOrEqual(60);
    // a server uuid is not a name to show (status line, note, log)
    const u = classifyTool('0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e:send_message');
    expect(u).toMatchObject({ kind: 'action', connector: null, name: 'send_message' });
    expect(JSON.stringify(classifyTool('get_0a0a0a0a1b1b4c2c8d3d4e4e4e4e4e4e_status'))).not.toMatch(/0a0a0a0a/);
  });
});

// Ported from the round-6 review's PoCs (classify.mts, classify2.mts): every one of these was
// classified as a read (or as the sandbox) before; each must be handed off now.
describe('review PoCs: classifier bypasses are handed off', () => {
  const MUST_BE_ACTION: [string, object?][] = [
    // read-first names that write
    ['search_replace'], ['find_replace'], ['find_and_replace'], ['status_update'], ['read_write_file'], ['get_delete_all'],
    ['list_send_email'], ['document_query_overwrite'], ['objects_search_destroy'], ['purge_search_index'], ['rebuild_search_index'],
    ['launch_extended_search_task'], ['emit_status'], ['trigger_search'], ['invoke_lookup'], ['spawn_browser'], ['browser_navigate'],
    ['browse_and_click'], ['fetch_page_actions'], ['preview_and_send'], ['list_emails_send'], ['get_or_create'], ['listen'],
    // generic query / URL / code runners
    ['query'], ['exec_query'], ['exec'], ['fetch_url'], ['http_request'], ['query', { marked: true }], ['fetch_url', { marked: true }],
    // namespaces keep their segments
    ['delete__list'], ['send_email__get'], ['Gmail:list_then_send'], ['write/search_threads'], ['mcp__server__delete__get'],
    ['mcp__bash_tool'], ['mcp__bash_tool', { marked: true }], ['server.delete'],
    // case, camelCase, digits
    ['searchAndDelete'], ['getSend'], ['GETsend'], ['getANDcreate'], ['sendEmailList'], ['search_update2'], ['objects_delete2_search'],
    // unicode: homoglyphs, zero-width, fullwidth
    ['search_updаte'], ['objects_dеlete_search'], ['send​_list'], ['list​send'], ['ｓｅｎｄ_email'], ['ѕearch_threads'],
    // built-in names with spoofed or unrecognisable labels, and the sandbox itself
    ['create_file', { connector: 'File Creation' }], ['create_file', { connector: 'File  Creation' }], ['create_file', {}], ['bash_tool', {}],
    ['view', { connector: 'Tool Search' }], ['create_file', { connector: 'Google Drive' }], ['create_file', { connector: '☠' }],
    ['create_file', { connector: 'File Cre​ation' }], ['conversation_search', { connector: '☠' }], ['web_search', { connector: '​' }],
    ['tool_search', { connector: 'Tool Search​' }],
    // memory and unknowns
    ['memory_user_edits', {}], ['memory', {}], ['web_fetch', { connector: 'Evil' }], ['post_message'], ['server_tool_use'], ['tool_use'],
  ];
  for (const [n, h] of MUST_BE_ACTION) {
    it(`${JSON.stringify(n)} ${JSON.stringify(h ?? {})} → action`, () => {
      expect(classifyTool(n, h ?? {}).kind).toBe('action');
    });
  }

  it('a rejected unicode name is still described legibly (folded), never trusted', () => {
    const t = classifyTool('ѕend_email');
    expect(t).toMatchObject({ kind: 'action', connector: null });
    expect(t.name).toBe('send_email');
    expect(t.action).toContain('unusual name');
  });
});

describe('toolTokens', () => {
  it('splits snake, kebab, dotted, namespaced, camelCase and letter/digit boundaries', () => {
    expect(toolTokens('gcal_create-event.v2')).toEqual(['gcal', 'create', 'event', 'v', '2']);
    expect(toolTokens('sendHTMLEmail')).toEqual(['send', 'html', 'email']);
    expect(toolTokens('objects_delete2_search')).toEqual(['objects', 'delete', '2', 'search']);
  });
});

describe('handoffNote', () => {
  const url = 'https://claude.ai/chat/11111111-2222-4333-8444-555555555555';
  it('an action: what Claude wants, with which connector, a link to approve it on claude.ai, and the warning', () => {
    const note = handoffNote('action', classifyTool('create_event', { connector: 'Google Calendar' }), url, 45, 'before-run');
    expect(note).toContain('Claude wants to create event with Google Calendar');
    expect(note).toContain(`[open this chat in claude.ai to approve ↗](${url})`);
    expect(note).toContain('stopped it before it ran (claude.ai shows no result from it)');
    expect(note).toContain(APPROVE_WARNING);
  });
  it('only claims "before it ran" when that was checked', () => {
    const t = classifyTool('create_event', { connector: 'Google Calendar' });
    for (const stop of ['requested', 'failed'] as const) {
      const note = handoffNote('action', t, url, 45, stop);
      expect(note, stop).not.toMatch(/before it ran/);
      expect(note, stop).toMatch(/may have started/);
      expect(note, stop).toContain('check the chat in claude.ai');
      expect(note, stop).toContain(APPROVE_WARNING);
    }
    expect(handoffNote('action', t, url, 45, 'requested')).toContain('Stop requested — the action may have started; check the chat in claude.ai.');
  });
  it('a stall / a tool left waiting / an unrecognised step', () => {
    expect(handoffNote('stall', classifyTool('search_threads', { connector: 'Gmail' }), url, 45, 'requested')).toMatch(/`search_threads` call with Gmail made no progress for 45 s[\s\S]*approve ↗\]\(/);
    expect(handoffNote('waiting', classifyTool('list_mcp_resources'), url, 45, 'requested')).toMatch(/`list_mcp_resources` call is waiting for claude\.ai/);
    expect(handoffNote('waiting', classifyTool('list_mcp_resources'), url, 45, 'failed')).toMatch(/may still be running/);
    const u = handoffNote('unknown', { kind: 'action', name: 'mcp_call', label: '', action: '', connector: null }, url, 45, 'requested');
    expect(u).toMatch(/doesn't recognise\*\* \(`mcp_call`\)[\s\S]*may have started/);
    for (const r of ['stall', 'waiting', 'unknown'] as const) expect(handoffNote(r, classifyTool('x_y'), url, 1, 'requested')).toContain(APPROVE_WARNING);
  });
});
