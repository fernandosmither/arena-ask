import { describe, expect, it } from 'vitest';
import { checkPersonal, parseSession } from './gpt-account';
import { memoryBackend, StateStore } from './state-store';

// Shapes as chatgpt.com returned them (2026-09-25), values made up.
const session = (over: Record<string, unknown> = {}, account: Record<string, unknown> = {}) => ({
  user: { id: 'user-1', email: 'x@example.org' },
  accessToken: 'tok',
  account: { id: 'acct-1', planType: 'plus', structure: 'personal', ...account },
  expires: 'later',
  ...over,
});
const entry = (over: Record<string, unknown> = {}) => ({
  account: { account_id: 'acct-1', structure: 'personal', plan_type: 'plus', workspace_type: null, organization_id: null, is_deactivated: false, ...over },
});
const check = (over: Record<string, unknown> = {}) => ({ accounts: { 'acct-1': entry(over), default: entry(over) }, account_ordering: ['acct-1'] });

describe('parseSession', () => {
  it('the account the page acts as; null when logged out', () => {
    expect(parseSession(session())).toEqual({ accessToken: 'tok', accountId: 'acct-1', planType: 'plus', structure: 'personal' });
    expect(parseSession({})).toBeNull();
    expect(parseSession(session({ user: undefined }))).toBeNull();
    expect(parseSession(session({ accessToken: '' }))).toBeNull();
    expect(parseSession(session({ account: undefined }))).toBeNull();
  });
});

describe('checkPersonal', () => {
  const s = parseSession(session())!;
  it('a personal plan passes', () => {
    for (const plan of ['free', 'plus', 'pro', 'prolite', 'go']) {
      expect(checkPersonal({ ...s, planType: plan }, check({ plan_type: plan })), plan).toEqual({ ok: true, plan });
    }
  });

  it('team / enterprise / edu workspaces are refused', () => {
    for (const plan of ['team', 'enterprise', 'edu', 'business', 'enterprise_cbp_usage_based', 'k12']) {
      expect(checkPersonal({ ...s, planType: plan }, check({ plan_type: plan })), plan).toMatchObject({ ok: false, why: 'not_personal' });
    }
    expect(checkPersonal({ ...s, structure: 'workspace' }, check())).toEqual({ ok: false, why: 'not_personal' });
    expect(checkPersonal(s, check({ structure: 'workspace' }))).toEqual({ ok: false, why: 'not_personal' });
    expect(checkPersonal(s, check({ workspace_type: 'team' }))).toEqual({ ok: false, why: 'not_personal' });
    expect(checkPersonal(s, check({ organization_id: 'org-1' }))).toEqual({ ok: false, why: 'not_personal' });
  });

  it('anything missing or inconsistent is refused', () => {
    expect(checkPersonal({ ...s, structure: null }, check())).toEqual({ ok: false, why: 'unknown' });
    expect(checkPersonal(s, {})).toEqual({ ok: false, why: 'unknown' });
    expect(checkPersonal(s, { accounts: { 'acct-2': entry({ account_id: 'acct-2' }) } })).toEqual({ ok: false, why: 'unknown' });
    expect(checkPersonal(s, { accounts: { 'acct-1': entry({ account_id: 'acct-9' }) } })).toEqual({ ok: false, why: 'unknown' });
    expect(checkPersonal(s, check({ plan_type: undefined }))).toEqual({ ok: false, why: 'unknown' });
    expect(checkPersonal(s, check({ is_deactivated: true }))).toEqual({ ok: false, why: 'unknown' });
  });
});

describe('pinning (the background keeps only the tag)', () => {
  it('pins the first account, refuses to re-pin, and forgets on request', async () => {
    const db = new StateStore(memoryBackend());
    expect(await db.loadPinnedGpt()).toBeNull();
    expect(await db.pinGptOnce('0123456789abcdef')).toBe(true);
    expect(await db.pinGptOnce('fedcba9876543210')).toBe(false);
    expect(await db.loadPinnedGpt()).toBe('0123456789abcdef');
    expect(await db.pinGptOnce('not-a-tag')).toBe(false);
    await db.forgetPinnedGpt();
    expect(await db.loadPinnedGpt()).toBeNull();
    expect(await db.pinGptOnce('fedcba9876543210')).toBe(true);
    // the Claude pin is separate
    expect(await db.loadPinnedOrg()).toBeNull();
  });
});
