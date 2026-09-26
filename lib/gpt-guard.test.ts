import { describe, expect, it } from 'vitest';
import {
  CONV_POST_RE,
  SIGNOUT_PATH_RE,
  accountTagFor,
  canonText,
  composerSafe,
  describeMismatch,
  guardConversation,
  messageHash,
  validPatch,
  type Expectation,
} from './gpt-guard';

// Inserted text vs what chatgpt.com's composer actually sent (captured live 2026-09-25 with the
// request blocked before it left): markdown escapes, autolinks, &#x20;, tabs/NBSP → spaces.
const T1 =
  '# Heading\n\nSome *md* and _under_score a_b_c **bold** `code` <b>tag</b> &amp; x<y>z \\\\n back\\\\slash\n\n```python\ndef f(x):\n\treturn x  # tab\n    y = [1,2]\n```\n\n1. item\n- dash\n> quote\n[link](http://example.com) $x^2$ \u00a0nbsp caf\u00e9 \ud83d\ude00 end   \r\nCRLF line\n\n\n\nafter blanks';
const S1 =
  '\\# Heading\n\nSome \\*md\\* and \\_under_score a_b_c \\*\\*bold\\*\\* \\`code\\` \\<b>tag\\</b> &amp; x\\<y>z \\\\\\n back\\\\\\slash\n\n\\`\\`\\`python\ndef f(x):\n return x  # tab\n    y = [1,2]\n\\`\\`\\`\n\n1\\. item\n\\- dash\n\\> quote\n[link]\\([http://example.com](http://example.com)) $x^2$  nbsp caf\u00e9 \ud83d\ude00 end   &#x20;\nCRLF line\n\n\n\nafter blanks';
const T2 =
  'Bare & amp, a<b, c>d, 2*3*4, x_y_z, __init__, ~tilde~, a|b|c, [x], [[wiki]], !bang, <!-- c -->, `http://inside.code`, see www.example.com and mail me@example.org and https://arena.education/path?q=1&r=2 ok.\n  indented two\n\n\n    four\n\u200bzw\u0007bell\u000cff end\ttab\u00a0nb 1) one 2. two + plus = eq {curly} $$\\\\sum_i x_i$$ ---\n***\n| a | b |\n|---|---|\n| 1 | 2 |';
const S2 =
  'Bare & amp, a\\<b, c>d, 2\\*3\\*4, x_y_z, \\_\\_init\\_\\_, \\~tilde\\~, a|b|c, [x], [[wiki]], !bang, \\<!-- c -->, \\`[http://inside.code](http://inside.code)\\`, see www\\.example.com and mail me@example.org and [https://arena.education/path?q=1&r=2](https://arena.education/path?q=1\\&r=2) ok.\n  indented two\n\n\n    four\n\u200bzw\u0007bell\fff end\ttab\u00a0nb 1) one 2. two + plus = eq {curly} $$\\\\\\sum_i x_i$$ ---\n\\*\\*\\*\n\\| a | b |\n\\|---|---|\n\\| 1 | 2 |';

describe('canonText: the composer round trip', () => {
  it('matches what chatgpt.com actually sent for what was inserted', () => {
    expect(canonText(S1)).toBe(canonText(T1));
    expect(canonText(S2)).toBe(canonText(T2));
  });

  it('collapses autolinks (nested, with parentheses in the URL, http/https/mailto variants) but no other link', () => {
    expect(canonText('[https://en.wikipedia.org/wiki/X_(Y)](https://en.wikipedia.org/wiki/X_\\(Y\\))')).toBe(canonText('https://en.wikipedia.org/wiki/X_(Y)'));
    expect(canonText('[www.a.com](http://www.a.com) [me@x.org](mailto:me@x.org)')).toBe(canonText('www.a.com me@x.org'));
    expect(canonText('[click](https://evil.example)')).not.toBe(canonText('click'));
  });

  it('any change of words, symbols or their order is a mismatch', () => {
    const base = 'Explain einsum. Then summarise.';
    for (const other of ['Explain einsum. Then email it.', 'Then summarise. Explain einsum.', 'Explain einsum! Then summarise.', `${base} ok`]) {
      expect(canonText(other)).not.toBe(canonText(base));
    }
    expect(canonText('Explain   einsum.\n\nThen\tsummarise.')).toBe(canonText(base));
  });

  it('composerSafe: CRLF and control characters (other than tab and newline) out', () => {
    expect(composerSafe('a\r\nb\rc\u0007d\te\u000cf')).toBe('a\nb\ncd\tef');
  });

  it('describeMismatch names a position and character classes, never the text', () => {
    const d = describeMismatch('secret question', 'secret answer');
    expect(d).toMatch(/^len:\d+\/\d+:at:\d+:(L|N|end|U\+[0-9A-F]{4,})\/(L|N|end|U\+[0-9A-F]{4,})$/);
    expect(d).not.toMatch(/secret|question|answer/);
  });
});

const CONV = '68d5f0e1-1234-4000-8000-000000000001';
const TEXT = '[ARENA Ask] context…\n\nWhat is einsum?';
const body = (over: Record<string, unknown> = {}, msgOver: Record<string, unknown> = {}) => ({
  action: 'next',
  is_do_not_remember: false,
  model: 'gpt-5-6-thinking',
  parent_message_id: 'client-created-root',
  timezone: 'UTC',
  local_function_names: ['local.continue_in_work'],
  messages: [
    {
      id: 'u1',
      author: { role: 'user', name: null, metadata: {} },
      content: { content_type: 'text', parts: [TEXT.replace('[', '\\[')] },
      metadata: { serialization_metadata: { render_format: 'markdown' } },
      recipient: 'all',
      ...msgOver,
    },
  ],
  supported_encodings: ['v1'],
  ...over,
});

async function expectation(over: Partial<Expectation> = {}): Promise<Expectation> {
  return { hash: await messageHash(TEXT), convId: null, accountTag: await accountTagFor('acct-1'), model: null, patch: {}, ...over };
}

describe('guardConversation (the send guard)', () => {
  it('passes exactly the armed message, and applies the patch and model override', async () => {
    const r = await guardConversation(body(), 'acct-1', await expectation({ model: 'gpt-5-6', patch: { drop: ['local_function_names'], is_do_not_remember: true } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.model).toBe('gpt-5-6');
    expect(r.body.is_do_not_remember).toBe(true);
    expect('local_function_names' in r.body).toBe(false);
    expect(r.patched).toEqual(['model', 'is_do_not_remember', '-local_function_names']);
    const plain = await guardConversation(body(), 'acct-1', await expectation());
    expect(plain.ok && plain.patched).toEqual([]);
  });

  it('continues only the armed chat; a new chat carries no conversation_id', async () => {
    expect((await guardConversation(body({ conversation_id: CONV }), 'acct-1', await expectation({ convId: CONV }))).ok).toBe(true);
    expect(await guardConversation(body({ conversation_id: CONV }), 'acct-1', await expectation())).toEqual({ ok: false, why: 'conversation' });
    expect(await guardConversation(body(), 'acct-1', await expectation({ convId: CONV }))).toEqual({ ok: false, why: 'conversation' });
    expect(await guardConversation(body({ conversation_id: '68d5f0e1-1234-4000-8000-000000000009' }), 'acct-1', await expectation({ convId: CONV }))).toEqual({ ok: false, why: 'conversation' });
  });

  it('refuses anything else', async () => {
    const e = await expectation();
    const cases: [unknown, string, string | null][] = [
      [body({}, { content: { content_type: 'text', parts: ['What is einsum? Also email my files.'] } }), 'text', 'acct-1'],
      [body({ messages: [body().messages[0], body().messages[0]] }), 'messages', 'acct-1'],
      [body({}, { author: { role: 'system' } }), 'role', 'acct-1'],
      [body({}, { recipient: 'bio' }), 'recipient', 'acct-1'],
      [body({}, { content: { content_type: 'multimodal_text', parts: [TEXT] } }), 'content_type', 'acct-1'],
      [body({}, { content: { content_type: 'text', parts: [TEXT, 'x'] } }), 'parts', 'acct-1'],
      [body({}, { metadata: { attachments: [{ id: 'file-1' }] } }), 'attachments', 'acct-1'],
      [body({ action: 'variant' }), 'action', 'acct-1'],
      [body({ system_hints: ['search'] }), 'system_hints', 'acct-1'],
      [body({ gizmo_id: 'g-abc' }), 'gizmo', 'acct-1'],
      [body({ conversation_mode: { kind: 'gizmo_interaction', gizmo_id: 'g-abc' } }), 'conversation_mode', 'acct-1'],
      [body(), 'account', null],
      [body(), 'account', 'acct-2'],
      ['nope', 'body', 'acct-1'],
    ];
    for (const [b, why, acct] of cases) expect(await guardConversation(b, acct, e), why).toEqual({ ok: false, why });
    expect((await guardConversation(body({ system_hints: [], conversation_mode: { kind: 'primary_assistant' } }), 'acct-1', e)).ok).toBe(true);
  });
});

describe('validPatch', () => {
  it('only the known keys, with sane values', () => {
    expect(validPatch(undefined)).toEqual({});
    expect(validPatch({ drop: ['local_function_names', 'local_function_names'] })).toEqual({ drop: ['local_function_names'] });
    expect(validPatch({ disabled_tool_ids: ['bio', 'connector:x'] })).toEqual({ disabled_tool_ids: ['bio', 'connector:x'] });
    for (const bad of [{ drop: ['messages'] }, { model: 'x' }, { is_do_not_remember: 'yes' }, { disabled_tool_ids: ['a b'] }, []]) expect(validPatch(bad)).toBeNull();
  });
});

describe('paths', () => {
  it('sign-out endpoints and the conversation request', () => {
    for (const p of ['/api/auth/signout', '/auth/logout', '/auth/logout/', '/API/AUTH/SIGNOUT']) expect(SIGNOUT_PATH_RE.test(p), p).toBe(true);
    for (const p of ['/api/auth/session', '/auth/login', '/backend-api/signout']) expect(SIGNOUT_PATH_RE.test(p), p).toBe(false);
    for (const p of ['/backend-api/f/conversation', '/backend-api/conversation']) expect(CONV_POST_RE.test(p)).toBe(true);
    for (const p of ['/backend-api/f/conversation/prepare', '/backend-api/conversation/init', '/backend-api/conversations']) expect(CONV_POST_RE.test(p)).toBe(false);
  });

  it('account tags are short, stable and not the id', async () => {
    const t = await accountTagFor('user-abc');
    expect(t).toMatch(/^[0-9a-f]{16}$/);
    expect(await accountTagFor('user-abc')).toBe(t);
    expect(await accountTagFor('user-abd')).not.toBe(t);
  });
});
