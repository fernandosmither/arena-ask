/**
 * An account pin (full-mode Claude's org, My ChatGPT's account tag), kept in the background's
 * IndexedDB, with the rules both providers need:
 *
 * - A read that fails is an error (the caller refuses the question), never "not pinned".
 * - Reads, pin writes and forgets run one at a time, in order. A question reads the pin with its
 *   generation; its pin write is dropped if a forget happened since (`stale`), so a question already
 *   running can't undo a forget by pinning afterwards.
 * - A write that fails is held in memory for the service worker's life (fail closed: the next
 *   question is still held to it), until a forget clears it.
 * - Every storage call has a deadline, so one that never settles can't block the chain (and with
 *   it every later question, the Options page and forgetting): a read past it fails (the question
 *   is refused), a write past it is held in memory, and if that write still lands after a forget,
 *   it is undone.
 */
export interface PinStore {
  load(): Promise<string | null>;
  /** Stores `value` unless one is stored already (or it is malformed): whether it stored it. */
  pinOnce(value: string): Promise<boolean>;
  forget(): Promise<void>;
}

export interface PinRead {
  /** The pinned value (null: none yet). */
  value: string | null;
  /** The generation it was read in (a later forget moves it on). */
  gen: number;
}

/** How a pin write ended. */
export type PinOutcome = 'pinned' | 'kept' | 'stale' | 'memory';

/** How long one storage call of a pin may take. */
export const PIN_STORE_TIMEOUT_MS = 5_000;

export class AccountPin {
  private tail: Promise<unknown> = Promise.resolve();
  private gen = 0;
  private memory: string | null = null;

  constructor(
    private readonly store: PinStore,
    private readonly timeoutMs = PIN_STORE_TIMEOUT_MS,
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }

  /** `p`, or a rejection once the deadline passes (`p` itself may still settle later). */
  private bounded<T>(p: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pin storage timed out')), this.timeoutMs);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  /** The pin and its generation. Rejects when the store can't be read (in time). */
  read(): Promise<PinRead> {
    return this.serial(async () => ({ value: (await this.bounded(this.store.load())) ?? this.memory, gen: this.gen }));
  }

  /** Whether an account is pinned (stored, or held in memory). Rejects when the store can't be read. */
  async pinned(): Promise<boolean> {
    return (await this.read()).value !== null;
  }

  /**
   * Pin `value` for a question that read the pin (unpinned) in generation `gen`: `pinned`; `kept`
   * (one is stored already, or the value is malformed); `stale` (a forget happened since: nothing is
   * written); `memory` (the write failed: held in memory until a forget).
   */
  pin(value: string, gen: number): Promise<PinOutcome> {
    return this.serial(async () => {
      if (gen !== this.gen) return 'stale';
      const write = this.store.pinOnce(value);
      try {
        return (await this.bounded(write)) ? 'pinned' : 'kept';
      } catch {
        this.memory ??= value;
        // Past its deadline the write may still land: if the pin was forgotten by then, undo it.
        write.then(
          (stored) => {
            if (stored) this.undoIfForgotten(value, gen);
          },
          () => {},
        );
        return 'memory';
      }
    });
  }

  /** A late write of `value` (read in generation `gen`) landed: remove it if a forget came since. */
  private undoIfForgotten(value: string, gen: number): void {
    void this.serial(async () => {
      if (gen === this.gen) return; // not forgotten since: it is the pin (as held in memory)
      if ((await this.bounded(this.store.load())) === value) await this.bounded(this.store.forget());
    }).catch(() => {});
  }

  /**
   * Forget the pin (stored and in memory); pin writes of questions that read it before are dropped.
   * Rejects if the store doesn't confirm in time (the memory copy is gone either way).
   */
  forget(): Promise<void> {
    return this.serial(async () => {
      this.gen++;
      this.memory = null;
      await this.bounded(this.store.forget());
    });
  }
}
