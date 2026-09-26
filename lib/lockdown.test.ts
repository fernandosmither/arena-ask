import { describe, expect, it } from 'vitest';
import { LOCKED_CREATE_PARAMS, lockdownSettings, lockdownViolations, mcpKeys } from './lockdown';

// Shaped like a real claude.ai conversation's settings right after creation (copied from the account).
const fresh = () => ({
  enabled_bananagrams: null,
  enabled_web_search: true,
  enabled_compass: null,
  enabled_sourdough: null,
  enabled_foccacia: null,
  enabled_mcp_tools: { 'a1b2:search_threads': true, 'a1b2:send_message': true, 'c3d4:read_file': false, 'local:x': false },
  enabled_megaminds: null,
  paprika_mode: 'auto',
  enabled_monkeys_in_a_barrel: true,
  enabled_saffron: true,
  tool_search_mode: 'auto',
  thinking_mode: 'auto',
  chat_memory_mode: 'disabled',
  preview_feature_uses_artifacts: true,
  enabled_turmeric: true,
});

describe('lockdownSettings', () => {
  it('switches every connector tool, web search, code execution, memory and the Google/Research flags off', () => {
    const s = lockdownSettings(fresh());
    expect(s).toMatchObject({
      enabled_web_search: false,
      enabled_monkeys_in_a_barrel: false,
      enabled_saffron: false,
      enabled_bananagrams: false,
      enabled_sourdough: false,
      enabled_foccacia: false,
      enabled_compass: false,
      enabled_drive_search: false,
      enabled_artifacts_attachments: false,
      enabled_imagine: false,
      enabled_megaminds: [],
      enabled_mcp_tools: { 'a1b2:search_threads': false, 'a1b2:send_message': false, 'c3d4:read_file': false, 'local:x': false },
    });
    expect(s).not.toHaveProperty('enabled_turmeric'); // not changeable per conversation; accepted
    expect(s).not.toHaveProperty('paprika_mode'); // only feature flags are touched
  });

  it('also switches off unknown enabled_* features that are on', () => {
    expect(lockdownSettings({ ...fresh(), enabled_new_thing: true })).toMatchObject({ enabled_new_thing: false });
  });

  it('copes with missing settings', () => {
    expect(lockdownSettings(null)).toMatchObject({ enabled_web_search: false, enabled_mcp_tools: {} });
  });

  it('create params: no profile preferences, memory disabled, not temporary', () => {
    expect(LOCKED_CREATE_PARAMS).toEqual({ include_conversation_preferences: false, chat_memory_mode: 'disabled', is_temporary: false });
  });
});

describe('lockdownViolations (fail closed)', () => {
  const locked = () => ({ ...fresh(), ...lockdownSettings(fresh()) });

  it('a fresh conversation is not locked down (null = the account default does not count as off)', () => {
    expect(lockdownViolations(fresh()).sort()).toEqual(
      [
        'enabled_bananagrams',
        'enabled_compass',
        'enabled_foccacia',
        'enabled_mcp_tools',
        'enabled_megaminds',
        'enabled_monkeys_in_a_barrel',
        'enabled_saffron',
        'enabled_sourdough',
        'enabled_web_search',
      ].sort(),
    );
  });

  it('L5: the settings claude.ai echoes after the lockdown PUT (live shape) pass', () => {
    // verified live 2026-09-25: known flags false, megaminds [], every tool false, ignored flags absent
    const echo = {
      enabled_bananagrams: false,
      enabled_web_search: false,
      enabled_compass: false,
      enabled_sourdough: false,
      enabled_foccacia: false,
      enabled_mcp_tools: { 'a1b2:search_threads': false, 'c3d4:read_file': false },
      enabled_megaminds: [],
      paprika_mode: 'auto',
      enabled_monkeys_in_a_barrel: false,
      enabled_saffron: false,
      tool_search_mode: 'auto',
      thinking_mode: 'auto',
      chat_memory_mode: 'disabled',
      enabled_turmeric: true,
    };
    expect(lockdownViolations(echo)).toEqual([]);
    // flags claude.ai ignores per conversation may be null (a GET shows them so)
    expect(lockdownViolations({ ...echo, enabled_drive_search: null, enabled_artifacts_attachments: null })).toEqual([]);
  });

  it('L5: every known flag must be exactly false; megaminds exactly []', () => {
    const locked = () => ({ ...fresh(), ...lockdownSettings(fresh()) });
    for (const k of ['enabled_web_search', 'enabled_monkeys_in_a_barrel', 'enabled_saffron', 'enabled_bananagrams', 'enabled_sourdough', 'enabled_foccacia', 'enabled_compass']) {
      for (const bad of [null, undefined, 'false', 0, true, 1, {}]) {
        const s: Record<string, unknown> = { ...locked(), [k]: bad };
        if (bad === undefined) delete s[k];
        expect(lockdownViolations(s), `${k}=${JSON.stringify(bad)}`).toContain(k);
      }
    }
    for (const bad of [null, undefined, ['x'], {}, false]) {
      const s: Record<string, unknown> = { ...locked(), enabled_megaminds: bad };
      if (bad === undefined) delete s.enabled_megaminds;
      expect(lockdownViolations(s)).toContain('enabled_megaminds');
    }
  });

  it('L5: unknown enabled_* flags fail whenever they read as on, in any shape', () => {
    const locked = () => ({ ...fresh(), ...lockdownSettings(fresh()) });
    for (const on of [true, 1, 'on', 'auto', ['x'], { a: true }]) {
      expect(lockdownViolations({ ...locked(), enabled_new: on }), JSON.stringify(on)).toContain('enabled_new');
    }
    for (const off of [false, null, 0, '', 'off', [], { a: false }]) {
      expect(lockdownViolations({ ...locked(), enabled_new: off }), JSON.stringify(off)).toEqual([]);
    }
    expect(lockdownSettings({ ...fresh(), enabled_a: 1, enabled_b: ['x'], enabled_c: { t: true }, enabled_d: null })).toMatchObject({
      enabled_a: false,
      enabled_b: [],
      enabled_c: { t: false },
    });
    expect(lockdownSettings({ ...fresh(), enabled_d: null })).not.toHaveProperty('enabled_d');
  });

  it('a locked-down one is, with AI-powered artifacts (turmeric) accepted', () => {
    expect(lockdownViolations(locked())).toEqual([]);
    expect(lockdownViolations(locked(), mcpKeys(fresh()))).toEqual([]);
  });

  it('each missing guarantee is a violation', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ enabled_web_search: null }, 'enabled_web_search'],
      [{ enabled_saffron: undefined }, 'enabled_saffron'],
      [{ enabled_monkeys_in_a_barrel: true }, 'enabled_monkeys_in_a_barrel'],
      [{ chat_memory_mode: null }, 'chat_memory_mode'],
      [{ enabled_mcp_tools: { 'a1b2:search_threads': true } }, 'enabled_mcp_tools'],
      [{ enabled_mcp_tools: null }, 'enabled_mcp_tools'],
      [{ enabled_sourdough: true }, 'enabled_sourdough'],
      [{ enabled_brand_new: true }, 'enabled_brand_new'],
      [{ enabled_megaminds: ['x'] }, 'enabled_megaminds'],
      [{ enabled_mcp_tools: { 'a1b2:search_threads': null } }, 'enabled_mcp_tools'],
    ];
    for (const [patch, want] of cases) expect(lockdownViolations({ ...locked(), ...patch })).toContain(want);
  });

  it('every connector tool the conversation started with must be present and off', () => {
    const s: Record<string, unknown> = locked();
    s.enabled_mcp_tools = { 'a1b2:search_threads': false }; // others silently dropped
    expect(lockdownViolations(s, mcpKeys(fresh()))).toEqual(['enabled_mcp_tools']);
  });

  it('non-objects fail', () => {
    for (const x of [null, undefined, 'x', []]) expect(lockdownViolations(x)).toEqual(['settings']);
  });
});
