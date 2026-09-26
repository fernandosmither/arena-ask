import { describe, expect, it } from 'vitest';
import { AccountPin, type PinStore } from './pins';
import { AskQueue } from './ask-queue';
import { SetupLock } from './projects';

/** An in-memory pin store; `gate` holds writes until released, `fail*` make calls throw. */
function store(initial: string | null = null) {
  const st = { value: initial, failLoad: false, failPin: false, gate: null as Promise<void> | null, writes: 0 };
  const s: PinStore = {
    load: async () => {
      if (st.failLoad) throw new Error('idb');
      return st.value;
    },
    pinOnce: async (v) => {
      if (st.gate) await st.gate;
      if (st.failPin) throw new Error('idb');
      if (st.value !== null) return false;
      st.value = v;
      st.writes++;
      return true;
    },
    forget: async () => {
      st.value = null;
    },
  };
  return { st, s };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe('AccountPin: a pin that fails closed and a forget that sticks', () => {
  it('an unreadable pin is an error, never "not pinned"', async () => {
    const { st, s } = store('org-A');
    const pin = new AccountPin(s);
    st.failLoad = true;
    await expect(pin.read()).rejects.toThrow();
    await expect(pin.pinned()).rejects.toThrow();
    st.failLoad = false;
    expect(await pin.read()).toEqual({ value: 'org-A', gen: 0 });
  });

  it('a question that read the pin before a forget cannot pin afterwards (stale)', async () => {
    const { st, s } = store();
    const pin = new AccountPin(s);
    const r = await pin.read(); // unpinned, generation 0
    await pin.forget();
    expect(await pin.pin('org-B', r.gen)).toBe('stale');
    expect(st.value).toBeNull();
    // the next question reads the new generation and pins its own
    const r2 = await pin.read();
    expect(await pin.pin('org-C', r2.gen)).toBe('pinned');
    expect(st.value).toBe('org-C');
  });

  it('a forget issued while a pin write is in flight runs after it, and wins', async () => {
    const { st, s } = store();
    const pin = new AccountPin(s);
    const g = gate();
    st.gate = g.p;
    const r = await pin.read();
    const writing = pin.pin('org-A', r.gen);
    const forgetting = pin.forget();
    g.open();
    expect(await writing).toBe('pinned');
    await forgetting;
    expect(st.value).toBeNull();
    expect(await pin.pinned()).toBe(false);
  });

  it('a failed write is held in memory (the next question is still held to it) until a forget', async () => {
    const { st, s } = store();
    const pin = new AccountPin(s);
    st.failPin = true;
    expect(await pin.pin('tag-A', (await pin.read()).gen)).toBe('memory');
    expect(await pin.read()).toEqual({ value: 'tag-A', gen: 0 });
    expect(await pin.pinned()).toBe(true);
    await pin.forget();
    expect(await pin.pinned()).toBe(false);
  });

  it('a storage call that never settles fails at its deadline instead of blocking every later one', async () => {
    const { st, s } = store();
    let hang = true;
    const never = new Promise<never>(() => {});
    const pin = new AccountPin({ ...s, load: () => (hang ? never : s.load()) }, 30);
    await expect(pin.read()).rejects.toThrow(/timed out/); // the question is refused
    hang = false;
    expect(await pin.read()).toEqual({ value: null, gen: 0 }); // the chain moved on
    await pin.forget(); // and forgetting still works
    expect(st.value).toBeNull();
  });

  it('a write past its deadline is held in memory; if it lands after a forget, it is undone', async () => {
    const { st, s } = store();
    const pin = new AccountPin(s, 30);
    const g = gate();
    st.gate = g.p; // the write hangs
    const r = await pin.read();
    expect(await pin.pin('org-A', r.gen)).toBe('memory');
    expect(await pin.pinned()).toBe(true); // held to it meanwhile (fail closed)
    await pin.forget();
    expect(await pin.pinned()).toBe(false);
    st.gate = null;
    g.open(); // the late write lands now…
    await sleep(20);
    expect(st.value).toBeNull(); // …and is removed again
  });

  it("a late write that lands with no forget since is kept (it is the pin)", async () => {
    const { st, s } = store();
    const pin = new AccountPin(s, 30);
    const g = gate();
    st.gate = g.p;
    expect(await pin.pin('org-A', (await pin.read()).gen)).toBe('memory');
    st.gate = null;
    g.open();
    await sleep(20);
    expect(st.value).toBe('org-A');
    expect((await pin.read()).value).toBe('org-A');
  });

  it('a retry reads a new generation after a forget (background.ts then refuses it)', async () => {
    const { s } = store('org-A');
    const pin = new AccountPin(s);
    const first = await pin.read();
    await pin.forget();
    const retry = await pin.read();
    expect(retry.value).toBeNull();
    expect(retry.gen).not.toBe(first.gen);
  });

  it('only the first pin sticks (kept)', async () => {
    const { s } = store('org-A');
    const pin = new AccountPin(s);
    expect(await pin.pin('org-B', 0)).toBe('kept');
    expect((await pin.read()).value).toBe('org-A');
  });
});

describe('Claude: the pin is read under the setup lock and written before it is released', () => {
  /** A first full-mode question, as background.ts runs it: read under the lock, pin at `started`, then release. */
  async function question(lock: SetupLock, pin: AccountPin, activeOrg: string, log: string[]) {
    const release = await lock.acquire(45_000);
    try {
      const r = await pin.read();
      log.push(`${activeOrg}:read:${r.value ?? 'none'}`);
      await sleep(5); // the relay sets up and reports `started`
      if (!r.value) await pin.pin(activeOrg, r.gen); // awaited before the lock goes
      return r.value ?? activeOrg;
    } finally {
      release();
    }
  }

  it('two concurrent first questions: the second runs in the first one\'s pinned org', async () => {
    const { st, s } = store();
    const pin = new AccountPin(s);
    const lock = new SetupLock();
    const log: string[] = [];
    const [a, b] = await Promise.all([question(lock, pin, 'org-A', log), question(lock, pin, 'org-B', log)]);
    expect(a).toBe('org-A');
    expect(b).toBe('org-A'); // held to A, not run unpinned in B
    expect(log).toEqual(['org-A:read:none', 'org-B:read:org-A']);
    expect(st.value).toBe('org-A');
  });

  it("a forget while a first question is setting up isn't undone by that question", async () => {
    const { st, s } = store();
    const pin = new AccountPin(s);
    const lock = new SetupLock();
    const q = question(lock, pin, 'org-A', []);
    await sleep(1); // it has read the pin (unpinned)
    await pin.forget();
    await q;
    expect(st.value).toBeNull(); // its pin write was dropped
  });
});

describe('AskQueue: forgetting never runs alongside a ChatGPT question', () => {
  it('first come, first served; a waiter gives up after its timeout', async () => {
    const q = new AskQueue();
    const a = await q.acquire(10);
    expect(q.busy).toBe(true);
    expect(await q.acquire(10)).toBeNull();
    const order: string[] = [];
    const b = q.acquire(1_000).then((r) => (order.push('b'), r));
    const c = q.acquire(1_000).then((r) => (order.push('c'), r));
    a!();
    (await b)!();
    (await c)!();
    expect(order).toEqual(['b', 'c']);
    expect(q.busy).toBe(false);
  });

  it('the running question finishes in time: taken ahead of queued ones, nothing stopped', async () => {
    const q = new AskQueue();
    const running = (await q.acquire(10))!;
    let stopped = false;
    q.onStop(running, () => (stopped = true));
    const queued = q.acquire(1_000);
    const forget = q.acquireStopping(200, 200);
    setTimeout(running, 20);
    const lease = await forget;
    expect(lease).not.toBeNull();
    expect(stopped).toBe(false);
    let queuedGot = false;
    void queued.then(() => (queuedGot = true));
    await sleep(5);
    expect(queuedGot).toBe(false); // the forget holds it; the queued question waits
    lease!();
    expect(await queued).not.toBeNull();
  });

  it('it runs on past the wait: it is stopped first, then the forget goes ahead of queued ones', async () => {
    const q = new AskQueue();
    const running = (await q.acquire(10))!;
    q.onStop(running, () => setTimeout(running, 5)); // stopping ends it (the question lets go)
    const queued = q.acquire(1_000);
    const lease = await q.acquireStopping(20, 500);
    expect(lease).not.toBeNull();
    let queuedGot = false;
    void queued.then(() => (queuedGot = true));
    await sleep(5);
    expect(queuedGot).toBe(false);
    lease!();
    expect(await queued).not.toBeNull();
  });

  it("it won't let go even when stopped: null, and the caller must not go ahead", async () => {
    const q = new AskQueue();
    const running = (await q.acquire(10))!;
    let stops = 0;
    q.onStop(running, () => stops++);
    expect(await q.acquireStopping(20, 20)).toBeNull();
    expect(stops).toBe(1);
    expect(q.busy).toBe(true);
    running();
    expect(q.busy).toBe(false);
  });

  it("a finished question's stop is cleared: the next holder isn't stopped by it", async () => {
    const q = new AskQueue();
    const first = (await q.acquire(10))!;
    let firstStopped = 0;
    q.onStop(first, () => firstStopped++);
    first();
    const second = (await q.acquire(10))!; // registers no stop
    expect(await q.acquireStopping(10, 10)).toBeNull();
    expect(firstStopped).toBe(0);
    second();
  });

  it('as background.ts forgets: a question stopped mid-pin still finishes its write first; the forget then clears it', async () => {
    const q = new AskQueue();
    const { st, s } = store();
    const pin = new AccountPin(s);
    const g = gate();
    st.gate = g.p;
    // A ChatGPT question: holds the queue, reads the pin, reports `started` (pin write in flight).
    const leave = (await q.acquire(10))!;
    const r = await pin.read();
    const pending = pin.pin('tag-A', r.gen);
    q.onStop(leave, () => {
      // stopped: its attempt ends once its pending writes are done (background.ts runOnRelay's finally)
      void pending.finally(leave);
    });
    const forgetting = (async () => {
      const l = await q.acquireStopping(20, 500);
      if (!l) throw new Error('still running');
      try {
        await pin.forget();
      } finally {
        l();
      }
    })();
    await sleep(40);
    g.open();
    await forgetting;
    expect(st.value).toBeNull();
    expect(st.writes).toBe(1);
  });
});
