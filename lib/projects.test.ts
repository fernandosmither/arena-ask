import { describe, expect, it, vi } from 'vitest';
import { ProjectBook, SetupLock } from './projects';
import { StateStore, memoryBackend } from './state-store';

const TAG = '0123456789abcdef';
const P1 = { orgTag: TAG, uuid: '0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e' };
const P2 = { orgTag: TAG, uuid: '0f0f0f0f-2a2a-4b3b-8c4c-5d5d5d5d5d5d' };
const P3 = { orgTag: TAG, uuid: '0c0c0c0c-3a3a-4b4b-8c5c-6d6d6d6d6d6d' };

describe('SetupLock', () => {
  it('one holder at a time, in order; release is idempotent', async () => {
    const lock = new SetupLock();
    const order: string[] = [];
    const a = await lock.acquire(10_000);
    const bP = lock.acquire(10_000).then((rel) => (order.push('b'), rel));
    const cP = lock.acquire(10_000).then((rel) => (order.push('c'), rel));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    a();
    a();
    const b = await bP;
    expect(order).toEqual(['b']);
    b();
    (await cP)();
    expect(order).toEqual(['b', 'c']);
  });

  it('a holder that never releases is stopped (onExpire) after maxHoldMs, before the next one gets the lock', async () => {
    vi.useFakeTimers();
    const lock = new SetupLock();
    const order: string[] = [];
    await lock.acquire(45_000, () => order.push('holder stopped')); // never released
    let got = false;
    const next = lock.acquire(45_000).then(() => {
      order.push('next');
      got = true;
    });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(got).toBe(false);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    await next;
    expect(order).toEqual(['holder stopped', 'next']);
    vi.useRealTimers();
  });

  it('a holder that released in time is never stopped; a throwing onExpire still passes the lock on', async () => {
    vi.useFakeTimers();
    const lock = new SetupLock();
    const stopped = vi.fn();
    (await lock.acquire(1_000, stopped))();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).not.toHaveBeenCalled();
    await lock.acquire(1_000, () => {
      throw new Error('boom');
    });
    const next = lock.acquire(1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(next).resolves.toBeTypeOf('function');
    vi.useRealTimers();
  });
});

describe('ProjectBook', () => {
  const book = () => {
    const store = new StateStore(memoryBackend());
    return { store, b: new ProjectBook(store) };
  };

  it('the first created project becomes current and used', async () => {
    const { store, b } = book();
    expect(await b.forRelay()).toEqual({ project: null, cleanup: [] });
    await b.record({ project: P1, created: P1 }, null, true);
    expect(await store.loadProject()).toEqual(P1);
    expect(await store.loadOwnProjects()).toEqual([{ ...P1, used: true }]);
    expect(await b.forRelay()).toEqual({ project: P1, cleanup: [] });
  });

  it('a project created by a relay that then failed (no conversation) is a cleanup candidate', async () => {
    const { store, b } = book();
    await b.record({ created: P1 }, null, false); // e.g. its memory could not be switched off
    await b.record({ project: P2, created: P2 }, null, true);
    expect(await store.loadProject()).toEqual(P2);
    expect(await b.forRelay()).toEqual({ project: P2, cleanup: [P1] });
    await b.record({ project: P2, cleaned: [P1.uuid] }, P2, true);
    expect(await b.forRelay()).toEqual({ project: P2, cleanup: [] });
  });

  it('a race: a project made after another relay already stored one stays an extra, never current', async () => {
    const { store, b } = book();
    await b.record({ project: P1, created: P1 }, null, true); // relay A
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await b.record({ project: P2, created: P2 }, null, false); // relay B was dispatched with none
    expect(await store.loadProject()).toEqual(P1);
    expect((await b.forRelay()).cleanup).toEqual([P2]);
    // …but once a conversation lives in it, it is never deleted
    await b.record({ project: P2 }, null, true);
    expect((await b.forRelay()).cleanup).toEqual([]);
    warn.mockRestore();
  });

  it('a deliberate replacement (the stored project was no longer usable) is adopted; the old one is only cleaned if unused', async () => {
    const { store, b } = book();
    await b.record({ project: P1, created: P1 }, null, true);
    await b.record({ project: P3, created: P3 }, P1, true); // relay was given P1, replaced it
    expect(await store.loadProject()).toEqual(P3);
    expect((await b.forRelay()).cleanup).toEqual([]); // P1 had conversations
  });

  it('another account replaces the current project', async () => {
    const { store, b } = book();
    await b.record({ project: P1, created: P1 }, null, true);
    const other = { orgTag: 'fedcba9876543210', uuid: P2.uuid };
    await b.record({ project: other, created: other }, null, true);
    expect(await store.loadProject()).toEqual(other);
  });
});
