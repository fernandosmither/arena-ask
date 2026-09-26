import { MAX_CLEANUP_PROJECTS, type ProjectRef } from './protocol';
import type { OwnProject, StateStore } from './state-store';

/**
 * The background's bookkeeping of the claude.ai projects this extension creates (see relay.ts):
 *
 * - SetupLock: relays run their setup (org → project → conversation → lockdown) one at a time,
 *   until they report `started`, so N concurrent first questions create ONE project: the first
 *   relay creates it, the background stores it before the next relay is even given the project.
 * - ProjectBook: the current project (the one handed to relays), and every project the extension
 *   created, marked `used` once a conversation lives in it. Created-but-never-used projects (a
 *   question that failed after creating one, or a race the lock only makes unlikely) are handed to
 *   relays for deletion, which happens only if the project is still an empty, private "ARENA" one.
 */

export class SetupLock {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Wait for the lock; resolves with its release (idempotent). A holder still holding it after
   * `maxHoldMs` is stopped first (`onExpire`: it must abort its setup, e.g. by disconnecting its
   * relay, so it can't go on creating things once others may run), then the lock passes on.
   */
  acquire(maxHoldMs: number, onExpire: () => void = () => {}): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => held);
    return prev.then(() => {
      let done = false;
      const free = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        release();
      };
      const timer = setTimeout(() => {
        try {
          onExpire();
        } catch {
          /* it is stopped as far as it can be */
        }
        free();
      }, maxHoldMs);
      return free;
    });
  }
}

const sameRef = (a: ProjectRef | null, b: ProjectRef | null) => (a?.uuid ?? null) === (b?.uuid ?? null) && (a?.orgTag ?? null) === (b?.orgTag ?? null);

export interface ProjectReport {
  /** The project the relay's conversation lives in (or would have). */
  project?: ProjectRef;
  /** A project the relay created. */
  created?: ProjectRef;
  /** Cleanup candidates the relay dealt with. */
  cleaned?: string[];
}

export class ProjectBook {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: StateStore) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** What a relay gets: the current project, and created-but-never-used projects to clean up. */
  forRelay(): Promise<{ project: ProjectRef | null; cleanup: ProjectRef[] }> {
    return this.serial(async () => {
      const project = await this.store.loadProject();
      const own = await this.store.loadOwnProjects();
      const cleanup = own
        .filter((o) => !o.used && o.uuid !== project?.uuid)
        .slice(0, MAX_CLEANUP_PROJECTS)
        .map(({ orgTag, uuid }) => ({ orgTag, uuid }));
      return { project, cleanup };
    });
  }

  /**
   * Record what a relay reported. `dispatched`: the project it was given; `inUse`: a conversation
   * now lives in `r.project`. The reported project becomes the current one unless another relay
   * replaced the current one since this relay was dispatched (then it stays an extra, never used
   * here, and is cleaned up if it ends up empty).
   */
  record(r: ProjectReport, dispatched: ProjectRef | null, inUse: boolean): Promise<void> {
    return this.serial(async () => {
      let own: OwnProject[] = await this.store.loadOwnProjects();
      if (r.created && !own.some((o) => o.uuid === r.created!.uuid)) own.push({ ...r.created, used: false });
      if (r.cleaned?.length) own = own.filter((o) => !r.cleaned!.includes(o.uuid));
      if (r.project) {
        const cur = await this.store.loadProject();
        if (!cur || cur.orgTag !== r.project.orgTag || sameRef(cur, dispatched)) {
          if (!sameRef(cur, r.project)) await this.store.saveProject(r.project);
        } else if (cur.uuid !== r.project.uuid) {
          console.warn('[arena-ask] a second ARENA project was created concurrently; keeping the first');
        }
        if (inUse) own = own.map((o) => (o.uuid === r.project!.uuid ? { ...o, used: true } : o));
      }
      await this.store.saveOwnProjects(own);
    });
  }
}
