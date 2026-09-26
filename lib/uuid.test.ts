import { describe, expect, it, vi } from 'vitest';
import { ROOT_PARENT, UUID_RE, uuidv7 } from './uuid';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('has the RFC 9562 v7 shape (version 7, variant 10xx)', () => {
    for (let i = 0; i < 200; i++) expect(uuidv7()).toMatch(V7);
  });

  it('encodes the current millisecond timestamp in the first 48 bits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:34:56.789Z'));
    const id = uuidv7();
    const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(ms).toBe(Date.parse('2026-09-25T12:34:56.789Z'));
    vi.useRealTimers();
  });

  it('sorts by creation time across milliseconds and is unique', () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      vi.setSystemTime(1_790_000_000_000 + i);
      ids.push(uuidv7());
    }
    vi.useRealTimers();
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ROOT_PARENT is the claude.ai null-parent sentinel', () => {
    expect(ROOT_PARENT).toBe('00000000-0000-4000-8000-000000000000');
    expect(ROOT_PARENT).toMatch(UUID_RE);
  });
});
