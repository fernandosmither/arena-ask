/**
 * One holder at a time, first come first served (My ChatGPT drives one chatgpt.com page, so it asks
 * one question at a time). A waiter gives up after its timeout. The holder can say how to stop it,
 * so a settings change that must not run alongside a question (forgetting the pinned account) can
 * stop the running one instead of going ahead while it still runs.
 */
export type Release = () => void;

export class AskQueue {
  private waiting: (() => void)[] = [];
  private held = false;
  private stopper: { lease: object; stop: () => void } | null = null;

  /** Someone holds the queue (a new question would wait). */
  get busy(): boolean {
    return this.held;
  }

  /**
   * Wait for the queue (at most `timeoutMs`); resolves with its release (idempotent), or null when
   * the wait timed out. `front`: ahead of those already waiting.
   */
  acquire(timeoutMs: number, o: { front?: boolean } = {}): Promise<Release | null> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(this.lease());
    }
    return new Promise((resolve) => {
      const entry = () => {
        clearTimeout(t);
        resolve(this.lease());
      };
      if (o.front) this.waiting.unshift(entry);
      else this.waiting.push(entry);
      const t = setTimeout(() => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) {
          this.waiting.splice(i, 1);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  /** The current holder (the one `release` belongs to) says how to stop it; cleared when it lets go. */
  onStop(release: Release, stop: () => void): void {
    this.stopper = { lease: release, stop };
  }

  /**
   * Wait, ahead of the queued ones, up to `waitMs` for the holder to finish; if it still runs, stop it
   * and wait up to `stopWaitMs` more. Null if it still hasn't let go (the caller must not go ahead).
   */
  async acquireStopping(waitMs: number, stopWaitMs: number): Promise<Release | null> {
    const first = await this.acquire(waitMs, { front: true });
    if (first) return first;
    const s = this.stopper;
    try {
      s?.stop();
    } catch {
      /* stopped as far as it can be */
    }
    return this.acquire(stopWaitMs, { front: true });
  }

  private lease(): Release {
    let done = false;
    const release: Release = () => {
      if (done) return;
      done = true;
      if (this.stopper?.lease === release) this.stopper = null;
      const next = this.waiting.shift();
      if (next) next();
      else this.held = false;
    };
    return release;
  }
}
